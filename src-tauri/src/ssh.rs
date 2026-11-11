// SSH-forbindelser: opsætning, host key-tjek, login og terminalsessioner.
use crate::error::{Error, Result};
use crate::store::{self, Host};
use crate::AppState;
use russh::client::{self, DisconnectReason, Handle};
use russh::keys::{agent::client::AgentClient, HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect};
use russh_sftp::client::SftpSession;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot};

pub type Conn = Handle<Client>;

pub struct Session {
    pub conn: Arc<Conn>,
    pub tx: mpsc::UnboundedSender<Input>,
    pub host_id: Option<String>,
    pub gen: u64,
    // Én delt SFTP-kanal pr. session til at liste, omdøbe osv.
    pub sftp: tokio::sync::Mutex<Option<Arc<SftpSession>>>,
}

pub enum Input {
    Data(String),
    Resize(u32, u32),
}

pub struct Client {
    app: AppHandle,
    host: String,
    port: u16,
    interactive: bool,
    problem: Arc<Mutex<Option<&'static str>>>,
    last_error: Arc<Mutex<String>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, k: &PublicKeyOrCertificate) -> std::result::Result<bool, Self::Error> {
        let data = match k {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.key_data().clone(),
            PublicKeyOrCertificate::Certificate(c) => c.public_key().clone(),
        };
        let fp = data.fingerprint(HashAlg::Sha256).to_string();
        Ok(verify_host(&self.app, &self.host, self.port, &fp, self.interactive, &self.problem).await)
    }

    async fn disconnected(&mut self, reason: DisconnectReason<Self::Error>) -> std::result::Result<(), Self::Error> {
        match reason {
            DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            DisconnectReason::Error(e) => {
                *self.last_error.lock().unwrap() = e.to_string();
                Err(e)
            }
        }
    }
}

// ---------- Host key-verifikation (trust on first use) ----------
// interactive=false bruges af baggrundsforbindelser (metrik): de spørger aldrig,
// men accepterer kun servere, du allerede har godkendt.
async fn verify_host(
    app: &AppHandle,
    host: &str,
    port: u16,
    fp: &str,
    interactive: bool,
    problem: &Mutex<Option<&'static str>>,
) -> bool {
    let key = format!("[{host}]:{port}");
    let old = store::read_known().get(&key).cloned();
    if old.as_deref() == Some(fp) {
        return true;
    }
    if !interactive {
        *problem.lock().unwrap() = Some(if old.is_some() { "changed" } else { "unknown" });
        return false;
    }
    // Brugerfladen viser dialogen (på brugerens sprog) og svarer med hostkey_answer
    let st = app.state::<AppState>();
    let id = st.next_id();
    let (tx, rx) = oneshot::channel();
    st.hostkey_waiters.lock().unwrap().insert(id, tx);
    let _ = app.emit("hostkey-ask", json!({ "id": id, "host": format!("{host}:{port}"), "fp": fp, "old": old }));
    if !rx.await.unwrap_or(false) {
        return false;
    }
    let mut known = store::read_known();
    known.insert(key, fp.into());
    let _ = store::write_known(&known);
    true
}

#[tauri::command]
pub fn hostkey_answer(state: tauri::State<'_, AppState>, id: u64, ok: bool) {
    if let Some(tx) = state.hostkey_waiters.lock().unwrap().remove(&id) {
        let _ = tx.send(ok);
    }
}

// ---------- Nøgler ----------
fn expand_home(p: &str) -> std::path::PathBuf {
    match p.strip_prefix('~') {
        Some(rest) => dirs::home_dir().unwrap_or_default().join(rest.trim_start_matches(['/', '\\'])),
        None => p.into(),
    }
}

fn nonempty(s: String) -> Option<String> {
    (!s.is_empty()).then_some(s)
}

