//! Recursive workspace filesystem watching with debounced change events.
//!
//! The frontend refreshes its file tree, Git status, and untouched editor
//! tabs from one coalesced `fs-changed` event instead of polling.

use notify::{Event, RecursiveMode, Watcher};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::paths::checked_directory;
use crate::state::{lock, AppState, BackendResult, WatchState};

/// Wait this long after the latest event before flushing a batch, so a build
/// writing hundreds of files produces one refresh instead of hundreds.
const DEBOUNCE: Duration = Duration::from_millis(400);
/// Always flush a batch after this window even while events keep arriving.
const MAX_BATCH_DELAY: Duration = Duration::from_secs(3);
/// Cap the path list per event so a giant sync cannot balloon the payload.
const MAX_PATHS_PER_EVENT: usize = 500;

/// Directories whose churn is irrelevant to the project view.
fn noisy_path(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(
            component.as_os_str().to_str(),
            Some(".git") | Some("node_modules") | Some("target")
        )
    })
}

fn spawn_watcher(root: PathBuf, window_label: String, app: AppHandle, stop: std::sync::Arc<std::sync::atomic::AtomicBool>) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let Ok(mut watcher) = notify::recommended_watcher(tx) else {
            return;
        };
        if watcher.watch(&root, RecursiveMode::Recursive).is_err() {
            return;
        }
        let mut pending: Vec<PathBuf> = Vec::new();
        let mut first_event_at: Option<Instant> = None;
        let mut last_event_at = Instant::now();
        loop {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            let flush_due = first_event_at.is_some_and(|first| {
                last_event_at.duration_since(first) >= MAX_BATCH_DELAY
                    || last_event_at.elapsed() >= DEBOUNCE
            });
            if flush_due {
                let mut paths: Vec<PathBuf> = pending.drain(..).collect();
                paths.sort();
                paths.dedup();
                paths.truncate(MAX_PATHS_PER_EVENT);
                let _ = app.emit_to(
                    &window_label,
                    "fs-changed",
                    json!({
                        "root": root.to_string_lossy(),
                        "paths": paths
                            .iter()
                            .map(|path| path.to_string_lossy().into_owned())
                            .collect::<Vec<_>>(),
                        "truncated": paths.len() == MAX_PATHS_PER_EVENT,
                    }),
                );
                first_event_at = None;
                continue;
            }
            match rx.recv_timeout(DEBOUNCE) {
                Ok(Ok(event)) => {
                    let relevant = event.paths.iter().filter(|path| !noisy_path(path)).cloned();
                    for path in relevant {
                        pending.push(path);
                    }
                    if pending.is_empty() {
                        continue;
                    }
                    if first_event_at.is_none() {
                        first_event_at = Some(Instant::now());
                    }
                    last_event_at = Instant::now();
                }
                Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Timeout) => {
                    // A watcher error means we simply stop receiving updates;
                    // manual refresh keeps working, so do not crash the app.
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    })
}

fn stop_existing(state: &AppState) -> BackendResult<()> {
    if let Some(mut watcher) = lock(&state.core.watcher)?.take() {
        watcher.stop.store(true, Ordering::Relaxed);
        if let Some(join) = watcher.join.take() {
            let _ = join.join();
        }
    }
    Ok(())
}

#[tauri::command(async)]
pub(crate) fn watch_start(
    root: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
    app: AppHandle,
) -> BackendResult<()> {
    let state = state.for_window(&window)?;
    stop_existing(&state)?;
    let canonical = checked_directory(&state, &root)?;
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let join = spawn_watcher(
        canonical,
        window.label().to_string(),
        app,
        stop.clone(),
    );
    *lock(&state.core.watcher)? = Some(WatchState { stop, join: Some(join) });
    Ok(())
}

#[tauri::command(async)]
pub(crate) fn watch_stop(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<()> {
    let state = state.for_window(&window)?;
    stop_existing(&state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noisy_directories_are_filtered() {
        assert!(noisy_path(Path::new("/tmp/project/.git/index")));
        assert!(noisy_path(Path::new("/tmp/project/node_modules/pkg/index.js")));
        assert!(noisy_path(Path::new("/tmp/project/target/debug/app")));
        assert!(!noisy_path(Path::new("/tmp/project/main.go")));
        assert!(!noisy_path(Path::new("/tmp/project/pkg/helper/helper.go")));
    }
}
