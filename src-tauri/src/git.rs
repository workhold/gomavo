use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use tauri::{State, WebviewWindow};

use crate::dto::{
    GitBlameCommit, GitBlameLine, GitBlameResult, GitBranch, GitCommitResult, GitFileHistoryEntry,
    GitFileStatus, GitGraphCommit, GitLogEntry, GitMergeResult, GitStashEntry, GitStatus,
};
use crate::process::command_for;
use crate::paths::{candidate_path, checked_directory, workspace};
use crate::state::{AppState, BackendResult};

pub(crate) fn git_command_base(root: &Path) -> Command {
    let mut command = command_for("git");
    command
        .current_dir(root)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_COMMON_DIR");
    command
}

fn git_command(root: &Path) -> Command {
    let mut command = git_command_base(root);
    command.arg("--literal-pathspecs");
    command
}

pub(crate) fn git_output(root: &Path, args: &[&str]) -> BackendResult<std::process::Output> {
    git_command(root)
        .args(args)
        .output()
        .map_err(|e| e.to_string())
}

fn git_path_output(root: &Path, args: &[&str], path: &Path) -> BackendResult<std::process::Output> {
    git_command(root)
        .args(args)
        .arg("--")
        .arg(path)
        .output()
        .map_err(|e| e.to_string())
}

pub(crate) fn git_result(output: std::process::Output) -> BackendResult<std::process::Output> {
    if output.status.success() {
        Ok(output)
    } else {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if message.is_empty() {
            "Git command failed".to_string()
        } else {
            message
        })
    }
}

fn git_repository_root(root: &Path) -> BackendResult<PathBuf> {
    let output = git_output(root, &["rev-parse", "--show-toplevel"])?;
    if !output.status.success() {
        return Err("Current folder is not a Git repository".to_string());
    }
    let top = String::from_utf8_lossy(&output.stdout)
        .trim_end_matches(['\r', '\n'])
        .to_string();
    let top = fs::canonicalize(top).map_err(|e| e.to_string())?;
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    if !root.starts_with(&top) {
        return Err("Git repository is outside the open workspace".to_string());
    }
    Ok(top)
}

