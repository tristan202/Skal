// Filoverførsel over SFTP. Genbruger terminalsessionens SSH-forbindelse,
// så der ikke skal logges ind igen.
use crate::error::{Error, Result};
use crate::ssh::{open_sftp, Session};
use crate::AppState;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const CHUNK: usize = 256 * 1024;
const MAX_DEPTH: usize = 40;

type BoxFut<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

fn session(app: &AppHandle, sid: &str) -> Result<Arc<Session>> {
    app.state::<AppState>().sessions.lock().unwrap().get(sid).cloned().ok_or_else(|| Error::key("err.notConnected"))
}

async fn shared(app: &AppHandle, sid: &str) -> Result<Arc<SftpSession>> {
    let s = session(app, sid)?;
    let mut g = s.sftp.lock().await;
    if let Some(x) = &*g {
        return Ok(x.clone());
    }
    let x = Arc::new(open_sftp(&s.conn).await?);
    *g = Some(x.clone());
    Ok(x)
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}
fn basename(p: &str) -> &str {
    p.trim_end_matches('/').rsplit('/').next().unwrap_or(p)
}

// ---------- Browse ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    is_dir: bool,
    is_link: bool,
    size: u64,
    mtime: u32,
    mode: u32,
}

#[tauri::command]
pub async fn sftp_list(app: AppHandle, sid: String, dir: Option<String>) -> Result<Value> {
    let sftp = shared(&app, &sid).await?;
    let dir = dir.filter(|d| !d.is_empty()).unwrap_or_else(|| ".".into());
    let real = sftp.canonicalize(dir).await?;
    let mut entries = Vec::new();
    for it in sftp.read_dir(real.as_str()).await? {
        let a = it.metadata();
        let name = it.file_name();
        let is_link = a.is_symlink();
        let mut is_dir = a.is_dir();
        if is_link {
            if let Ok(t) = sftp.metadata(join(&real, &name)).await {
                is_dir = t.is_dir();
            }
        }
        entries.push(Entry { name, is_dir, is_link, size: a.size.unwrap_or(0), mtime: a.mtime.unwrap_or(0), mode: a.permissions.unwrap_or(0) });
    }
    Ok(json!({ "path": real, "entries": entries }))
}

#[tauri::command]
pub async fn sftp_mkdir(app: AppHandle, sid: String, path: String) -> Result<bool> {
    shared(&app, &sid).await?.create_dir(path).await?;
    Ok(true)
}

#[tauri::command]
pub async fn sftp_rename(app: AppHandle, sid: String, from: String, to: String) -> Result<bool> {
    shared(&app, &sid).await?.rename(from, to).await?;
    Ok(true)
}

#[tauri::command]
pub async fn sftp_delete(app: AppHandle, sid: String, path: String) -> Result<bool> {
    rmrf(&*shared(&app, &sid).await?, path).await?;
    Ok(true)
}

