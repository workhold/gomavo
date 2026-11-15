//! Delve DAP bridge.
//!
//! Spawns `dlv dap --listen=127.0.0.1:0`, connects to the advertised port,
//! and relays Debug Adapter Protocol frames between the TCP socket and the
//! frontend — mirroring how `lsp.rs` bridges gopls. All DAP logic (launch,
//! breakpoints, stack frames) lives in the frontend client.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::Stdio;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::lsp::read_lsp_message;
use crate::paths::checked_directory;
use crate::state::{lock, AppState, BackendResult, DebugSession};

/// How long to wait for `dlv` to print its listening address.
const START_TIMEOUT: Duration = Duration::from_secs(20);

fn write_dap_message(writer: &mut dyn Write, message: &Value) -> BackendResult<()> {
    let body = serde_json::to_vec(message).map_err(|e| e.to_string())?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    writer
        .write_all(header.as_bytes())
        .and_then(|_| writer.write_all(&body))
        .map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

/// Locate the Delve binary: the copy bundled into the app resources first,
/// then whatever `dlv` is on the user's PATH.
pub(crate) fn resolve_dlv(app: &AppHandle) -> Option<std::path::PathBuf> {
    crate::process::resolve_bundled(app, "dlv")
}

#[tauri::command(async)]
pub(crate) fn debug_start(
    root: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
    app: AppHandle,
) -> BackendResult<String> {
    let state = state.for_window(&window)?;
    let window_label = window.label().to_string();
    let root = checked_directory(&state, &root)?;

    let Some(dlv_path) = resolve_dlv(&app) else {
        return Err("Delve (dlv) is not installed".to_string());
    };

    // An explicit binary path skips PATH lookup, but dlv still shells out to
    // `go` when building the debug target, so keep the augmented PATH.
    let mut child = std::process::Command::new(&dlv_path)
        .args(["dap", "--listen=127.0.0.1:0"])
        .env("PATH", crate::process::augmented_path())
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start dlv: {e}"))?;
    let stdout = child.stdout.take().ok_or("dlv stdout is unavailable")?;
    let stderr = child.stderr.take().ok_or("dlv stderr is unavailable")?;

    // Delve prints "DAP server listening at: 127.0.0.1:PORT" on either
    // stream depending on the version; scan both until it appears.
    let (found_tx, found_rx) = mpsc::channel::<String>();
    let id = state.core.id("debug");
    let pipes: [Box<dyn Read + Send>; 2] = [Box::new(stdout), Box::new(stderr)];
    for stream in pipes {
        let sender = found_tx.clone();
        let app = app.clone();
        let label = window_label.clone();
        let session = id.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let text = line.trim_end();
                        if !text.is_empty() {
                            let _ = app.emit_to(
                                &label,
                                "debug-log",
                                json!({ "id": session, "line": text }),
                            );
                        }
                        if let Some(address) = text
                            .split_once("listening at:")
                            .map(|(_, rest)| rest.trim().to_string())
                            .filter(|rest| !rest.is_empty())
                        {
                            let _ = sender.send(address);
                            // Keep draining so dlv never blocks on a full pipe.
                            continue;
                        }
                    }
                }
            }
        });
    }
    drop(found_tx);

    let address = found_rx
        .recv_timeout(START_TIMEOUT)
        .map_err(|_| {
            let _ = child.kill();
            "Delve did not report its DAP address".to_string()
        })?;
    let stream = TcpStream::connect(&address).map_err(|error| {
        let _ = child.kill();
        format!("Could not connect to dlv at {address}: {error}")
    })?;
    stream.set_nodelay(true).ok();

    let stdin = stream
        .try_clone()
        .map_err(|e| format!("Could not open the dlv write stream: {e}"))?;
    let stdout = stream
        .try_clone()
        .map_err(|e| format!("Could not open the dlv read stream: {e}"))?;

    lock(&state.core.debug)?.insert(
        id.clone(),
        DebugSession {
            child,
            stdin: Arc::new(Mutex::new(Box::new(stdin) as Box<dyn Write + Send>)),
        },
    );

    // Reader thread: frames from dlv become frontend events.
    {
        let app = app.clone();
        let label = window_label.clone();
        let session = id.clone();
        let core = state.core.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_lsp_message(&mut reader) {
                    Ok(Some(message)) => {
                        let _ = app.emit_to(
                            &label,
                            "debug-event",
                            json!({ "id": session, "message": message }),
                        );
                    }
                    Ok(None) | Err(_) => break,
                }
            }
            let _ = app.emit_to(&label, "debug-exit", json!({ "id": session }));
            if let Ok(mut sessions) = core.debug.lock() {
                if let Some(mut session) = sessions.remove(&session) {
                    let _ = session.child.kill();
                    let _ = session.child.wait();
                }
            }
        });
    }
    Ok(id)
}

#[tauri::command(async)]
pub(crate) fn debug_send(
    id: String,
    message: Value,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<()> {
    let state = state.for_window(&window)?;
    let stdin = lock(&state.core.debug)?
        .get(&id)
        .map(|session| session.stdin.clone())
        .ok_or("Debug session is not running")?;
    let mut stdin = lock(&stdin)?;
    write_dap_message(&mut *stdin, &message)
}

#[tauri::command(async)]
pub(crate) fn debug_stop(
    id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<()> {
    let state = state.for_window(&window)?;
    if let Some(mut session) = lock(&state.core.debug)?.remove(&id) {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dap_writes_use_content_length_framing() {
        let mut writer = Vec::new();
        write_dap_message(
            &mut writer,
            &json!({"seq": 2, "type": "event", "event": "stopped"}),
        )
        .unwrap();
        let text = String::from_utf8(writer).unwrap();
        assert!(text.starts_with("Content-Length: "));
        assert!(text.contains("\r\n\r\n"));
        assert!(text.ends_with("}"));
    }
}
