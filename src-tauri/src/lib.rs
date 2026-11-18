mod debug;
mod dto;
mod files;
mod git;
mod go_source;
mod go_tasks;
mod lsp;
mod native_plugins;
mod paths;
mod process;
mod project_windows;
mod runner;
mod search;
mod session;
mod state;
mod terminal;
mod watch;

use tauri::Manager;

use crate::state::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Focused(true) => {
                project_windows::note_focused_window(window.label());
            }
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                session::note_geometry(window);
            }
            tauri::WindowEvent::Destroyed => {
                window
                    .app_handle()
                    .state::<AppState>()
                    .close_window(window.label());
                project_windows::forget_window(window.label());
                session::window_destroyed(window.app_handle(), window.label());
            }
            _ => {}
        })
        .setup(|app| {
            project_windows::install_app_menu(app.handle())?;
            #[cfg(target_os = "macos")]
            project_windows::install_dock_menu(app.handle());
            session::restore(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            project_windows::startup_intent,
            project_windows::open_project_window,
            project_windows::open_new_project_window,
            project_windows::open_empty_project_window,
            project_windows::create_go_project,
            project_windows::set_menu_locale,
            project_windows::set_recent_projects,
            session::quit_cancelled,
            files::open_workspace,
            files::list_directory,
            files::list_project_files,
            files::read_file,
            files::read_binary_preview,
            go_source::read_go_source,
            go_source::go_modules,
            files::write_file,
            files::create_file,
            files::create_file_with_content,
            files::create_directory,
            files::rename_path,
            files::delete_path,
            git::git_status,
            git::git_branches,
            git::git_checkout_branch,
            git::git_create_branch,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_log,
            git::git_file_history,
            git::git_file_commit_diff,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            git::git_merge,
            git::git_abort_merge,
            git::git_stash_push,
            git::git_stash_list,
            git::git_stash_pop,
            git::git_stash_drop,
            git::git_blame,
            git::git_log_graph,
            process::tool_versions,
            process::set_go_toolchain,
            runner::run_go_task,
            runner::task_cancel,
            search::search_in_files,
            search::replace_in_files,
            watch::watch_start,
            watch::watch_stop,
            debug::debug_start,
            debug::debug_send,
            debug::debug_stop,
            terminal::terminal_start,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            lsp::lsp_start,
            lsp::lsp_health,
            lsp::lsp_send,
            lsp::lsp_stop,
            native_plugins::list_native_plugins,
            native_plugins::install_native_plugin,
            native_plugins::set_native_plugin_enabled,
            native_plugins::remove_native_plugin,
            native_plugins::read_native_plugin_code,
        ])
        .build(tauri::generate_context!())
        .expect("Failed to build GoMavo")
        .run(|app, event| match event {
            // Quitting windows must stay in the session file; window teardown
            // that happens after this point is app shutdown, not a user close.
            tauri::RunEvent::ExitRequested { .. } => session::mark_quitting(),
            tauri::RunEvent::Exit => {
                app.state::<AppState>().shutdown_all();
            }
            _ => {}
        });
}