fn rmrf(sftp: &SftpSession, p: String) -> BoxFut<'_, ()> {
    Box::pin(async move {
        if sftp.symlink_metadata(p.as_str()).await?.is_dir() {
            for it in sftp.read_dir(p.as_str()).await? {
                rmrf(sftp, join(&p, &it.file_name())).await?;
            }
            sftp.remove_dir(p).await?;
        } else {
            sftp.remove_file(p).await?;
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn sftp_existing(app: AppHandle, sid: String, dir: String, names: Vec<String>) -> Result<Vec<String>> {
    let have: std::collections::HashSet<String> =
        shared(&app, &sid).await?.read_dir(dir).await?.map(|e| e.file_name()).collect();
    Ok(names.into_iter().filter(|n| have.contains(n)).collect())
}

// ---------- Overførsler ----------
struct Reporter {
    app: AppHandle,
    id: String,
    total: u64,
    last: Instant,
}

impl Reporter {
    fn report(&mut self, done: u64, file: &str, force: bool) {
        if !force && self.last.elapsed() < Duration::from_millis(120) {
            return;
        }
        self.last = Instant::now();
        let _ = self.app.emit("sftp-progress", json!({ "id": self.id, "done": done, "total": self.total, "file": file, "state": "running" }));
    }
}

async fn run_transfer<F>(app: &AppHandle, id: &str, work: impl FnOnce(Arc<AtomicBool>) -> F) -> Value
where
    F: Future<Output = Result<Value>>,
{
    let st = app.state::<AppState>();
    let cancel = Arc::new(AtomicBool::new(false));
    st.transfers.lock().unwrap().insert(id.into(), cancel.clone());
    let res = work(cancel.clone()).await;
    st.transfers.lock().unwrap().remove(id);
    match res {
        Ok(mut v) => {
            v["id"] = json!(id);
            v["state"] = json!("done");
            let _ = app.emit("sftp-progress", &v);
            v
        }
        Err(e) => {
            let cancelled = cancel.load(Ordering::Relaxed);
            let state = if cancelled { "cancelled" } else { "error" };
            let msg = if cancelled { Value::String(String::new()) } else { serde_json::to_value(&e).unwrap() };
            let _ = app.emit("sftp-progress", json!({ "id": id, "state": state, "error": msg }));
            json!({ "error": msg, "state": state })
        }
    }
}

fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) { Err(Error::key("err.cancelled")) } else { Ok(()) }
}

#[tauri::command]
pub fn sftp_cancel(state: tauri::State<'_, AppState>, id: String) -> bool {
    if let Some(c) = state.transfers.lock().unwrap().get(&id) {
        c.store(true, Ordering::Relaxed);
    }
    true
}

// Kopierer i blokke, så annullering og fremskridt virker midt i en fil
async fn pump<R, W>(r: &mut R, w: &mut W, cancel: &AtomicBool, mut step: impl FnMut(u64)) -> Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; CHUNK];
    let mut sent = 0u64;
    loop {
        check(cancel)?;
        let n = r.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        w.write_all(&buf[..n]).await?;
        sent += n as u64;
        step(sent);
    }
    w.shutdown().await?;
    Ok(())
}

struct LocalFile {
    local: PathBuf,
    remote: String,
    size: u64,
}

// Links til mapper følges ikke (undgår løkker)
fn walk_local(local: &Path, remote: String, depth: usize, dirs: &mut Vec<String>, files: &mut Vec<LocalFile>) -> Result<()> {
    let st = std::fs::symlink_metadata(local)?;
    if st.is_symlink() {
        if let Ok(real) = std::fs::metadata(local) {
            if real.is_file() {
                files.push(LocalFile { local: local.into(), remote, size: real.len() });
            }
        }
    } else if st.is_dir() {
        if depth > MAX_DEPTH {
            return Ok(());
        }
        dirs.push(remote.clone());
        for e in std::fs::read_dir(local)? {
            let e = e?;
            let name = e.file_name().to_string_lossy().into_owned();
            walk_local(&e.path(), join(&remote, &name), depth + 1, dirs, files)?;
        }
    } else if st.is_file() {
        files.push(LocalFile { local: local.into(), remote, size: st.len() });
    }
    Ok(())
}

// Upload: lokale filer og mapper -> remoteDir
#[tauri::command]
pub async fn sftp_upload(app: AppHandle, sid: String, id: String, paths: Vec<String>, dir: String) -> Value {
    let a = app.clone();
    run_transfer(&app, &id.clone(), move |cancel| async move {
        let (mut dirs, mut files) = (Vec::new(), Vec::new());
        for p in &paths {
            let p = Path::new(p);
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            walk_local(p, join(&dir, &name), 0, &mut dirs, &mut files)?;
        }
        let total: u64 = files.iter().map(|f| f.size).sum();
        let mut rep = Reporter { app: a.clone(), id, total, last: Instant::now() };
        rep.report(0, "", true);
        let sftp = open_sftp(&session(&a, &sid)?.conn).await?;
        check(&cancel)?;

        for d in &dirs {
            if let Err(e) = sftp.create_dir(d.as_str()).await {
                if !sftp.metadata(d.as_str()).await.is_ok_and(|m| m.is_dir()) {
                    return Err(e.into());
                }
            }
        }
        let mut done = 0;
        for f in &files {
            let name = f.local.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let mut src = tokio::fs::File::open(&f.local).await?;
            let mut dst = sftp.create(f.remote.as_str()).await?;
            pump(&mut src, &mut dst, &cancel, |n| rep.report(done + n, &name, false)).await?;
            done += f.size;
            rep.report(done, &name, true);
        }
        let _ = sftp.close().await;
        Ok(json!({ "done": total, "total": total, "files": files.len() }))
    })
    .await
}

