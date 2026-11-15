use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::dto::ToolVersions;

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
        let bundled = resource_dir.join("binaries").join(name);
        if bundled.is_file() {
            return Some(bundled);
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
pub(crate) fn tool_versions(app: tauri::AppHandle) -> ToolVersions {
    // Prefer app-bundled binaries so gopls and the debugger work out of the
    // box; a user-installed copy is the fallback when no bundle exists.
    let dlv_version = resolve_bundled(&app, "dlv")
        .and_then(|path| version_at(&path, &["version"]))
        .or_else(|| version("dlv", &["version"]));
    let gopls_version = resolve_bundled(&app, "gopls")
        .and_then(|path| version_at(&path, &["version"]))
        .or_else(|| version("gopls", &["version"]));
    ToolVersions {
        go: version("go", &["version"]),
        gopls: gopls_version,
        git: version("git", &["--version"]),
        dlv: dlv_version,
        govulncheck: version("govulncheck", &["-version"]),
    }
}
