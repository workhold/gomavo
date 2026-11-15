//! Safe Go test/run argument construction and `go test -json` event decoding.
//!
//! The caller should start `go` with `current_dir(workspace_root)` and pass the
//! returned arguments directly to `Command::args`, without a shell.

use serde::Serialize;
use serde_json::Value;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug)]
pub enum TestScope<'a> {
    /// Tests declared in this `_test.go` file (or the matching test file for
    /// a selected ordinary `.go` source file).
    File(&'a Path),
    /// Only the package containing this directory.
    Package(&'a Path),
    /// This directory and all of its subpackages.
    Directory(&'a Path),
    /// Every package below the workspace root.
    Workspace,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GoTestEvent {
    pub action: String,
    pub package: Option<String>,
    pub test: Option<String>,
    pub output: Option<String>,
    pub elapsed_seconds: Option<f64>,
    pub failed_build: Option<String>,
    /// Build events use ImportPath, which is not always equal to Package.
    pub import_path: Option<String>,
}

/// Build arguments for `go test`. The workspace root is used as the process
/// working directory. Explicit test runs use `-count=1` so "rerun" always
/// executes rather than displaying a cached result.
pub fn test_args(
    workspace_root: &Path,
    scope: TestScope<'_>,
    test_name: Option<&str>,
) -> Result<Vec<OsString>, String> {
    let root = checked_root(workspace_root)?;
    let mut args = vec![os("test"), os("-json"), os("-count=1")];

    let package = match scope {
        TestScope::Workspace => PathBuf::from("./..."),
        TestScope::Package(path) => package_arg(&root, &checked_directory(&root, path)?, false)?,
        TestScope::Directory(path) => package_arg(&root, &checked_directory(&root, path)?, true)?,
        TestScope::File(path) => {
            let selected = checked_file(&root, path)?;
            if selected
                .extension()
                .is_none_or(|extension| extension != "go")
            {
                return Err("File test scope requires a Go source file".to_string());
            }
            let test_file = matching_test_file(&root, &selected)?;
            let names = test_names_in_file(&test_file)?;
            if names.is_empty() {
                return Err(format!(
                    "No Test, Example, or Fuzz functions found in {}",
                    test_file.display()
                ));
            }
            if let Some(name) = test_name {
                let parent = name.split('/').next().unwrap_or("");
                if !names.iter().any(|candidate| candidate == parent) {
                    return Err(format!(
                        "Test {name} is not declared in {}",
                        test_file.display()
                    ));
                }
                push_test_selection(&mut args, name)?;
            } else {
                let (benchmarks, tests): (Vec<_>, Vec<_>) = names
                    .iter()
                    .partition(|name| is_benchmark_function_name(name));
                args.push(os("-run"));
                args.push(os(names_pattern(&tests)));
                if !benchmarks.is_empty() {
                    args.push(os("-bench"));
                    args.push(os(names_pattern(&benchmarks)));
                }
            }
            let parent = test_file
                .parent()
                .ok_or("Go test file has no parent directory")?;
            package_arg(&root, parent, false)?
        }
    };

    if !matches!(scope, TestScope::File(_)) {
        if let Some(name) = test_name {
            push_test_selection(&mut args, name)?;
        }
    }
    args.push(package.into_os_string());
    Ok(args)
}

/// Build arguments for `go run <selected package>`. The Go tool validates
/// whether that package is `main`; this function validates its filesystem scope.
pub fn run_args(workspace_root: &Path, package_dir: &Path) -> Result<Vec<OsString>, String> {
    let root = checked_root(workspace_root)?;
    let package_dir = checked_directory(&root, package_dir)?;
    Ok(vec![
        os("run"),
        package_arg(&root, &package_dir, false)?.into_os_string(),
    ])
}

/// Like [`test_args`], but inserts extra `go test` build flags (for example
/// `-race` or `-tags`) right after the fixed `-count=1` prefix.
pub fn test_args_with_flags(
    workspace_root: &Path,
    scope: TestScope<'_>,
    test_name: Option<&str>,
    extra_flags: &[OsString],
) -> Result<Vec<OsString>, String> {
    let mut args = test_args(workspace_root, scope, test_name)?;
    if extra_flags.is_empty() {
        return Ok(args);
    }
    let prefix_end = args
        .iter()
        .position(|arg| arg.to_str() == Some("-count=1"))
        .map(|index| index + 1)
        .unwrap_or(0);
    for (offset, flag) in extra_flags.iter().enumerate() {
        args.insert(prefix_end + offset, flag.clone());
    }
    Ok(args)
}

/// Decode one stdout line from `go test -json`. Returns `None` for ordinary
/// stderr text, blank lines, and JSON without an Action field. Build events
/// are retained via `import_path` and `action` (`build-output`/`build-fail`).
#[allow(dead_code)] // Reference decoder; exercised by the unit tests below.
pub fn parse_test_event(line: &str) -> Option<GoTestEvent> {
    let value: Value = serde_json::from_str(line).ok()?;
    let object = value.as_object()?;
    let action = object.get("Action")?.as_str()?.to_string();
    Some(GoTestEvent {
        action,
        package: field_string(&value, "Package"),
        test: field_string(&value, "Test"),
        output: field_string(&value, "Output"),
        elapsed_seconds: object.get("Elapsed").and_then(Value::as_f64),
        failed_build: field_string(&value, "FailedBuild"),
        import_path: field_string(&value, "ImportPath"),
    })
}

fn field_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn os(value: impl Into<OsString>) -> OsString {
    value.into()
}

fn checked_root(root: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("Workspace root must be a directory".to_string());
    }
    Ok(root)
}

fn checked_existing(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let candidate = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    let canonical = fs::canonicalize(candidate).map_err(|error| error.to_string())?;
    if !canonical.starts_with(root) {
        return Err("Path is outside the open workspace".to_string());
    }
    Ok(canonical)
}

fn checked_directory(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let directory = checked_existing(root, candidate)?;
    if !directory.is_dir() {
        return Err("Expected a directory".to_string());
    }
    Ok(directory)
}

fn checked_file(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let file = checked_existing(root, candidate)?;
    if !file.is_file() {
        return Err("Expected a file".to_string());
    }
    Ok(file)
}

fn matching_test_file(root: &Path, selected: &Path) -> Result<PathBuf, String> {
    let name = selected
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid Go filename")?;
    if name.ends_with("_test.go") {
        return Ok(selected.to_path_buf());
    }
    let stem = selected
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or("Invalid Go filename")?;
    let candidate = selected.with_file_name(format!("{stem}_test.go"));
    checked_file(root, &candidate).map_err(|_| {
        format!(
            "No matching test file for {} (expected {stem}_test.go)",
            selected.display()
        )
    })
}

fn package_arg(root: &Path, directory: &Path, recursive: bool) -> Result<PathBuf, String> {
    let relative = directory
        .strip_prefix(root)
        .map_err(|_| "Path is outside the open workspace".to_string())?;
    // Go interprets `...` anywhere in a package argument as a wildcard, not
    // as literal filename characters. Reject such directory names so a
    // selected package cannot silently expand to more packages.
    if relative
        .components()
        .any(|component| component.as_os_str().to_string_lossy().contains("..."))
    {
        return Err("Package path contains Go's ... wildcard".to_string());
    }
    let mut arg = PathBuf::from(".");
    arg.push(relative);
    if recursive {
        arg.push("...");
    }
    Ok(arg)
}

fn exact_test_pattern(name: &str) -> Result<String, String> {
    if name.is_empty() || name.chars().any(char::is_control) {
        return Err("Invalid test name".to_string());
    }
    let mut parts = Vec::new();
    for part in name.split('/') {
        if part.is_empty() {
            return Err("Invalid test name".to_string());
        }
        parts.push(format!("^{}$", escape_regex(part)));
    }
    Ok(parts.join("/"))
}

fn push_test_selection(args: &mut Vec<OsString>, name: &str) -> Result<(), String> {
    let pattern = exact_test_pattern(name)?;
    if is_benchmark_function_name(name.split('/').next().unwrap_or("")) {
        // Benchmarks are disabled by default, while -run targets tests and examples.
        args.extend([os("-run"), os("^$"), os("-bench"), os(pattern)]);
    } else {
        args.extend([os("-run"), os(pattern)]);
    }
    Ok(())
}

fn names_pattern(names: &[&String]) -> String {
    if names.is_empty() {
        return "^$".to_string();
    }
    format!(
        "^({})$",
        names
            .iter()
            .map(|name| escape_regex(name))
            .collect::<Vec<_>>()
            .join("|")
    )
}

fn escape_regex(value: &str) -> String {
    let mut escaped = String::new();
    for ch in value.chars() {
        if matches!(
            ch,
            '.' | '+' | '*' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '|' | '\\'
        ) {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

fn test_names_in_file(path: &Path) -> Result<Vec<String>, String> {
    let source = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let tokens = top_level_tokens(&source);
    let mut names = Vec::new();
    for window in tokens.windows(3) {
        if window[0] == "func" && window[2] == "(" && is_test_function_name(&window[1]) {
            names.push(window[1].clone());
        }
    }
    names.sort();
    names.dedup();
    Ok(names)
}

fn is_test_function_name(name: &str) -> bool {
    for prefix in ["Test", "Fuzz", "Benchmark"] {
        if let Some(suffix) = name.strip_prefix(prefix) {
            return suffix.chars().next().is_none_or(|ch| !ch.is_lowercase());
        }
    }
    name.starts_with("Example")
}

fn is_benchmark_function_name(name: &str) -> bool {
    name.strip_prefix("Benchmark")
        .is_some_and(|suffix| suffix.chars().next().is_none_or(|ch| !ch.is_lowercase()))
}

/// A small lexer is enough to discover top-level test declarations without
/// matching fake declarations in comments, strings, or nested functions.
fn top_level_tokens(source: &str) -> Vec<String> {
    let mut chars = source.chars().peekable();
    let mut tokens = Vec::new();
    let mut depth = 0usize;
    while let Some(ch) = chars.next() {
        match ch {
            '/' if chars.peek() == Some(&'/') => {
                chars.next();
                for next in chars.by_ref() {
                    if next == '\n' {
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut previous = '\0';
                for next in chars.by_ref() {
                    if previous == '*' && next == '/' {
                        break;
                    }
                    previous = next;
                }
            }
            '"' | '\'' => {
                let quote = ch;
                let mut escaped = false;
                for next in chars.by_ref() {
                    if escaped {
                        escaped = false;
                    } else if next == '\\' {
                        escaped = true;
                    } else if next == quote {
                        break;
                    }
                }
            }
            '`' => {
                for next in chars.by_ref() {
                    if next == '`' {
                        break;
                    }
                }
            }
            '{' => depth += 1,
            '}' => depth = depth.saturating_sub(1),
            _ if ch.is_alphabetic() || ch == '_' => {
                let mut word = ch.to_string();
                while chars
                    .peek()
                    .is_some_and(|next| next.is_alphanumeric() || *next == '_')
                {
                    word.push(chars.next().expect("peeked character"));
                }
                if depth == 0 {
                    tokens.push(word);
                }
            }
            '(' if depth == 0 => tokens.push("(".to_string()),
            _ => {}
        }
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "mgland-go-tasks-{}-{}",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn write(&self, relative: &str, contents: &str) {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn argv(args: Vec<OsString>) -> Vec<String> {
        args.into_iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn scopes_select_the_expected_packages() {
        let workspace = TempDir::new();
        workspace.write("cmd/app/main.go", "package main\nfunc main() {}\n");
        assert_eq!(
            argv(test_args(&workspace.0, TestScope::Workspace, None).unwrap()),
            ["test", "-json", "-count=1", "./..."]
        );
        assert_eq!(
            argv(test_args(&workspace.0, TestScope::Package(Path::new("cmd/app")), None).unwrap()),
            ["test", "-json", "-count=1", "./cmd/app"]
        );
        assert_eq!(
            argv(test_args(&workspace.0, TestScope::Directory(Path::new("cmd")), None).unwrap()),
            ["test", "-json", "-count=1", "./cmd/..."]
        );
        assert_eq!(
            argv(run_args(&workspace.0, Path::new("cmd/app")).unwrap()),
            ["run", "./cmd/app"]
        );
    }

    #[test]
    fn file_scope_runs_its_declarations_in_the_complete_package() {
        let workspace = TempDir::new();
        workspace.write("p/widget.go", "package p\n");
        workspace.write(
            "p/widget_test.go",
            "package p\n// func TestFake(t *testing.T) {}\nvar s = `func TestAlsoFake(t *testing.T) {}`\nfunc TestWidget(t *testing.T) {\n  t.Run(\"case\", func(t *testing.T) {})\n}\nfunc ExampleWidget() {}\nfunc FuzzWidget(f *testing.F) {}\nfunc BenchmarkWidget(b *testing.B) {}\nfunc Benchmarklower(b *testing.B) {}\nfunc Testlower(t *testing.T) {}\n",
        );
        workspace.write(
            "p/other_test.go",
            "package p\nfunc TestOther(t *testing.T) {}\n",
        );
        let args = argv(
            test_args(
                &workspace.0,
                TestScope::File(Path::new("p/widget.go")),
                None,
            )
            .unwrap(),
        );
        assert_eq!(
            args,
            [
                "test",
                "-json",
                "-count=1",
                "-run",
                "^(ExampleWidget|FuzzWidget|TestWidget)$",
                "-bench",
                "^(BenchmarkWidget)$",
                "./p"
            ]
        );
        let nested = argv(
            test_args(
                &workspace.0,
                TestScope::File(Path::new("p/widget_test.go")),
                Some("TestWidget/case[1]"),
            )
            .unwrap(),
        );
        assert_eq!(
            nested,
            [
                "test",
                "-json",
                "-count=1",
                "-run",
                "^TestWidget$/^case\\[1\\]$",
                "./p"
            ]
        );
        let benchmark = argv(
            test_args(
                &workspace.0,
                TestScope::File(Path::new("p/widget_test.go")),
                Some("BenchmarkWidget/case[1]"),
            )
            .unwrap(),
        );
        assert_eq!(
            benchmark,
            [
                "test",
                "-json",
                "-count=1",
                "-run",
                "^$",
                "-bench",
                "^BenchmarkWidget$/^case\\[1\\]$",
                "./p"
            ]
        );
        assert!(test_args(
            &workspace.0,
            TestScope::File(Path::new("p/widget_test.go")),
            Some("TestOther")
        )
        .is_err());
    }

    #[test]
    fn benchmark_only_file_does_not_run_unrelated_tests() {
        let workspace = TempDir::new();
        workspace.write(
            "p/benchmark_test.go",
            "package p\nfunc BenchmarkOnly(b *testing.B) {}\n",
        );
        workspace.write(
            "p/other_test.go",
            "package p\nfunc TestOther(t *testing.T) {}\n",
        );
        assert_eq!(
            argv(
                test_args(
                    &workspace.0,
                    TestScope::File(Path::new("p/benchmark_test.go")),
                    None,
                )
                .unwrap()
            ),
            [
                "test",
                "-json",
                "-count=1",
                "-run",
                "^$",
                "-bench",
                "^(BenchmarkOnly)$",
                "./p"
            ]
        );
    }

    #[test]
    fn selected_paths_cannot_escape_the_workspace() {
        let workspace = TempDir::new();
        let outside = TempDir::new();
        outside.write("main.go", "package main\n");
        assert!(run_args(&workspace.0, &outside.0).is_err());
        assert!(test_args(&workspace.0, TestScope::Package(&outside.0), None).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside.0, workspace.0.join("escape")).unwrap();
            assert!(run_args(&workspace.0, Path::new("escape")).is_err());
        }
    }

    #[test]
    fn literal_directory_named_like_go_wildcard_is_rejected() {
        let workspace = TempDir::new();
        fs::create_dir_all(workspace.0.join("cmd...old")).unwrap();
        assert!(run_args(&workspace.0, Path::new("cmd...old")).is_err());
        assert!(test_args(
            &workspace.0,
            TestScope::Directory(Path::new("cmd...old")),
            None
        )
        .is_err());
    }

    #[test]
    fn test_name_is_literal_and_cannot_change_go_flags() {
        let workspace = TempDir::new();
        let args = argv(
            test_args(
                &workspace.0,
                TestScope::Workspace,
                Some("TestA[1]/-count=0"),
            )
            .unwrap(),
        );
        assert_eq!(
            args,
            [
                "test",
                "-json",
                "-count=1",
                "-run",
                "^TestA\\[1\\]$/^-count=0$",
                "./..."
            ]
        );
        assert!(test_args(&workspace.0, TestScope::Workspace, Some("TestA\nInjected")).is_err());
        assert!(test_args(&workspace.0, TestScope::Workspace, Some("TestA//case")).is_err());
        assert_eq!(
            argv(test_args(&workspace.0, TestScope::Workspace, Some("BenchmarkA[1]")).unwrap()),
            [
                "test",
                "-json",
                "-count=1",
                "-run",
                "^$",
                "-bench",
                "^BenchmarkA\\[1\\]$",
                "./..."
            ]
        );
    }

    #[test]
    fn parses_test_and_build_events_without_conflating_package_ids() {
        let test = parse_test_event(r#"{"Action":"fail","Package":"example.com/p","Test":"TestX/case","Elapsed":0.12,"Output":"bad\n","FailedBuild":"example.com/p [example.com/p.test]"}"#).unwrap();
        assert_eq!(test.action, "fail");
        assert_eq!(test.package.as_deref(), Some("example.com/p"));
        assert_eq!(test.test.as_deref(), Some("TestX/case"));
        assert_eq!(test.output.as_deref(), Some("bad\n"));
        assert_eq!(
            test.failed_build.as_deref(),
            Some("example.com/p [example.com/p.test]")
        );
        let build = parse_test_event(r#"{"ImportPath":"example.com/p [example.com/p.test]","Action":"build-output","Output":"syntax error\n"}"#).unwrap();
        assert_eq!(build.package, None);
        assert_eq!(
            build.import_path.as_deref(),
            Some("example.com/p [example.com/p.test]")
        );
        assert_eq!(parse_test_event("compile error"), None);
        assert_eq!(parse_test_event("{}"), None);
    }
}
