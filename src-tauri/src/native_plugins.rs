//! Storage for GoMavo's own JavaScript plugins. A package is a small ZIP with
//! exactly `manifest.json` and `main.js`; archive entries are never extracted.

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Cursor, Read, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use zip::ZipArchive;

type PluginResult<T> = Result<T, String>;

const MAX_PACKAGE_BYTES: u64 = 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_CODE_BYTES: u64 = 512 * 1024;
const MAX_PLUGINS: usize = 100;
const MAX_COMMANDS: usize = 32;
const MAX_ACTIVATION_EVENTS: usize = 64;
static PLUGIN_IO_LOCK: Mutex<()> = Mutex::new(());
static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativePluginCommand {
    command: String,
    title: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativePluginContributions {
    #[serde(default)]
    commands: Vec<NativePluginCommand>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativePluginManifest {
    id: String,
    name: String,
    version: String,
    description: String,
    main: String,
    activation_events: Vec<String>,
    contributes: NativePluginContributions,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativePluginState {
    enabled: bool,
    installed_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativePluginRecord {
    manifest: NativePluginManifest,
    enabled: bool,
    installed_at: String,
}

fn safe_id(value: &str) -> bool {
    let mut chars = value.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_lowercase()) || value.len() > 80 {
        return false;
    }
    let mut separator = false;
    for ch in value.chars().skip(1) {
        if ch == '.' || ch == '-' {
            if separator {
                return false;
            }
            separator = true;
        } else if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            separator = false;
        } else {
            return false;
        }
    }
    !separator
}

fn visible_text(value: &str, max_chars: usize) -> bool {
    !value.trim().is_empty()
        && value.trim() == value
        && value.chars().count() <= max_chars
        && !value.chars().any(char::is_control)
}

fn validate_manifest(manifest: &NativePluginManifest) -> PluginResult<()> {
    if !safe_id(&manifest.id) {
        return Err("Plugin id must be a safe lowercase identifier".into());
    }
    if !visible_text(&manifest.name, 80) || !visible_text(&manifest.description, 500) {
        return Err("Plugin name or description is invalid".into());
    }
    if !visible_text(&manifest.version, 64)
        || !manifest
            .version
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ".-+".contains(ch))
    {
        return Err("Plugin version is invalid".into());
    }
    if manifest.main != "main.js" {
        return Err("Plugin main must be main.js".into());
    }
    if manifest.activation_events.is_empty()
        || manifest.activation_events.len() > MAX_ACTIVATION_EVENTS
    {
        return Err("Plugin must declare 1–64 activation events".into());
    }
    let mut events = HashSet::new();
    for event in &manifest.activation_events {
        let valid = event == "onStartupFinished"
            || event.strip_prefix("onLanguage:").is_some_and(safe_id)
            || event.strip_prefix("onCommand:").is_some_and(safe_id);
        if !valid || !events.insert(event) {
            return Err(format!("Invalid or duplicate activation event: {event}"));
        }
    }
    if manifest.contributes.commands.len() > MAX_COMMANDS {
        return Err("A plugin can contribute at most 32 commands".into());
    }
    let mut commands = HashSet::new();
    for command in &manifest.contributes.commands {
        if !safe_id(&command.command) || !visible_text(&command.title, 80) {
            return Err("Plugin command id or title is invalid".into());
        }
        if !commands.insert(&command.command) {
            return Err(format!("Duplicate plugin command: {}", command.command));
        }
    }
    Ok(())
}

fn directory_status(path: &Path, create: bool) -> PluginResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(format!(
                    "Plugin storage path is not a regular directory: {}",
                    path.display()
                ));
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|error| error.to_string())?;
            directory_status(path, false)
        }
        Err(error) => Err(error.to_string()),
    }
}

fn plugin_root(app: &AppHandle, create: bool) -> PluginResult<PathBuf> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    if !directory_status(&app_data, create)? {
        return Ok(app_data.join("plugins"));
    }
    let plugins = app_data.join("plugins");
    directory_status(&plugins, create)?;
    Ok(plugins)
}

