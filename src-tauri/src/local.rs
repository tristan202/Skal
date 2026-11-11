// Den lokale side af fil-commanderen.
use crate::error::{Error, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[tauri::command]
pub fn local_info() -> Value {
    let platform = if cfg!(windows) { "win32" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" };
    json!({ "home": dirs::home_dir(), "sep": std::path::MAIN_SEPARATOR_STR, "platform": platform })
}

#[tauri::command]
pub fn local_drives() -> Vec<String> {
    if !cfg!(windows) {
        return vec!["/".into()];
    }
    ('C'..='Z').map(|c| format!("{c}:\\")).filter(|d| Path::new(d).exists()).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    is_dir: bool,
    is_link: bool,
    size: u64,
    mtime: u64,
    hidden: bool,
}

#[cfg(windows)]
fn os_hidden(m: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_SYSTEM};
    m.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0
}
#[cfg(not(windows))]
fn os_hidden(_: &std::fs::Metadata) -> bool {
    false
}

#[tauri::command]
pub fn local_list(dir: Option<String>) -> Result<Value> {
    let dir = dir.filter(|d| !d.is_empty()).map(PathBuf::from).or_else(dirs::home_dir).unwrap_or_default();
    let real = std::path::absolute(&dir)?;
    let mut entries = Vec::new();
    for d in std::fs::read_dir(&real)? {
        let d = d?;
        let name = d.file_name().to_string_lossy().into_owned();
        let is_link = d.file_type().is_ok_and(|t| t.is_symlink());
        let hidden = name.starts_with('.') || d.metadata().is_ok_and(|m| os_hidden(&m));
        entries.push(match std::fs::metadata(d.path()) {
            Ok(st) => Entry {
                name,
                is_dir: st.is_dir(),
                is_link,
                size: st.len(),
                mtime: st.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs()),
                hidden,
            },
            // Låste filer (fx pagefile.sys) og døde links vises uden detaljer
            Err(_) => Entry { name, is_dir: d.file_type().is_ok_and(|t| t.is_dir()), is_link, size: 0, mtime: 0, hidden: true },
        });
    }
    Ok(json!({ "path": real, "parent": real.parent(), "entries": entries }))
}

#[tauri::command]
pub fn local_mkdir(path: String) -> Result<bool> {
    std::fs::create_dir(path)?;
    Ok(true)
}

#[tauri::command]
pub fn local_rename(from: String, to: String) -> Result<bool> {
    // Kun store/små bogstaver ændret er tilladt, selvom "to" findes på Windows
    if Path::new(&to).exists() && from.to_lowercase() != to.to_lowercase() {
        return Err(Error::key("err.nameExists"));
    }
    std::fs::rename(from, to)?;
    Ok(true)
}

// Lokale filer slettes aldrig permanent – de lægges i papirkurven
#[tauri::command]
pub fn local_trash(paths: Vec<String>) -> Result<bool> {
    trash::delete_all(paths).map_err(Error::msg)?;
    Ok(true)
}

#[tauri::command]
pub fn local_existing(dir: String, names: Vec<String>) -> Result<Vec<String>> {
    let norm = |s: &str| if cfg!(windows) { s.to_lowercase() } else { s.to_string() };
    let have: std::collections::HashSet<String> =
        std::fs::read_dir(dir)?.filter_map(|e| e.ok()).map(|e| norm(&e.file_name().to_string_lossy())).collect();
    Ok(names.into_iter().filter(|n| have.contains(&norm(n))).collect())
}

#[tauri::command]
pub fn local_open(path: String) -> Result<bool> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(Error::msg)?;
    Ok(true)
}

#[tauri::command]
pub fn show_item(path: String) -> Result<bool> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(Error::msg)?;
    Ok(true)
}
