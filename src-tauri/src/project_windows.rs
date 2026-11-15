use crate::state::{lock, AppState, BackendResult};
use serde::Serialize;
use std::collections::HashMap;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
#[cfg(target_os = "macos")]
use tauri::menu::PredefinedMenuItem;
use tauri::menu::{Menu, MenuItem, MenuItemKind, Submenu};
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, WebviewWindow, WebviewWindowBuilder};

const NEW_PROJECT_MENU_ID: &str = "project.new";
const NEW_WINDOW_MENU_ID: &str = "window.new";
const OPEN_PROJECT_MENU_ID: &str = "project.open";
#[cfg(target_os = "macos")]
const QUIT_APP_MENU_ID: &str = "app.quit";
const OPEN_SETTINGS_MENU_ID: &str = "app.settings";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartupIntent {
    pub(crate) workspace: Option<String>,
    pub(crate) new_project: bool,
    pub(crate) empty_window: bool,
}

impl StartupIntent {
    fn empty_window() -> Self {
        Self {
            workspace: None,
            new_project: false,
            empty_window: true,
        }
    }
}

static NEXT_WINDOW_ID: AtomicU64 = AtomicU64::new(1);
static WINDOW_INTENTS: OnceLock<Mutex<HashMap<String, StartupIntent>>> = OnceLock::new();
static LAST_FOCUSED_WINDOW: OnceLock<Mutex<String>> = OnceLock::new();
#[cfg(target_os = "macos")]
static DOCK_APP: OnceLock<AppHandle> = OnceLock::new();

fn window_intents() -> &'static Mutex<HashMap<String, StartupIntent>> {
    WINDOW_INTENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn last_focused_window() -> &'static Mutex<String> {
    LAST_FOCUSED_WINDOW.get_or_init(|| Mutex::new("main".to_string()))
}

pub(crate) fn note_focused_window(label: &str) {
    if let Ok(mut last) = last_focused_window().lock() {
        *last = label.to_string();
    }
}

pub(crate) fn forget_window(label: &str) {
    if let Ok(mut intents) = window_intents().lock() {
        intents.remove(label);
    }
}

pub(crate) fn intents_snapshot() -> Vec<(String, StartupIntent)> {
    lock(window_intents())
        .map(|intents| {
            let mut entries: Vec<_> = intents.clone().into_iter().collect();
            entries.sort_by_key(|(label, _)| crate::session::label_sort_key(label));
            entries
        })
        .unwrap_or_default()
}

pub(crate) fn seed_main_intent(intent: StartupIntent) {
    if let Ok(mut intents) = window_intents().lock() {
        intents.insert("main".to_string(), intent);
    }
}

/// Parse and canonicalize the process command-line startup intent.
pub(crate) fn cli_startup_intent() -> BackendResult<StartupIntent> {
    let mut intent = parse_startup_intent(env::args_os().skip(1))?;
    if let Some(path) = intent.workspace.as_deref() {
        intent.workspace = Some(canonical_directory(path)?.to_string_lossy().into_owned());
    }
    Ok(intent)
}

fn focused_window_label(app: &AppHandle) -> Option<String> {
    if let Some(window) = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
    {
        let label = window.label().to_string();
        note_focused_window(&label);
        return Some(label);
    }
    let label = last_focused_window().lock().ok()?.clone();
    if app.get_webview_window(&label).is_some() {
        Some(label)
    } else {
        app.get_webview_window("main")
            .map(|window| window.label().to_string())
            .or_else(|| app.webview_windows().into_keys().next())
    }
}

pub(crate) fn set_window_workspace(app: &AppHandle, label: &str, path: &Path) -> BackendResult<()> {
    lock(window_intents())?.insert(
        label.to_string(),
        StartupIntent {
            workspace: Some(path.to_string_lossy().into_owned()),
            new_project: false,
            empty_window: false,
        },
    );
    crate::session::workspace_changed(app);
    Ok(())
}

fn canonical_directory(path: &str) -> BackendResult<PathBuf> {
    let canonical = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !canonical.is_dir() {
        return Err("Project path must be a directory".to_string());
    }
    Ok(canonical)
}

