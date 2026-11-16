#[cfg(unix)]
use std::os::unix::process::CommandExt;
use serde_json::json;
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::dto::CoverageProfile;
use crate::go_tasks;
use crate::paths::checked_directory;
use crate::process::command_for;
use crate::state::{lock, AppState, BackendResult, TaskSession};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum GoTaskScope {
    Workspace,
    File,
    Package,
    Directory,
}

/// Typed extensions for run configurations: program arguments, environment
/// variables, build tags, race detection, and coverage collection. Every
/// field is validated before it reaches a child process command line.
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct TaskExtras {
    program_args: Option<Vec<String>>,
    env_vars: Option<HashMap<String, String>>,
    build_tags: Option<String>,
    race: Option<bool>,
    coverage: Option<bool>,
    module: Option<String>,
    /// `go test -bench` pattern; `-run` is pinned to `^$` so only benchmarks run.
    bench: Option<String>,
}

fn valid_env_key(key: &str) -> bool {
    !key.is_empty()
        && !key.starts_with(|character: char| character.is_ascii_digit())
        && key.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_'
        })
}

fn go_run_file_directory(root: &Path, target: &Path) -> BackendResult<PathBuf> {
    let candidate = if target.is_absolute() {
        target.to_path_buf()
    } else {
        root.join(target)
    };
    let file = fs::canonicalize(candidate).map_err(|error| error.to_string())?;
    if !file.starts_with(root) {
        return Err("Path is outside the open workspace".to_string());
    }
    if !file.is_file() || file.extension() != Some(OsStr::new("go")) {
        return Err("Run file scope requires a Go source file".to_string());
    }
    file.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Go source file has no parent directory".to_string())
}

fn valid_build_tags(tags: &str) -> bool {
    !tags.is_empty()
        && !tags.starts_with('-')
        && tags
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | ','))
}

fn valid_module_path(module: &str) -> bool {
    !module.is_empty()
        && !module.starts_with('-')
        && module.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '.' | '_' | '-' | '/' | '~' | '+' | '@')
        })
}

/// Everything needed to spawn one task process.
#[derive(Debug)]
struct TaskPlan {
    /// The executable name resolved through PATH (usually "go").
    program: &'static str,
    args: Vec<OsString>,
    /// Environment overrides applied on top of the inherited environment.
    env: HashMap<String, String>,
    /// Set for `go test -coverprofile=…` runs; the profile is parsed and
    /// attached to the task-exit event, then the temp file is removed.
    cover_profile: Option<PathBuf>,
}

