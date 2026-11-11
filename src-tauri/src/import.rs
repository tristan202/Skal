// Import af hosts fra ~/.ssh/config og PuTTY's gemte sessioner.
use crate::error::Result;
use crate::store::{self, Host};
use serde_json::{json, Value};

fn local_user() -> String {
    std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default()
}

fn new_host(name: &str) -> Host {
    Host { name: name.into(), host: name.into(), port: 22, auth_type: "password".into(), ..Default::default() }
}

// Kun "Host"-blokke uden jokertegn bliver til hosts. Som i OpenSSH vinder den første værdi.
pub fn parse_ssh_config(text: &str) -> Vec<Host> {
    let mut out: Vec<Host> = Vec::new();
    let mut cur: Vec<usize> = Vec::new();
    let mut seen: Vec<Vec<String>> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once(|c: char| c.is_whitespace() || c == '=') else { continue };
        let k = k.to_lowercase();
        let v = v.trim().trim_start_matches('=').trim().trim_matches('"').to_string();
        match k.as_str() {
            "host" => {
                cur.clear();
                for name in v.split_whitespace().filter(|n| !n.contains(['*', '?', '!'])) {
                    out.push(new_host(name));
                    seen.push(Vec::new());
                    cur.push(out.len() - 1);
                }
            }
            "match" => cur.clear(),
            "hostname" | "user" | "port" | "identityfile" => {
                for &i in &cur {
                    if seen[i].contains(&k) {
                        continue;
                    }
                    seen[i].push(k.clone());
                    let h = &mut out[i];
                    match k.as_str() {
                        "hostname" => h.host = v.clone(),
                        "user" => h.username = v.clone(),
                        "port" => h.port = v.parse().unwrap_or(22),
                        _ => {
                            h.key_path = v.clone();
                            h.auth_type = "key".into();
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("");
            if let Ok(n) = u8::from_str_radix(hex, 16) {
                out.push(n);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// Output fra `reg query HKCU\Software\SimonTatham\PuTTY\Sessions /s`
pub fn parse_putty_reg(text: &str) -> Vec<Host> {
    let mut out = Vec::new();
    let mut cur: Option<(Host, bool)> = None; // (host, er det SSH?)
    let flush = |c: Option<(Host, bool)>, out: &mut Vec<Host>| {
        if let Some((h, ssh)) = c {
            if ssh && !h.host.is_empty() {
                out.push(h);
            }
        }
    };
    for line in text.lines() {
        if line.starts_with("HKEY_") {
            flush(cur.take(), &mut out);
            let name = url_decode(line.rsplit('\\').next().unwrap_or(""));
            if line.contains("\\Sessions\\") && name != "Default Settings" {
                let mut h = new_host(&name);
                h.host.clear();
                cur = Some((h, true));
            }
            continue;
        }
        let Some((h, ssh)) = cur.as_mut() else { continue };
        let mut parts = line.trim().splitn(3, "    ");
        let (Some(k), Some(_), Some(v)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let v = v.trim();
        match k {
            "HostName" => match v.split_once('@') {
                Some((u, host)) => {
                    h.username = u.into();
                    h.host = host.into();
                }
                None => h.host = v.into(),
            },
            "UserName" if !v.is_empty() => h.username = v.into(),
            "PortNumber" => h.port = u16::from_str_radix(v.trim_start_matches("0x"), 16).unwrap_or(22),
            "Protocol" => *ssh = v == "ssh",
            "PublicKeyFile" if !v.is_empty() => {
                h.key_path = v.into();
                h.auth_type = "key".into();
            }
            _ => {}
        }
    }
    flush(cur, &mut out);
    out
}

#[cfg(windows)]
fn putty_sessions() -> Vec<Host> {
    use std::os::windows::process::CommandExt;
    // shortcut: reg.exe skriver i konsollens tegnsæt, så sjældne tegn i stier kan blive forkerte
    let out = std::process::Command::new("reg")
        .args(["query", r"HKCU\Software\SimonTatham\PuTTY\Sessions", "/s"])
        .creation_flags(0x0800_0000) // intet konsolvindue
        .output();
    out.map(|o| parse_putty_reg(&String::from_utf8_lossy(&o.stdout))).unwrap_or_default()
}
#[cfg(not(windows))]
fn putty_sessions() -> Vec<Host> {
    Vec::new()
}

#[tauri::command]
pub fn hosts_import_scan() -> Vec<Value> {
    let saved = store::read_hosts();
    let user = local_user();
    let cfg = dirs::home_dir().map(|d| d.join(".ssh").join("config"));
    let ssh = cfg.and_then(|p| std::fs::read_to_string(p).ok()).map(|t| parse_ssh_config(&t)).unwrap_or_default();
    let all = ssh.into_iter().map(|h| ("ssh", h)).chain(putty_sessions().into_iter().map(|h| ("putty", h)));
    all.map(|(src, mut h)| {
        if h.username.is_empty() {
            h.username = user.clone();
        }
        let exists = saved.iter().any(|s| {
            s.host.eq_ignore_ascii_case(&h.host) && s.port() == h.port() && s.username == h.username
        });
        let mut v = h.sanitized();
        v["source"] = json!(src);
        v["exists"] = json!(exists);
        v
    })
    .collect()
}

#[tauri::command]
pub fn hosts_import(items: Vec<Host>) -> Result<usize> {
    let mut hosts = store::read_hosts();
    let n = items.len();
    for mut h in items {
        h.id = uuid::Uuid::new_v4().to_string();
        h.password.clear();
        h.passphrase.clear();
        if !["password", "key", "agent"].contains(&h.auth_type.as_str()) {
            h.auth_type = "password".into();
        }
        hosts.push(h);
    }
    store::write_hosts(&hosts)?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_config() {
        let t = "Host *\n  User nobody\n\nHost web web2\n  HostName 10.0.0.5\n  User root\n  Port 2222\n  IdentityFile ~/.ssh/id_web\n  IdentityFile ~/.ssh/other\nHost pi\n  User=pi\nMatch all\n  User ignored\n";
        let h = parse_ssh_config(t);
        assert_eq!(h.len(), 3);
        assert_eq!((h[0].name.as_str(), h[0].host.as_str(), h[0].port, h[0].username.as_str()), ("web", "10.0.0.5", 2222, "root"));
        assert_eq!((h[0].auth_type.as_str(), h[0].key_path.as_str()), ("key", "~/.ssh/id_web"));
        assert_eq!(h[1].host, "10.0.0.5");
        assert_eq!((h[2].host.as_str(), h[2].username.as_str(), h[2].auth_type.as_str()), ("pi", "pi", "password"));
    }

    #[test]
    fn putty_reg() {
        let t = "\r\nHKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Default%20Settings\r\n    HostName    REG_SZ    \r\n\r\nHKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\My%20Pi\r\n    HostName    REG_SZ    admin@192.168.1.9\r\n    PortNumber    REG_DWORD    0x16\r\n    Protocol    REG_SZ    ssh\r\n    PublicKeyFile    REG_SZ    C:\\Keys\\my key.ppk\r\n\r\nHKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Serial\r\n    HostName    REG_SZ    x\r\n    Protocol    REG_SZ    serial\r\n";
        let h = parse_putty_reg(t);
        assert_eq!(h.len(), 1);
        assert_eq!((h[0].name.as_str(), h[0].host.as_str(), h[0].username.as_str(), h[0].port), ("My Pi", "192.168.1.9", "admin", 22));
        assert_eq!(h[0].key_path, "C:\\Keys\\my key.ppk");
    }
}