fn checked_git_path(root: &Path, path: &str) -> BackendResult<PathBuf> {
    let input = Path::new(path);
    if input.components().any(|part| part == Component::ParentDir) {
        return Err("Git path must stay inside the open workspace".to_string());
    }
    let candidate = candidate_path(root, path);
    let relative = candidate
        .strip_prefix(root)
        .map_err(|_| "Git path must stay inside the open workspace".to_string())?;
    if relative.as_os_str().is_empty() {
        return Err("Expected a file path".to_string());
    }
    let mut parent = candidate.parent().ok_or("Expected a file path")?;
    loop {
        match fs::symlink_metadata(parent) {
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                parent = parent.parent().ok_or("Expected a file path")?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if !parent.starts_with(root) {
        return Err("Git path must stay inside the open workspace".to_string());
    }
    if let Ok(metadata) = fs::symlink_metadata(&candidate) {
        if metadata.is_dir() {
            return Err("Expected a file path".to_string());
        }
    }
    Ok(relative.to_path_buf())
}

#[tauri::command(async)]
pub(crate) fn git_status(
    root: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<GitStatus> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    git_status_for_root(&root)
}

fn git_status_for_root(root: &Path) -> BackendResult<GitStatus> {
    let _ = git_repository_root(root)?;
    let branch_output = git_output(root, &["branch", "--show-current"])?;
    let mut branch = String::from_utf8_lossy(&branch_output.stdout)
        .trim()
        .to_string();
    if branch.is_empty() {
        let detached = git_output(root, &["rev-parse", "--short", "HEAD"])?;
        if detached.status.success() {
            branch = format!(
                "detached {}",
                String::from_utf8_lossy(&detached.stdout).trim()
            );
        }
    }
    let prefix_output = git_output(root, &["rev-parse", "--show-prefix"])?;
    let prefix = String::from_utf8_lossy(&prefix_output.stdout)
        .trim_end_matches(['\r', '\n'])
        .to_string();
    let output = git_output(
        root,
        &[
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "-z",
            "--",
            ".",
        ],
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let mut records = output.stdout.split(|byte| *byte == 0);
    let mut files = Vec::new();
    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }
        let status = String::from_utf8_lossy(&record[..2]).into_owned();
        let staged = record[0] != b' ' && record[0] != b'?' && record[0] != b'!';
        let unstaged = record[1] != b' ' && record[1] != b'!';
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        let path = path.strip_prefix(&prefix).unwrap_or(&path).to_string();
        if record[0] == b'R' || record[1] == b'R' || record[0] == b'C' || record[1] == b'C' {
            let _ = records.next(); // The second -z path is the source of a rename/copy.
        }
        files.push(GitFileStatus {
            path,
            status,
            staged,
            unstaged,
        });
    }
    Ok(GitStatus { branch, files })
}

fn git_branch_repository(root: &Path, workspace_root: &Path) -> BackendResult<PathBuf> {
    let repository = git_repository_root(root)?;
    if !repository.starts_with(workspace_root) {
        return Err("Git repository root is outside the open workspace".to_string());
    }
    Ok(repository)
}

fn checked_git_branch_name(root: &Path, name: &str) -> BackendResult<()> {
    if name.is_empty() || name.starts_with('-') || name.chars().any(char::is_control) {
        return Err("Invalid Git branch name".to_string());
    }
    let checked = git_output(root, &["check-ref-format", "--branch", name])?;
    if !checked.status.success() {
        return Err("Invalid Git branch name".to_string());
    }
    let checked = String::from_utf8(checked.stdout)
        .map_err(|_| "Git branch name is not valid UTF-8".to_string())?;
    if checked.trim_end_matches(['\r', '\n']) != name {
        return Err("Git checkout shorthand is not a branch name".to_string());
    }
    Ok(())
}

#[tauri::command(async)]
pub(crate) fn git_branches(
    root: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<Vec<GitBranch>> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    let workspace_root = workspace(&state)?;
    git_branches_for_root(&root, &workspace_root)
}

fn git_branches_for_root(root: &Path, workspace_root: &Path) -> BackendResult<Vec<GitBranch>> {
    let _ = git_branch_repository(root, workspace_root)?;
    let current = git_result(git_output(root, &["branch", "--show-current"])?)?;
    let current = String::from_utf8(current.stdout)
        .map_err(|_| "Current Git branch name is not valid UTF-8".to_string())?;
    let current = current.trim_end_matches(['\r', '\n']);
    let listed = git_result(git_output(
        root,
        &["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"],
    )?)?;
    let listed = String::from_utf8(listed.stdout)
        .map_err(|_| "Git branch name is not valid UTF-8".to_string())?;
    let mut branches = listed
        .lines()
        .filter(|name| !name.is_empty())
        .map(|name| GitBranch {
            name: name.to_string(),
            current: name == current,
        })
        .collect::<Vec<_>>();
    // An unborn branch is named by HEAD but has no refs/heads entry yet.
    if !current.is_empty() && !branches.iter().any(|branch| branch.name == current) {
        branches.push(GitBranch {
            name: current.to_string(),
            current: true,
        });
    }
    branches.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(branches)
}

#[tauri::command(async)]
pub(crate) fn git_checkout_branch(
    root: String,
    name: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<GitStatus> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    let workspace_root = workspace(&state)?;
    git_checkout_branch_for_root(&root, &workspace_root, &name)
}

fn git_checkout_branch_for_root(
    root: &Path,
    workspace_root: &Path,
    name: &str,
) -> BackendResult<GitStatus> {
    let _ = git_branch_repository(root, workspace_root)?;
    checked_git_branch_name(root, name)?;
    let reference = format!("refs/heads/{name}");
    if !git_output(root, &["show-ref", "--verify", "--quiet", &reference])?
        .status
        .success()
    {
        return Err(format!("Local Git branch does not exist: {name}"));
    }
    git_result(git_output(
        root,
        &["switch", "--no-guess", "--no-overwrite-ignore", "--", name],
    )?)?;
    git_status_for_root(root)
}

#[tauri::command(async)]
pub(crate) fn git_create_branch(
    root: String,
    name: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<GitStatus> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    let workspace_root = workspace(&state)?;
    git_create_branch_for_root(&root, &workspace_root, &name)
}

fn git_create_branch_for_root(
    root: &Path,
    workspace_root: &Path,
    name: &str,
) -> BackendResult<GitStatus> {
    let _ = git_branch_repository(root, workspace_root)?;
    checked_git_branch_name(root, name)?;
    git_result(git_output(
        root,
        &["switch", "--no-overwrite-ignore", "-c", name],
    )?)?;
    git_status_for_root(root)
}

#[tauri::command(async)]
pub(crate) fn git_diff(
    root: String,
    path: String,
    staged: Option<bool>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<String> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    git_diff_for_root(&root, &path, staged.unwrap_or(false))
}

fn git_diff_for_root(root: &Path, path: &str, staged: bool) -> BackendResult<String> {
    let _ = git_repository_root(root)?;
    let path = checked_git_path(root, path)?;
    let mut args = vec!["diff", "--no-ext-diff", "--no-textconv"];
    if staged {
        args.push("--cached");
    }
    let output = git_result(git_path_output(root, &args, &path)?)?;
    if !staged && output.stdout.is_empty() {
        let tracked = git_path_output(root, &["ls-files", "--error-unmatch"], &path)?;
        if !tracked.status.success() {
            fs::symlink_metadata(root.join(&path))
                .map_err(|_| "File is neither tracked nor present".to_string())?;
            let no_index = git_command(root)
                .args([
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-index",
                    "--",
                    "/dev/null",
                ])
                .arg(&path)
                .output()
                .map_err(|e| e.to_string())?;
            if no_index.status.code() != Some(0) && no_index.status.code() != Some(1) {
                return Err(String::from_utf8_lossy(&no_index.stderr).trim().to_string());
            }
            return Ok(String::from_utf8_lossy(&no_index.stdout).into_owned());
        }
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[tauri::command(async)]
pub(crate) fn git_stage(
    root: String,
    path: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<GitStatus> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    git_stage_for_root(&root, &path)
}

fn git_stage_for_root(root: &Path, path: &str) -> BackendResult<GitStatus> {
    let _ = git_repository_root(root)?;
    let path = checked_git_path(root, path)?;
    git_result(git_path_output(root, &["add", "-A"], &path)?)?;
    git_status_for_root(root)
}

#[tauri::command(async)]
pub(crate) fn git_unstage(
    root: String,
    path: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<GitStatus> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    git_unstage_for_root(&root, &path)
}

fn git_unstage_for_root(root: &Path, path: &str) -> BackendResult<GitStatus> {
    let _ = git_repository_root(root)?;
    let path = checked_git_path(root, path)?;
    let has_head = git_output(root, &["rev-parse", "--verify", "HEAD"])?
        .status
        .success();
    let args: &[&str] = if has_head {
        &["reset", "-q", "HEAD"]
    } else {
        &["rm", "-q", "-f", "--cached"]
    };
    git_result(git_path_output(root, args, &path)?)?;
    git_status_for_root(root)
}

#[tauri::command(async)]
pub(crate) fn git_commit(
    root: String,
    message: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<GitCommitResult> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    git_commit_for_root(&root, &message)
}

fn git_commit_for_root(root: &Path, message: &str) -> BackendResult<GitCommitResult> {
    let repository = git_repository_root(root)?;
    if message.trim().is_empty() {
        return Err("Commit message must not be empty".to_string());
    }
    let staged = git_result(git_output(
        &repository,
        &["diff", "--cached", "--name-only", "--no-renames", "-z"],
    )?)?;
    let mut count = 0;
    for path in staged
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        count += 1;
        let path = String::from_utf8_lossy(path);
        let path = Path::new(path.as_ref());
        if path.is_absolute()
            || path.components().any(|part| part == Component::ParentDir)
            || !repository.join(path).starts_with(root)
        {
            return Err(
                "Staged changes outside the open workspace must be committed separately"
                    .to_string(),
            );
        }
    }
    if count == 0 {
        return Err("No staged changes to commit".to_string());
    }
    let output = git_command(root)
        .args(["commit", "-m"])
        .arg(message)
        .output()
        .map_err(|e| e.to_string())?;
    git_result(output)?;
    let head = git_result(git_output(root, &["rev-parse", "HEAD"])?)?;
    Ok(GitCommitResult {
        hash: String::from_utf8_lossy(&head.stdout).trim().to_string(),
        status: git_status_for_root(root)?,
    })
}

#[tauri::command(async)]
pub(crate) fn git_log(
    root: String,
    limit: Option<usize>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<Vec<GitLogEntry>> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    git_log_for_root(&root, limit.unwrap_or(20))
}

fn git_log_for_root(root: &Path, limit: usize) -> BackendResult<Vec<GitLogEntry>> {
    let _ = git_repository_root(root)?;
    if !git_output(root, &["rev-parse", "--verify", "HEAD"])?
        .status
        .success()
    {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 50).to_string();
    let output = git_result(git_output(
        root,
        &[
            "log",
            "-z",
            "-n",
            &limit,
            "--format=%H%x00%h%x00%s%x00%an%x00%aI",
        ],
    )?)?;
    let fields = output.stdout.split(|byte| *byte == 0).collect::<Vec<_>>();
    Ok(fields
        .chunks_exact(5)
        .filter(|chunk| !chunk[0].is_empty())
        .map(|chunk| GitLogEntry {
            hash: String::from_utf8_lossy(chunk[0]).into_owned(),
            short_hash: String::from_utf8_lossy(chunk[1]).into_owned(),
            subject: String::from_utf8_lossy(chunk[2]).into_owned(),
            author: String::from_utf8_lossy(chunk[3]).into_owned(),
            date: String::from_utf8_lossy(chunk[4]).into_owned(),
        })
        .collect())
}

#[tauri::command(async)]
pub(crate) fn git_file_history(
    root: String,
    path: String,
    limit: Option<usize>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<Vec<GitFileHistoryEntry>> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    git_file_history_for_root(&root, &path, limit.unwrap_or(50))
}

fn git_file_history_for_root(
    root: &Path,
    path: &str,
    limit: usize,
) -> BackendResult<Vec<GitFileHistoryEntry>> {
    let _ = git_repository_root(root)?;
    let path = checked_git_path(root, path)?;
    if !git_output(root, &["rev-parse", "--verify", "HEAD"])?
        .status
        .success()
    {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 50).to_string();
    // --relative keeps rename tracking inside the selected project folder.
    // --name-only yields the filename as it existed at each commit, so an
    // older entry can still be opened after a rename.
    let output = git_result(git_path_output(
        root,
        &[
            "log",
            "--relative",
            "--follow",
            "--find-renames",
            "--name-only",
            "-z",
            "-n",
            &limit,
            "--format=%H%x00%h%x00%s%x00%an%x00%aI",
        ],
        &path,
    )?)?;
    let fields = output.stdout.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut history = Vec::new();
    for chunk in fields.chunks_exact(6) {
        if chunk[0].is_empty() {
            continue;
        }
        // Git separates its formatted header from the NUL-delimited path
        // with one newline. A filename may itself begin with a newline.
        let Some(path) = chunk[5].strip_prefix(b"\n") else {
            return Err("Could not read Git file history".to_string());
        };
        let path = String::from_utf8(path.to_vec())
            .map_err(|_| "Git file path is not valid UTF-8".to_string())?;
        if checked_git_path(root, &path).is_err() {
            continue;
        }
        history.push(GitFileHistoryEntry {
            hash: String::from_utf8_lossy(chunk[0]).into_owned(),
            short_hash: String::from_utf8_lossy(chunk[1]).into_owned(),
            subject: String::from_utf8_lossy(chunk[2]).into_owned(),
            author: String::from_utf8_lossy(chunk[3]).into_owned(),
            date: String::from_utf8_lossy(chunk[4]).into_owned(),
            path,
        });
    }
    Ok(history)
}

#[tauri::command(async)]
pub(crate) fn git_file_commit_diff(
    root: String,
    path: String,
    hash: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<String> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    git_file_commit_diff_for_root(&root, &path, &hash)
}

fn git_file_commit_diff_for_root(root: &Path, path: &str, hash: &str) -> BackendResult<String> {
    if !matches!(hash.len(), 40 | 64) || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid Git commit hash".to_string());
    }
    let repository = git_repository_root(root)?;
    let entry = git_file_history_for_root(root, path, 50)?
        .into_iter()
        .find(|entry| entry.hash == hash)
        .ok_or_else(|| "Commit is not in this file's recent history".to_string())?;
    let historical_path = checked_git_path(root, &entry.path)?;
    let repository_relative_root = root
        .strip_prefix(&repository)
        .map_err(|_| "Git repository is outside the open workspace".to_string())?;
    let repository_path = repository_relative_root
        .join(&historical_path)
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");

    // Include both sides of a rename so Git shows a rename instead of a
    // misleading delete/add patch. Only include the old side when it remains
    // inside the open project folder.
    let names = git_result(git_output(
        root,
        &[
            "show",
            "--format=",
            "--name-status",
            "-z",
            "--find-renames",
            hash,
        ],
    )?)?;
    let names = names.stdout.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut old_path = None;
    let mut index = 0;
    while index < names.len() {
        let status = names[index];
        index += 1;
        if status.is_empty() {
            continue;
        }
        if status.first() == Some(&b'R') {
            if index + 1 >= names.len() {
                break;
            }
            let old = names[index];
            let new = names[index + 1];
            index += 2;
            if new == repository_path.as_bytes() {
                if let Ok(old) = String::from_utf8(old.to_vec()) {
                    if let Ok(old) = Path::new(&old).strip_prefix(repository_relative_root) {
                        if let Ok(checked) = checked_git_path(root, &old.to_string_lossy()) {
                            old_path = Some(checked);
                        }
                    }
                }
            }
        } else {
            index += 1;
        }
    }
    let mut command = git_command(root);
    command.args([
        "show",
        "--format=",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        hash,
        "--",
    ]);
    if let Some(old_path) = old_path {
        command.arg(old_path);
    }
    let output = git_result(
        command
            .arg(historical_path)
            .output()
            .map_err(|error| error.to_string())?,
    )?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
// ---------------------------------------------------------------------------
// Remote operations: fetch / pull / push
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn git_fetch(
    root: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<GitStatus> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    git_fetch_for_root(&root)
}

fn git_fetch_for_root(root: &Path) -> BackendResult<GitStatus> {
    let _ = git_repository_root(root)?;
    git_result(git_output(root, &["fetch", "--prune"])?)?;
    git_status_for_root(root)
}

#[tauri::command(async)]
pub(crate) fn git_pull(
    root: String,
    rebase: Option<bool>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<GitStatus> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    git_pull_for_root(&root, rebase.unwrap_or(false))
}

fn git_pull_for_root(root: &Path, rebase: bool) -> BackendResult<GitStatus> {
    let _ = git_repository_root(root)?;
    if !git_output(root, &["rev-parse", "--verify", "HEAD"])?
        .status
        .success()
    {
        return Err("Pull requires at least one local commit".to_string());
    }
    // Refuse to lose uncommitted work; the frontend asks the user first.
    let dirty = git_result(git_output(
        root,
        &["status", "--porcelain=v1", "--untracked-files=no"],
    )?)?;
    if !dirty.stdout.is_empty() {
        return Err("Pull with uncommitted changes: commit or stash first".to_string());
    }
    let mut args = vec!["pull", "--no-edit"];
    if rebase {
        args.push("--rebase");
    }
    git_result(git_output(root, &args)?)?;
    git_status_for_root(root)
}

#[tauri::command(async)]
pub(crate) fn git_push(
    root: String,
    set_upstream: Option<bool>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<String> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    git_push_for_root(&root, set_upstream.unwrap_or(false))
}

fn git_push_for_root(root: &Path, set_upstream: bool) -> BackendResult<String> {
    let _ = git_repository_root(root)?;
    let branch = git_result(git_output(root, &["branch", "--show-current"])?)?;
    let branch = String::from_utf8_lossy(&branch.stdout).trim().to_string();
    if branch.is_empty() {
        return Err("Push requires a named branch".to_string());
    }
    let has_upstream = git_output(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "@{upstream}",
        ],
    )?
    .status
        .success();
    if has_upstream {
        git_result(git_output(root, &["push"])?)?;
        return Ok(format!("Pushed {branch}"));
    }
    if !set_upstream {
        return Err(format!(
            "Branch {branch} has no upstream. Push with -u to set it."
        ));
    }
    let remotes = git_result(git_output(root, &["remote"])?)?;
    let remotes = String::from_utf8_lossy(&remotes.stdout);
    let first = remotes.lines().find(|line| !line.trim().is_empty());
    let Some(remote) = first.map(str::trim) else {
        return Err("No Git remote is configured".to_string());
    };
    if remote.contains('\0') || remote.starts_with('-') || remote.contains(char::is_control) {
        return Err("Invalid Git remote name".to_string());
    }
    git_result(git_output(
        root,
        &["push", "--set-upstream", remote, &branch],
    )?)?;
    Ok(format!("Pushed {branch} to {remote}"))
}

// ---------------------------------------------------------------------------
// Merge (including conflict reporting) and abort
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn git_merge(
    root: String,
    name: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<GitMergeResult> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    let workspace_root = workspace(&state)?;
    git_merge_for_root(&root, &workspace_root, &name)
}

fn git_merge_for_root(
    root: &Path,
    workspace_root: &Path,
    name: &str,
) -> BackendResult<GitMergeResult> {
    let _ = git_branch_repository(root, workspace_root)?;
    checked_git_branch_name(root, name)?;
    let reference = format!("refs/heads/{name}");
    if !git_output(root, &["show-ref", "--verify", "--quiet", &reference])?
        .status
        .success()
    {
        return Err(format!("Local Git branch does not exist: {name}"));
    }
    let current = git_result(git_output(root, &["branch", "--show-current"])?)?;
    let current = String::from_utf8_lossy(&current.stdout).trim().to_string();
    if current == name {
        return Err(format!("Branch {name} is already checked out"));
    }
    let merge = git_output(root, &["merge", "--no-edit", "--", name])?;
    if !merge.status.success() {
        // A failed merge either aborted cleanly or left conflict markers.
        let status = git_status_for_root(root)?;
        if !status.files.iter().any(|file| is_conflict_code(&file.status)) {
            return Err(String::from_utf8_lossy(&merge.stderr).trim().to_string());
        }
    }
    let status = git_status_for_root(root)?;
    let conflicts = status
        .files
        .iter()
        .filter(|file| is_conflict_code(&file.status))
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    Ok(GitMergeResult {
        conflicted: !conflicts.is_empty(),
        conflicts,
        status,
    })
}

#[tauri::command(async)]
pub(crate) fn git_abort_merge(
    root: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<GitStatus> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    git_abort_merge_for_root(&root)
}

fn git_abort_merge_for_root(root: &Path) -> BackendResult<GitStatus> {
    let _ = git_repository_root(root)?;
    git_result(git_output(root, &["merge", "--abort"])?)?;
    git_status_for_root(root)
}

/// Porcelain codes that mark an unresolved conflict (both sides changed).
fn is_conflict_code(status: &str) -> bool {
    matches!(
        status,
        "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU"
    )
}

// ---------------------------------------------------------------------------
// Stash
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn git_stash_push(
    root: String,
    message: Option<String>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<GitStatus> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    let message = message.unwrap_or_default();
    if message.contains('\0') || message.starts_with('-') {
        return Err("Invalid stash message".to_string());
    }
    let _ = git_repository_root(&root)?;
    // Plain command: `--literal-pathspecs` breaks how `stash push -u` matches
    // the untracked files it should remove, leaving them in the tree.
    let mut stash = git_command_base(&root);
    stash
        .args(["stash", "push", "--include-untracked", "-m"])
        .arg(&message);
    let output = stash.output().map_err(|e| e.to_string())?;
    // "No local changes to save" exits 0 and leaves the tree untouched.
    git_result(output)?;
    git_status_for_root(&root)
}

#[tauri::command(async)]
pub(crate) fn git_stash_list(
    root: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<Vec<GitStashEntry>> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    git_stash_list_for_root(&root)
}

fn git_stash_list_for_root(root: &Path) -> BackendResult<Vec<GitStashEntry>> {
    let _ = git_repository_root(root)?;
    let output = git_result(git_output(
        root,
        &["stash", "list", "--format=%gd%x00%gs%x00%ci"],
    )?)?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    for line in text.lines() {
        let mut fields = line.split('\u{0}');
        let (Some(reference), Some(subject), Some(date)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let index = reference
            .rsplit('/')
            .next()
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(0);
        entries.push(GitStashEntry {
            index,
            message: subject.to_string(),
            date: date.to_string(),
        });
    }
    Ok(entries)
}

#[tauri::command(async)]
pub(crate) fn git_stash_pop(
    root: String,
    index: Option<u32>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<GitStatus> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    git_stash_apply_for_root(&root, index.unwrap_or(0), "pop")
}

#[tauri::command(async)]
pub(crate) fn git_stash_drop(
    root: String,
    index: Option<u32>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<()> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    git_stash_apply_for_root(&root, index.unwrap_or(0), "drop").map(|_| ())
}

fn git_stash_apply_for_root(
    root: &Path,
    index: u32,
    action: &str,
) -> BackendResult<GitStatus> {
    let _ = git_repository_root(root)?;
    if index > 9_999 {
        return Err("Invalid stash index".to_string());
    }
    let reference = format!("stash@{{{index}}}");
    let listed = git_result(git_output(
        root,
        &["stash", "list", "--format=%gd", "-n", "10000"],
    )?)?;
    let listed = String::from_utf8_lossy(&listed.stdout);
    if !listed.lines().any(|line| line.trim() == format!("stash@{{{index}}}")) {
        return Err(format!("Stash {reference} does not exist"));
    }
    let output = git_output(root, &["stash", action, &reference])?;
    if action == "drop" {
        git_result(output)?;
        return git_status_for_root(root);
    }
    // A pop onto conflicting changes fails; surface the conflicted status.
    if !output.status.success() {
        let status = git_status_for_root(root)?;
        if status.files.iter().any(|file| is_conflict_code(&file.status)) {
            return Ok(status);
        }
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    git_status_for_root(root)
}

// ---------------------------------------------------------------------------
// Blame
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn git_blame(
    root: String,
    path: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<GitBlameResult> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    git_blame_for_root(&root, &path)
}

fn git_blame_for_root(root: &Path, path: &str) -> BackendResult<GitBlameResult> {
    let _ = git_repository_root(root)?;
    let relative = checked_git_path(root, path)?;
    if !git_output(root, &["rev-parse", "--verify", "HEAD"])?
        .status
        .success()
    {
        return Err("Blame requires at least one commit".to_string());
    }
    let output = git_result(git_path_output(
        root,
        &["blame", "--line-porcelain"],
        &relative,
    )?)?;
    let text = String::from_utf8_lossy(&output.stdout);

    // Porcelain blame repeats "<hash> <orig> <final> <size>" once per source
    // line, each followed by header lines and the tab-prefixed content. A
    // block's headers complete *after* its opening line, so commit metadata
    // is flushed when the next block (or EOF) is reached.
    let is_block_header = |line: &str| -> bool {
        let mut parts = line.splitn(4, ' ');
        let hash = parts.next().unwrap_or("");
        (hash.len() == 40 || hash.len() == 64)
            && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            && parts.next().is_some_and(|value| value.parse::<u32>().is_ok())
    };

    struct PendingCommit {
        author: String,
        date: String,
        summary: String,
    }
    let short_hashes = git_result(git_output(
        root,
        &["log", "--format=%h %H", "-n", "10000", "--all"],
    )?)
    .map(|output| {
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let (short, hash) = line.split_once(' ')?;
                Some((hash.to_string(), short.to_string()))
            })
            .collect::<std::collections::HashMap<_, _>>()
    })
    .unwrap_or_default();

    let mut lines = Vec::new();
    let mut commits = std::collections::HashMap::new();
    let mut current_hash: Option<String> = None;
    let mut pending = PendingCommit {
        author: String::new(),
        date: String::new(),
        summary: String::new(),
    };
    let mut flush = |hash: &Option<String>,
                     pending: &PendingCommit,
                     commits: &mut std::collections::HashMap<String, GitBlameCommit>| {
        let Some(hash) = hash else { return };
        if hash.is_empty() || commits.contains_key(hash) {
            return;
        }
        let short = short_hashes
            .get(hash)
            .cloned()
            .unwrap_or_else(|| hash.chars().take(8).collect());
        commits.insert(
            hash.clone(),
            GitBlameCommit {
                short_hash: short,
                author: pending.author.clone(),
                date: pending.date.clone(),
                summary: pending.summary.clone(),
            },
        );
    };
    for line in text.lines() {
        if line.starts_with('\t') {
            continue; // Content; not needed for the blame view.
        }
        if is_block_header(line) {
            flush(&current_hash, &pending, &mut commits);
            let mut parts = line.split(' ');
            let hash = parts.next().unwrap_or("").to_string();
            // "<hash> <orig-line> <final-line> <group-size>"
            let final_line = parts
                .nth(1)
                .and_then(|value| value.parse::<u32>().ok());
            current_hash = Some(hash.clone());
            pending = PendingCommit {
                author: String::new(),
                date: String::new(),
                summary: String::new(),
            };
            if let Some(number) = final_line {
                lines.push(GitBlameLine { line: number, hash });
            }
        } else if let Some((name, value)) = line.split_once(' ') {
            match name {
                "author" => pending.author = value.to_string(),
                "author-time" => {
                    let seconds = value.parse::<i64>().unwrap_or(0);
                    pending.date = chrono::DateTime::from_timestamp(seconds, 0)
                        .map(|time| time.to_rfc3339())
                        .unwrap_or_default();
                }
                "summary" => {
                    pending.summary = line["summary ".len()..].to_string();
                }
                _ => {}
            }
        }
    }
    flush(&current_hash, &pending, &mut commits);
    lines.sort_by_key(|line| line.line);
    Ok(GitBlameResult {
        path: relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/"),
        lines,
        commits,
    })
}

// ---------------------------------------------------------------------------
// Log graph data (parents + refs let the frontend draw the graph)
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn git_log_graph(
    root: String,
    limit: Option<usize>,
    all: Option<bool>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<Vec<GitGraphCommit>> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    git_log_graph_for_root(&root, limit.unwrap_or(300), all.unwrap_or(true))
}

fn git_log_graph_for_root(
    root: &Path,
    limit: usize,
    all: bool,
) -> BackendResult<Vec<GitGraphCommit>> {
    let _ = git_repository_root(root)?;
    if !git_output(root, &["rev-parse", "--verify", "HEAD"])?
        .status
        .success()
    {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 2_000).to_string();
    let mut args = vec![
        "log".to_string(),
        "--topo-order".to_string(),
        format!("-n{limit}"),
        "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%P%x1f%D".to_string(),
    ];
    if all {
        args.push("--all".to_string());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = git_result(git_output(root, &arg_refs)?)?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut commits = Vec::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split('\u{1f}').collect();
        if fields.len() < 7 || fields[0].is_empty() {
            continue;
        }
        // %D lists decorations comma-separated, e.g. "HEAD -> main, origin/main".
        let refs: Vec<String> = fields[6]
            .split(", ")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect();
        commits.push(GitGraphCommit {
            hash: fields[0].to_string(),
            short_hash: fields[1].to_string(),
            subject: fields[2].to_string(),
            author: fields[3].to_string(),
            date: fields[4].to_string(),
            parents: fields[5]
                .split_whitespace()
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect(),
            is_head: refs.iter().any(|reference| reference.starts_with("HEAD")),
            refs,
        });
    }
    Ok(commits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;

    #[test]
    fn git_status_paths_are_relative_to_nested_project() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = env::temp_dir().join(format!("mgland-git-test-{}-{nonce}", std::process::id()));
        let project = base.join("repo").join("project");
        fs::create_dir_all(&project).unwrap();
        let initialized = command_for("git")
            .current_dir(base.join("repo"))
            .args(["init", "-q"])
            .status()
            .unwrap();
        assert!(initialized.success());
        fs::write(project.join("main.go"), "package main\n").unwrap();

        let status = git_status_for_root(&project).unwrap();
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, "main.go");
        assert_eq!(status.files[0].status, "??");
        assert!(!status.files[0].staged);
        assert!(status.files[0].unstaged);

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn git_diff_stage_unstage_commit_and_log_cover_untracked_and_deleted_files() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = env::temp_dir().join(format!("mgland-git-flow-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&base).unwrap();
        assert!(command_for("git")
            .current_dir(&base)
            .args(["init", "-q"])
            .status()
            .unwrap()
            .success());
        let root = fs::canonicalize(&base).unwrap();
        git_result(git_output(&root, &["config", "user.name", "MG Land Test"]).unwrap()).unwrap();
        git_result(git_output(&root, &["config", "user.email", "test@example.com"]).unwrap())
            .unwrap();
        fs::write(root.join("main.go"), "package main\n").unwrap();

        let status = git_status_for_root(&root).unwrap();
        assert_eq!(status.files[0].status, "??");
        assert!(git_diff_for_root(&root, "main.go", false)
            .unwrap()
            .contains("+package main"));
        let status = git_stage_for_root(&root, "main.go").unwrap();
        assert_eq!(status.files[0].status, "A ");
        assert!(status.files[0].staged);
        assert!(!status.files[0].unstaged);
        assert!(git_diff_for_root(&root, "main.go", true)
            .unwrap()
            .contains("+package main"));
        let status = git_unstage_for_root(&root, "main.go").unwrap();
        assert_eq!(status.files[0].status, "??");

        assert!(git_commit_for_root(&root, " ").is_err());
        git_stage_for_root(&root, "main.go").unwrap();
        let committed = git_commit_for_root(&root, "Initial commit").unwrap();
        assert!(!committed.hash.is_empty());
        assert!(committed.status.files.is_empty());
        let history = git_log_for_root(&root, 20).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].subject, "Initial commit");

        fs::write(root.join("main.go"), "package main\n// edited\n").unwrap();
        let status = git_status_for_root(&root).unwrap();
        assert_eq!(status.files[0].status, " M");
        git_stage_for_root(&root, "main.go").unwrap();
        fs::write(root.join("main.go"), "package main\n// edited twice\n").unwrap();
        let status = git_status_for_root(&root).unwrap();
        assert_eq!(status.files[0].status, "MM");
        assert!(status.files[0].staged && status.files[0].unstaged);
        git_unstage_for_root(&root, "main.go").unwrap();
        fs::remove_file(root.join("main.go")).unwrap();
        let status = git_status_for_root(&root).unwrap();
        assert_eq!(status.files[0].status, " D");
        let status = git_stage_for_root(&root, "main.go").unwrap();
        assert_eq!(status.files[0].status, "D ");
        assert!(git_diff_for_root(&root, "main.go", true)
            .unwrap()
            .contains("-package main"));
        let status = git_unstage_for_root(&root, "main.go").unwrap();
        assert_eq!(status.files[0].status, " D");

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn git_file_history_follows_renames_and_limits_diffs_to_the_file() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = env::temp_dir().join(format!(
            "mgland-git-file-history-{}-{nonce}",
            std::process::id()
        ));
        let project = base.join("project");
        fs::create_dir_all(&project).unwrap();
        assert!(command_for("git")
            .current_dir(&base)
            .args(["init", "-q"])
            .status()
            .unwrap()
            .success());
        let repository = fs::canonicalize(&base).unwrap();
        let project = fs::canonicalize(project).unwrap();
        git_result(git_output(&repository, &["config", "user.name", "MG Land Test"]).unwrap())
            .unwrap();
        git_result(git_output(&repository, &["config", "user.email", "test@example.com"]).unwrap())
            .unwrap();

        fs::write(project.join("old.go"), "package main\n").unwrap();
        fs::write(repository.join("outside.go"), "package outside\n").unwrap();
        git_result(git_output(&repository, &["add", "."]).unwrap()).unwrap();
        git_result(git_output(&repository, &["commit", "-q", "-m", "Initial files"]).unwrap())
            .unwrap();
        let initial_hash = String::from_utf8_lossy(
            &git_result(git_output(&repository, &["rev-parse", "HEAD"]).unwrap())
                .unwrap()
                .stdout,
        )
        .trim()
        .to_string();

        fs::write(project.join("old.go"), "package main\n// changed\n").unwrap();
        fs::write(
            repository.join("outside.go"),
            "package outside\n// private\n",
        )
        .unwrap();
        git_result(git_output(&repository, &["add", "."]).unwrap()).unwrap();
        git_result(git_output(&repository, &["commit", "-q", "-m", "Mixed change"]).unwrap())
            .unwrap();
        let mixed_hash = String::from_utf8_lossy(
            &git_result(git_output(&repository, &["rev-parse", "HEAD"]).unwrap())
                .unwrap()
                .stdout,
        )
        .trim()
        .to_string();

        git_result(git_output(&repository, &["mv", "project/old.go", "project/new.go"]).unwrap())
            .unwrap();
        git_result(git_output(&repository, &["commit", "-q", "-m", "Rename file"]).unwrap())
            .unwrap();
        let rename_hash = String::from_utf8_lossy(
            &git_result(git_output(&repository, &["rev-parse", "HEAD"]).unwrap())
                .unwrap()
                .stdout,
        )
        .trim()
        .to_string();

        let history = git_file_history_for_root(&project, "new.go", 50).unwrap();
        assert_eq!(history.len(), 3);
        assert_eq!(history[0].path, "new.go");
        assert_eq!(history[1].path, "old.go");
        assert_eq!(history[2].path, "old.go");
        assert_eq!(history[2].hash, initial_hash);
        assert_eq!(
            git_file_history_for_root(&project, "new.go", 1)
                .unwrap()
                .len(),
            1
        );
        assert!(git_file_history_for_root(&project, "../outside.go", 50).is_err());

        let mixed_diff = git_file_commit_diff_for_root(&project, "new.go", &mixed_hash).unwrap();
        assert!(mixed_diff.contains("+// changed"));
        assert!(!mixed_diff.contains("outside.go"));
        assert!(!mixed_diff.contains("private"));
        let rename_diff = git_file_commit_diff_for_root(&project, "new.go", &rename_hash).unwrap();
        assert!(rename_diff.contains("rename from project/old.go"));
        assert!(rename_diff.contains("rename to project/new.go"));
        let initial_diff =
            git_file_commit_diff_for_root(&project, "new.go", &initial_hash).unwrap();
        assert!(initial_diff.contains("+package main"));
        assert!(!initial_diff.contains("outside.go"));
        assert!(git_file_commit_diff_for_root(&project, "new.go", "HEAD").is_err());
        assert!(git_file_commit_diff_for_root(&project, "../outside.go", &mixed_hash).is_err());

        git_result(git_output(&repository, &["mv", "outside.go", "project/imported.go"]).unwrap())
            .unwrap();
        git_result(git_output(&repository, &["commit", "-q", "-m", "Import file"]).unwrap())
            .unwrap();
        let import_hash = String::from_utf8_lossy(
            &git_result(git_output(&repository, &["rev-parse", "HEAD"]).unwrap())
                .unwrap()
                .stdout,
        )
        .trim()
        .to_string();
        let imported_history = git_file_history_for_root(&project, "imported.go", 50).unwrap();
        assert_eq!(imported_history.len(), 1);
        assert_eq!(imported_history[0].hash, import_hash);
        assert!(git_file_commit_diff_for_root(&project, "new.go", &import_hash).is_err());
        let import_diff =
            git_file_commit_diff_for_root(&project, "imported.go", &import_hash).unwrap();
        assert!(import_diff.contains("new file mode"));
        assert!(!import_diff.contains("outside.go"));

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn git_paths_and_commits_stay_inside_nested_workspace() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = env::temp_dir().join(format!("mgland-git-scope-{}-{nonce}", std::process::id()));
        let project = base.join("project");
        fs::create_dir_all(&project).unwrap();
        assert!(git_status_for_root(&project).is_err());
        assert!(command_for("git")
            .current_dir(&base)
            .args(["init", "-q"])
            .status()
            .unwrap()
            .success());
        let repository = fs::canonicalize(&base).unwrap();
        let project = fs::canonicalize(project).unwrap();
        fs::write(repository.join("outside.go"), "package outside\n").unwrap();
        fs::write(project.join("main.go"), "package main\n").unwrap();
        assert!(checked_git_path(&project, "../outside.go").is_err());
        assert!(
            checked_git_path(&project, &repository.join("outside.go").to_string_lossy()).is_err()
        );
        assert_eq!(
            checked_git_path(&project, "removed/nested.go").unwrap(),
            PathBuf::from("removed/nested.go")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside = repository.join("outside-dir");
            fs::create_dir_all(&outside).unwrap();
            symlink(&outside, project.join("escape")).unwrap();
            assert!(checked_git_path(&project, "escape/secret.go").is_err());
        }
        git_result(git_output(&repository, &["add", "outside.go"]).unwrap()).unwrap();
        assert!(git_commit_for_root(&project, "Must stay scoped")
            .err()
            .unwrap()
            .contains("outside"));

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn git_branch_commands_validate_names_and_preserve_dirty_changes() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = env::temp_dir().join(format!(
            "mgland-git-branches-{}-{nonce}",
            std::process::id()
        ));
        let repository = base.join("repository");
        fs::create_dir_all(&repository).unwrap();
        assert!(command_for("git")
            .current_dir(&repository)
            .args(["init", "-q"])
            .status()
            .unwrap()
            .success());
        let repository = fs::canonicalize(repository).unwrap();
        let initial = git_status_for_root(&repository).unwrap().branch;
        let unborn = git_branches_for_root(&repository, &repository).unwrap();
        assert_eq!(unborn.len(), 1);
        assert_eq!(unborn[0].name, initial);
        assert!(unborn[0].current);

        git_result(git_output(&repository, &["config", "user.name", "MG Land Test"]).unwrap())
            .unwrap();
        git_result(git_output(&repository, &["config", "user.email", "test@example.com"]).unwrap())
            .unwrap();
        fs::write(repository.join("main.go"), "package main\n").unwrap();
        git_result(git_output(&repository, &["add", "--", "main.go"]).unwrap()).unwrap();
        git_result(git_output(&repository, &["commit", "-q", "-m", "Initial commit"]).unwrap())
            .unwrap();

        let created = git_create_branch_for_root(&repository, &repository, "feature/ui").unwrap();
        assert_eq!(created.branch, "feature/ui");
        let branches = git_branches_for_root(&repository, &repository).unwrap();
        assert_eq!(branches.len(), 2);
        assert!(branches
            .iter()
            .any(|branch| branch.name == initial && !branch.current));
        assert!(branches
            .iter()
            .any(|branch| branch.name == "feature/ui" && branch.current));
        assert!(git_create_branch_for_root(&repository, &repository, "feature/ui").is_err());
        for name in ["-f", "../escape", "bad name", "@{-1}"] {
            assert!(git_create_branch_for_root(&repository, &repository, name).is_err());
            assert!(git_checkout_branch_for_root(&repository, &repository, name).is_err());
        }
        assert!(git_checkout_branch_for_root(&repository, &repository, "missing").is_err());

        fs::write(repository.join("main.go"), "package main\n// feature\n").unwrap();
        git_result(git_output(&repository, &["add", "--", "main.go"]).unwrap()).unwrap();
        git_result(git_output(&repository, &["commit", "-q", "-m", "Feature change"]).unwrap())
            .unwrap();
        fs::write(repository.join("main.go"), "package main\n// dirty\n").unwrap();
        assert!(git_checkout_branch_for_root(&repository, &repository, &initial).is_err());
        assert_eq!(
            git_status_for_root(&repository).unwrap().branch,
            "feature/ui"
        );
        assert_eq!(
            fs::read_to_string(repository.join("main.go")).unwrap(),
            "package main\n// dirty\n"
        );
        fs::write(repository.join("main.go"), "package main\n// feature\n").unwrap();
        let checked_out = git_checkout_branch_for_root(&repository, &repository, &initial).unwrap();
        assert_eq!(checked_out.branch, initial);

        let nested = repository.join("nested");
        fs::create_dir_all(&nested).unwrap();
        let nested = fs::canonicalize(nested).unwrap();
        assert!(git_branches_for_root(&nested, &nested).is_err());
        assert!(git_checkout_branch_for_root(&nested, &nested, "feature/ui").is_err());

        fs::remove_dir_all(base).unwrap();
    }

    fn initialized_repository(tag: &str) -> PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = env::temp_dir().join(format!("mgland-{tag}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&base).unwrap();
        assert!(command_for("git")
            .current_dir(&base)
            .args(["init", "-q"])
            .status()
            .unwrap()
            .success());
        let root = fs::canonicalize(&base).unwrap();
        for (key, value) in [
            ("user.name", "MG Land Test"),
            ("user.email", "test@example.com"),
        ] {
            git_result(git_output(&root, &["config", key, value]).unwrap()).unwrap();
        }
        root
    }

    fn commit_all(root: &Path, message: &str) -> String {
        git_result(git_output(root, &["add", "-A"]).unwrap()).unwrap();
        git_result(git_output(root, &["commit", "-q", "-m", message]).unwrap()).unwrap();
        String::from_utf8_lossy(
            &git_result(git_output(root, &["rev-parse", "HEAD"]).unwrap()).unwrap().stdout,
        )
        .trim()
        .to_string()
    }

    #[test]
    fn stash_roundtrip_covers_untracked_files() {
        let root = initialized_repository("stash");
        fs::write(root.join("main.go"), "package main\n").unwrap();
        commit_all(&root, "Initial commit");
        fs::write(root.join("main.go"), "package main\n// changed\n").unwrap();
        fs::write(root.join("notes.txt"), "scratch").unwrap();

        let stashed = git_stash_push_for_test(&root, Some("work in progress"));
        assert!(stashed.files.is_empty(), "tree must be clean after stash");
        assert_eq!(
            fs::read_to_string(root.join("main.go")).unwrap(),
            "package main\n"
        );
        assert!(!root.join("notes.txt").exists());

        let entries = git_stash_list_for_root(&root).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].index, 0);
        assert!(entries[0].message.contains("work in progress"));

        let restored = git_stash_apply_for_root(&root, 0, "pop").unwrap();
        assert!(restored.files.iter().any(|file| file.path == "main.go"));
        assert!(restored.files.iter().any(|file| file.path == "notes.txt"));
        assert!(git_stash_apply_for_root(&root, 5, "pop").is_err());
        assert!(git_stash_list_for_root(&root).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    fn git_stash_push_for_test(root: &Path, message: Option<&str>) -> GitStatus {
        let output = git_command_base(root)
            .args(["stash", "push", "--include-untracked", "-m"])
            .arg(message.unwrap_or("mgland"))
            .output()
            .unwrap();
        git_result(output).unwrap();
        git_status_for_root(root).unwrap()
    }

    #[test]
    fn merge_reports_conflicts_and_abort_restores_the_tree() {
        let root = initialized_repository("merge");
        fs::write(root.join("conflict.go"), "package main\n").unwrap();
        commit_all(&root, "Base");
        let base_content = fs::read_to_string(root.join("conflict.go")).unwrap();

        git_result(git_output(&root, &["switch", "-c", "feature"]).unwrap()).unwrap();
        fs::write(root.join("conflict.go"), "package main\n// feature\n").unwrap();
        commit_all(&root, "Feature");
        let feature_content = fs::read_to_string(root.join("conflict.go")).unwrap();
        git_result(git_output(&root, &["switch", "-"]).unwrap()).unwrap();
        fs::write(root.join("conflict.go"), "package main\n// main\n").unwrap();
        commit_all(&root, "Main side");
        let main_content = fs::read_to_string(root.join("conflict.go")).unwrap();
        assert_ne!(main_content, feature_content);
        assert_ne!(main_content, base_content);

        let result = git_merge_for_root(&root, &root, "feature").unwrap();
        assert!(result.conflicted);
        assert_eq!(result.conflicts, ["conflict.go"]);

        let aborted = git_abort_merge_for_root(&root).unwrap();
        assert!(aborted.files.is_empty());
        // Aborting returns the working tree to the current branch's HEAD.
        assert_eq!(
            fs::read_to_string(root.join("conflict.go")).unwrap(),
            main_content
        );
        assert!(git_merge_for_root(&root, &root, "main").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn log_graph_exposes_parents_and_decorations() {
        let root = initialized_repository("graph");
        fs::write(root.join("main.go"), "package main\n").unwrap();
        let first = commit_all(&root, "First");
        git_result(git_output(&root, &["branch", "topic"]).unwrap()).unwrap();
        fs::write(root.join("main.go"), "package main\n// second\n").unwrap();
        let second = commit_all(&root, "Second");
        let commits = git_log_graph_for_root(&root, 50, true).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].hash, second);
        assert_eq!(commits[0].parents, [first]);
        assert!(commits[0].is_head);
        assert!(commits[0]
            .refs
            .iter()
            .any(|reference| reference == "HEAD -> master" || reference == "HEAD -> main"));
        assert!(commits[1].parents.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn blame_attributes_each_line_to_its_commit() {
        let root = initialized_repository("blame");
        fs::write(root.join("main.go"), "package main\n").unwrap();
        let first = commit_all(&root, "Initial");
        fs::write(root.join("main.go"), "package main\n// touched\n").unwrap();
        let second = commit_all(&root, "Touch");
        let blame = git_blame_for_root(&root, "main.go").unwrap();
        assert_eq!(blame.lines.len(), 2);
        assert_eq!(blame.lines[0].hash, first);
        assert_eq!(blame.lines[1].hash, second);
        let first_commit = &blame.commits[&first];
        assert_eq!(first_commit.author, "MG Land Test");
        assert_eq!(first_commit.summary, "Initial");
        assert_eq!(blame.commits[&second].summary, "Touch");
        assert!(first_commit.date.starts_with("20"));
        fs::remove_dir_all(root).unwrap();
    }

}
