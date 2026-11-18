use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::json;
use std::thread;
use std::io::{Read, Write};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::paths::checked_directory;
use crate::process::augmented_path;
use crate::state::{lock, AppState, BackendResult, TerminalSession};

fn decoded_utf8(pending: &mut Vec<u8>) -> String {
    let mut text = String::new();
    let mut consumed = 0;
    while consumed < pending.len() {
        match std::str::from_utf8(&pending[consumed..]) {
            Ok(valid) => {
                text.push_str(valid);
                consumed = pending.len();
            }
            Err(error) => {
                let valid = error.valid_up_to();
                text.push_str(&String::from_utf8_lossy(
                    &pending[consumed..consumed + valid],
                ));
                consumed += valid;
                if let Some(len) = error.error_len() {
                    text.push('\u{fffd}');
                    consumed += len;
                } else {
                    break;
                }
            }
        }
    }
    pending.drain(..consumed);
    text
}

#[tauri::command(async)]
pub(crate) fn terminal_start(
    root: String,
    cols: u16,
    rows: u16,
    window: WebviewWindow,
    state: State<'_, AppState>,
    app: AppHandle,
) -> BackendResult<String> {
    let state = state.for_window(&window)?;
    let window_label = window.label().to_string();
    let root = checked_directory(&state, &root)?;
    if cols == 0 || rows == 0 {
        return Err("Terminal size must be positive".to_string());
    }
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let mut command = CommandBuilder::new_default_prog();
    command.cwd(root);
    command.env("TERM", "xterm-256color");
    command.env("PATH", augmented_path());
    if let Some(version) = crate::process::go_toolchain(&state)? {
        command.env("GOTOOLCHAIN", version);
    }
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| e.to_string())?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    let id = state.core.id("terminal");
    lock(&state.core.terminals)?.insert(
        id.clone(),
        TerminalSession {
            master: pair.master,
            writer,
            killer,
        },
    );
    thread::spawn(move || {
        let _ = child.wait();
    });
    let core = state.core.clone();
    let terminal_id = id.clone();
    thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0_u8; 8192];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    pending.extend_from_slice(&buffer[..count]);
                    let data = decoded_utf8(&mut pending);
                    if !data.is_empty() {
                        let _ = app.emit_to(
                            &window_label,
                            "terminal-output",
                            json!({ "id": terminal_id, "data": data }),
                        );
                    }
                }
                Err(_) => break,
            }
        }
        if !pending.is_empty() {
            let _ = app.emit_to(
                &window_label,
                "terminal-output",
                json!({ "id": terminal_id, "data": String::from_utf8_lossy(&pending) }),
            );
        }
        if let Ok(mut sessions) = core.terminals.lock() {
            sessions.remove(&terminal_id);
        }
        let _ = app.emit_to(&window_label, "terminal-exit", json!({ "id": terminal_id }));
    });
    Ok(id)
}

#[tauri::command(async)]
pub(crate) fn terminal_write(
    id: String,
    data: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<()> {
    let state = state.for_window(&window)?;
    let mut sessions = lock(&state.core.terminals)?;
    let session = sessions.get_mut(&id).ok_or("Terminal has already exited")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub(crate) fn terminal_resize(
    id: String,
    cols: u16,
    rows: u16,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<()> {
    let state = state.for_window(&window)?;
    if cols == 0 || rows == 0 {
        return Err("Terminal size must be positive".to_string());
    }
    let sessions = lock(&state.core.terminals)?;
    let session = sessions.get(&id).ok_or("Terminal has already exited")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub(crate) fn terminal_close(
    id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<()> {
    let state = state.for_window(&window)?;
    if let Some(mut session) = lock(&state.core.terminals)?.remove(&id) {
        session.killer.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}
