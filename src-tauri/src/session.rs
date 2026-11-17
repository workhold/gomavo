use crate::project_windows::StartupIntent;
use crate::state::{lock, BackendResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow};

const SESSION_VERSION: u32 = 1;
const GEOMETRY_PERSIST_INTERVAL: Duration = Duration::from_secs(2);

static QUITTING: AtomicBool = AtomicBool::new(false);
static GEOMETRY: OnceLock<Mutex<HashMap<String, WindowGeometry>>> = OnceLock::new();
static LAST_PERSIST: OnceLock<Mutex<Instant>> = OnceLock::new();

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct WindowGeometry {
    pub(crate) x: Option<f64>,
    pub(crate) y: Option<f64>,
    pub(crate) width: Option<f64>,
    pub(crate) height: Option<f64>,
    pub(crate) maximized: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
struct SessionEntry {
    label: String,
    workspace: Option<String>,
    new_project: bool,
    empty_window: bool,
    geometry: WindowGeometry,
}

impl SessionEntry {
    fn from_parts(label: String, intent: &StartupIntent, geometry: WindowGeometry) -> Self {
        Self {
            label,
            workspace: intent.workspace.clone(),
            new_project: intent.new_project,
            empty_window: intent.empty_window,
            geometry,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
struct SessionFile {
    version: u32,
    windows: Vec<SessionEntry>,
}

fn geometry_map() -> &'static Mutex<HashMap<String, WindowGeometry>> {
    GEOMETRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn last_persist() -> &'static Mutex<Instant> {
    LAST_PERSIST.get_or_init(|| Mutex::new(Instant::now() - GEOMETRY_PERSIST_INTERVAL))
}

pub(crate) fn mark_quitting() {
    QUITTING.store(true, Ordering::Relaxed);
}

pub(crate) fn clear_quitting() {
    QUITTING.store(false, Ordering::Relaxed);
}

pub(crate) fn is_quitting() -> bool {
    QUITTING.load(Ordering::Relaxed)
}

fn session_path(app: &AppHandle) -> BackendResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir.join("session.json"))
}

fn read_session(path: &Path) -> Option<SessionFile> {
    let bytes = fs::read(path).ok()?;
    if bytes.len() > 1 << 20 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn write_session(path: &Path, file: &SessionFile) {
    let Ok(json) = serde_json::to_string_pretty(file) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, json).is_ok() {
        let _ = fs::rename(&tmp, path);
    }
}

/// "main" first, then project windows ordered by their numeric id.
pub(crate) fn label_sort_key(label: &str) -> (u8, u64) {
    if label == "main" {
        return (0, 0);
    }
    (
        1,
        label
            .strip_prefix("project-")
            .and_then(|id| id.parse().ok())
            .unwrap_or(u64::MAX),
    )
}

/// Only session-created labels are restored; anything else in the file is
/// treated as corrupt and dropped.
fn is_restorable_label(label: &str) -> bool {
    label == "main" || label_start_id(label).is_some()
}

fn label_start_id(label: &str) -> Option<u64> {
    label
        .strip_prefix("project-")
        .filter(|id| !id.is_empty() && id.chars().all(|ch| ch.is_ascii_digit()))
        .and_then(|id| id.parse().ok())
}

fn captured_geometry(window: &WebviewWindow) -> Option<WindowGeometry> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    let scale = window.scale_factor().ok()?;
    Some(WindowGeometry {
        x: Some(position.x as f64 / scale),
        y: Some(position.y as f64 / scale),
        width: Some(size.width as f64 / scale),
        height: Some(size.height as f64 / scale),
        maximized: window.is_maximized().unwrap_or(false),
    })
}

/// A restored point counts as visible only when a current monitor contains the
/// window's center; otherwise the saved position is dropped and the window
/// uses its default placement.
fn center_is_visible(app: &AppHandle, geometry: &WindowGeometry, fallback_size: (f64, f64)) -> bool {
    let (Some(x), Some(y)) = (geometry.x, geometry.y) else {
        return true;
    };
    let width = geometry.width.unwrap_or(fallback_size.0);
    let height = geometry.height.unwrap_or(fallback_size.1);
    let center = (x + width / 2.0, y + height / 2.0);
    let monitors = app
        .get_webview_window("main")
        .and_then(|main| main.available_monitors().ok())
        .or_else(|| app.available_monitors().ok());
    let Some(monitors) = monitors else {
        return true;
    };
    monitors.iter().any(|monitor| {
        let scale = monitor.scale_factor();
        let position = monitor.position();
        let size = monitor.size();
        let x = position.x as f64 / scale;
        let y = position.y as f64 / scale;
        let width = size.width as f64 / scale;
        let height = size.height as f64 / scale;
        center.0 >= x && center.0 < x + width && center.1 >= y && center.1 < y + height
    })
}