fn go_args(
    root: &Path,
    task: &str,
    scope: Option<GoTaskScope>,
    target_path: Option<&str>,
    test_name: Option<&str>,
    extras: &TaskExtras,
) -> BackendResult<TaskPlan> {
    let mut env = HashMap::new();
    if let Some(variables) = &extras.env_vars {
        for (key, value) in variables {
            if !valid_env_key(key) {
                return Err(format!("Invalid environment variable name: {key}"));
            }
            env.insert(key.clone(), value.clone());
        }
    }
    let build_flags: Vec<OsString> = match extras.build_tags.as_deref() {
        Some(tags) if !tags.trim().is_empty() => {
            if !valid_build_tags(tags) {
                return Err(format!("Invalid Go build tags: {tags}"));
            }
            vec![OsString::from("-tags"), OsString::from(tags)]
        }
        _ => Vec::new(),
    };
    let mut extras_used: Vec<&str> = Vec::new();
    if extras.program_args.as_ref().is_some_and(|args| !args.is_empty()) {
        extras_used.push("programArgs");
    }
    if extras.env_vars.as_ref().is_some_and(|vars| !vars.is_empty()) {
        extras_used.push("envVars");
    }
    if extras.build_tags.is_some() {
        extras_used.push("buildTags");
    }
    if extras.race.is_some() {
        extras_used.push("race");
    }
    if extras.coverage.is_some() {
        extras_used.push("coverage");
    }
    if extras.module.is_some() {
        extras_used.push("module");
    }
    if let Some(pattern) = &extras.bench {
        if pattern.len() > 100
            || !pattern.chars().all(|character| {
                character.is_ascii_alphanumeric()
                    || matches!(character, '.' | '*' | '+' | '|' | '(' | ')' | '^' | '$' | '-' | '_' | '/' | '[' | ']' | ' ')
            })
        {
            return Err("bench pattern contains unsupported characters".to_string());
        }
        extras_used.push("bench");
    }

    let scope = scope.unwrap_or(GoTaskScope::Workspace);
    let target = target_path.map(Path::new);
    match task {
        "test" => {
            if !extras_used.iter().all(|extra| {
                matches!(*extra, "envVars" | "buildTags" | "race" | "coverage" | "bench")
            }) {
                return Err(format!(
                    "test does not accept {}",
                    extras_used
                        .iter()
                        .filter(|extra| !matches!(extra, &&"envVars" | &&"buildTags" | &&"race" | &&"coverage" | &&"bench"))
                        .copied()
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            let scope = match scope {
                GoTaskScope::Workspace => {
                    if target.is_some() {
                        return Err("Workspace test scope does not accept targetPath".to_string());
                    }
                    go_tasks::TestScope::Workspace
                }
                GoTaskScope::File => {
                    go_tasks::TestScope::File(target.ok_or("File test scope requires targetPath")?)
                }
                GoTaskScope::Package => go_tasks::TestScope::Package(
                    target.ok_or("Package test scope requires targetPath")?,
                ),
                GoTaskScope::Directory => go_tasks::TestScope::Directory(
                    target.ok_or("Directory test scope requires targetPath")?,
                ),
            };
            let mut flags = build_flags;
            if extras.race == Some(true) {
                flags.push(OsString::from("-race"));
            }
            if let Some(pattern) = &extras.bench {
                // Benchmarks only: suppress regular tests so `go test` reports
                // benchmark results instead of running the whole suite.
                flags.push(OsString::from("-run"));
                flags.push(OsString::from("^$"));
                flags.push(OsString::from("-bench"));
                flags.push(OsString::from(if pattern.trim().is_empty() { "." } else { pattern.as_str() }));
            }
            let mut args = go_tasks::test_args_with_flags(root, scope, test_name, &flags)?;
            let mut cover_profile = None;
            if extras.coverage == Some(true) {
                cover_profile = Some(next_cover_profile_path());
                // Coverage flags must precede the package argument.
                let package_at = args.len().saturating_sub(1);
                args.splice(
                    package_at..package_at,
                    [
                        OsString::from("-cover"),
                        OsString::from("-coverprofile"),
                        cover_profile
                            .as_ref()
                            .map(|path| path.as_os_str().to_os_string())
                            .unwrap_or_default(),
                    ],
                );
            }
            Ok(TaskPlan {
                program: "go",
                args,
                env,
                cover_profile,
            })
        }
        "run" => {
            if test_name.is_some() {
                return Err("Run task does not accept testName".to_string());
            }
            if !extras_used
                .iter()
                .all(|extra| matches!(*extra, "envVars" | "buildTags" | "race" | "programArgs"))
            {
                return Err(format!("run does not accept coverage or module"));
            }
            let package_dir = match scope {
                GoTaskScope::Workspace => {
                    if target.is_some() {
                        return Err("Workspace run scope does not accept targetPath".to_string());
                    }
                    root.to_path_buf()
                }
                GoTaskScope::File => go_run_file_directory(
                    root,
                    target.ok_or("File run scope requires targetPath")?,
                )?,
                GoTaskScope::Package | GoTaskScope::Directory => target
                    .ok_or("Package or directory run scope requires targetPath")?
                    .to_path_buf(),
            };
            let mut args = go_tasks::run_args(root, &package_dir)?;
            // Build flags sit between `run` and the package path.
            for (offset, flag) in build_flags.iter().enumerate() {
                args.insert(1 + offset, flag.clone());
            }
            if extras.race == Some(true) {
                args.insert(1, OsString::from("-race"));
            }
            // Everything after the package path is passed to the program.
            if let Some(program_args) = &extras.program_args {
                for arg in program_args {
                    args.push(OsString::from(arg));
                }
            }
            Ok(TaskPlan {
                program: "go",
                args,
                env,
                cover_profile: None,
            })
        }
        "mod_get" => {
            if !extras_used
                .iter()
                .all(|extra| matches!(*extra, "envVars" | "module"))
            {
                return Err(format!(
                    "mod_get does not accept {}",
                    extras_used
                        .iter()
                        .filter(|extra| !matches!(extra, &&"envVars" | &&"module"))
                        .copied()
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            let module = extras
                .module
                .as_deref()
                .filter(|module| !module.trim().is_empty())
                .ok_or("go get requires a module path")?;
            if !valid_module_path(module) {
                return Err(format!("Invalid Go module path: {module}"));
            }
            Ok(TaskPlan {
                program: "go",
                args: vec![OsString::from("get"), OsString::from(module)],
                env,
                cover_profile: None,
            })
        }
        "vulncheck" => {
            if !extras_used.iter().all(|extra| matches!(*extra, "envVars")) {
                return Err("vulncheck does not accept task extras".to_string());
            }
            Ok(TaskPlan {
                program: "govulncheck",
                args: vec![OsString::from("./...")],
                env,
                cover_profile: None,
            })
        }
        _ => {
            if scope != GoTaskScope::Workspace || target.is_some() || test_name.is_some() {
                return Err(format!(
                    "{task} does not accept scope, targetPath, or testName"
                ));
            }
            if !extras_used.is_empty() {
                return Err(format!("{task} does not accept {}", extras_used.join(", ")));
            }
            let args = match task {
                "build" => vec!["build", "./..."],
                "fmt" => vec!["fmt", "./..."],
                "vet" => vec!["vet", "./..."],
                "mod_tidy" => vec!["mod", "tidy"],
                "mod_download" => vec!["mod", "download"],
                "install_gopls" => vec!["install", "golang.org/x/tools/gopls@latest"],
                "install_dlv" => vec![
                    "install",
                    "github.com/go-delve/delve/cmd/dlv@latest",
                ],
                "install_govulncheck" => {
                    vec!["install", "golang.org/x/vuln/cmd/govulncheck@latest"]
                }
                _ => return Err(format!("Unknown Go task: {task}")),
            };
            Ok(TaskPlan {
                program: "go",
                args: args.into_iter().map(OsString::from).collect(),
                env,
                cover_profile: None,
            })
        }
    }
}

fn next_cover_profile_path() -> PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "mgland-cover-{}-{nonce}.out",
        std::process::id()
    ))
}

/// Read a `go test -coverprofile` file into a structured profile.
pub(crate) fn parse_cover_profile(text: &str) -> Option<CoverageProfile> {
    let mut lines = text.lines();
    let mode = lines.next()?.strip_prefix("mode: ")?.to_string();
    let mut files: Vec<crate::dto::CoverageFile> = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        // "<path>:<startLine>.<startCol>,<endLine>.<endCol> <statements> <count>"
        // Paths with spaces or colons are double-quoted before the colon.
        let (path, positions, statements, count) = if let Some(rest) = line.strip_prefix('"') {
            let Some((path, remainder)) = rest.split_once('"') else {
                continue // Unterminated quote; skip the malformed line.
            };
            let Some(remainder) = remainder.strip_prefix(':') else { continue };
            let Some((positions, tail)) = remainder.split_once(' ') else { continue };
            let Some((statements, count)) = tail.split_once(' ') else { continue };
            (path, positions, statements, count)
        } else {
            let Some((location, tail)) = line.split_once(' ') else { continue };
            let Some((statements, count)) = tail.split_once(' ') else { continue };
            let Some((path, positions)) = location.rsplit_once(':') else { continue };
            (path, positions, statements, count)
        };
        let (start_position, end_position) = positions.split_once(',')?;
        let (start_line, start_col) = start_position.split_once('.')?;
        let (end_line, end_col) = end_position.split_once('.')?;
        let block = crate::dto::CoverageBlock {
            start_line: start_line.parse().ok()?,
            start_col: start_col.parse().ok()?,
            end_line: end_line.parse().ok()?,
            end_col: end_col.parse().ok()?,
            statements: statements.parse().ok()?,
            count: count.parse().ok()?,
        };
        let path = path.to_string();
        match files.last_mut() {
            Some(file) if file.path == path => file.blocks.push(block),
            _ => files.push(crate::dto::CoverageFile {
                path,
                blocks: vec![block],
            }),
        }
    }
    Some(CoverageProfile { mode, files })
}

pub(crate) fn read_task_stream<R: Read + Send + 'static>(
    stream: R,
    app: AppHandle,
    window_label: String,
    id: String,
    stream_name: &'static str,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut bytes = Vec::new();
        loop {
            bytes.clear();
            match reader.read_until(b'\n', &mut bytes) {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&bytes)
                        .trim_end_matches(['\r', '\n'])
                        .to_string();
                    let _ = app.emit_to(
                        &window_label,
                        "task-output",
                        json!({ "id": id, "stream": stream_name, "line": line }),
                    );
                }
                Err(error) => {
                    let _ = app.emit_to(
                        &window_label,
                        "task-output",
                        json!({ "id": id, "stream": "stderr", "line": error.to_string() }),
                    );
                    break;
                }
            }
        }
    })
}

