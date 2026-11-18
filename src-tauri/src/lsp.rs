use serde_json::{json, Value};
use std::io::{self, BufRead, BufReader, Write};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::paths::checked_directory;
use crate::state::{lock, AppState, BackendResult, LspSession};

pub(crate) fn read_lsp_message<R: BufRead>(reader: &mut R) -> io::Result<Option<Value>> {
    let mut length = None;
    let mut line = String::new();
    loop {
        line.clear();
        let count = reader.read_line(&mut line)?;
        if count == 0 {
            return if length.is_none() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Incomplete LSP headers",
                ))
            };
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.eq_ignore_ascii_case("Content-Length") {
                length = Some(value.trim().parse::<usize>().map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidData, "Invalid LSP Content-Length")
                })?);
            }
        }
    }
    let length = length
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Missing LSP Content-Length"))?;
    if length > 16 * 1024 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "LSP message is too large",
        ));
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let message =
        serde_json::from_slice(&body).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(Some(message))
}

#[tauri::command(async)]
pub(crate) fn lsp_start(
    root: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
    app: AppHandle,
) -> BackendResult<()> {
    let state = state.for_window(&window)?;
    let window_label = window.label().to_string();
    let canonical = checked_directory(&state, &root)?;
    let mut sessions = lock(&state.core.lsp)?;
    if sessions.contains_key(&canonical) {
        return Ok(());
    }
    let Some(gopls_path) = crate::process::resolve_bundled(&app, "gopls") else {
        return Err("gopls is not installed".to_string());
    };
    // An explicit binary path skips PATH lookup, but gopls still shells out
    // to `go` for workspace queries, so keep the augmented PATH.
    let mut command = std::process::Command::new(&gopls_path);
    crate::process::apply_go_toolchain(&mut command, &state)?;
    let mut child = command
        .arg("serve")
        .env("PATH", crate::process::augmented_path())
        .current_dir(&canonical)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start gopls: {e}"))?;
    let stdin = child.stdin.take().ok_or("gopls stdin is unavailable")?;
    let stdout = child.stdout.take().ok_or("gopls stdout is unavailable")?;
    let stderr = child.stderr.take().ok_or("gopls stderr is unavailable")?;
    let session_id = state.core.id("lsp");
    sessions.insert(
        canonical.clone(),
        LspSession {
            id: session_id.clone(),
            child,
            stdin: Arc::new(Mutex::new(stdin)),
        },
    );
    drop(sessions);
    let core = state.core.clone();
    let event_root = root.clone();
    let stderr_app = app.clone();
    let stderr_label = window_label.clone();
    let stderr_root = event_root.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_lsp_message(&mut reader) {
                Ok(Some(message)) => {
                    let _ = app.emit_to(
                        &window_label,
                        "lsp-message",
                        json!({ "root": event_root, "message": message }),
                    );
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = app.emit_to(
                        &window_label,
                        "lsp-error",
                        json!({ "root": event_root, "error": error.to_string() }),
                    );
                    break;
                }
            }
        }
        if let Ok(mut sessions) = core.lsp.lock() {
            if sessions
                .get(&canonical)
                .is_some_and(|session| session.id == session_id)
            {
                if let Some(mut session) = sessions.remove(&canonical) {
                    drop(sessions);
                    let _ = session.child.kill();
                    let _ = session.child.wait();
                }
            }
        }
        let _ = app.emit_to(&window_label, "lsp-exit", json!({ "root": event_root }));
    });
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        while reader.read_line(&mut line).unwrap_or(0) > 0 {
            let text = line.trim_end().to_string();
            if !text.is_empty() {
                // Surface the real gopls failure reasons (version mismatch,
                // load errors) to the frontend instead of only the console.
                let _ = stderr_app.emit_to(
                    &stderr_label,
                    "lsp-stderr",
                    json!({ "root": stderr_root, "line": text }),
                );
            }
            eprintln!("gopls: {}", text);
            line.clear();
        }
    });
    Ok(())
}

#[tauri::command(async)]
pub(crate) fn lsp_health(root: String, window: WebviewWindow, state: State<'_, AppState>) -> BackendResult<bool> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    let mut sessions = lock(&state.core.lsp)?;
    let Some(session) = sessions.get_mut(&root) else { return Ok(false) };
    match session.child.try_wait().map_err(|e| e.to_string())? {
        None => Ok(true),
        Some(_) => {
            sessions.remove(&root);
            Ok(false)
        }
    }
}

#[tauri::command(async)]
pub(crate) fn lsp_send(
    root: String,
    message: Value,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<()> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    let stdin = lock(&state.core.lsp)?
        .get(&root)
        .map(|session| session.stdin.clone())
        .ok_or("gopls is not running for this workspace")?;
    let body = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut stdin = lock(&stdin)?;
    stdin
        .write_all(header.as_bytes())
        .map_err(|e| e.to_string())?;
    stdin.write_all(&body).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub(crate) fn lsp_stop(root: String, window: WebviewWindow, state: State<'_, AppState>) -> BackendResult<()> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    let session = lock(&state.core.lsp)?.remove(&root);
    if let Some(mut session) = session {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn lsp_framing_counts_utf8_bytes_and_keeps_message_boundaries() {
        let first = json!({ "jsonrpc": "2.0", "method": "window/logMessage", "params": { "message": "你好" } });
        let second = json!({ "jsonrpc": "2.0", "id": 2, "result": null });
        let mut wire = Vec::new();
        for message in [&first, &second] {
            let body = serde_json::to_vec(message).unwrap();
            write!(wire, "Content-Length: {}\r\n\r\n", body.len()).unwrap();
            wire.extend_from_slice(&body);
        }
        let mut reader = BufReader::new(Cursor::new(wire));
        assert_eq!(read_lsp_message(&mut reader).unwrap(), Some(first));
        assert_eq!(read_lsp_message(&mut reader).unwrap(), Some(second));
        assert_eq!(read_lsp_message(&mut reader).unwrap(), None);
    }

}
