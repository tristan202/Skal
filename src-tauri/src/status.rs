// Serverstatus og online-prik til Hosts-oversigten.
//
// Metrik: bruger en åben terminalsession til hosten, hvis der er en. Ellers holdes
// en stille baggrundsforbindelse åben, så længe oversigten bliver vist – den lukkes
// automatisk efter 3 minutter uden brug. Baggrundsforbindelser spørger aldrig om
// noget: kun servere med gemt login og en allerede godkendt host-nøgle bruges.
// Brugerfladen fortolker outputtet (parse i api.js).
//
// Ping: der logges ikke ind. Skal åbner blot SSH-porten, læser serverens
// identifikation ("SSH-2.0-OpenSSH_9.6 …"), svarer pænt med sin egen og lukker.
use crate::error::{Error, Result};
use crate::ssh::{self, Conn, Opts};
use crate::store::{self, Host};
use crate::AppState;
use russh::Disconnect;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const SCRIPT: &str = r#"export LC_ALL=C
echo @@os; ( . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" ) || uname -s
echo @@uptime; cat /proc/uptime
echo @@load; cat /proc/loadavg
echo @@ncpu; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo
echo @@mem; grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo
echo @@stat1; head -1 /proc/stat
sleep 1
echo @@stat2; head -1 /proc/stat
echo @@df; df -kPT 2>/dev/null || df -kP
echo @@end"#;
const IDLE: Duration = Duration::from_secs(180);
const BACKOFF: Duration = Duration::from_secs(30);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

struct Entry {
    conn: Option<Arc<Conn>>,
    sig: String,
    last_used: Instant,
    failed: Option<(Error, Instant)>,
}

#[derive(Default)]
pub struct Pool {
    entries: Mutex<HashMap<String, Entry>>,
    // Én forbindelse ad gangen pr. host, så samtidige forespørgsler deler den
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

fn sig_of(h: &Host) -> String {
    [&h.host, &h.port.to_string(), &h.username, &h.auth_type, &h.key_path, &h.password, &h.passphrase].map(|s| s.as_str()).join("|")
}

fn close(conn: Arc<Conn>) {
    tauri::async_runtime::spawn(async move {
        let _ = conn.disconnect(Disconnect::ByApplication, "", "en").await;
    });
}

fn live_conn(app: &AppHandle, host_id: &str) -> Option<Arc<Conn>> {
    let st = app.state::<AppState>();
    let s = st.sessions.lock().unwrap();
    s.values().find(|s| s.host_id.as_deref() == Some(host_id)).map(|s| s.conn.clone())
}

async fn get_conn(app: &AppHandle, h: &Host) -> Result<Arc<Conn>> {
    if let Some(c) = live_conn(app, &h.id) {
        return Ok(c);
    }
    let pool = &app.state::<AppState>().pool;
    let lock = pool.locks.lock().unwrap().entry(h.id.clone()).or_default().clone();
    let _g = lock.lock().await;
    let sig = sig_of(h);
    {
        let mut m = pool.entries.lock().unwrap();
        if let Some(e) = m.get_mut(&h.id) {
            let fresh = e.sig == sig;
            match (&e.failed, &e.conn) {
                (Some((err, until)), _) if fresh && *until > Instant::now() => return Err(err.clone()),
                (None, Some(c)) if fresh && !c.is_closed() => {
                    e.last_used = Instant::now();
                    return Ok(c.clone());
                }
                _ => {}
            }
            if let Some(c) = m.remove(&h.id).and_then(|e| e.conn) {
                close(c);
            }
        }
    }
    match ssh::open(app, h, Opts { password: None, passphrase: None, interactive: false }).await {
        Ok((c, _)) => {
            let c = Arc::new(c);
            let e = Entry { conn: Some(c.clone()), sig, last_used: Instant::now(), failed: None };
            pool.entries.lock().unwrap().insert(h.id.clone(), e);
            Ok(c)
        }
        Err(err) => {
            // Manglende login tjekkes billigt hver gang; andre fejl venter 30 sek.
            if !matches!(err.code, Some("NEED_LOGIN" | "NEED_PASSPHRASE")) {
                let e = Entry { conn: None, sig, last_used: Instant::now(), failed: Some((err.clone(), Instant::now() + BACKOFF)) };
                pool.entries.lock().unwrap().insert(h.id.clone(), e);
            }
            Err(err)
        }
    }
}

async fn fetch_one(app: &AppHandle, h: &Host) -> Value {
    let res = async {
        let conn = get_conn(app, h).await?;
        let cmd = format!("sh -c '{}'", SCRIPT.replace('\'', r"'\''"));
        tokio::time::timeout(Duration::from_secs(15), ssh::exec(&conn, &cmd))
            .await
            .map_err(|_| Error::key("m.timeout").code("ETIMEDOUT"))?
    }
    .await;
    match res {
        Ok(raw) => json!({ "ok": true, "at": now_ms(), "raw": raw }),
        Err(e) => json!({ "ok": false, "at": now_ms(), "error": e }),
    }
}

async fn for_hosts<F, Fut>(ids: Vec<String>, f: F) -> HashMap<String, Value>
where
    F: Fn(Host) -> Fut,
    Fut: std::future::Future<Output = Value> + Send + 'static,
{
    let tasks: Vec<_> = store::read_hosts()
        .into_iter()
        .filter(|h| ids.contains(&h.id))
        .map(|h| (h.id.clone(), tauri::async_runtime::spawn(f(h))))
        .collect();
    let mut out = HashMap::new();
    for (id, t) in tasks {
        if let Ok(v) = t.await {
            out.insert(id, v);
        }
    }
    out
}

#[tauri::command]
pub async fn metrics_get(app: AppHandle, ids: Vec<String>) -> HashMap<String, Value> {
    for_hosts(ids, |h| {
        let app = app.clone();
        async move { fetch_one(&app, &h).await }
    })
    .await
}

// Luk baggrundsforbindelser, der ikke har været brugt i 3 minutter
pub fn start_cleanup(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let pool = &app.state::<AppState>().pool;
            pool.entries.lock().unwrap().retain(|_, e| {
                let keep = e.last_used.elapsed() < IDLE;
                if let (false, Some(c)) = (keep, &e.conn) {
                    close(c.clone());
                }
                keep
            });
        }
    });
}