fn parse_startup_intent(args: impl IntoIterator<Item = OsString>) -> BackendResult<StartupIntent> {
    let mut args = args.into_iter();
    let mut intent = StartupIntent::default();
    while let Some(arg) = args.next() {
        if arg == OsStr::new("--workspace") {
            if intent.workspace.is_some() || intent.new_project {
                return Err("Only one startup project may be specified".to_string());
            }
            let value = args
                .next()
                .ok_or_else(|| "--workspace requires a project path".to_string())?;
            let path = value
                .into_string()
                .map_err(|_| "Project path is not valid UTF-8".to_string())?;
            if path.is_empty() || path.starts_with("--") {
                return Err("--workspace requires a project path".to_string());
            }
            intent.workspace = Some(path);
        } else if arg == OsStr::new("--new-project") {
            if intent.workspace.is_some() || intent.new_project {
                return Err("Only one startup project may be specified".to_string());
            }
            intent.new_project = true;
        }
        // Launch Services and development tooling may append their own arguments.
    }
    Ok(intent)
}

#[tauri::command(async)]
pub(crate) fn startup_intent(window: WebviewWindow) -> BackendResult<StartupIntent> {
    let mut intents = lock(window_intents())?;
    if let Some(intent) = intents.get(window.label()) {
        return Ok(intent.clone());
    }
    if window.label() != "main" {
        return Err("The project window has no startup intent".to_string());
    }
    let intent = cli_startup_intent()?;
    intents.insert(window.label().to_string(), intent.clone());
    Ok(intent)
}

fn base_window_config(app: &AppHandle) -> BackendResult<tauri::utils::config::WindowConfig> {
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .ok_or("The main window configuration is missing")?
        .clone();
    config.title = "MG Land".to_string();
    config.decorations = true;
    config.resizable = true;
    config.maximizable = true;
    Ok(config)
}

fn build_window(
    app: &AppHandle,
    config: tauri::utils::config::WindowConfig,
    label: &str,
    focus: bool,
) -> BackendResult<()> {
    let built = WebviewWindowBuilder::from_config(app, &config).and_then(|builder| builder.build());
    match built {
        Ok(window) => {
            crate::session::window_created(app, &window);
            if focus {
                let _ = window.set_focus();
            }
            Ok(())
        }
        Err(error) => {
            forget_window(label);
            Err(format!("Could not open a project window: {error}"))
        }
    }
}

pub(crate) fn restore_window(
    app: &AppHandle,
    label: String,
    intent: StartupIntent,
    geometry: crate::session::WindowGeometry,
) -> BackendResult<()> {
    let mut config = base_window_config(app)?;
    config.label = label.clone();
    if let Some(id) = label.strip_prefix("project-").and_then(|id| id.parse::<u64>().ok()) {
        NEXT_WINDOW_ID.fetch_max(id + 1, Ordering::Relaxed);
    }
    if let Some(width) = geometry.width {
        config.width = width;
    }
    if let Some(height) = geometry.height {
        config.height = height;
    }
    if geometry.maximized {
        config.maximized = true;
    } else {
        config.x = geometry.x;
        config.y = geometry.y;
    }
    lock(window_intents())?.insert(label.clone(), intent);
    build_window(app, config, &label, true)
}

