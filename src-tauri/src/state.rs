use portable_pty::{ChildKiller, MasterPty};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use tauri::WebviewWindow;

use crate::runner::kill_task;

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> BackendResult<MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| "Internal state lock is poisoned".to_string())
}

pub(crate) type BackendResult<T> = Result<T, String>;

pub(crate) struct TerminalSession {
    pub(crate) master: Box<dyn MasterPty + Send>,
    pub(crate) writer: Box<dyn Write + Send>,
    pub(crate) killer: Box<dyn ChildKiller + Send + Sync>,
}

pub(crate) struct LspSession {
    pub(crate) id: String,
    pub(crate) child: Child,
    pub(crate) stdin: Arc<Mutex<ChildStdin>>,
}

pub(crate) struct DebugSession {
    pub(crate) child: Child,
    /// The DAP TCP stream's write half (`dlv dap` is spoken over TCP).
    pub(crate) stdin: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
}

/// One recursive filesystem watcher per window core. The thread owns the
/// notify watcher; setting `stop` makes it exit and release the watch.
pub(crate) struct WatchState {
    pub(crate) stop: Arc<AtomicBool>,
    pub(crate) join: Option<JoinHandle<()>>,
}

#[derive(Clone)]
pub(crate) struct TaskSession {
    pub(crate) child: Arc<Mutex<Child>>,
    #[cfg(unix)]
    pub(crate) pgid: i32,
}

#[derive(Default)]
pub(crate) struct Core {
    pub(crate) workspace: Mutex<Option<PathBuf>>,
    pub(crate) terminals: Mutex<HashMap<String, TerminalSession>>,
    pub(crate) lsp: Mutex<HashMap<PathBuf, LspSession>>,
    pub(crate) tasks: Mutex<HashMap<String, TaskSession>>,
    pub(crate) debug: Mutex<HashMap<String, DebugSession>>,
    pub(crate) watcher: Mutex<Option<WatchState>>,
    pub(crate) next_id: AtomicU64,
}

impl Core {
    pub(crate) fn id(&self, prefix: &str) -> String {
        format!(
            "{}-{}",
            prefix,
            self.next_id.fetch_add(1, Ordering::Relaxed) + 1
        )
    }

    pub(crate) fn shutdown(&self) {
        if let Ok(mut watcher) = self.watcher.lock() {
            if let Some(mut state) = watcher.take() {
                state.stop.store(true, Ordering::Relaxed);
                if let Some(join) = state.join.take() {
                    let _ = join.join();
                }
            }
        }
        if let Ok(mut sessions) = self.debug.lock() {
            let old = sessions
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>();
            drop(sessions);
            for mut session in old {
                let _ = session.child.kill();
                let _ = session.child.wait();
            }
        }
        if let Ok(mut sessions) = self.terminals.lock() {
            for (_, mut session) in sessions.drain() {
                let _ = session.killer.kill();
            }
        }
        if let Ok(mut sessions) = self.lsp.lock() {
            let old = sessions
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>();
            drop(sessions);
            for mut session in old {
                let _ = session.child.kill();
                let _ = session.child.wait();
            }
        }
        if let Ok(mut sessions) = self.tasks.lock() {
            let old = sessions
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>();
            drop(sessions);
            for session in old {
                let _ = kill_task(&session);
            }
        }
    }
}

#[derive(Default)]
pub(crate) struct AppState {
    pub(crate) core: Arc<Core>,
    pub(crate) windows: Arc<Mutex<HashMap<String, Arc<Core>>>>,
}

impl AppState {
    pub(crate) fn for_window(&self, window: &WebviewWindow) -> BackendResult<Self> {
        self.for_label(window.label())
    }

    pub(crate) fn for_label(&self, label: &str) -> BackendResult<Self> {
        let core = if label == "main" {
            self.core.clone()
        } else {
            lock(&self.windows)?
                .entry(label.to_string())
                .or_insert_with(|| Arc::new(Core::default()))
                .clone()
        };
        Ok(Self {
            core,
            windows: self.windows.clone(),
        })
    }

    pub(crate) fn close_window(&self, label: &str) {
        if label == "main" {
            self.core.shutdown();
        } else {
            let core = self
                .windows
                .lock()
                .ok()
                .and_then(|mut map| map.remove(label));
            if let Some(core) = core {
                core.shutdown();
            }
        }
    }

    pub(crate) fn shutdown_all(&self) {
        self.core.shutdown();
        let cores = self
            .windows
            .lock()
            .ok()
            .map(|mut map| map.drain().map(|(_, core)| core).collect::<Vec<_>>())
            .unwrap_or_default();
        for core in cores {
            core.shutdown();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;
    use crate::paths::*;

    #[test]
    fn project_windows_keep_independent_workspaces_and_file_access() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let parent = env::temp_dir().join(format!("mgland-window-state-{nonce}"));
        let a_root = parent.join("alpha");
        let b_root = parent.join("beta");
        fs::create_dir_all(&a_root).unwrap();
        fs::create_dir_all(&b_root).unwrap();
        let a_file = a_root.join("main.go");
        let b_file = b_root.join("main.go");
        fs::write(&a_file, "package alpha\n").unwrap();
        fs::write(&b_file, "package beta\n").unwrap();

        let app = AppState::default();
        let alpha = app.for_label("project-alpha").unwrap();
        let beta = app.for_label("project-beta").unwrap();
        *lock(&alpha.core.workspace).unwrap() = Some(fs::canonicalize(&a_root).unwrap());
        *lock(&beta.core.workspace).unwrap() = Some(fs::canonicalize(&b_root).unwrap());

        assert_eq!(
            checked_existing(&alpha, a_file.to_str().unwrap()).unwrap(),
            fs::canonicalize(&a_file).unwrap()
        );
        assert_eq!(
            checked_existing(&beta, b_file.to_str().unwrap()).unwrap(),
            fs::canonicalize(&b_file).unwrap()
        );
        assert!(checked_existing(&alpha, b_file.to_str().unwrap()).is_err());
        assert!(checked_existing(&beta, a_file.to_str().unwrap()).is_err());

        app.close_window("project-alpha");
        let beta_after_close = app.for_label("project-beta").unwrap();
        assert!(Arc::ptr_eq(&beta.core, &beta_after_close.core));
        assert_eq!(
            workspace(&beta_after_close).unwrap(),
            fs::canonicalize(&b_root).unwrap()
        );
        let reopened_alpha = app.for_label("project-alpha").unwrap();
        assert!(!Arc::ptr_eq(&alpha.core, &reopened_alpha.core));
        assert!(workspace(&reopened_alpha).is_err());
        fs::remove_dir_all(parent).unwrap();
    }

}
