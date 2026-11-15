use std::fs;
use std::path::{Path, PathBuf};

use crate::state::{lock, AppState, BackendResult};


pub(crate) fn workspace(state: &AppState) -> BackendResult<PathBuf> {
    lock(&state.core.workspace)?
        .clone()
        .ok_or_else(|| "Open a workspace before using project commands".to_string())
}

pub(crate) fn candidate_path(root: &Path, path: &str) -> PathBuf {
    let path = Path::new(path);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    }
}

pub(crate) fn checked_existing(state: &AppState, path: &str) -> BackendResult<PathBuf> {
    let root = workspace(state)?;
    let canonical = fs::canonicalize(candidate_path(&root, path)).map_err(|e| e.to_string())?;
    if !canonical.starts_with(&root) {
        return Err("Path is outside the open workspace".to_string());
    }
    Ok(canonical)
}

// Rename/delete act on the directory entry itself. Validating its canonical
// parent prevents escapes while allowing safe removal of dangling symlinks.
pub(crate) fn checked_entry(state: &AppState, path: &str) -> BackendResult<PathBuf> {
    let root = workspace(state)?;
    let candidate = candidate_path(&root, path);
    let name = candidate
        .file_name()
        .ok_or("Expected a file or directory name")?;
    if name == std::ffi::OsStr::new(".") || name == std::ffi::OsStr::new("..") {
        return Err("Expected a file or directory name".to_string());
    }
    let parent = candidate.parent().ok_or("Expected a parent directory")?;
    let parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if !parent.starts_with(&root) {
        return Err("Path is outside the open workspace".to_string());
    }
    let entry = parent.join(name);
    fs::symlink_metadata(&entry).map_err(|e| e.to_string())?;
    Ok(entry)
}

pub(crate) fn checked_directory(state: &AppState, path: &str) -> BackendResult<PathBuf> {
    let canonical = checked_existing(state, path)?;
    if !canonical.is_dir() {
        return Err("Expected a directory".to_string());
    }
    Ok(canonical)
}

pub(crate) fn checked_new(state: &AppState, path: &str) -> BackendResult<PathBuf> {
    let root = workspace(state)?;
    let candidate = candidate_path(&root, path);
    let name = candidate
        .file_name()
        .ok_or_else(|| "Expected a file or directory name".to_string())?;
    if name == std::ffi::OsStr::new(".") || name == std::ffi::OsStr::new("..") {
        return Err("Expected a file or directory name".to_string());
    }
    let parent = candidate
        .parent()
        .ok_or_else(|| "Expected a parent directory".to_string())?;
    let parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if !parent.starts_with(&root) || !parent.is_dir() {
        return Err("Path is outside the open workspace".to_string());
    }
    Ok(parent.join(name))
}

pub(crate) fn checked_writable(state: &AppState, path: &str) -> BackendResult<PathBuf> {
    let root = workspace(state)?;
    let candidate = candidate_path(&root, path);
    if fs::symlink_metadata(&candidate).is_ok() {
        checked_existing(state, path)
    } else {
        checked_new(state, path)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;

    #[cfg(unix)]
    #[test]
    fn workspace_paths_reject_symlink_escapes() {
        use std::os::unix::fs::symlink;
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = env::temp_dir().join(format!("mgland-path-test-{}-{nonce}", std::process::id()));
        let root = base.join("project");
        let outside = base.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.go"), "package outside").unwrap();
        symlink(outside.join("secret.go"), root.join("link.go")).unwrap();
        symlink(&outside, root.join("escape")).unwrap();

        let state = AppState::default();
        *lock(&state.core.workspace).unwrap() = Some(fs::canonicalize(&root).unwrap());
        assert!(checked_existing(&state, "link.go").is_err());
        assert!(checked_new(&state, "escape/new.go").is_err());
        // Removing the link itself is safe, even though reading its target is not.
        assert_eq!(
            checked_entry(&state, "link.go").unwrap(),
            fs::canonicalize(&root).unwrap().join("link.go")
        );

        fs::remove_dir_all(base).unwrap();
    }

}