fn create_window(app: &AppHandle, intent: StartupIntent) -> BackendResult<()> {
    let window_id = NEXT_WINDOW_ID.fetch_add(1, Ordering::Relaxed);
    let label = format!("project-{window_id}");
    let mut config = base_window_config(app)?;
    config.label = label.clone();

    // Each project has its own native window. Place it beside the active one
    // so the windows do not obscure one another immediately after creation.
    if let Some(source) = focused_window_label(app).and_then(|label| app.get_webview_window(&label))
    {
        if let (Ok(position), Ok(Some(monitor))) =
            (source.outer_position(), source.current_monitor())
        {
            let scale = monitor.scale_factor();
            let work_area = monitor.work_area();
            let work_left = work_area.position.x as f64 / scale;
            let work_top = work_area.position.y as f64 / scale;
            let work_width = work_area.size.width as f64 / scale;
            let work_height = work_area.size.height as f64 / scale;
            // Leave enough room to reveal the window behind this one on a
            // laptop display, while respecting the editor's minimum size.
            config.width = config
                .width
                .min((work_width - 128.0).max(config.min_width.unwrap_or(900.0)));
            config.height = config
                .height
                .min((work_height - 128.0).max(config.min_height.unwrap_or(600.0)));
            let max_x = work_left + (work_width - config.width).max(0.0);
            let max_y = work_top + (work_height - config.height).max(0.0);
            let offset = 32.0;
            let next_x = position.x as f64 / scale + offset;
            let next_y = position.y as f64 / scale + offset;
            config.x = Some(if next_x > max_x {
                work_left
            } else {
                next_x.max(work_left)
            });
            config.y = Some(if next_y > max_y {
                work_top
            } else {
                next_y.max(work_top)
            });
        }
    }
    lock(window_intents())?.insert(label.clone(), intent);
    build_window(app, config, &label, true)
}

#[cfg(target_os = "macos")]
extern "C" {
    fn mgland_install_dock_menu() -> bool;
}

#[cfg(target_os = "macos")]
#[no_mangle]
extern "C" fn mgland_open_new_window_from_dock() {
    // Dock actions run on AppKit's main thread; building a new webview on a
    // worker keeps its contextual menu responsive.
    let Some(app) = DOCK_APP.get().cloned() else {
        eprintln!("Could not open a new window from the Dock: app handle unavailable");
        return;
    };
    std::thread::spawn(move || {
        if let Err(error) = create_window(&app, StartupIntent::empty_window()) {
            eprintln!("Could not open a new window from the Dock: {error}");
        }
    });
}

#[cfg(target_os = "macos")]
pub(crate) fn install_dock_menu(app: &AppHandle) {
    let _ = DOCK_APP.set(app.clone());
    // The Tao app delegate is already installed by Tauri when setup runs.
    if !unsafe { mgland_install_dock_menu() } {
        eprintln!("Could not install the macOS Dock project menu");
    }
}

#[tauri::command(async)]
pub(crate) fn open_project_window(
    root: String,
    state: State<'_, AppState>,
    app: AppHandle,
    window: WebviewWindow,
) -> BackendResult<String> {
    let canonical = canonical_directory(&root)?;
    let current = state.for_window(&window)?;
    if lock(&current.core.workspace)?.as_ref() == Some(&canonical) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(canonical.to_string_lossy().into_owned());
    }
    create_window(
        &app,
        StartupIntent {
            workspace: Some(canonical.to_string_lossy().into_owned()),
            new_project: false,
            empty_window: false,
        },
    )?;
    Ok(canonical.to_string_lossy().into_owned())
}

#[tauri::command(async)]
pub(crate) fn open_new_project_window(app: AppHandle) -> BackendResult<()> {
    create_window(
        &app,
        StartupIntent {
            workspace: None,
            new_project: true,
            empty_window: false,
        },
    )
}

#[tauri::command(async)]
pub(crate) fn open_empty_project_window(app: AppHandle) -> BackendResult<()> {
    create_window(&app, StartupIntent::empty_window())
}