// PPK v2/v3, PKCS#8, PKCS#1, OpenSSH – russh læser dem alle
fn load_key(h: &Host, passphrase: Option<String>) -> Result<PrivateKey> {
    let raw = std::fs::read_to_string(expand_home(&h.key_path))
        .map_err(|e| Error::key("err.keyRead").param("err", e))?;
    let text = raw.trim_start_matches('\u{feff}').trim();
    let first = text.split_whitespace().next().unwrap_or("");
    let is_public = text.starts_with("---- BEGIN SSH2 PUBLIC KEY")
        || ((first.starts_with("ssh-") || first.starts_with("ecdsa-sha2-") || first.starts_with("sk-"))
            && text.split_whitespace().nth(1).is_some_and(|b| b.starts_with("AAAA")));
    if is_public {
        return Err(Error::key("kc.isPublic").code("BAD_KEY"));
    }
    if !text.starts_with("PuTTY-User-Key-File-") && !text.starts_with("-----BEGIN") {
        return Err(Error::key("kc.notKey").code("BAD_KEY"));
    }
    let pass = passphrase.and_then(nonempty).or_else(|| nonempty(store::dec(&h.passphrase)));
    russh::keys::decode_secret_key(text, pass.as_deref()).map_err(|e| {
        let encrypted = matches!(e, russh::keys::Error::KeyIsEncrypted) || is_encrypted(text);
        match (encrypted, pass.is_some()) {
            (true, false) => Error::key("kc.needPass").code("NEED_PASSPHRASE"),
            (true, true) => Error::key("kc.badPass").code("BAD_PASSPHRASE"),
            _ => Error::key("kc.readFail").param("err", e).code("BAD_KEY"),
        }
    })
}

fn is_encrypted(text: &str) -> bool {
    use base64::{engine::general_purpose::STANDARD, Engine};
    if text.starts_with("PuTTY-User-Key-File-") {
        return text.lines().any(|l| l.starts_with("Encryption:") && !l.ends_with("none"));
    }
    if text.contains("ENCRYPTED") {
        return true;
    }
    // OpenSSH-format: krypterede nøgler bruger bcrypt som KDF
    let body: String = text.lines().filter(|l| !l.starts_with("-----")).collect();
    STANDARD.decode(body).is_ok_and(|b| b.windows(6).any(|w| w == b"bcrypt"))
}

// ---------- Forbindelse ----------
pub struct Opts {
    pub password: Option<String>,
    pub passphrase: Option<String>,
    pub interactive: bool,
}

pub async fn open(app: &AppHandle, h: &Host, o: Opts) -> Result<(Conn, Arc<Mutex<String>>)> {
    let pw = o.password.and_then(nonempty).unwrap_or_else(|| store::dec(&h.password));
    let key = if h.auth_type == "key" { Some(load_key(h, o.passphrase)?) } else { None };
    if !matches!(h.auth_type.as_str(), "key" | "agent") && pw.is_empty() && !o.interactive {
        return Err(Error::key("err.needPassword").code("NEED_LOGIN"));
    }

    let limit = Duration::from_secs(if o.interactive { 20 } else { 10 });
    let timeout = || Error::key("m.timeout").code("ETIMEDOUT");
    let addrs: Vec<_> = tokio::net::lookup_host((h.host.as_str(), h.port()))
        .await
        .map_err(|_| Error::key("m.unknownHost").code("ENOTFOUND"))?
        .collect();
    let tcp = tokio::time::timeout(limit, tokio::net::TcpStream::connect(&addrs[..])).await.map_err(|_| timeout())??;
    let _ = tcp.set_nodelay(true);

    let problem = Arc::new(Mutex::new(None));
    let last_error = Arc::new(Mutex::new(String::new()));
    let handler = Client {
        app: app.clone(),
        host: h.host.clone(),
        port: h.port(),
        interactive: o.interactive,
        problem: problem.clone(),
        last_error: last_error.clone(),
    };
    let cfg = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(15)),
        nodelay: true,
        ..Default::default()
    });
    let fut = client::connect_stream(cfg, tcp, handler);
    // Interaktivt venter vi på brugerens svar i host key-dialogen, så ingen tidsgrænse her
    let res = if o.interactive { fut.await } else { tokio::time::timeout(limit, fut).await.map_err(|_| timeout())? };
    let mut conn = match res {
        Ok(c) => c,
        Err(e) => {
            return Err(match *problem.lock().unwrap() {
                Some("changed") => Error::key("m.hostChanged").code("HOSTKEY_CHANGED"),
                Some(_) => Error::key("m.hostUnknown").code("HOSTKEY_UNKNOWN"),
                None if matches!(e, russh::Error::UnknownKey) => Error::key("err.cancelled"),
                None => e.into(),
            })
        }
    };

    let user = h.username.as_str();
    let ok = match (h.auth_type.as_str(), key) {
        ("key", Some(k)) => {
            let hash = conn.best_supported_rsa_hash().await?.flatten();
            let ok = conn.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(k), hash)).await?.success();
            // Reserve, hvis serveren også vil have adgangskode
            ok || (!pw.is_empty() && password_auth(&mut conn, user, &pw).await?)
        }
        ("agent", _) => agent_auth(&mut conn, user).await?,
        _ => password_auth(&mut conn, user, &pw).await?,
    };
    if !ok {
        return Err(Error::key("m.authFailed").code("AUTH"));
    }
    Ok((conn, last_error))
}