pub(crate) fn apply_geometry(window: &WebviewWindow, geometry: &WindowGeometry) {
    if let (Some(width), Some(height)) = (geometry.width, geometry.height) {
        let _ = window.set_size(LogicalSize::new(width, height));
    }
    if let (Some(x), Some(y)) = (geometry.x, geometry.y) {
        let _ = window.set_position(LogicalPosition::new(x, y));
    }
    if geometry.maximized {
        let _ = window.maximize();
    }
}

pub(crate) fn persist(app: &AppHandle) {
    let Ok(path) = session_path(app) else {
        return;
    };
    let mut entries = Vec::new();
    for (label, intent) in crate::project_windows::intents_snapshot() {
        if app.get_webview_window(&label).is_none() {
            continue;
        }
        let geometry = lock(geometry_map())
            .ok()
            .and_then(|map| map.get(&label).copied())
            .unwrap_or_default();
        entries.push(SessionEntry::from_parts(label, &intent, geometry));
    }
    write_session(&path, &SessionFile {
        version: SESSION_VERSION,
        windows: entries,
    });
}

/// Persist from the move/resize hot path: the in-memory geometry map is always
/// current, the file only every couple of seconds.
fn throttled_persist(app: &AppHandle) {
    let Ok(mut last) = lock(last_persist()) else {
        return;
    };
    if last.elapsed() < GEOMETRY_PERSIST_INTERVAL {
        return;
    }
    *last = Instant::now();
    drop(last);
    persist(app);
}

pub(crate) fn note_geometry(window: &tauri::Window) {
    if is_quitting() {
        return;
    }
    let app = window.app_handle().clone();
    if let Some(geometry) = window_geometry_of(window) {
        if let Ok(mut map) = lock(geometry_map()) {
            map.insert(window.label().to_string(), geometry);
        }
        throttled_persist(&app);
    }
}

fn window_geometry_of(window: &tauri::Window) -> Option<WindowGeometry> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    let scale = window.scale_factor().ok()?;
    Some(WindowGeometry {
        x: Some(position.x as f64 / scale),
        y: Some(position.y as f64 / scale),
        width: Some(size.width as f64 / scale),
        height: Some(size.height as f64 / scale),
        maximized: window.is_maximized().unwrap_or(false),
    })
}

pub(crate) fn window_created(app: &AppHandle, window: &WebviewWindow) {
    if let Some(geometry) = captured_geometry(window) {
        if let Ok(mut map) = lock(geometry_map()) {
            map.insert(window.label().to_string(), geometry);
        }
    }
    persist(app);
}

pub(crate) fn window_destroyed(app: &AppHandle, label: &str) {
    if let Ok(mut map) = lock(geometry_map()) {
        map.remove(label);
    }
    if !is_quitting() {
        persist(app);
    }
}

pub(crate) fn workspace_changed(app: &AppHandle) {
    persist(app);
}

fn default_window_size(app: &AppHandle) -> (f64, f64) {
    app.config()
        .app
        .windows
        .first()
        .map(|config| (config.width, config.height))
        .unwrap_or((1440.0, 900.0))
}

/// A restored entry whose workspace disappeared becomes a welcome window.
/// Restored empty windows stay welcome windows instead of reusing the
/// last-workspace fallback, since the session is the source of truth here.
fn prepare_intent(entry: &SessionEntry) -> StartupIntent {
    let workspace = entry
        .workspace
        .as_deref()
        .filter(|path| fs::canonicalize(path).map(|p| p.is_dir()).unwrap_or(false))
        .map(|path| {
            fs::canonicalize(path)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| path.to_string())
        });
    let empty_window = entry.empty_window || workspace.is_none() && !entry.new_project;
    StartupIntent {
        workspace,
        new_project: entry.new_project,
        empty_window,
    }
}

