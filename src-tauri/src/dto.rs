use serde::Serialize;

#[derive(Clone, Serialize)]
pub(crate) struct FileEntry {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) is_dir: bool,
    pub(crate) ignored: bool,
}

#[derive(Serialize)]
pub(crate) struct BinaryPreview {
    pub(crate) size: u64,
    pub(crate) bytes: Vec<u8>,
    pub(crate) truncated: bool,
}

#[derive(Clone, Serialize)]
pub(crate) struct GitFileStatus {
    pub(crate) path: String,
    pub(crate) status: String,
    pub(crate) staged: bool,
    pub(crate) unstaged: bool,
}

#[derive(Clone, Serialize)]
pub(crate) struct GitStatus {
    pub(crate) branch: String,
    pub(crate) files: Vec<GitFileStatus>,
}

#[derive(Clone, Serialize)]
pub(crate) struct GitBranch {
    pub(crate) name: String,
    pub(crate) current: bool,
}

#[derive(Clone, Serialize)]
pub(crate) struct GitCommitResult {
    pub(crate) hash: String,
    pub(crate) status: GitStatus,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitLogEntry {
    pub(crate) hash: String,
    pub(crate) short_hash: String,
    pub(crate) subject: String,
    pub(crate) author: String,
    pub(crate) date: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitFileHistoryEntry {
    pub(crate) hash: String,
    pub(crate) short_hash: String,
    pub(crate) subject: String,
    pub(crate) author: String,
    pub(crate) date: String,
    pub(crate) path: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct ToolVersions {
    pub(crate) go: Option<String>,
    pub(crate) gopls: Option<String>,
    pub(crate) git: Option<String>,
    pub(crate) dlv: Option<String>,
    pub(crate) govulncheck: Option<String>,
}

#[derive(Clone, Default, Serialize, serde::Deserialize)]
#[serde(default)]
pub(crate) struct SearchOptions {
    pub(crate) regex: bool,
    pub(crate) case_sensitive: bool,
    pub(crate) whole_word: bool,
    pub(crate) include_ignored: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchMatch {
    pub(crate) line: u32,
    /// One-based character column of the match start.
    pub(crate) column: u32,
    pub(crate) length: u32,
    pub(crate) line_text: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct SearchFileResult {
    pub(crate) path: String,
    pub(crate) matches: Vec<SearchMatch>,
}

#[derive(Clone, Serialize)]
pub(crate) struct ReplaceFileResult {
    pub(crate) path: String,
    pub(crate) replacements: u32,
    /// Content before and after the replacement so open editor tabs can be
    /// updated without re-reading files or losing unsaved positions.
    pub(crate) before: String,
    pub(crate) after: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct GitStashEntry {
    pub(crate) index: u32,
    pub(crate) message: String,
    pub(crate) date: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct GitMergeResult {
    pub(crate) status: GitStatus,
    pub(crate) conflicted: bool,
    pub(crate) conflicts: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitBlameCommit {
    pub(crate) short_hash: String,
    pub(crate) author: String,
    pub(crate) date: String,
    pub(crate) summary: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitBlameResult {
    pub(crate) path: String,
    /// Final line number (one-based) to commit hash.
    pub(crate) lines: Vec<GitBlameLine>,
    pub(crate) commits: std::collections::HashMap<String, GitBlameCommit>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitBlameLine {
    pub(crate) line: u32,
    pub(crate) hash: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitGraphCommit {
    pub(crate) hash: String,
    pub(crate) short_hash: String,
    pub(crate) subject: String,
    pub(crate) author: String,
    pub(crate) date: String,
    pub(crate) parents: Vec<String>,
    /// Decoration names from %D, e.g. "HEAD -> main", "origin/main", "tag:v1".
    pub(crate) refs: Vec<String>,
    pub(crate) is_head: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoverageBlock {
    pub(crate) start_line: u32,
    pub(crate) start_col: u32,
    pub(crate) end_line: u32,
    pub(crate) end_col: u32,
    pub(crate) statements: u32,
    pub(crate) count: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoverageFile {
    pub(crate) path: String,
    pub(crate) blocks: Vec<CoverageBlock>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoverageProfile {
    pub(crate) mode: String,
    pub(crate) files: Vec<CoverageFile>,
}
