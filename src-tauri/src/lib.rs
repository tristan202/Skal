mod error;
mod local;
mod sftp;
mod ssh;
mod status;
mod store;

use error::Result;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use store::Host;
use tauri::Manager;

#[derive(Default)]
pub struct AppState {
    pub sessions: Mutex<HashMap<String, Arc<ssh::Session>>>,
    pub hostkey_waiters: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<bool>>>,
    pub transfers: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub edits: Mutex<HashMap<PathBuf, sftp::Edit>>,
    pub pool: status::Pool,
    counter: AtomicU64,
}

impl AppState {
    pub fn next_id(&self) -> u64 {
        self.counter.fetch_add(1, Ordering::Relaxed)
    }
}

// ---------- Hosts ----------
#[tauri::command]
fn can_encrypt() -> bool {
    store::can_encrypt()
}

#[tauri::command]
fn hosts_list() -> Vec<Value> {
    store::read_hosts().iter().map(Host::sanitized).collect()
}

#[tauri::command]
fn hosts_save(input: Value) -> Result<Value> {
    let s = |k: &str| input[k].as_str().unwrap_or("").trim().to_string();
    let mut hosts = store::read_hosts();
    let id = s("id");
    let i = hosts.iter().position(|h| !id.is_empty() && h.id == id);
    let prev = i.map(|i| hosts[i].clone()).unwrap_or_default();
    let auth = s("authType");
    let port = match &input["port"] {
        Value::Number(n) => n.as_u64().unwrap_or(22) as u16,
        Value::String(p) => p.trim().parse().unwrap_or(22),
        _ => 22,
    };
    // Tom adgangskode i formularen = behold den gemte, medmindre den udtrykkeligt ryddes
    let secret = |k: &str, clear: &str, old: &str| {
        if input[clear].as_bool().unwrap_or(false) {
            String::new()
        } else if let Some(p) = input[k].as_str().filter(|p| !p.is_empty()) {
            store::enc(p)
        } else {
            old.to_string()
        }
    };
    let h = Host {
        id: if id.is_empty() { uuid::Uuid::new_v4().to_string() } else { id },
        name: s("name"),
        group: s("group"),
        host: s("host"),
        port: if port == 0 { 22 } else { port },
        username: s("username"),
        auth_type: if ["password", "key", "agent"].contains(&auth.as_str()) { auth } else { "password".into() },
        key_path: s("keyPath"),
        color: input["color"].as_str().unwrap_or("").to_string(),
        password: secret("password", "clearPassword", &prev.password),
        passphrase: secret("passphrase", "clearPassphrase", &prev.passphrase),
    };
    match i {
        Some(i) => hosts[i] = h.clone(),
        None => hosts.push(h.clone()),
    }
    store::write_hosts(&hosts)?;
    Ok(h.sanitized())
}

#[tauri::command]
fn hosts_duplicate(id: String) -> Result<Option<Value>> {
    let mut hosts = store::read_hosts();
    let Some(src) = hosts.iter().find(|h| h.id == id) else { return Ok(None) };
    let mut copy = src.clone();
    copy.id = uuid::Uuid::new_v4().to_string();
    copy.name = format!("{} (kopi)", if src.name.is_empty() { &src.host } else { &src.name });
    hosts.push(copy.clone());
    store::write_hosts(&hosts)?;
    Ok(Some(copy.sanitized()))
}

#[tauri::command]
fn hosts_delete(id: String) -> Result<bool> {
    let hosts: Vec<Host> = store::read_hosts().into_iter().filter(|h| h.id != id).collect();
    store::write_hosts(&hosts)?;
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    store::migrate_secrets();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::default())
        .setup(|app| {
            status::start_cleanup(app.handle().clone());
            let title = format!("Skal {}", app.package_info().version);
            if let Some(w) = app.get_webview_window("main") {
                w.set_title(&title)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            can_encrypt,
            hosts_list,
            hosts_save,
            hosts_duplicate,
            hosts_delete,
            ssh::hostkey_answer,
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_disconnect,
            sftp::sftp_list,
            sftp::sftp_mkdir,
            sftp::sftp_rename,
            sftp::sftp_delete,
            sftp::sftp_existing,
            sftp::sftp_upload,
            sftp::sftp_download,
            sftp::sftp_cancel,
            sftp::sftp_edit,
            sftp::sftp_stop_edits,
            local::local_info,
            local::local_drives,
            local::local_list,
            local::local_mkdir,
            local::local_rename,
            local::local_trash,
            local::local_existing,
            local::local_open,
            local::show_item,
            status::metrics_get,
            status::ping_check,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                sftp::stop_edits(app, None);
                status::close_all(app);
            }
        });
}