pub(crate) fn restore(app: &AppHandle) {
    let cli = crate::project_windows::cli_startup_intent();
    // Explicit command-line intents describe a fresh window; only plain
    // launches bring the previous session back.
    let explicit = match &cli {
        Ok(intent) => intent.workspace.is_some() || intent.new_project,
        Err(_) => true,
    };
    let session = if explicit {
        None
    } else {
        session_path(app).ok().and_then(|path| read_session(&path))
    };

    match session {
        Some(file) => {
            let fallback_size = default_window_size(app);
            let mut entries = file.windows;
            entries.sort_by_key(|entry| label_sort_key(&entry.label));
            for entry in &entries {
                if !is_restorable_label(&entry.label) {
                    continue;
                }
                let intent = prepare_intent(entry);
                let mut geometry = entry.geometry;
                if entry.label == "main" {
                    crate::project_windows::seed_main_intent(intent);
                    if let Some(main) = app.get_webview_window("main") {
                        if !center_is_visible(app, &geometry, fallback_size) {
                            geometry.x = None;
                            geometry.y = None;
                        }
                        apply_geometry(&main, &geometry);
                    }
                } else {
                    if !center_is_visible(app, &geometry, fallback_size) {
                        geometry.x = None;
                        geometry.y = None;
                    }
                    if let Err(error) =
                        crate::project_windows::restore_window(app, entry.label.clone(), intent, geometry)
                    {
                        eprintln!("Could not restore window {}: {error}", entry.label);
                    }
                }
            }
        }
        None => {
            if let Ok(intent) = cli {
                crate::project_windows::seed_main_intent(intent);
            }
        }
    }
    persist(app);
}

/// The frontend close-prompt Cancel signals an aborted quit: windows closed
/// before the cancel stay closed, the survivors keep their session entries.
#[tauri::command(async)]
pub(crate) fn quit_cancelled(app: AppHandle) {
    clear_quitting();
    persist(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(label: &str, workspace: Option<&str>) -> SessionEntry {
        SessionEntry {
            label: label.to_string(),
            workspace: workspace.map(str::to_string),
            new_project: false,
            empty_window: false,
            geometry: WindowGeometry::default(),
        }
    }

    #[test]
    fn session_file_round_trips_camel_case() {
        let file = SessionFile {
            version: 1,
            windows: vec![SessionEntry {
                label: "project-2".to_string(),
                workspace: Some("/tmp/demo".to_string()),
                new_project: false,
                empty_window: false,
                geometry: WindowGeometry {
                    x: Some(12.5),
                    y: Some(34.0),
                    width: Some(800.0),
                    height: Some(600.0),
                    maximized: true,
                },
            }],
        };
        let json = serde_json::to_string(&file).unwrap();
        assert!(json.contains("\"newProject\""));
        assert!(json.contains("\"emptyWindow\""));
        let parsed: SessionFile = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.windows[0].label, "project-2");
        assert_eq!(parsed.windows[0].geometry, file.windows[0].geometry);
        // A truncated or foreign file degrades to an empty session.
        assert!(serde_json::from_str::<SessionFile>("{").is_err());
    }

    #[test]
    fn labels_sort_main_first_then_by_numeric_id() {
        let mut labels = ["project-10", "main", "project-2", "project-3"];
        labels.sort_by_key(|label| label_sort_key(label));
        assert_eq!(labels, ["main", "project-2", "project-3", "project-10"]);
        assert!(!is_restorable_label("project-"));
        assert!(!is_restorable_label("project-x"));
        assert!(is_restorable_label("project-12"));
        assert!(is_restorable_label("main"));
    }

    #[test]
    fn restored_intents_downgrade_missing_workspaces_to_welcome() {
        let parent = std::env::temp_dir().join(format!("gomavo-session-test-{}", std::process::id()));
        fs::create_dir_all(&parent).unwrap();
        let project = parent.join("demo");
        fs::create_dir_all(&project).unwrap();
        let canonical = fs::canonicalize(&project).unwrap().to_string_lossy().into_owned();

        let restored = prepare_intent(&entry("project-1", Some(&canonical)));
        assert_eq!(restored.workspace.as_deref(), Some(canonical.as_str()));
        assert!(!restored.empty_window);

        let missing = prepare_intent(&entry("project-1", Some(parent.join("gone").to_str().unwrap())));
        assert_eq!(missing.workspace, None);
        assert!(missing.empty_window);

        let welcome = prepare_intent(&entry("project-1", None));
        assert_eq!(welcome.workspace, None);
        assert!(welcome.empty_window);

        let mut new_project = entry("project-1", None);
        new_project.new_project = true;
        let restored_new = prepare_intent(&new_project);
        assert!(restored_new.new_project);
        assert!(!restored_new.empty_window);

        fs::remove_dir_all(parent).unwrap();
    }
}