fn valid_project_name(name: &str) -> bool {
    name == name.trim()
        && !name.is_empty()
        && !name.chars().any(|ch| {
            ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        && matches!(
            Path::new(name).components().next(),
            Some(Component::Normal(_))
        )
        && Path::new(name).components().count() == 1
}

fn project_module(name: &str, requested: Option<&str>) -> BackendResult<String> {
    let module = requested
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(name);
    if module.is_empty() || module.chars().any(char::is_whitespace) || module.contains('\\') {
        return Err("Module path is invalid".to_string());
    }
    Ok(module.to_string())
}

#[tauri::command(async)]
pub(crate) fn create_go_project(
    parent: String,
    name: String,
    module: Option<String>,
) -> BackendResult<String> {
    if !valid_project_name(&name) {
        return Err("Project name must be one safe directory name".to_string());
    }
    let module = project_module(&name, module.as_deref())?;
    let parent = canonical_directory(&parent)?;
    let target = parent.join(&name);
    fs::create_dir(&target).map_err(|e| format!("Could not create project directory: {e}"))?;
    let result = crate::process::command_for("go")
        .arg("mod")
        .arg("init")
        .arg(&module)
        .current_dir(&target)
        .output()
        .map_err(|e| format!("Could not run go mod init: {e}"))
        .and_then(|output| {
            if output.status.success() {
                Ok(())
            } else {
                let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
                Err(if error.is_empty() {
                    format!("go mod init failed: {}", output.status)
                } else {
                    error
                })
            }
        });
    if let Err(error) = result {
        // Only remove an empty directory. Another process may have started
        // writing to it while go mod init ran; recursive cleanup would erase
        // those files.
        return if fs::remove_dir(&target).is_ok() {
            Err(error)
        } else {
            Err(format!(
                "{error}; project directory was left at {}",
                target.display()
            ))
        };
    }
    Ok(target.to_string_lossy().into_owned())
}

pub(crate) fn install_file_menu(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    #[cfg(target_os = "macos")]
    {
        // The predefined Quit item invokes Cocoa's `terminate:` directly, which
        // skips per-window CloseRequested handlers and their unsaved-file prompts.
        let app_menu = menu
            .items()?
            .into_iter()
            .next()
            .and_then(|item| match item {
                MenuItemKind::Submenu(submenu) => Some(submenu),
                _ => None,
            })
            .ok_or_else(|| std::io::Error::other("default macOS app menu is missing"))?;
        let settings = MenuItem::with_id(
            app,
            OPEN_SETTINGS_MENU_ID,
            "Settings…",
            true,
            Some("Cmd+Comma"),
        )?;
        // Keep Settings in the application menu, between About and Services.
        app_menu.insert(&settings, 2)?;
        app_menu.insert(&PredefinedMenuItem::separator(app)?, 3)?;
        let items = app_menu.items()?;
        let quit_index = items
            .len()
            .checked_sub(1)
            .ok_or_else(|| std::io::Error::other("default macOS Quit item is missing"))?;
        match &items[quit_index] {
            MenuItemKind::Predefined(item) if item.text()?.starts_with("Quit") => {}
            _ => return Err(std::io::Error::other("default macOS Quit item changed").into()),
        }
        app_menu.remove_at(quit_index)?;
        let quit = MenuItem::with_id(
            app,
            QUIT_APP_MENU_ID,
            format!("Quit {}", app.package_info().name),
            true,
            Some("Cmd+Q"),
        )?;
        app_menu.insert(&quit, quit_index)?;
    }
    let new_window = MenuItem::with_id(
        app,
        NEW_WINDOW_MENU_ID,
        "New Window",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let new_project = MenuItem::with_id(app, NEW_PROJECT_MENU_ID, "Project…", true, None::<&str>)?;
    let new = Submenu::with_items(app, "New", true, &[&new_project])?;
    let open_project = MenuItem::with_id(
        app,
        OPEN_PROJECT_MENU_ID,
        "Open Project…",
        true,
        None::<&str>,
    )?;
    let existing_file = menu.items()?.into_iter().find_map(|item| match item {
        MenuItemKind::Submenu(submenu) if submenu.text().ok().as_deref() == Some("File") => {
            Some(submenu)
        }
        _ => None,
    });
    if let Some(file) = existing_file {
        file.insert(&new_window, 0)?;
        file.insert(&new, 1)?;
        file.insert(&open_project, 2)?;
    } else {
        let file = Submenu::with_items(app, "File", true, &[&new_window, &new, &open_project])?;
        #[cfg(target_os = "macos")]
        let position = 1;
        #[cfg(not(target_os = "macos"))]
        let position = 0;
        menu.insert(&file, position)?;
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id() == NEW_WINDOW_MENU_ID {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(error) = create_window(&app, StartupIntent::empty_window()) {
                    eprintln!("Could not open a new window: {error}");
                }
            });
            return;
        }
        #[cfg(target_os = "macos")]
        if event.id() == QUIT_APP_MENU_ID {
            // Closing windows from inside the menu action can run during
            // AppKit menu tracking, where the per-window close-requested flow
            // is skipped and unsaved-file prompts never appear. Deferring to a
            // worker keeps the prompts working, like the Dock actions do.
            let app = app.clone();
            std::thread::spawn(move || {
                // Snapshot the session before any window closes: windows that
                // answer their prompt by closing must still restore next
                // launch, so teardown while quitting never rewrites the file.
                crate::session::persist(&app);
                crate::session::mark_quitting();
                for window in app.webview_windows().into_values() {
                    let _ = window.close();
                }
            });
            return;
        }
        let event_name = if event.id() == NEW_PROJECT_MENU_ID {
            Some("menu-new-project")
        } else if event.id() == OPEN_PROJECT_MENU_ID {
            Some("menu-open-project")
        } else if event.id() == OPEN_SETTINGS_MENU_ID {
            Some("menu-open-settings")
        } else {
            None
        };
        if let (Some(event_name), Some(label)) = (event_name, focused_window_label(app)) {
            let _ = app.emit_to(EventTarget::webview_window(label), event_name, ());
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn startup_flags_are_exclusive() {
        let args = ["--workspace", "/tmp/project"];
        let intent = parse_startup_intent(args.map(OsString::from)).unwrap();
        assert_eq!(intent.workspace.as_deref(), Some("/tmp/project"));
        assert!(!intent.new_project);
        assert!(!intent.empty_window);
        let intent = parse_startup_intent([OsString::from("--new-project")]).unwrap();
        assert!(intent.new_project);
        assert!(!intent.empty_window);
        assert!(parse_startup_intent(
            ["--workspace", "/tmp/project", "--new-project"].map(OsString::from)
        )
        .is_err());
        assert!(parse_startup_intent([OsString::from("--workspace")]).is_err());
    }

    #[test]
    fn empty_window_intent_is_explicit_in_frontend_payload() {
        let intent = StartupIntent::empty_window();
        assert_eq!(
            serde_json::to_value(intent).unwrap(),
            serde_json::json!({
                "workspace": null,
                "newProject": false,
                "emptyWindow": true,
            })
        );
    }

    #[test]
    fn project_names_are_single_safe_components() {
        for name in ["hello", "my-project", "测试项目"] {
            assert!(valid_project_name(name), "{name}");
        }
        for name in ["", ".", "..", "a/b", "a\\b", " a", "a ", "a:b", "a\n"] {
            assert!(!valid_project_name(name), "{name:?}");
        }
    }

    #[test]
    fn module_input_rejects_whitespace() {
        assert_eq!(project_module("demo", None).unwrap(), "demo");
        assert_eq!(project_module("demo", Some(" ")).unwrap(), "demo");
        assert_eq!(
            project_module("demo", Some("example.com/demo")).unwrap(),
            "example.com/demo"
        );
        assert!(project_module("demo", Some("bad module")).is_err());
    }

    #[test]
    fn creates_go_module_without_overwriting_an_existing_project() {
        if crate::process::version("go", &["version"]).is_none() {
            return;
        }
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let parent = env::temp_dir().join(format!("mgland-project-create-{nonce}"));
        fs::create_dir(&parent).unwrap();
        let parent_string = parent.to_string_lossy().into_owned();
        let project = create_go_project(
            parent_string.clone(),
            "demo".to_string(),
            Some("example.com/demo".to_string()),
        )
        .unwrap();
        let go_mod = fs::read_to_string(Path::new(&project).join("go.mod")).unwrap();
        assert!(go_mod.starts_with("module example.com/demo\n"));
        assert!(create_go_project(parent_string, "demo".to_string(), None).is_err());
        assert_eq!(
            fs::read_to_string(Path::new(&project).join("go.mod")).unwrap(),
            go_mod
        );
        fs::remove_dir_all(parent).unwrap();
    }
}
