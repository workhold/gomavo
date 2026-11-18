use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{State, WebviewWindow};

use crate::paths::{candidate_path, workspace};
use crate::process::command_for;
use crate::state::{AppState, BackendResult};

fn go_json(root: &Path, args: &[&str], file: Option<&Path>, state: &AppState) -> BackendResult<Value> {
    let mut command = command_for("go");
    crate::process::apply_go_toolchain(&mut command, state)?;
    command
        .current_dir(root)
        .env("GOPROXY", "off")
        .args(args);
    if let Some(file) = file {
        command.arg(file);
    }
    let output = command
        .output()
        .map_err(|e| format!("Could not query Go project metadata: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Could not query Go project metadata: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
}

fn local_replace_path(path: &str) -> bool {
    Path::new(path).is_absolute()
        || path.starts_with("./")
        || path.starts_with("../")
        || path.starts_with(".\\")
        || path.starts_with("..\\")
}

fn local_module_dir(base: &Path, path: &str) -> Option<PathBuf> {
    let candidate = candidate_path(base, path);
    let directory = fs::canonicalize(candidate).ok()?;
    (directory.is_dir() && directory.join("go.mod").is_file()).then_some(directory)
}

fn add_local_replacements(config: &Value, base: &Path, roots: &mut Vec<PathBuf>) {
    if let Some(replacements) = config.get("Replace").and_then(Value::as_array) {
        for replacement in replacements {
            let new = &replacement["New"];
            if new.get("Version").and_then(Value::as_str).is_some() {
                continue; // A module-version replacement lives in GOMODCACHE.
            }
            if let Some(path) = new.get("Path").and_then(Value::as_str) {
                if local_replace_path(path) {
                    if let Some(directory) = local_module_dir(base, path) {
                        roots.push(directory);
                    }
                }
            }
        }
    }
}

fn go_source_roots(workspace_root: &Path, state: &AppState) -> BackendResult<Vec<PathBuf>> {
    // Go resolves GOMOD and GOWORK from the active project directory. Reading
    // their JSON through the Go tool avoids guessing where a replace/use points.
    let values = go_json(
        workspace_root,
        &["env", "-json", "GOROOT", "GOMODCACHE", "GOMOD", "GOWORK"],
        None,
        state,
    )?;
    let mut roots = ["GOROOT", "GOMODCACHE"]
        .into_iter()
        .filter_map(|name| values.get(name).and_then(Value::as_str))
        .filter(|path| !path.is_empty())
        .filter_map(|path| fs::canonicalize(candidate_path(workspace_root, path)).ok())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();

    let mut module_files = Vec::new();
    if let Some(go_mod) = values.get("GOMOD").and_then(Value::as_str) {
        let go_mod = candidate_path(workspace_root, go_mod);
        if go_mod.file_name() == Some(std::ffi::OsStr::new("go.mod")) && go_mod.is_file() {
            module_files.push(go_mod);
        }
    }
    if let Some(go_work) = values
        .get("GOWORK")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty() && *path != "off")
    {
        let go_work = candidate_path(workspace_root, go_work);
        if go_work.is_file() {
            if let Ok(config) = go_json(workspace_root, &["work", "edit", "-json"], Some(&go_work), state)
            {
                if let Some(base) = go_work.parent() {
                    if let Some(uses) = config
                        .get("Use")
                        .or_else(|| config.get("Directory"))
                        .and_then(Value::as_array)
                    {
                        for use_entry in uses {
                            let disk_path = use_entry
                                .get("DiskPath")
                                .or_else(|| use_entry.get("Path"))
                                .and_then(Value::as_str);
                            if let Some(directory) =
                                disk_path.and_then(|path| local_module_dir(base, path))
                            {
                                module_files.push(directory.join("go.mod"));
                            }
                        }
                    }
                    add_local_replacements(&config, base, &mut roots);
                }
            }
        }
    }
    module_files.sort();
    module_files.dedup();
    for go_mod in module_files {
        if let Some(base) = go_mod.parent() {
            if let Ok(config) = go_json(workspace_root, &["mod", "edit", "-json"], Some(&go_mod), state) {
                if let Some(directory) = local_module_dir(base, ".") {
                    roots.push(directory);
                }
                add_local_replacements(&config, base, &mut roots);
            }
        }
    }
    roots.sort();
    roots.dedup();
    Ok(roots)
}

fn checked_go_source(path: &Path, roots: &[PathBuf]) -> BackendResult<PathBuf> {
    if path.extension().is_none_or(|extension| extension != "go") {
        return Err("Only Go source files can be read outside the workspace".to_string());
    }
    let canonical = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !canonical.is_file()
        || canonical
            .extension()
            .is_none_or(|extension| extension != "go")
    {
        return Err("Expected a Go source file".to_string());
    }
    let allowed = roots.iter().any(|root| {
        fs::canonicalize(root).is_ok_and(|canonical_root| {
            canonical_root.is_dir() && canonical.starts_with(canonical_root)
        })
    });
    if !allowed {
        return Err(
            "Go source path is outside the SDK, module cache, and configured local modules"
                .to_string(),
        );
    }
    Ok(canonical)
}

#[tauri::command(async)]
pub(crate) fn read_go_source(
    path: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<String> {
    let state = state.for_window(&window)?;
    let roots = go_source_roots(&workspace(&state)?, &state)?;
    fs::read_to_string(checked_go_source(Path::new(&path), &roots)?).map_err(|e| e.to_string())
}

/// The workspace module closure (`go list -m all`), for the External Libraries tree.
#[tauri::command(async)]
pub(crate) fn go_modules(window: WebviewWindow, state: State<'_, AppState>) -> BackendResult<Vec<String>> {
    let state = state.for_window(&window)?;
    let root = workspace(&state)?;
    let mut command = command_for("go");
    crate::process::apply_go_toolchain(&mut command, &state)?;
    command
        .current_dir(&root)
        .env("GOPROXY", "off")
        .args(["list", "-m", "all"]);
    let output = command
        .output()
        .map_err(|e| format!("Could not list Go modules: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Could not list Go modules: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::to_string)
        .collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;

    #[test]
    fn go_source_reader_accepts_only_go_files_in_go_roots() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = env::temp_dir().join(format!(
            "gomavo-go-source-test-{}-{nonce}",
            std::process::id()
        ));
        let goroot = base.join("goroot");
        let modcache = base.join("modcache");
        let outside = base.join("outside");
        fs::create_dir_all(&goroot).unwrap();
        fs::create_dir_all(&modcache).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(goroot.join("strings.go"), "package strings\n").unwrap();
        fs::write(modcache.join("module.go"), "package module\n").unwrap();
        fs::write(outside.join("secret.go"), "package secret\n").unwrap();
        fs::write(goroot.join("notes.txt"), "private notes\n").unwrap();
        let roots = vec![goroot.clone(), modcache.clone()];

        assert!(checked_go_source(&goroot.join("strings.go"), &roots).is_ok());
        assert!(checked_go_source(&modcache.join("module.go"), &roots).is_ok());
        assert!(checked_go_source(&outside.join("secret.go"), &roots).is_err());
        assert!(checked_go_source(&goroot.join("notes.txt"), &roots).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(outside.join("secret.go"), goroot.join("escape.go")).unwrap();
            assert!(checked_go_source(&goroot.join("escape.go"), &roots).is_err());
        }

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn go_source_roots_follow_local_replace_and_go_work_modules() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base =
            env::temp_dir().join(format!("gomavo-go-modules-{}-{nonce}", std::process::id()));
        let project = base.join("project");
        let replacement = base.join("replacement");
        let workspace_module = base.join("workspace-module");
        let work_replacement = base.join("work-replacement");
        let unrelated = base.join("unrelated");
        for directory in [
            &project,
            &replacement,
            &workspace_module,
            &work_replacement,
            &unrelated,
        ] {
            fs::create_dir_all(directory).unwrap();
            fs::write(directory.join("source.go"), "package sample\n").unwrap();
        }
        fs::write(project.join("go.mod"), "module example.com/project\n\ngo 1.23\n\nrequire example.com/replacement v0.0.0\nreplace example.com/replacement => ../replacement\n").unwrap();
        fs::write(
            replacement.join("go.mod"),
            "module example.com/replacement\n\ngo 1.23\n",
        )
        .unwrap();
        fs::write(
            workspace_module.join("go.mod"),
            "module example.com/workspace\n\ngo 1.23\n",
        )
        .unwrap();
        fs::write(
            work_replacement.join("go.mod"),
            "module example.com/work-replacement\n\ngo 1.23\n",
        )
        .unwrap();
        fs::write(
            unrelated.join("go.mod"),
            "module example.com/unrelated\n\ngo 1.23\n",
        )
        .unwrap();
        fs::write(base.join("go.work"), "go 1.23\n\nuse ./project\nuse ./workspace-module\n\nreplace example.com/unused => ./work-replacement\n").unwrap();

        let roots = go_source_roots(&project, &AppState::default()).unwrap();
        for directory in [&project, &replacement, &workspace_module, &work_replacement] {
            assert!(
                checked_go_source(&directory.join("source.go"), &roots).is_ok(),
                "expected {} to be allowed",
                directory.display()
            );
        }
        assert!(checked_go_source(&unrelated.join("source.go"), &roots).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(unrelated.join("source.go"), replacement.join("escape.go")).unwrap();
            assert!(checked_go_source(&replacement.join("escape.go"), &roots).is_err());
        }

        fs::remove_dir_all(base).unwrap();
    }

}
