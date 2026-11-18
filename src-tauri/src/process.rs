use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::dto::ToolVersions;
use crate::state::{lock, AppState, BackendResult};
use tauri::{State, WebviewWindow};

pub(crate) fn augmented_path() -> std::ffi::OsString {
    let current = env::var_os("PATH").unwrap_or_default();
    let mut dirs = env::split_paths(&current).collect::<Vec<_>>();
    for fixed in [
        "/opt/homebrew/bin",
        "/usr/local/go/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    ] {
        dirs.push(PathBuf::from(fixed));
    }
    if let Some(gobin) = env::var_os("GOBIN") {
        dirs.push(PathBuf::from(gobin));
    }
    if let Some(gopath) = env::var_os("GOPATH") {
        for path in env::split_paths(&gopath) {
            dirs.push(path.join("bin"));
        }
    }
    if let Some(home) = env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join("go").join("bin"));
    }
    env::join_paths(dirs).unwrap_or(current)
}

pub(crate) fn resolve_executable(name: &str) -> PathBuf {
    let mut dirs = env::split_paths(&augmented_path()).collect::<Vec<_>>();
    if name == "gopls" {
        // `go env -w` can set GOBIN/GOPATH without exporting shell variables.
        if let Ok(output) = Command::new(resolve_executable("go"))
            .args(["env", "GOBIN", "GOPATH"])
            .env("PATH", augmented_path())
            .output()
        {
            if output.status.success() {
                let values = String::from_utf8_lossy(&output.stdout);
                let mut lines = values.lines();
                if let Some(gobin) = lines.next().filter(|value| !value.is_empty()) {
                    dirs.push(PathBuf::from(gobin));
                }
                if let Some(gopath) = lines.next() {
                    for path in env::split_paths(gopath) {
                        dirs.push(path.join("bin"));
                    }
                }
            }
        }
    }
    for dir in dirs {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return candidate;
        }
        #[cfg(windows)]
        {
            let candidate = dir.join(format!("{name}.exe"));
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from(name)
}

pub(crate) fn command_for(name: &str) -> Command {
    let mut command = Command::new(resolve_executable(name));
    command.env("PATH", augmented_path());
    command
}

pub(crate) fn apply_go_toolchain(command: &mut Command, state: &AppState) -> BackendResult<()> {
    if let Some(version) = lock(&state.core.go_toolchain)?.as_ref() {
        command.env("GOTOOLCHAIN", version);
    }
    Ok(())
}

pub(crate) fn go_toolchain(state: &AppState) -> BackendResult<Option<String>> {
    Ok(lock(&state.core.go_toolchain)?.clone())
}

#[tauri::command(async)]
pub(crate) fn set_go_toolchain(
    version: Option<String>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<String> {
    let state = state.for_window(&window)?;
    let version = version.filter(|value| !value.is_empty());
    if let Some(value) = &version {
        let valid = value.starts_with("go1.")
            && value[4..].split('.').count() == 2
            && value[4..].split('.').all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()));
        if !valid { return Err("Enter a full Go release such as go1.26.3".into()); }
    }
    // Go 1.21+ downloads and verifies a selected toolchain automatically.
    // Resolve it before changing the window, so a failed download leaves the
    // previous toolchain active.
    let mut command = command_for("go");
    if let Some(value) = &version { command.env("GOTOOLCHAIN", value); }
    let output = command.arg("version").output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    *lock(&state.core.go_toolchain)? = version;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(crate) fn version(program: &str, args: &[&str]) -> Option<String> {
    let output = command_for(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
}

/// Locate a helper binary: the copy bundled into the app resources first,
/// then whatever is on the user's PATH (via GOBIN/GOPATH lookups).
pub(crate) fn resolve_bundled(app: &tauri::AppHandle, name: &str) -> Option<PathBuf> {
    use tauri::Manager;
    if let Ok(resource_dir) = app.path().resource_dir() {
        let dir = resource_dir.join("binaries");
        let candidates = [name.to_string(), format!("{name}.exe")];
        for candidate in candidates {
            let bundled = dir.join(candidate);
            if bundled.is_file() {
                return Some(bundled);
            }
        }
    }
    let from_path = resolve_executable(name);
    (from_path != PathBuf::from(name)).then_some(from_path)
}

fn version_at(path: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new(path)
        .args(args)
        .env("PATH", augmented_path())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
}

#[tauri::command(async)]
pub(crate) fn tool_versions(app: tauri::AppHandle, window: WebviewWindow, state: State<'_, AppState>) -> ToolVersions {
    let window_state = state.for_window(&window).ok();
    // Prefer app-bundled binaries so gopls and the debugger work out of the
    // box; a user-installed copy is the fallback when no bundle exists.
    let dlv_version = resolve_bundled(&app, "dlv")
        .and_then(|path| version_at(&path, &["version"]))
        .or_else(|| version("dlv", &["version"]));
    let gopls_version = resolve_bundled(&app, "gopls")
        .and_then(|path| version_at(&path, &["version"]))
        .or_else(|| version("gopls", &["version"]));
    ToolVersions {
        go: window_state.as_ref().and_then(|state| {
            let mut command = command_for("go");
            apply_go_toolchain(&mut command, state).ok()?;
            let output = command.arg("version").output().ok()?;
            output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        }),
        gopls: gopls_version,
        git: version("git", &["--version"]),
        dlv: dlv_version,
        govulncheck: version("govulncheck", &["-version"]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_go_toolchains_are_isolated_by_window() {
        let app = AppState::default();
        let first = app.for_label("first").unwrap();
        let second = app.for_label("second").unwrap();
        *lock(&first.core.go_toolchain).unwrap() = Some("go1.25.4".into());
        *lock(&second.core.go_toolchain).unwrap() = Some("go1.26.3".into());
        let mut first_command = command_for("go");
        let mut second_command = command_for("go");
        apply_go_toolchain(&mut first_command, &first).unwrap();
        apply_go_toolchain(&mut second_command, &second).unwrap();
        let selected = |command: &Command| command.get_envs()
            .find(|(name, _)| *name == "GOTOOLCHAIN")
            .and_then(|(_, value)| value)
            .map(|value| value.to_string_lossy().to_string());
        assert_eq!(selected(&first_command).as_deref(), Some("go1.25.4"));
        assert_eq!(selected(&second_command).as_deref(), Some("go1.26.3"));
    }
}