fn plugin_dir(root: &Path, id: &str) -> PluginResult<PathBuf> {
    if !safe_id(id) {
        return Err("Invalid plugin id".into());
    }
    Ok(root.join(id))
}

fn read_regular_limited(path: &Path, limit: u64) -> PluginResult<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > limit {
        return Err(format!(
            "Plugin file is invalid or too large: {}",
            path.display()
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let file = options.open(path).map_err(|error| error.to_string())?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Plugin file is not a regular file".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("Plugin file exceeds its size limit".into());
    }
    Ok(bytes)
}

fn read_record(root: &Path, id: &str) -> PluginResult<NativePluginRecord> {
    let dir = plugin_dir(root, id)?;
    if !directory_status(&dir, false)? {
        return Err(format!("Plugin {id} is not installed"));
    }
    let manifest_bytes = read_regular_limited(&dir.join("manifest.json"), MAX_MANIFEST_BYTES)?;
    let manifest: NativePluginManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|error| error.to_string())?;
    validate_manifest(&manifest)?;
    if manifest.id != id {
        return Err("Stored plugin id does not match its directory".into());
    }
    let state_bytes = read_regular_limited(&dir.join("state.json"), 4096)?;
    let state: NativePluginState =
        serde_json::from_slice(&state_bytes).map_err(|error| error.to_string())?;
    let code = fs::symlink_metadata(dir.join("main.js")).map_err(|error| error.to_string())?;
    if code.file_type().is_symlink() || !code.is_file() || code.len() > MAX_CODE_BYTES {
        return Err("Stored plugin code is invalid".into());
    }
    Ok(NativePluginRecord {
        manifest,
        enabled: state.enabled,
        installed_at: state.installed_at,
    })
}

fn list_records(root: &Path) -> PluginResult<Vec<NativePluginRecord>> {
    if !directory_status(root, false)? {
        return Ok(Vec::new());
    }
    let mut records = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !safe_id(&id) {
            continue;
        }
        // A damaged record is omitted rather than preventing other plugins
        // from loading. read_record never follows a symlink.
        if let Ok(record) = read_record(root, &id) {
            records.push(record);
        }
    }
    records.sort_by(|left, right| left.manifest.id.cmp(&right.manifest.id));
    Ok(records)
}

fn read_package(path: &Path) -> PluginResult<(NativePluginManifest, String)> {
    if !path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".gomavo-plugin") || name.ends_with(".mgland-plugin"))
    {
        return Err("Choose a .gomavo-plugin package (older .mgland-plugin packages also work)".into());
    }
    let bytes = read_regular_limited(path, MAX_PACKAGE_BYTES)?;
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
    if archive.len() != 2 {
        return Err("A plugin package must contain only manifest.json and main.js".into());
    }
    let mut manifest_bytes = None;
    let mut code_bytes = None;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let limit = match entry.name() {
            "manifest.json" if manifest_bytes.is_none() => MAX_MANIFEST_BYTES,
            "main.js" if code_bytes.is_none() => MAX_CODE_BYTES,
            _ => return Err("Unexpected or duplicate plugin package entry".into()),
        };
        if entry.is_dir()
            || entry.size() > limit
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Invalid plugin package entry".into());
        }
        let mut contents = Vec::new();
        entry
            .by_ref()
            .take(limit + 1)
            .read_to_end(&mut contents)
            .map_err(|error| error.to_string())?;
        if contents.len() as u64 > limit {
            return Err("Plugin package entry exceeds its size limit".into());
        }
        match entry.name() {
            "manifest.json" => manifest_bytes = Some(contents),
            "main.js" => code_bytes = Some(contents),
            _ => unreachable!(),
        }
    }
    let manifest: NativePluginManifest =
        serde_json::from_slice(&manifest_bytes.ok_or("Plugin manifest.json is missing")?)
            .map_err(|error| format!("Invalid plugin manifest.json: {error}"))?;
    validate_manifest(&manifest)?;
    let code = String::from_utf8(code_bytes.ok_or("Plugin main.js is missing")?)
        .map_err(|_| "Plugin main.js must be UTF-8".to_string())?;
    if code.trim().is_empty() || code.contains('\0') {
        return Err("Plugin main.js must contain JavaScript source".into());
    }
    Ok((manifest, code))
}