pub fn close_all(app: &AppHandle) {
    let pool = &app.state::<AppState>().pool;
    for (_, e) in pool.entries.lock().unwrap().drain() {
        if let Some(c) = e.conn {
            close(c);
        }
    }
}

// ---------- Ping ----------
async fn probe(host: String, port: u16) -> Value {
    let t0 = Instant::now();
    let res = tokio::time::timeout(Duration::from_secs(5), async {
        let addrs: Vec<_> = tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|_| Error::key("m.unknownHost"))?
            .collect();
        let mut s = tokio::net::TcpStream::connect(&addrs[..]).await?;
        let (mut buf, mut chunk) = (Vec::new(), [0u8; 1024]);
        loop {
            let n = s.read(&mut chunk).await?;
            if n == 0 {
                return Err(Error::key("ping.notSsh"));
            }
            buf.extend_from_slice(&chunk[..n]);
            let text = String::from_utf8_lossy(&buf);
            if let Some(line) = text.split('\n').find(|l| l.starts_with("SSH-")) {
                let banner: String = line.trim().chars().take(80).collect();
                let _ = s.write_all(b"SSH-2.0-Skal_status\r\n").await;
                let _ = s.shutdown().await;
                return Ok(banner);
            }
            if buf.len() > 4096 {
                return Err(Error::key("ping.notSsh"));
            }
        }
    })
    .await
    .unwrap_or_else(|_| Err(Error::key("m.timeout")));
    match res {
        Ok(banner) => json!({ "ok": true, "ms": t0.elapsed().as_millis() as u64, "banner": banner, "at": now_ms() }),
        Err(e) => json!({ "ok": false, "msgKey": e.key, "message": e.message, "at": now_ms() }),
    }
}

#[tauri::command]
pub async fn ping_check(app: AppHandle, ids: Vec<String>) -> HashMap<String, Value> {
    for_hosts(ids, |h| {
        // Er der allerede en åben session, er serveren beviseligt oppe
        let live = live_conn(&app, &h.id).is_some();
        async move {
            if live {
                return json!({ "ok": true, "session": true, "at": now_ms() });
            }
            probe(h.host.clone(), h.port()).await
        }
    })
    .await
}
