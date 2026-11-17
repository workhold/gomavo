//! Project-wide text search and replace, scoped to the open workspace.

use regex::RegexBuilder;
use std::fs;
use std::path::Path;
use tauri::{State, WebviewWindow};

use crate::dto::{ReplaceFileResult, SearchFileResult, SearchMatch, SearchOptions};
use crate::files::list_project_files_for_root;
use crate::paths::checked_directory;
use crate::state::{AppState, BackendResult};

/// Hard caps keep a pathological query (single-character search over a huge
/// vendor tree) from stalling the UI thread with tens of thousands of rows.
const MAX_MATCH_FILES: usize = 2_000;
const MAX_TOTAL_MATCHES: usize = 20_000;
const MAX_MATCHES_PER_FILE: usize = 500;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const BINARY_SNIFF_BYTES: usize = 8 * 1024;
/// Long lines are trimmed around the first match for the results list.
const MAX_LINE_SNIPPET: usize = 400;

#[derive(Clone)]
enum Matcher {
    Literal {
        query: Vec<char>,
        case_sensitive: bool,
        whole_word: bool,
    },
    Pattern {
        regex: regex::Regex,
    },
}

impl Matcher {
    fn new(query: &str, options: &SearchOptions) -> BackendResult<Self> {
        if query.is_empty() {
            return Err("Search query must not be empty".to_string());
        }
        if options.regex {
            let pattern = if options.whole_word {
                format!(r"\b(?:{query})\b")
            } else {
                query.to_string()
            };
            let regex = RegexBuilder::new(&pattern)
                .case_insensitive(!options.case_sensitive)
                .size_limit(8 * 1024 * 1024)
                .build()
                .map_err(|error| format!("Invalid regular expression: {error}"))?;
            Ok(Matcher::Pattern { regex })
        } else {
            Ok(Matcher::Literal {
                query: query.chars().collect(),
                case_sensitive: options.case_sensitive,
                whole_word: options.whole_word,
            })
        }
    }

    /// Match starts and lengths for one line, as zero-based character columns.
    fn find(&self, line: &str) -> Vec<(usize, usize)> {
        match self {
            Matcher::Literal {
                query,
                case_sensitive,
                whole_word,
            } => {
                let chars: Vec<char> = line.chars().collect();
                let mut matches = Vec::new();
                if query.is_empty() || query.len() > chars.len() {
                    return matches;
                }
                let mut start = 0;
                while start + query.len() <= chars.len() {
                    let window = &chars[start..start + query.len()];
                    let equal = if *case_sensitive {
                        window.iter().zip(query).all(|(a, b)| a == b)
                    } else {
                        window
                            .iter()
                            .zip(query)
                            .all(|(a, b)| a.to_lowercase().eq(b.to_lowercase()))
                    };
                    if equal && (!*whole_word || is_word_bounded(&chars, start, query.len())) {
                        matches.push((start, query.len()));
                        start += query.len();
                    } else {
                        start += 1;
                    }
                }
                matches
            }
            Matcher::Pattern { regex } => regex
                .find_iter(line)
                .map(|found| {
                    let column = line[..found.start()].chars().count();
                    let length = found.as_str().chars().count();
                    (column, length)
                })
                .collect(),
        }
    }

    fn is_literal(&self) -> bool {
        matches!(self, Matcher::Literal { .. })
    }
}

fn is_word_bounded(chars: &[char], start: usize, length: usize) -> bool {
    let word_char = |value: char| value.is_alphanumeric() || value == '_';
    let before_ok = start == 0 || !word_char(chars[start - 1]);
    let end = start + length;
    let after_ok = end >= chars.len() || !word_char(chars[end]);
    before_ok && after_ok
}