// Windows tillader ikke alle tegn i filnavne
fn safe_name(n: &str) -> String {
    if !cfg!(windows) {
        return n.into();
    }
    let s: String = n.chars().map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 32 { '_' } else { c }).collect();
    let trimmed = s.trim_end_matches(['.', ' ']);
    if trimmed.len() == s.len() { s } else { format!("{trimmed}_") }
}

fn unique_path(p: PathBuf) -> PathBuf {
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let mut c = p.clone();
    let mut i = 1;
    while c.exists() {
        c = p.with_file_name(format!("{stem} ({i}){ext}"));
        i += 1;
    }
    c
}

struct RemoteFile {
    remote: String,
    local: PathBuf,
    size: u64,
}

fn walk_remote<'a>(
    sftp: &'a SftpSession,
    remote: String,
    local: PathBuf,
    depth: usize,
    cancel: &'a AtomicBool,
    dirs: &'a mut Vec<PathBuf>,
    files: &'a mut Vec<RemoteFile>,
) -> BoxFut<'a, ()> {
    Box::pin(async move {
        check(cancel)?;
        let st = sftp.metadata(remote.as_str()).await?;
        if st.is_dir() {
            if depth > MAX_DEPTH {
                return Ok(());
            }
            dirs.push(local.clone());
            for it in sftp.read_dir(remote.as_str()).await? {
                let name = it.file_name();
                walk_remote(sftp, join(&remote, &name), local.join(safe_name(&name)), depth + 1, cancel, dirs, files).await?;
            }
        } else {
            files.push(RemoteFile { remote, local, size: st.size.unwrap_or(0) });
        }
        Ok(())
    })
}

#[derive(Deserialize)]
pub struct Item {
    path: String,
}
#[derive(Deserialize, Default)]
pub struct DownloadOpts {
    #[serde(default)]
    overwrite: bool,
}

// Download: fjernfiler og -mapper -> localDir (standard: Overførsler)
#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    sid: String,
    id: String,
    items: Vec<Item>,
    dir: Option<String>,
    opts: Option<DownloadOpts>,
) -> Value {
    let a = app.clone();
    run_transfer(&app, &id.clone(), move |cancel| async move {
        let target = dir.map(PathBuf::from).or_else(dirs::download_dir).unwrap_or_default();
        let overwrite = opts.unwrap_or_default().overwrite;
        let sftp = open_sftp(&session(&a, &sid)?.conn).await?;
        let (mut dirs, mut files, mut tops) = (Vec::new(), Vec::new(), Vec::new());
        for it in items {
            let dest = target.join(safe_name(basename(&it.path)));
            let local = if overwrite { dest } else { unique_path(dest) };
            tops.push(local.clone());
            walk_remote(&sftp, it.path, local, 0, &cancel, &mut dirs, &mut files).await?;
        }
        let total: u64 = files.iter().map(|f| f.size).sum();
        let mut rep = Reporter { app: a.clone(), id, total, last: Instant::now() };
        rep.report(0, "", true);
        for d in &dirs {
            tokio::fs::create_dir_all(d).await?;
        }
        let mut done = 0;
        for f in &files {
            let name = basename(&f.remote).to_string();
            let mut src = sftp.open(f.remote.as_str()).await?;
            let mut dst = tokio::fs::File::create(&f.local).await?;
            pump(&mut src, &mut dst, &cancel, |n| rep.report(done + n, &name, false)).await?;
            done += f.size;
            rep.report(done, &name, true);
        }
        let _ = sftp.close().await;
        Ok(json!({ "done": total, "total": total, "files": files.len(), "localPath": tops.first() }))
    })
    .await
}

// ---------- Redigér fjernfil lokalt (som i WinSCP) ----------
// Filen hentes til en midlertidig mappe og åbnes i standardprogrammet.
// Hver gang den gemmes, uploades den automatisk tilbage til serveren.
pub struct Edit {
    sid: String,
    remote: String,
    dir: PathBuf,
    _watcher: notify::RecommendedWatcher,
}

