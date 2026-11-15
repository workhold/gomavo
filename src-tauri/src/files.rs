use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::process::Stdio;
use std::thread;
use std::path::Path;
use tauri::{State, WebviewWindow};

use crate::dto::{BinaryPreview, FileEntry};
use crate::git::git_command_base;
use crate::paths::{checked_directory, checked_entry, checked_existing, checked_new, checked_writable, workspace};
use crate::project_windows;
use crate::state::{lock, AppState, BackendResult};

#[tauri::command(async)]
pub(crate) fn open_workspace(
    root: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<String> {
    let state = state.for_window(&window)?;
    let canonical = fs::canonicalize(&root).map_err(|e| e.to_string())?;
    if !canonical.is_dir() {
        return Err("Workspace must be a directory".to_string());
    }
    let mut active = lock(&state.core.workspace)?;
    if active.as_ref() != Some(&canonical) {
        state.core.shutdown();
        *active = Some(canonical.clone());
    }
    drop(active);
    project_windows::set_window_workspace(window.label(), &canonical)?;
    let name = canonical.file_name().unwrap_or(canonical.as_os_str());
    let _ = window.set_title(&format!("{} — MG Land", name.to_string_lossy()));
    Ok(canonical.to_string_lossy().into_owned())
}

#[tauri::command(async)]
pub(crate) fn list_directory(
    path: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<Vec<FileEntry>> {
    let state = state.for_window(&window)?;
    let directory = checked_directory(&state, &path)?;
    let mut entries = fs::read_dir(&directory)
        .map_err(|e| e.to_string())?
        .map(|entry| {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let is_dir = entry
                .metadata()
                .map(|metadata| metadata.is_dir())
                .unwrap_or(false);
            Ok(FileEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                is_dir,
                ignored: false,
            })
        })
        .collect::<BackendResult<Vec<_>>>()?;
    entries.retain(|entry| visible_project_entry(&entry.name));
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    mark_git_ignored(&directory, &mut entries);
    Ok(entries)
}

// Check a whole directory listing in one Git process. Git applies nested
// .gitignore files, global excludes, and its index, so tracked files remain
// visible even when a pattern also matches them.
fn mark_git_ignored(directory: &Path, entries: &mut [FileEntry]) {
    if entries.is_empty() {
        return;
    }
    let mut input = Vec::new();
    for entry in entries.iter() {
        let Ok(relative) = Path::new(&entry.path).strip_prefix(directory) else {
            return;
        };
        input.extend_from_slice(relative.to_string_lossy().as_bytes());
        input.push(0);
    }
    // check-ignore does not support Git's global --literal-pathspecs option.
    let Ok(mut child) = git_command_base(directory)
        .args(["check-ignore", "--stdin", "-z"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    let Some(mut stdin) = child.stdin.take() else {
        return;
    };
    // Drain output while writing to avoid a pipe deadlock with large folders.
    let writer = thread::spawn(move || stdin.write_all(&input));
    let output = child.wait_with_output();
    let _ = writer.join();
    let Ok(output) = output else {
        return;
    };
    // Exit 1 means there were no matches. Other failures (including a
    // non-Git folder) simply leave the tree with normal colors.
    if !output.status.success() && output.status.code() != Some(1) {
        return;
    }
    let ignored = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .collect::<HashSet<_>>();
    for entry in entries {
        let Ok(relative) = Path::new(&entry.path).strip_prefix(directory) else {
            continue;
        };
        entry.ignored = ignored.contains(relative.to_string_lossy().as_ref());
    }
}

fn visible_project_entry(name: &str) -> bool {
    !matches!(name, ".git" | "node_modules" | "target")
}

#[tauri::command(async)]
pub(crate) fn list_project_files(
    root: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<Vec<FileEntry>> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    Ok(list_project_files_for_root(&root, 10_000))
}

pub(crate) fn list_project_files_for_root(root: &Path, limit: usize) -> Vec<FileEntry> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut examined = 0;
    while let Some(directory) = stack.pop() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            examined += 1;
            if examined > 100_000 || files.len() >= limit {
                break;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if !visible_project_entry(&name) {
                continue;
            }
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                // Avoid loops through linked directories; only index linked files
                // whose resolved target remains inside this workspace.
                if !fs::canonicalize(&path)
                    .is_ok_and(|resolved| resolved.starts_with(root) && resolved.is_file())
                {
                    continue;
                }
            } else if metadata.is_dir() {
                stack.push(path);
                continue;
            } else if !metadata.is_file() {
                continue;
            }
            files.push(FileEntry {
                name,
                path: path.to_string_lossy().into_owned(),
                is_dir: false,
                ignored: false,
            });
        }
        if examined > 100_000 || files.len() >= limit {
            break;
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    mark_git_ignored(root, &mut files);
    files
}

#[tauri::command(async)]
pub(crate) fn read_file(
    path: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<String> {
    let state = state.for_window(&window)?;
    fs::read_to_string(checked_existing(&state, &path)?).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub(crate) fn read_binary_preview(
    path: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<BinaryPreview> {
    let state = state.for_window(&window)?;
    const PREVIEW_LIMIT: usize = 16 * 1024;
    let file = fs::File::open(checked_existing(&state, &path)?).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let mut bytes = Vec::with_capacity(PREVIEW_LIMIT);
    file.take(PREVIEW_LIMIT as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(BinaryPreview {
        size,
        truncated: size > bytes.len() as u64,
        bytes,
    })
}

#[tauri::command(async)]
pub(crate) fn write_file(
    path: String,
    content: String,
    expected_content: Option<String>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<()> {
    let state = state.for_window(&window)?;
    write_file_checked(&state, &path, &content, expected_content.as_deref())
}

fn write_file_checked(
    state: &AppState,
    path: &str,
    content: &str,
    expected_content: Option<&str>,
) -> BackendResult<()> {
    let path = checked_writable(state, path)?;
    if let Some(expected) = expected_content {
        let on_disk = fs::read_to_string(&path).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                "Save conflict: File no longer exists on disk".to_string()
            } else {
                error.to_string()
            }
        })?;
        if on_disk != expected {
            return Err("Save conflict: File changed on disk. Reload before saving".to_string());
        }
    }
    fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub(crate) fn create_file(
    path: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<()> {
    let state = state.for_window(&window)?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(checked_new(&state, &path)?)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub(crate) fn create_file_with_content(
    path: String,
    content: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<()> {
    let state = state.for_window(&window)?;
    create_file_with_content_checked(&state, &path, &content)
}

fn create_file_with_content_checked(
    state: &AppState,
    path: &str,
    content: &str,
) -> BackendResult<()> {
    let path = checked_new(state, path)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    if let Err(error) = file.write_all(content.as_bytes()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command(async)]
pub(crate) fn create_directory(
    path: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<()> {
    let state = state.for_window(&window)?;
    fs::create_dir(checked_new(&state, &path)?).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub(crate) fn rename_path(
    from: String,
    to: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<()> {
    let state = state.for_window(&window)?;
    let source = checked_entry(&state, &from)?;
    if source == workspace(&state)? {
        return Err("Cannot rename the open workspace".to_string());
    }
    let destination = checked_new(&state, &to)?;
    if fs::symlink_metadata(&destination).is_ok() {
        return Err("Destination already exists".to_string());
    }
    fs::rename(source, destination).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub(crate) fn delete_path(
    path: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<()> {
    let state = state.for_window(&window)?;
    let target = checked_entry(&state, &path)?;
    if target == workspace(&state)? {
        return Err("Cannot delete the open workspace".to_string());
    }
    let metadata = fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        fs::remove_dir_all(target).map_err(|e| e.to_string())
    } else {
        fs::remove_file(target).map_err(|e| e.to_string())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;
    use crate::git::{git_output, git_result};
    use crate::process::command_for;

    #[test]
    fn write_file_detects_external_edits_and_keeps_legacy_writes() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = env::temp_dir().join(format!("mgland-save-test-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("main.go");
        fs::write(&file, "initial").unwrap();
        let state = AppState::default();
        *lock(&state.core.workspace).unwrap() = Some(fs::canonicalize(&root).unwrap());

        write_file_checked(&state, "main.go", "editor", Some("initial")).unwrap();
        fs::write(&file, "external").unwrap();
        let conflict = write_file_checked(&state, "main.go", "stale", Some("editor")).unwrap_err();
        assert!(conflict.starts_with("Save conflict:"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "external");

        write_file_checked(&state, "main.go", "forced", None).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "forced");
        fs::remove_file(&file).unwrap();
        let conflict = write_file_checked(&state, "main.go", "stale", Some("forced")).unwrap_err();
        assert!(conflict.starts_with("Save conflict:"));
        assert!(!file.exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside = root.with_extension("outside.go");
            fs::write(&outside, "outside").unwrap();
            symlink(&outside, root.join("escape.go")).unwrap();
            assert!(write_file_checked(&state, "escape.go", "unsafe", None).is_err());
            assert_eq!(fs::read_to_string(&outside).unwrap(), "outside");
            fs::remove_file(outside).unwrap();
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_file_with_content_never_overwrites_an_existing_file() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            env::temp_dir().join(format!("mgland-create-test-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let state = AppState::default();
        *lock(&state.core.workspace).unwrap() = Some(fs::canonicalize(&root).unwrap());

        create_file_with_content_checked(&state, "main_test.go", "package main\n").unwrap();
        let file = root.join("main_test.go");
        assert_eq!(fs::read_to_string(&file).unwrap(), "package main\n");
        assert!(create_file_with_content_checked(&state, "main_test.go", "overwrite").is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "package main\n");

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside = root.with_extension("outside.go");
            fs::write(&outside, "outside").unwrap();
            symlink(&outside, root.join("link_test.go")).unwrap();
            assert!(create_file_with_content_checked(&state, "link_test.go", "unsafe").is_err());
            assert_eq!(fs::read_to_string(&outside).unwrap(), "outside");
            fs::remove_file(outside).unwrap();
        }

        fs::remove_dir_all(root).unwrap();
    }


    #[test]
    fn project_file_index_skips_metadata_and_external_links() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = env::temp_dir().join(format!("mgland-index-{}-{nonce}", std::process::id()));
        let root = base.join("project");
        for name in [".git", "node_modules", "target", "src"] {
            fs::create_dir_all(root.join(name)).unwrap();
            fs::write(root.join(name).join("hidden.go"), "package hidden\n").unwrap();
        }
        fs::write(root.join(".gitignore"), "target/\n").unwrap();
        fs::write(root.join("main.go"), "package main\n").unwrap();
        let root = fs::canonicalize(root).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside = base.join("outside.go");
            fs::write(&outside, "package outside\n").unwrap();
            symlink(outside, root.join("escape.go")).unwrap();
        }
        let files = list_project_files_for_root(&root, 10_000);
        let names = files
            .iter()
            .map(|file| file.name.as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"main.go"));
        assert!(names.contains(&".gitignore"));
        assert!(names.contains(&"hidden.go")); // src/hidden.go remains visible.
        assert_eq!(names.iter().filter(|name| **name == "hidden.go").count(), 1);
        assert!(!names.contains(&"escape.go"));
        assert!(list_project_files_for_root(&root, 2).len() <= 2);

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn ignored_entries_use_git_rules_without_dimming_tracked_files() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = env::temp_dir().join(format!("mgland-ignored-{}-{nonce}", std::process::id()));
        let root = base.join("project");
        let nested = root.join("src");
        fs::create_dir_all(root.join("cache")).unwrap();
        fs::create_dir_all(&nested).unwrap();
        fs::write(root.join(".gitignore"), "cache/\n*.tmp\n").unwrap();
        fs::write(nested.join(".gitignore"), "*.log\n").unwrap();
        fs::write(root.join("cache/data.bin"), "ignored").unwrap();
        fs::write(root.join("loose.tmp"), "ignored").unwrap();
        fs::write(root.join("tracked.tmp"), "tracked").unwrap();
        fs::write(nested.join("output.log"), "ignored").unwrap();
        fs::write(nested.join("normal.go"), "package main\n").unwrap();
        let root = fs::canonicalize(root).unwrap();
        assert!(command_for("git")
            .current_dir(&root)
            .args(["init", "-q"])
            .status()
            .unwrap()
            .success());
        git_result(git_output(&root, &["add", "-f", "--", "tracked.tmp"]).unwrap()).unwrap();

        let mut top = ["cache", "loose.tmp", "tracked.tmp", ".gitignore"].map(|name| FileEntry {
            name: name.to_string(),
            path: root.join(name).to_string_lossy().into_owned(),
            is_dir: name == "cache",
            ignored: false,
        });
        mark_git_ignored(&root, &mut top);
        assert_eq!(top.map(|entry| entry.ignored), [true, true, false, false]);

        let mut children = ["output.log", "normal.go"].map(|name| FileEntry {
            name: name.to_string(),
            path: nested.join(name).to_string_lossy().into_owned(),
            is_dir: false,
            ignored: false,
        });
        mark_git_ignored(&nested, &mut children);
        assert_eq!(children.map(|entry| entry.ignored), [true, false]);

        let indexed = list_project_files_for_root(&root, 10_000);
        assert!(indexed
            .iter()
            .any(|entry| entry.name == "data.bin" && entry.ignored));
        assert!(indexed
            .iter()
            .any(|entry| entry.name == "tracked.tmp" && !entry.ignored));

        let plain = base.join("plain");
        fs::create_dir_all(&plain).unwrap();
        let mut no_git = [FileEntry {
            name: "file.tmp".to_string(),
            path: plain.join("file.tmp").to_string_lossy().into_owned(),
            is_dir: false,
            ignored: false,
        }];
        mark_git_ignored(&plain, &mut no_git);
        assert!(!no_git[0].ignored);

        fs::remove_dir_all(base).unwrap();
    }
}