fn snippet_around(line: &str, column: usize) -> String {
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= MAX_LINE_SNIPPET {
        return line.trim_end_matches('\r').to_string();
    }
    let start = column.saturating_sub(MAX_LINE_SNIPPET / 2);
    let end = (start + MAX_LINE_SNIPPET).min(chars.len());
    let mut text: String = chars[start..end].iter().collect();
    if start > 0 {
        text.insert_str(0, "…");
    }
    if end < chars.len() {
        text.push('…');
    }
    text
}


fn search_file(path: &Path, matcher: &Matcher, budget: &mut usize) -> Vec<SearchMatch> {
    let Ok(content) = fs::read(path) else {
        return Vec::new();
    };
    if content[..content.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
        return Vec::new();
    }
    // Lossy decoding keeps searches working in mixed text trees; replacement
    // separately requires valid UTF-8 so it never corrupts a file.
    let text = String::from_utf8_lossy(&content);
    let mut matches = Vec::new();
    for (index, line) in text.split('\n').enumerate() {
        for (column, length) in matcher.find(line) {
            matches.push(SearchMatch {
                line: index as u32 + 1,
                column: column as u32 + 1,
                length: length as u32,
                line_text: snippet_around(line, column),
            });
            *budget -= 1;
            if *budget == 0 || matches.len() >= MAX_MATCHES_PER_FILE {
                return matches;
            }
        }
    }
    matches
}

fn candidate_files(root: &Path, options: &SearchOptions) -> Vec<std::path::PathBuf> {
    list_project_files_for_root(root, 10_000)
        .into_iter()
        .filter(|entry| options.include_ignored || !entry.ignored)
        .map(|entry| std::path::PathBuf::from(entry.path))
        .filter(|path| {
            fs::symlink_metadata(path)
                .is_ok_and(|metadata| metadata.is_file() && metadata.len() <= MAX_FILE_BYTES)
        })
        .collect()
}

fn search_files(root: &Path, matcher: &Matcher, options: &SearchOptions) -> Vec<SearchFileResult> {
    let mut results = Vec::new();
    let mut budget = MAX_TOTAL_MATCHES;
    for path in candidate_files(root, options) {
        if budget == 0 || results.len() >= MAX_MATCH_FILES {
            break;
        }
        let matches = search_file(&path, matcher, &mut budget);
        if matches.is_empty() {
            continue;
        }
        results.push(SearchFileResult {
            path: path.to_string_lossy().into_owned(),
            matches,
        });
    }
    results
}

/// Apply all matches of `matcher` to one file, preserving each line's ending
/// so CRLF files stay CRLF. Returns the new content when anything changed.
fn replace_in_content(content: &str, matcher: &Matcher, replacement: &str) -> Option<String> {
    let mut changed = false;
    let mut output = String::with_capacity(content.len());
    for segment in content.split_inclusive('\n') {
        let (body, ending) = match segment.strip_suffix('\n') {
            Some(_) if segment.ends_with("\r\n") => (&segment[..segment.len() - 2], "\r\n"),
            Some(body) => (body, "\n"),
            None => (segment, ""),
        };
        let matches = matcher.find(body);
        if matches.is_empty() {
            output.push_str(segment);
            continue;
        }
        changed = true;
        match matcher {
            Matcher::Literal { .. } => {
                // Reuse the same window scan as the search, so replacement
                // offsets stay in sync with reported matches.
                let chars: Vec<char> = body.chars().collect();
                let mut consumed = 0usize;
                for (column, length) in matches {
                    if column > consumed {
                        let text: String = chars[consumed..column].iter().collect();
                        output.push_str(&text);
                    }
                    output.push_str(replacement);
                    consumed = column + length;
                }
                if consumed < chars.len() {
                    let tail: String = chars[consumed..].iter().collect();
                    output.push_str(&tail);
                }
            }
            Matcher::Pattern { regex } => {
                // `$` has capture-group meaning in regex replacements; escape
                // it for literal replaces so references never expand.
                let text: std::borrow::Cow<'_, str> = if matcher.is_literal() {
                    replacement.replace('$', "$$").into()
                } else {
                    replacement.into()
                };
                let rewritten = regex.replace_all(body, text.as_ref()).into_owned();
                output.push_str(&rewritten);
            }
        }
        output.push_str(ending);
    }
    if changed {
        Some(output)
    } else {
        None
    }
}

