use crate::state::{lock, AppState, BackendResult};
use serde::Serialize;
use std::collections::HashMap;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::menu::PredefinedMenuItem;
use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, WebviewWindow, WebviewWindowBuilder};

const NEW_PROJECT_MENU_ID: &str = "project.new";
const NEW_WINDOW_MENU_ID: &str = "window.new";
const OPEN_PROJECT_MENU_ID: &str = "project.open";
#[cfg(target_os = "macos")]
const QUIT_APP_MENU_ID: &str = "app.quit";
const OPEN_SETTINGS_MENU_ID: &str = "app.settings";
const RECENT_PROJECT_MENU_PREFIX: &str = "project.recent:";

/// One entry of the File ▸ Recent Projects submenu, GoLand style ("name [branch]").
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub(crate) struct RecentProject {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) branch: Option<String>,
}

static MENU_LOCALE: OnceLock<Mutex<String>> = OnceLock::new();
static RECENT_PROJECTS: OnceLock<Mutex<Vec<RecentProject>>> = OnceLock::new();

fn menu_locale() -> &'static Mutex<String> {
    MENU_LOCALE.get_or_init(|| Mutex::new("en-US".to_string()))
}

fn recent_projects() -> &'static Mutex<Vec<RecentProject>> {
    RECENT_PROJECTS.get_or_init(|| Mutex::new(Vec::new()))
}

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

pub(crate) fn install_app_menu(app: &AppHandle) -> tauri::Result<()> {
    rebuild_app_menu(app)?;
    // Registered once: rebuilt menus reuse the same item ids, so a single
    // handler keeps covering them after a locale or recents change.
    app.on_menu_event(|app, event| {
        let id = event.id().clone().0;
        if id == NEW_WINDOW_MENU_ID {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(error) = create_window(&app, StartupIntent::empty_window()) {
                    eprintln!("Could not open a new window: {error}");
                }
            });
            return;
        }
        #[cfg(target_os = "macos")]
        if id == QUIT_APP_MENU_ID {
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
        let payload = if let Some(path) = id.strip_prefix(RECENT_PROJECT_MENU_PREFIX) {
            Some(MenuActionPayload { id: "recent-project".into(), path: Some(path.into()) })
        } else {
            Some(MenuActionPayload { id, path: None })
        };
        if let (Some(payload), Some(label)) = (payload, focused_window_label(app)) {
            let _ = app.emit_to(EventTarget::webview_window(label), "menu-action", payload);
        }
    });
    Ok(())
}