fn open_local(p: &Path) -> Result<()> {
    tauri_plugin_opener::open_path(p, None::<&str>).map_err(Error::msg)
}

#[tauri::command]
pub async fn sftp_edit(app: AppHandle, sid: String, path: String) -> Result<String> {
    let st = app.state::<AppState>();
    // Er filen allerede åben, genbruges den lokale kopi
    let open = st.edits.lock().unwrap().iter().find(|(_, e)| e.sid == sid && e.remote == path).map(|(l, _)| l.clone());
    if let Some(local) = open {
        open_local(&local)?;
        return Ok(local.to_string_lossy().into());
    }
    let sftp = shared(&app, &sid).await?;
    let dir = std::env::temp_dir().join(format!("skal-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir)?;
    let local = dir.join(safe_name(basename(&path)));
    let mut src = sftp.open(path.as_str()).await?;
    let mut dst = tokio::fs::File::create(&local).await?;
    pump(&mut src, &mut dst, &AtomicBool::new(false), |_| {}).await?;
    drop(dst);

    // Mappen overvåges (ikke filen), fordi mange editorer gemmer ved at erstatte filen
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let mut watcher = notify::recommended_watcher(move |_| {
        let _ = tx.send(());
    })
    .map_err(Error::msg)?;
    notify::Watcher::watch(&mut watcher, &dir, notify::RecursiveMode::NonRecursive).map_err(Error::msg)?;

    let mtime = Mutex::new(std::fs::metadata(&local)?.modified()?);
    let (a, l, s, r) = (app.clone(), local.clone(), sid.clone(), path.clone());
    tokio::spawn(async move {
        // Slutter, når overvågningen stoppes (tx lukkes sammen med watcher)
        while rx.recv().await.is_some() {
            loop {
                match tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
                    Ok(Some(())) => continue,
                    Ok(None) => return,
                    Err(_) => break,
                }
            }
            push_edit(&a, &l, &s, &r, &mtime).await;
        }
    });

    st.edits.lock().unwrap().insert(local.clone(), Edit { sid, remote: path, dir, _watcher: watcher });
    open_local(&local)?;
    Ok(local.to_string_lossy().into())
}

async fn push_edit(app: &AppHandle, local: &Path, sid: &str, remote: &str, last: &Mutex<SystemTime>) {
    let Ok(m) = std::fs::metadata(local).and_then(|m| m.modified()) else { return };
    {
        let mut l = last.lock().unwrap();
        if *l == m {
            return;
        }
        *l = m;
    }
    let res: Result<()> = async {
        let sftp = shared(app, sid).await?;
        let mut src = tokio::fs::File::open(local).await?;
        let mut dst = sftp.create(remote).await?;
        pump(&mut src, &mut dst, &AtomicBool::new(false), |_| {}).await
    }
    .await;
    let mut ev = json!({ "sid": sid, "remote": remote, "name": basename(remote), "ok": res.is_ok() });
    if let Err(e) = res {
        ev["error"] = serde_json::to_value(e).unwrap();
    }
    let _ = app.emit("sftp-edited", ev);
}

pub fn stop_edits(app: &AppHandle, sid: Option<&str>) {
    let st = app.state::<AppState>();
    let mut edits = st.edits.lock().unwrap();
    let gone: Vec<PathBuf> = edits.iter().filter(|(_, e)| sid.is_none_or(|s| e.sid == s)).map(|(l, _)| l.clone()).collect();
    for l in gone {
        if let Some(e) = edits.remove(&l) {
            let _ = std::fs::remove_dir_all(&e.dir);
        }
    }
}

#[tauri::command]
pub fn sftp_stop_edits(app: AppHandle, sid: Option<String>) -> bool {
    stop_edits(&app, sid.as_deref());
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(basename("/a/b/c.txt"), "c.txt");
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(join("/", "x"), "/x");
        assert_eq!(join("/a", "x"), "/a/x");
        if cfg!(windows) {
            assert_eq!(safe_name("a:b?.txt"), "a_b_.txt");
            assert_eq!(safe_name("dots..."), "dots_");
        }
    }
}