#[tauri::command(async)]
pub(crate) fn search_in_files(
    root: String,
    query: String,
    options: SearchOptions,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<Vec<SearchFileResult>> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    let matcher = Matcher::new(&query, &options)?;
    Ok(search_files(&root, &matcher, &options))
}

#[tauri::command(async)]
pub(crate) fn replace_in_files(
    root: String,
    query: String,
    replacement: String,
    options: SearchOptions,
    paths: Option<Vec<String>>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> BackendResult<Vec<ReplaceFileResult>> {
    let state = state.for_window(&window)?;
    let root = checked_directory(&state, &root)?;
    let matcher = Matcher::new(&query, &options)?;
    let files: Vec<std::path::PathBuf> = match paths {
        // Restricting to explicit paths backs "replace in selected files".
        Some(paths) => paths
            .iter()
            .map(|path| crate::paths::checked_existing(&state, path))
            .collect::<BackendResult<Vec<_>>>()?,
        None => candidate_files(&root, &options),
    };
    let mut results = Vec::new();
    let mut budget = MAX_TOTAL_MATCHES;
    for path in files {
        if budget == 0 {
            break;
        }
        if path.is_dir()
            || fs::symlink_metadata(&path)
                .is_ok_and(|metadata| metadata.len() > MAX_FILE_BYTES)
        {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        if bytes.contains(&0) {
            continue; // Never rewrite a file that is not plain text.
        }
        let Ok(before) = String::from_utf8(bytes) else {
            continue;
        };
        // Budget on the number of replacements about to be applied.
        let prospective = before
            .split('\n')
            .take_while(|_| budget > 0)
            .map(|line| matcher.find(line).len())
            .sum::<usize>();
        if prospective == 0 {
            continue;
        }
        let Some(after) = replace_in_content(&before, &matcher, &replacement) else {
            continue;
        };
        budget = budget.saturating_sub(prospective.min(budget));
        fs::write(&path, &after).map_err(|e| e.to_string())?;
        results.push(ReplaceFileResult {
            path: path.to_string_lossy().into_owned(),
            replacements: prospective as u32,
            before,
            after,
        });
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn temp_workspace(tag: &str) -> std::path::PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base =
            env::temp_dir().join(format!("gomavo-search-{tag}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&base).unwrap();
        fs::canonicalize(&base).unwrap()
    }

    fn plain_options() -> SearchOptions {
        SearchOptions {
            regex: false,
            case_sensitive: false,
            whole_word: false,
            include_ignored: true,
        }

    }

    #[test]
    fn literal_matcher_honors_case_and_word_options() {
        let matcher = Matcher::new("Go", &plain_options()).unwrap();
        assert_eq!(matcher.find("go go").len(), 2);

        let sensitive = Matcher::new(
            "Go",
            &SearchOptions {
                case_sensitive: true,
                ..plain_options()
            },
        )
        .unwrap();
        assert_eq!(sensitive.find("go Go").len(), 1);

        let word = Matcher::new(
            "go",
            &SearchOptions {
                whole_word: true,
                ..plain_options()
            },
        )
        .unwrap();
        assert_eq!(word.find("go golang cargo").len(), 1);
    }

    #[test]
    fn regex_matcher_supports_groups_and_case_flags() {
        let matcher = Matcher::new(
            r"func (\w+)",
            &SearchOptions {
                regex: true,
                case_sensitive: true,
                whole_word: false,
                include_ignored: true,
            },
        )
        .unwrap();
        let matches = matcher.find("func main() {}");
        assert_eq!(matches, vec![(0, 9)]);

        let invalid = Matcher::new(
            "func (",
            &SearchOptions {
                regex: true,
                ..plain_options()
            },
        );
        assert!(invalid.is_err());
    }

    #[test]
    fn search_reports_columns_lines_and_snippets() {
        let root = temp_workspace("columns");
        fs::write(root.join("main.go"), "package main\n\nfunc main() {}\n").unwrap();
        let matcher = Matcher::new("main", &plain_options()).unwrap();
        let results = search_files(&root, &matcher, &plain_options());
        assert_eq!(results.len(), 1);
        let matches = &results[0].matches;
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].line, 1);
        assert_eq!(matches[0].column, 9);
        assert_eq!(matches[1].line, 3);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn search_skips_ignored_files_and_binaries() {
        let root = temp_workspace("ignored");
        assert!(crate::process::command_for("git")
            .current_dir(&root)
            .args(["init", "-q"])
            .status()
            .unwrap()
            .success());
        fs::write(root.join(".gitignore"), "skip.go\n").unwrap();
        fs::write(root.join("skip.go"), "target target\n").unwrap();
        fs::write(root.join("keep.go"), "target\n").unwrap();
        fs::write(root.join("blob.bin"), b"target\x00binary").unwrap();

        let matcher = Matcher::new("target", &plain_options()).unwrap();
        let excluding_ignored = SearchOptions {
            include_ignored: false,
            ..plain_options()
        };
        let results = search_files(&root, &matcher, &excluding_ignored);
        let paths: Vec<&str> = results
            .iter()
            .map(|result| result.path.as_str())
            .collect();
        assert!(paths.iter().any(|path| path.ends_with("keep.go")));
        assert!(!paths.iter().any(|path| path.ends_with("skip.go")));
        assert!(!paths.iter().any(|path| path.ends_with("blob.bin")));

        let including_ignored = SearchOptions {
            include_ignored: true,
            ..plain_options()
        };
        let results = search_files(&root, &matcher, &including_ignored);
        assert!(results
            .iter()
            .any(|result| result.path.ends_with("skip.go")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replace_preserves_line_endings_and_reports_deltas() {
        let root = temp_workspace("replace");
        fs::write(root.join("crlf.go"), "alpha beta\r\nbeta gamma\r\n").unwrap();
        fs::write(root.join("lf.go"), "beta\n").unwrap();
        fs::write(root.join("clean.go"), "unchanged\n").unwrap();

        let options = plain_options();
        let matcher = Matcher::new("beta", &options).unwrap();
        let mut results = Vec::new();
        for name in ["crlf.go", "lf.go", "clean.go"] {
            let path = root.join(name);
            let before = fs::read_to_string(&path).unwrap();
            if let Some(after) = replace_in_content(&before, &matcher, "delta") {
                fs::write(&path, &after).unwrap();
                results.push((name, before, after));
            }
        }
        assert_eq!(results.len(), 2);
        let (name, before, after) = &results[0];
        assert_eq!(*name, "crlf.go");
        assert_eq!(after, "alpha delta\r\ndelta gamma\r\n");
        assert_eq!(fs::read_to_string(root.join("crlf.go")).unwrap(), *after);
        assert_eq!(before, "alpha beta\r\nbeta gamma\r\n");
        assert_eq!(fs::read_to_string(root.join("lf.go")).unwrap(), "delta\n");
        assert_eq!(fs::read_to_string(root.join("clean.go")).unwrap(), "unchanged\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn literal_replacement_escapes_regex_captures() {
        let content = "cost: 5 dollars\n";
        let matcher = Matcher::new("5", &plain_options()).unwrap();
        let replaced = replace_in_content(content, &matcher, "$100").unwrap();
        assert_eq!(replaced, "cost: $100 dollars\n");

        let regex = Matcher::new(
            r"(\d+)",
            &SearchOptions {
                regex: true,
                ..plain_options()
            },
        )
        .unwrap();
        let replaced = replace_in_content(content, &regex, "€$1").unwrap();
        assert_eq!(replaced, "cost: €5 dollars\n");
    }
}