#[derive(Clone, serde::Serialize)]
struct MenuActionPayload {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

/// Rebuild the whole menu bar, GoLand style, with labels for the current
/// locale and the stored recent-projects list. Accelerators are only set for
/// keys the webview does not already own through the shortcut preferences.
fn rebuild_app_menu(app: &AppHandle) -> tauri::Result<()> {
    let locale = lock(menu_locale()).map_err(std::io::Error::other)?.clone();
    let recents = lock(recent_projects()).map_err(std::io::Error::other)?.clone();
    let zh = locale.starts_with("zh");
    let t = move |zh_text: &'static str, en_text: &'static str| if zh { zh_text } else { en_text };
    let app_name = app.package_info().name.to_string();

    let menu = Menu::new(app)?;
    #[cfg(target_os = "macos")]
    {
        let about = PredefinedMenuItem::about(app, Some(&app_name), None)?;
        let settings = MenuItem::with_id(app, OPEN_SETTINGS_MENU_ID, t("设置…", "Settings…"), true, Some("Cmd+Comma"))?;
        let hide = PredefinedMenuItem::hide(app, Some(&format!("{app_name}")))?;
        let hide_others = PredefinedMenuItem::hide_others(app, None)?;
        let show_all = PredefinedMenuItem::show_all(app, None)?;
        let quit = MenuItem::with_id(app, QUIT_APP_MENU_ID, format!("{} {app_name}", t("退出", "Quit")), true, Some("Cmd+Q"))?;
        let sep = || PredefinedMenuItem::separator(app);
        // Custom quit instead of the predefined item: Cocoa's terminate:
        // skips the per-window CloseRequested handlers and their unsaved-file
        // prompts, while this item routes through the session-aware path.
        let app_menu = Submenu::with_items(
            app,
            &app_name,
            true,
            &[&about, &settings, &sep()?, &sep()?, &hide, &hide_others, &show_all, &sep()?, &quit],
        )?;
        menu.insert(&app_menu, 0)?;
    }

    let new_window = MenuItem::with_id(app, NEW_WINDOW_MENU_ID, t("新窗口", "New Window"), true, Some("CmdOrCtrl+N"))?;
    let new_go_file = MenuItem::with_id(app, "file.new-go-file", t("Go 文件", "Go File"), true, None::<&str>)?;
    let new_project = MenuItem::with_id(app, NEW_PROJECT_MENU_ID, t("项目…", "Project…"), true, None::<&str>)?;
    let new = Submenu::with_items(app, &t("新建", "New"), true, &[&new_go_file, &new_project])?;
    let open_project = MenuItem::with_id(app, OPEN_PROJECT_MENU_ID, t("打开项目…", "Open Project…"), true, Some("CmdOrCtrl+O"))?;
    let save = MenuItem::with_id(app, "file.save", t("保存", "Save"), true, None::<&str>)?;
    let save_all = MenuItem::with_id(app, "file.save-all", t("保存全部", "Save All"), true, None::<&str>)?;
    // Recent Projects submenu, GoLand style: "name [branch]".
    let recent_items: Vec<MenuItem<tauri::Wry>> = recents
        .iter()
        .map(|recent| {
            let label = match &recent.branch {
                Some(branch) if !branch.is_empty() => format!("{}  [{branch}]", recent.name),
                _ => recent.name.clone(),
            };
            MenuItem::with_id(app, format!("{RECENT_PROJECT_MENU_PREFIX}{}", recent.path), label, true, None::<&str>)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut recent_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = recent_items.iter().map(|item| item as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
    let no_recents = MenuItem::with_id(app, "project.recent-empty", t("暂无最近项目", "No recent projects"), false, None::<&str>)?;
    if recent_refs.is_empty() {
        recent_refs.push(&no_recents);
    }
    let recents_submenu = Submenu::with_items(app, &t("最近的项目", "Recent Projects"), true, &recent_refs)?;
    #[cfg(target_os = "macos")]
    let file = {
        let close_window = PredefinedMenuItem::close_window(app, Some(&t("关闭窗口", "Close Window")))?;
        Submenu::with_items(
            app,
            &t("文件", "File"),
            true,
            &[&new_window, &new, &open_project, &recents_submenu, &PredefinedMenuItem::separator(app)?, &save, &save_all, &close_window],
        )?
    };
    #[cfg(not(target_os = "macos"))]
    let file = Submenu::with_items(
        app,
        &t("文件", "File"),
        true,
        &[&new_window, &new, &open_project, &recents_submenu, &PredefinedMenuItem::separator(app)?, &save, &save_all],
    )?;
    let file_position = if cfg!(target_os = "macos") { 1 } else { 0 };
    menu.insert(&file, file_position)?;

    let edit = Submenu::with_items(
        app,
        &t("编辑", "Edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    menu.insert(&edit, 2)?;

    let toggle_project = MenuItem::with_id(app, "view.toggle-project", t("Project 项目", "Project"), true, None::<&str>)?;
    let toggle_git = MenuItem::with_id(app, "view.toggle-git", t("Git", "Git"), true, None::<&str>)?;
    let toggle_terminal = MenuItem::with_id(app, "view.toggle-terminal", t("终端 Terminal", "Terminal"), true, None::<&str>)?;
    let toggle_run = MenuItem::with_id(app, "view.toggle-run", t("运行 Run", "Run"), true, None::<&str>)?;
    let toggle_problems = MenuItem::with_id(app, "view.toggle-problems", t("问题 Problems", "Problems"), true, None::<&str>)?;
    let toggle_debug = MenuItem::with_id(app, "view.toggle-debug", t("调试 Debug", "Debug"), true, None::<&str>)?;
    let toggle_search = MenuItem::with_id(app, "view.toggle-search", t("搜索 Search", "Search"), true, None::<&str>)?;
    let tool_windows = Submenu::with_items(
        app,
        &t("工具窗口", "Tool Windows"),
        true,
        &[&toggle_project, &toggle_git, &toggle_terminal, &toggle_run, &toggle_problems, &toggle_debug, &toggle_search],
    )?;
    let view = Submenu::with_items(app, &t("视图", "View"), true, &[&tool_windows])?;
    menu.insert(&view, 3)?;

    let search_everywhere = MenuItem::with_id(app, "nav.search-everywhere", t("搜索所有内容", "Search Everywhere"), true, None::<&str>)?;
    let recent_files = MenuItem::with_id(app, "nav.recent-files", t("最近文件", "Recent Files"), true, None::<&str>)?;
    let goto_definition = MenuItem::with_id(app, "nav.go-to-definition", t("跳转定义", "Go to Definition"), true, None::<&str>)?;
    let nav_back = MenuItem::with_id(app, "nav.back", t("后退", "Back"), true, None::<&str>)?;
    let nav_forward = MenuItem::with_id(app, "nav.forward", t("前进", "Forward"), true, None::<&str>)?;
    let navigate = Submenu::with_items(
        app,
        &t("导航", "Navigate"),
        true,
        &[&search_everywhere, &recent_files, &PredefinedMenuItem::separator(app)?, &goto_definition, &PredefinedMenuItem::separator(app)?, &nav_back, &nav_forward],
    )?;
    menu.insert(&navigate, 4)?;

    let organize_imports = MenuItem::with_id(app, "code.organize-imports", t("整理 Imports", "Optimize Imports"), true, Some("Ctrl+Alt+O"))?;
    let reformat = MenuItem::with_id(app, "code.format", t("重新格式化代码", "Reformat Code"), true, None::<&str>)?;
    let quick_fix = MenuItem::with_id(app, "code.quick-fix", t("快速修复", "Quick Fix"), true, None::<&str>)?;
    let code = Submenu::with_items(
        app,
        &t("代码", "Code"),
        true,
        &[&organize_imports, &reformat, &quick_fix],
    )?;
    menu.insert(&code, 5)?;

    let rename = MenuItem::with_id(app, "refactor.rename", t("重命名", "Rename"), true, Some("Shift+F6"))?;
    let refactor = Submenu::with_items(app, &t("重构", "Refactor"), true, &[&rename])?;
    menu.insert(&refactor, 6)?;

    let run = MenuItem::with_id(app, "run.run", t("运行", "Run"), true, None::<&str>)?;
    let debug = MenuItem::with_id(app, "run.debug", t("调试", "Debug"), true, None::<&str>)?;
    let coverage = MenuItem::with_id(app, "run.coverage", t("覆盖率运行", "Run with Coverage"), true, None::<&str>)?;
    let build = MenuItem::with_id(app, "run.build", t("构建项目", "Build Project"), true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "run.stop", t("停止", "Stop"), true, None::<&str>)?;
    let run_configs = MenuItem::with_id(app, "run.configs", t("运行配置…", "Run Configurations…"), true, None::<&str>)?;
    let run_menu = Submenu::with_items(
        app,
        &t("运行", "Run"),
        true,
        &[&run, &debug, &PredefinedMenuItem::separator(app)?, &coverage, &build, &stop, &PredefinedMenuItem::separator(app)?, &run_configs],
    )?;
    menu.insert(&run_menu, 7)?;

    let go_mod_tidy = MenuItem::with_id(app, "tools.go-mod-tidy", t("Go Mod Tidy", "Go Mod Tidy"), true, None::<&str>)?;
    let restart_gopls = MenuItem::with_id(app, "tools.restart-gopls", t("重启 gopls", "Restart gopls"), true, None::<&str>)?;
    let tools = Submenu::with_items(app, &t("工具", "Tools"), true, &[&go_mod_tidy, &restart_gopls])?;
    menu.insert(&tools, 8)?;

    let git_window = MenuItem::with_id(app, "vcs.tool-window", t("Git 工具窗口", "Git Tool Window"), true, None::<&str>)?;
    let vcs_commit = MenuItem::with_id(app, "vcs.commit", t("提交…", "Commit…"), true, None::<&str>)?;
    let vcs_update = MenuItem::with_id(app, "vcs.update", t("更新项目", "Update Project"), true, Some("CmdOrCtrl+T"))?;
    let vcs_fetch = MenuItem::with_id(app, "vcs.fetch", t("拉取 Fetch", "Fetch"), true, None::<&str>)?;
    let vcs_push = MenuItem::with_id(app, "vcs.push", t("推送 Push", "Push All"), true, None::<&str>)?;
    let vcs = Submenu::with_items(
        app,
        "VCS",
        true,
        &[&git_window, &vcs_commit, &PredefinedMenuItem::separator(app)?, &vcs_update, &vcs_fetch, &vcs_push],
    )?;
    menu.insert(&vcs, 9)?;

    #[cfg(target_os = "macos")]
    {
        let minimize = PredefinedMenuItem::minimize(app, None)?;
        let maximize = PredefinedMenuItem::maximize(app, None)?;
        let window = Submenu::with_items(app, &t("窗口", "Window"), true, &[&minimize, &maximize])?;
        menu.insert(&window, 10)?;
    }

    let help_shortcuts = MenuItem::with_id(app, "help.shortcuts", t("快捷键", "Keyboard Shortcuts"), true, None::<&str>)?;
    let help = Submenu::with_items(app, &t("帮助", "Help"), true, &[&help_shortcuts])?;
    // GoLand puts 帮助/Help last, after 窗口/Window.
    menu.append(&help)?;

    app.set_menu(menu)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn set_menu_locale(app: AppHandle, locale: String) -> BackendResult<()> {
    if let Ok(mut current) = lock(menu_locale()) {
        *current = locale;
    }
    rebuild_app_menu(&app).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn set_recent_projects(app: AppHandle, projects: Vec<RecentProject>) -> BackendResult<()> {
    if let Ok(mut current) = lock(recent_projects()) {
        *current = projects;
    }
    rebuild_app_menu(&app).map_err(|error| error.to_string())
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