pub(crate) fn kill_task(session: &TaskSession) -> BackendResult<()> {
    let mut child = lock(&session.child)?;
    if child.try_wait().map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        // Each Go command is launched in its own process group, so this also
        // stops the compiled binary started by `go run`.
        let result = unsafe { libc::killpg(session.pgid, libc::SIGKILL) };
        if result == -1 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error.to_string());
            }
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        child.kill().map_err(|e| e.to_string())
    }
}

#[tauri::command(async)]
pub(crate) fn run_go_task(
    root: String,
    task: String,
    scope: Option<GoTaskScope>,
    target_path: Option<String>,
    test_name: Option<String>,
    extras: Option<TaskExtras>,
    window: WebviewWindow,
    state: State<'_, AppState>,
    app: AppHandle,
) -> BackendResult<String> {
    let state = state.for_window(&window)?;
    let window_label = window.label().to_string();
    let root = checked_directory(&state, &root)?;
    let plan = go_args(
        &root,
        &task,
        scope,
        target_path.as_deref(),
        test_name.as_deref(),
        extras.as_ref().unwrap_or(&TaskExtras::default()),
    )?;
    if plan.program == "govulncheck" && crate::process::resolve_executable("govulncheck")
        == std::path::PathBuf::from("govulncheck")
    {
        return Err("govulncheck is not installed. Use Install govulncheck first.".to_string());
    }
    let mut command = command_for(plan.program);
    command
        .current_dir(&root)
        .args(&plan.args)
        .envs(&plan.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    #[cfg(unix)]
    let pgid = i32::try_from(child.id()).map_err(|_| {
        let _ = child.kill();
        "Go task process ID is out of range".to_string()
    })?;
    let stdout = child.stdout.take().ok_or("Go stdout is unavailable")?;
    let stderr = child.stderr.take().ok_or("Go stderr is unavailable")?;
    let id = state.core.id("task");
    let child = Arc::new(Mutex::new(child));
    lock(&state.core.tasks)?.insert(
        id.clone(),
        TaskSession {
            child: child.clone(),
            #[cfg(unix)]
            pgid,
        },
    );
    let stdout_thread = read_task_stream(
        stdout,
        app.clone(),
        window_label.clone(),
        id.clone(),
        "stdout",
    );
    let stderr_thread = read_task_stream(
        stderr,
        app.clone(),
        window_label.clone(),
        id.clone(),
        "stderr",
    );
    let core = state.core.clone();
    let task_id = id.clone();
    let cover_profile = plan.cover_profile;
    let task_exit_root = root.clone();
    thread::spawn(move || {
        let code = loop {
            let result = child.lock().map(|mut child| child.try_wait());
            match result {
                Ok(Ok(Some(status))) => break status.code().unwrap_or(-1),
                Ok(Ok(None)) => thread::sleep(Duration::from_millis(50)),
                Ok(Err(error)) => {
                    let _ = app.emit_to(
                        &window_label,
                        "task-output",
                        json!({ "id": task_id, "stream": "stderr", "line": error.to_string() }),
                    );
                    break -1;
                }
                Err(_) => break -1,
            }
        };
        let _ = stdout_thread.join();
        let _ = stderr_thread.join();
        if let Ok(mut tasks) = core.tasks.lock() {
            tasks.remove(&task_id);
        }
        // Parse the coverage profile before the exit event so subscribers can
        // decorate editors as soon as the task is known to have finished.
        let coverage = cover_profile.as_ref().and_then(|path| {
            let parsed = fs::read_to_string(path)
                .ok()
                .and_then(|text| parse_cover_profile(&text));
            let _ = fs::remove_file(path);
            parsed
        });
        let mut exit = json!({ "id": task_id, "code": code });
        if let Some(coverage) = coverage {
            // Anchor workspace-relative profile paths to the module root so
            // the frontend can resolve them without guessing.
            if let serde_json::Value::Object(fields) = &mut exit {
                fields.insert("coverage".into(), serde_json::to_value(coverage).unwrap_or_default());
                fields.insert("root".into(), json!(task_exit_root.to_string_lossy()));
            }
        }
        let _ = app.emit_to(&window_label, "task-exit", exit);
    });
    Ok(id)
}

#[tauri::command(async)]
pub(crate) fn task_cancel(id: String, window: WebviewWindow, state: State<'_, AppState>) -> BackendResult<()> {
    let state = state.for_window(&window)?;
    let session = lock(&state.core.tasks)?
        .get(&id)
        .cloned()
        .ok_or_else(|| "Task has already exited".to_string())?;
    kill_task(&session)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;

    fn argv(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn test_task_emits_json_events() {
        let root = env::current_dir().unwrap();
        assert_eq!(
            argv(&go_args(&root, "test", None, None, None, &TaskExtras::default())
                .unwrap()
                .args),
            ["test", "-json", "-count=1", "./..."].map(String::from).to_vec()
        );
        let extras = TaskExtras {
            program_args: Some(vec!["-o".to_string(), "/tmp/other".to_string()]),
            ..TaskExtras::default()
        };
        for task in ["build", "fmt", "vet", "test", "mod_tidy"] {
            assert!(go_args(&root, task, None, None, None, &extras).is_err(), "{task}");
        }
    }

    #[test]
    fn run_file_scope_selects_its_package_and_rejects_escape() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base =
            env::temp_dir().join(format!("mgland-go-run-test-{}-{nonce}", std::process::id()));
        let root = base.join("project");
        let package = root.join("cmd/app");
        fs::create_dir_all(&package).unwrap();
        fs::write(package.join("main.go"), "package main\nfunc main() {}\n").unwrap();
        let root = fs::canonicalize(root).unwrap();
        assert_eq!(
            argv(&go_args(
                &root,
                "run",
                Some(GoTaskScope::File),
                Some("cmd/app/main.go"),
                None,
                &TaskExtras::default(),
            )
            .unwrap()
            .args),
            ["run", "./cmd/app"].map(String::from).to_vec()
        );
        let outside = base.join("outside.go");
        fs::write(&outside, "package main\n").unwrap();
        assert!(go_args(
            &root,
            "run",
            Some(GoTaskScope::File),
            outside.to_str(),
            None,
            &TaskExtras::default(),
        )
        .is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn run_configuration_extras_shape_the_command_line() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base =
            env::temp_dir().join(format!("mgland-run-extras-{nonce}-{}", std::process::id()));
        let package = base.join("cmd/app");
        fs::create_dir_all(&package).unwrap();
        fs::write(package.join("main.go"), "package main\nfunc main() {}\n").unwrap();
        let root = fs::canonicalize(&base).unwrap();

        let extras = TaskExtras {
            program_args: Some(vec!["-port".to_string(), "8080".to_string()]),
            build_tags: Some("integration".to_string()),
            race: Some(true),
            env_vars: Some(HashMap::from([(
                "SERVER_PORT".to_string(),
                "8080".to_string(),
            )])),
            ..TaskExtras::default()
        };
        let plan = go_args(&root, "run", Some(GoTaskScope::Directory), Some("cmd/app"), None, &extras)
            .unwrap();
        assert_eq!(
            argv(&plan.args),
            [
                "run",
                "-race",
                "-tags",
                "integration",
                "./cmd/app",
                "-port",
                "8080"
            ]
            .map(String::from)
            .to_vec()
        );
        assert_eq!(
            plan.env.get("SERVER_PORT").map(String::as_str),
            Some("8080")
        );
        assert!(plan.cover_profile.is_none());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn coverage_test_inserts_flags_before_the_package() {
        let root = env::current_dir().unwrap();
        let extras = TaskExtras {
            coverage: Some(true),
            build_tags: Some("race".to_string()),
            ..TaskExtras::default()
        };
        let plan = go_args(&root, "test", None, None, None, &extras).unwrap();
        let args = argv(&plan.args);
        assert!(plan.cover_profile.is_some());
        assert_eq!(args[0], "test");
        assert!(args.contains(&"-cover".to_string()));
        let profile_index = args
            .iter()
            .position(|arg| arg == "-coverprofile")
            .unwrap();
        // Coverage flags must precede the trailing package argument.
        assert_eq!(args.last().unwrap(), "./...");
        assert!(profile_index < args.len() - 1);
        assert!(args[profile_index + 1].contains("mgland-cover-"));
        // programArgs stays rejected for tests.
        let invalid = TaskExtras {
            program_args: Some(vec!["x".to_string()]),
            ..extras.clone()
        };
        assert!(go_args(&root, "test", None, None, None, &invalid).is_err());
    }

    #[test]
    fn extras_are_validated_before_use() {
        let root = env::current_dir().unwrap();
        let bad_env = TaskExtras {
            env_vars: Some(HashMap::from([("BAD-KEY".to_string(), "1".to_string())])),
            ..TaskExtras::default()
        };
        assert!(go_args(&root, "run", None, None, None, &bad_env).is_err());

        let bad_tags = TaskExtras {
            build_tags: Some("a b".to_string()),
            ..TaskExtras::default()
        };
        assert!(go_args(&root, "run", None, None, None, &bad_tags).is_err());

        let bad_module = TaskExtras {
            module: Some("-Injected=1".to_string()),
            ..TaskExtras::default()
        };
        assert!(go_args(&root, "mod_get", None, None, None, &bad_module).is_err());
        let good_module = TaskExtras {
            module: Some("github.com/pkg/module@v1.2.3".to_string()),
            ..TaskExtras::default()
        };
        assert_eq!(
            argv(&go_args(&root, "mod_get", None, None, None, &good_module)
                .unwrap()
                .args),
            ["get", "github.com/pkg/module@v1.2.3"].map(String::from).to_vec()
        );
    }

    #[test]
    fn cover_profiles_are_parsed_with_paths_positions_and_counts() {
        let profile = "mode: set\n\
            github.com/example/app/main.go:10.13,12.2 2 1\n\
            github.com/example/app/main.go:14.13,16.2 1 0\n\
            \"odd path with spaces.go\":1.2,3.4 1 5\n";
        let parsed = parse_cover_profile(profile).unwrap();
        assert_eq!(parsed.mode, "set");
        assert_eq!(parsed.files.len(), 2);
        assert_eq!(parsed.files[0].path, "github.com/example/app/main.go");
        assert_eq!(parsed.files[0].blocks.len(), 2);
        assert_eq!(parsed.files[0].blocks[0].start_line, 10);
        assert_eq!(parsed.files[0].blocks[0].statements, 2);
        assert_eq!(parsed.files[0].blocks[0].count, 1);
        assert_eq!(parsed.files[1].path, "odd path with spaces.go");
        assert_eq!(parsed.files[1].blocks[0].count, 5);
        assert!(parse_cover_profile("").is_none());
    }

}