async fn password_auth(conn: &mut Conn, user: &str, pw: &str) -> Result<bool> {
    use client::KeyboardInteractiveAuthResponse as K;
    if conn.authenticate_password(user, pw).await?.success() {
        return Ok(true);
    }
    // Nogle servere vil kun have keyboard-interactive: svar adgangskoden på alle spørgsmål
    let mut r = conn.authenticate_keyboard_interactive_start(user, None).await?;
    for _ in 0..5 {
        match r {
            K::Success => return Ok(true),
            K::Failure { .. } => return Ok(false),
            K::InfoRequest { prompts, .. } => {
                r = conn.authenticate_keyboard_interactive_respond(vec![pw.to_string(); prompts.len()]).await?;
            }
        }
    }
    Ok(false)
}

async fn try_agent<S>(conn: &mut Conn, user: &str, mut agent: AgentClient<S>) -> Result<bool>
where
    S: russh::keys::agent::client::AgentStream + Send + Unpin + 'static,
{
    let Ok(ids) = agent.request_identities().await else { return Ok(false) };
    let hash = conn.best_supported_rsa_hash().await?.flatten();
    for id in ids {
        let pk = id.public_key().into_owned();
        if conn.authenticate_publickey_with(user, pk, hash, &mut agent).await.is_ok_and(|r| r.success()) {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(windows)]
async fn agent_auth(conn: &mut Conn, user: &str) -> Result<bool> {
    let mut found = false;
    if let Ok(a) = AgentClient::connect_pageant().await {
        found = true;
        if try_agent(conn, user, a).await? {
            return Ok(true);
        }
    }
    if let Ok(a) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        found = true;
        if try_agent(conn, user, a).await? {
            return Ok(true);
        }
    }
    if found { Ok(false) } else { Err(Error::key("err.noAgent")) }
}

#[cfg(not(windows))]
async fn agent_auth(conn: &mut Conn, user: &str) -> Result<bool> {
    let a = AgentClient::connect_env().await.map_err(|_| Error::key("err.noAgent"))?;
    try_agent(conn, user, a).await
}

pub async fn open_sftp(conn: &Conn) -> Result<SftpSession> {
    let no = |e: &dyn std::fmt::Display| Error::key("err.noSftp").param("err", e);
    let ch = conn.channel_open_session().await.map_err(|e| no(&e))?;
    ch.request_subsystem(true, "sftp").await.map_err(|e| no(&e))?;
    SftpSession::new(ch.into_stream()).await.map_err(|e| no(&e))
}

// Kører en kommando og returnerer stdout (til serverstatus)
pub async fn exec(conn: &Conn, cmd: &str) -> Result<String> {
    let mut ch = conn.channel_open_session().await?;
    ch.exec(true, cmd).await?;
    let mut out = Vec::new();
    while let Some(m) = ch.wait().await {
        match m {
            ChannelMsg::Data { data } => out.extend_from_slice(&data),
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

// ---------- Terminalsessioner ----------
// Tegn kan blive delt mellem to pakker; resten gemmes til næste gang
#[derive(Default)]
pub struct Utf8Dec(Vec<u8>);

impl Utf8Dec {
    pub fn push(&mut self, b: &[u8]) -> String {
        self.0.extend_from_slice(b);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.0) {
                Ok(s) => {
                    out.push_str(s);
                    self.0.clear();
                    return out;
                }
                Err(e) => {
                    let v = e.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.0[..v]).unwrap());
                    match e.error_len() {
                        Some(n) => {
                            out.push('\u{FFFD}');
                            self.0.drain(..v + n);
                        }
                        None => {
                            self.0.drain(..v);
                            return out;
                        }
                    }
                }
            }
        }
    }
}