fn unique_temp_path(root: &Path, label: &str) -> PluginResult<PathBuf> {
    for _ in 0..32 {
        let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let candidate = root.join(format!(".{label}-{}-{sequence}", std::process::id()));
        match fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Err(error) => return Err(error.to_string()),
            Ok(_) => continue,
        }
    }
    Err("Could not reserve plugin temporary path".into())
}

fn write_new_file(path: &Path, bytes: &[u8]) -> PluginResult<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

fn write_state(dir: &Path, state: &NativePluginState) -> PluginResult<()> {
    let bytes = serde_json::to_vec(state).map_err(|error| error.to_string())?;
    let temporary = unique_temp_path(dir, "state")?;
    write_new_file(&temporary, &bytes)?;
    if let Err(error) = fs::rename(&temporary, dir.join("state.json")) {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command(async)]
pub(crate) fn list_native_plugins(app: AppHandle) -> PluginResult<Vec<NativePluginRecord>> {
    let _guard = PLUGIN_IO_LOCK.lock().map_err(|error| error.to_string())?;
    list_records(&plugin_root(&app, false)?)
}

#[tauri::command(async)]
pub(crate) fn install_native_plugin(
    path: String,
    replace: bool,
    app: AppHandle,
) -> PluginResult<NativePluginRecord> {
    let (manifest, code) = read_package(Path::new(&path))?;
    let _guard = PLUGIN_IO_LOCK.lock().map_err(|error| error.to_string())?;
    let root = plugin_root(&app, true)?;
    let destination = plugin_dir(&root, &manifest.id)?;
    let exists = directory_status(&destination, false)?;
    if exists && !replace {
        return Err(format!("Plugin {} is already installed", manifest.id));
    }
    let records = list_records(&root)?;
    if !exists && records.len() >= MAX_PLUGINS {
        return Err("At most 100 plugins can be installed".into());
    }
    let own_commands: HashSet<_> = manifest
        .contributes
        .commands
        .iter()
        .map(|command| command.command.as_str())
        .collect();
    for record in &records {
        if record.manifest.id != manifest.id {
            if let Some(conflict) = record
                .manifest
                .contributes
                .commands
                .iter()
                .find(|command| own_commands.contains(command.command.as_str()))
            {
                return Err(format!(
                    "Command {} is already contributed by another plugin",
                    conflict.command
                ));
            }
        }
    }
    let enabled = if exists {
        read_record(&root, &manifest.id)?.enabled
    } else {
        true
    };
    let state = NativePluginState {
        enabled,
        installed_at: Utc::now().to_rfc3339_opts(SecondsFormat::Nanos, true),
    };
    let temporary = unique_temp_path(&root, "install")?;
    fs::create_dir(&temporary).map_err(|error| error.to_string())?;
    let install_result = (|| -> PluginResult<()> {
        write_new_file(
            &temporary.join("manifest.json"),
            &serde_json::to_vec(&manifest).map_err(|error| error.to_string())?,
        )?;
        write_new_file(&temporary.join("main.js"), code.as_bytes())?;
        write_new_file(
            &temporary.join("state.json"),
            &serde_json::to_vec(&state).map_err(|error| error.to_string())?,
        )?;
        if exists {
            let backup = unique_temp_path(&root, "backup")?;
            fs::rename(&destination, &backup).map_err(|error| error.to_string())?;
            if let Err(error) = fs::rename(&temporary, &destination) {
                let _ = fs::rename(&backup, &destination);
                return Err(error.to_string());
            }
            let _ = fs::remove_dir_all(backup);
        } else {
            fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
        }
        Ok(())
    })();
    if install_result.is_err() {
        let _ = fs::remove_dir_all(&temporary);
    }
    install_result?;
    Ok(NativePluginRecord {
        manifest,
        enabled,
        installed_at: state.installed_at,
    })
}

#[tauri::command(async)]
pub(crate) fn set_native_plugin_enabled(
    id: String,
    enabled: bool,
    app: AppHandle,
) -> PluginResult<()> {
    let _guard = PLUGIN_IO_LOCK.lock().map_err(|error| error.to_string())?;
    let root = plugin_root(&app, false)?;
    let record = read_record(&root, &id)?;
    write_state(
        &plugin_dir(&root, &id)?,
        &NativePluginState {
            enabled,
            installed_at: record.installed_at,
        },
    )
}

#[tauri::command(async)]
pub(crate) fn remove_native_plugin(id: String, app: AppHandle) -> PluginResult<()> {
    let _guard = PLUGIN_IO_LOCK.lock().map_err(|error| error.to_string())?;
    let root = plugin_root(&app, false)?;
    let dir = plugin_dir(&root, &id)?;
    if !directory_status(&dir, false)? {
        return Err(format!("Plugin {id} is not installed"));
    }
    fs::remove_dir_all(dir).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub(crate) fn read_native_plugin_code(id: String, app: AppHandle) -> PluginResult<String> {
    let _guard = PLUGIN_IO_LOCK.lock().map_err(|error| error.to_string())?;
    let root = plugin_root(&app, false)?;
    let record = read_record(&root, &id)?;
    if !record.enabled {
        return Err(format!("Plugin {id} is disabled"));
    }
    String::from_utf8(read_regular_limited(
        &plugin_dir(&root, &id)?.join("main.js"),
        MAX_CODE_BYTES,
    )?)
    .map_err(|_| "Stored plugin main.js is not UTF-8".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use zip::write::SimpleFileOptions;

    fn manifest() -> NativePluginManifest {
        NativePluginManifest {
            id: "example.hello".into(),
            name: "Hello".into(),
            version: "1.0.0".into(),
            description: "An example plugin".into(),
            main: "main.js".into(),
            activation_events: vec!["onCommand:example.hello.say".into()],
            contributes: NativePluginContributions {
                commands: vec![NativePluginCommand {
                    command: "example.hello.say".into(),
                    title: "Say hello".into(),
                }],
            },
        }
    }

    #[test]
    fn validates_manifest_and_rejects_duplicate_commands() {
        let mut value = manifest();
        assert!(validate_manifest(&value).is_ok());
        value
            .contributes
            .commands
            .push(value.contributes.commands[0].clone());
        assert!(validate_manifest(&value).is_err());
    }

    #[test]
    fn rejects_traversal_ids_and_unsupported_activation_events() {
        let mut value = manifest();
        value.id = "../outside".into();
        assert!(validate_manifest(&value).is_err());
        value.id = "example.hello".into();
        value.activation_events = vec!["onWorkspaceContains:go.mod".into()];
        assert!(validate_manifest(&value).is_err());
    }

    #[test]
    fn manifest_serializes_with_camel_case_activation_events() {
        let value = serde_json::to_value(manifest()).unwrap();
        assert_eq!(value["activationEvents"][0], "onCommand:example.hello.say");
        assert_eq!(
            value["contributes"]["commands"][0]["command"],
            "example.hello.say"
        );
    }

    #[test]
    fn package_accepts_only_the_two_expected_root_entries() {
        let path = std::env::temp_dir().join(format!(
            "gomavo-native-test-{}-{}.gomavo-plugin",
            std::process::id(),
            NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let write_package = |extra: bool| {
            let file = File::create(&path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("manifest.json", options).unwrap();
            zip.write_all(&serde_json::to_vec(&manifest()).unwrap())
                .unwrap();
            zip.start_file("main.js", options).unwrap();
            zip.write_all(b"exports.activate = () => {}; ").unwrap();
            if extra {
                zip.start_file("../outside.js", options).unwrap();
                zip.write_all(b"ignored").unwrap();
            }
            zip.finish().unwrap();
        };
        write_package(false);
        let (parsed, code) = read_package(&path).unwrap();
        assert_eq!(parsed.id, "example.hello");
        assert!(code.contains("activate"));
        let legacy_path = path.with_extension("mgland-plugin");
        fs::copy(&path, &legacy_path).unwrap();
        assert!(read_package(&legacy_path).is_ok());
        fs::remove_file(legacy_path).unwrap();
        write_package(true);
        assert!(read_package(&path).is_err());
        fs::remove_file(path).unwrap();
    }
}