fn host_for(host_id: &Option<String>, adhoc: Option<Host>) -> Result<Host> {
    match host_id {
        Some(id) => store::find_host(id),
        None => adhoc,
    }
    .ok_or_else(|| Error::key("err.hostGone"))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_connect(
    app: AppHandle,
    session_id: String,
    host_id: Option<String>,
    adhoc: Option<Host>,
    cols: u32,
    rows: u32,
    password: Option<String>,
    passphrase: Option<String>,
    on_data: Channel<String>,
) -> Result<bool> {
    let h = host_for(&host_id, adhoc)?;
    disconnect(&app, &session_id);
    let (conn, last_error) = open(&app, &h, Opts { password, passphrase, interactive: true }).await?;

    let ch = conn.channel_open_session().await?;
    // Bed serveren om UTF-8-tegnsæt. Uden det tæller zsh/bash fx "⬡" som 3 tegn
    // (3 bytes) i stedet for 1, og så havner markøren forkert efter prompten.
    // Kun LC_CTYPE sættes, så sprog og datoformat på serveren ikke ændres.
    let _ = ch.set_env(false, "LC_CTYPE", "C.UTF-8").await;
    ch.request_pty(false, "xterm-256color", cols, rows, 0, 0, &[]).await?;
    ch.request_shell(true).await?;
    let (mut rd, wr) = ch.split();

    let (tx, mut rx) = mpsc::unbounded_channel();
    let st = app.state::<AppState>();
    let gen = st.next_id();
    let sess = Arc::new(Session { conn: Arc::new(conn), tx, host_id, gen, sftp: Default::default() });
    st.sessions.lock().unwrap().insert(session_id.clone(), sess.clone());

    // Skriv tastetryk og størrelsesændringer i den rækkefølge, de kom
    tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            let ok = match m {
                Input::Data(s) => wr.data(s.as_bytes()).await.is_ok(),
                Input::Resize(c, r) => wr.window_change(c, r, 0, 0).await.is_ok(),
            };
            if !ok {
                break;
            }
        }
    });

    tokio::spawn(async move {
        let (mut out, mut err) = (Utf8Dec::default(), Utf8Dec::default());
        // ExitStatus kommer kun, når shellen selv afslutter (fx 'exit' eller Ctrl+D) –
        // ikke når netværket falder ud. Det bruges til at lukke fanen automatisk.
        let exited = AtomicBool::new(false);
        while let Some(m) = rd.wait().await {
            let text = match m {
                ChannelMsg::Data { data } => out.push(&data),
                ChannelMsg::ExtendedData { data, .. } => err.push(&data),
                ChannelMsg::ExitStatus { .. } | ChannelMsg::ExitSignal { .. } => {
                    exited.store(true, Ordering::Relaxed);
                    continue;
                }
                ChannelMsg::Close => break,
                _ => continue,
            };
            if !text.is_empty() && on_data.send(text).is_err() {
                break;
            }
        }
        let _ = sess.conn.disconnect(Disconnect::ByApplication, "", "en").await;
        // Kun den aktuelle forbindelse for sessionId må melde lukning til UI'et –
        // ellers kan en gammel, bevidst afbrudt forbindelse lukke en ny genforbindelse.
        let st = app.state::<AppState>();
        let current = {
            let mut m = st.sessions.lock().unwrap();
            let cur = m.get(&session_id).is_some_and(|s| s.gen == sess.gen);
            if cur {
                m.remove(&session_id);
            }
            cur
        };
        if current {
            let msg = last_error.lock().unwrap().clone();
            let _ = app.emit("ssh-closed", json!({ "id": session_id, "msg": msg, "exited": exited.load(Ordering::Relaxed) }));
        }
    });
    Ok(true)
}

// Synkrone kommandoer køres i rækkefølge på hovedtråden, så tastetryk ikke bytter plads
#[tauri::command]
pub fn ssh_write(state: tauri::State<'_, AppState>, id: String, data: String) {
    if let Some(s) = state.sessions.lock().unwrap().get(&id) {
        let _ = s.tx.send(Input::Data(data));
    }
}

#[tauri::command]
pub fn ssh_resize(state: tauri::State<'_, AppState>, id: String, cols: u32, rows: u32) {
    if let Some(s) = state.sessions.lock().unwrap().get(&id) {
        let _ = s.tx.send(Input::Resize(cols, rows));
    }
}

#[tauri::command]
pub fn ssh_disconnect(app: AppHandle, id: String) {
    disconnect(&app, &id);
}

fn disconnect(app: &AppHandle, id: &str) {
    let old = app.state::<AppState>().sessions.lock().unwrap().remove(id);
    if let Some(s) = old {
        tauri::async_runtime::spawn(async move {
            let _ = s.conn.disconnect(Disconnect::ByApplication, "", "en").await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_split_across_packets() {
        let mut d = Utf8Dec::default();
        let b = "a⬡b".as_bytes();
        assert_eq!(d.push(&b[..2]), "a");
        assert_eq!(d.push(&b[2..3]), "");
        assert_eq!(d.push(&b[3..]), "⬡b");
        assert_eq!(d.push(&[0xff, b'x']), "\u{FFFD}x");
    }
}
