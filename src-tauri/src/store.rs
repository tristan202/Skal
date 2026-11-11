// Lager: hosts.json og known_hosts.json i samme mappe som Electron-versionen
// brugte (%APPDATA%\Skal), så data følger med ved skiftet.
use crate::error::{Error, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

pub fn data_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_default().join("Skal")
}
fn hosts_file() -> PathBuf {
    data_dir().join("hosts.json")
}
fn known_file() -> PathBuf {
    data_dir().join("known_hosts.json")
}

fn read_json<T: DeserializeOwned + Default>(p: PathBuf) -> T {
    std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}
fn write_json<T: Serialize>(p: PathBuf, v: &T) -> Result<()> {
    std::fs::create_dir_all(p.parent().unwrap())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(v).map_err(Error::msg)?)?;
    std::fs::rename(tmp, p)?;
    Ok(())
}

// Porten kan komme som tal eller tekst fra formularen
fn port_de<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<u16, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Number(n) => n.as_u64().unwrap_or(22) as u16,
        Value::String(s) => s.trim().parse().unwrap_or(22),
        _ => 22,
    })
}
fn default_port() -> u16 {
    22
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Host {
    pub id: String,
    pub name: String,
    pub group: String,
    pub host: String,
    #[serde(deserialize_with = "port_de", default = "default_port")]
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub key_path: String,
    pub color: String,
    pub password: String,
    pub passphrase: String,
}

impl Host {
    pub fn port(&self) -> u16 {
        if self.port == 0 { 22 } else { self.port }
    }
    // Brugerfladen ser aldrig de krypterede felter
    pub fn sanitized(&self) -> Value {
        let mut v = serde_json::to_value(self).unwrap();
        let o = v.as_object_mut().unwrap();
        o.remove("password");
        o.remove("passphrase");
        o.insert("hasPassword".into(), json!(!self.password.is_empty()));
        o.insert("hasPassphrase".into(), json!(!self.passphrase.is_empty()));
        v
    }
}

pub fn read_hosts() -> Vec<Host> {
    read_json(hosts_file())
}
pub fn write_hosts(h: &[Host]) -> Result<()> {
    write_json(hosts_file(), &h)
}
pub fn find_host(id: &str) -> Option<Host> {
    read_hosts().into_iter().find(|h| h.id == id)
}

pub fn read_known() -> HashMap<String, String> {
    read_json(known_file())
}
pub fn write_known(k: &HashMap<String, String>) -> Result<()> {
    write_json(known_file(), k)
}

// Electron-versionen krypterede med Chromiums os_crypt; de omkrypteres én gang til DPAPI
pub fn migrate_secrets() {
    let mut hosts = read_hosts();
    let mut changed = false;
    for h in &mut hosts {
        for f in [&mut h.password, &mut h.passphrase] {
            if f.is_empty() || f.starts_with(PREFIX) {
                continue;
            }
            // Kan den ikke dekrypteres, bevares den gamle værdi uændret
            let plain = dec(f);
            let new = enc(&plain);
            if !plain.is_empty() && !new.is_empty() {
                *f = new;
                changed = true;
            }
        }
    }
    if changed {
        let _ = write_hosts(&hosts);
    }
}

// ---------- Kryptering ----------
// Adgangskoder krypteres med Windows' DPAPI (bundet til brugerkontoen).
// Andre platforme: gemmes slet ikke.
const PREFIX: &str = "dpapi:";

pub fn can_encrypt() -> bool {
    cfg!(windows)
}

pub fn enc(s: &str) -> String {
    if s.is_empty() {
        return String::new();
    }
    match dpapi::protect(s.as_bytes()) {
        Some(b) => format!("{PREFIX}{}", B64.encode(b)),
        None => String::new(),
    }
}

pub fn dec(s: &str) -> String {
    if s.is_empty() {
        return String::new();
    }
    let plain = if let Some(rest) = s.strip_prefix(PREFIX) {
        B64.decode(rest).ok().and_then(|b| dpapi::unprotect(&b))
    } else {
        B64.decode(s).ok().and_then(|b| legacy_dec(&b))
    };
    plain.and_then(|b| String::from_utf8(b).ok()).unwrap_or_default()
}

// Chromium/Electron safeStorage: "v10" + 12 bytes nonce + AES-256-GCM, med en
// nøgle der ligger DPAPI-krypteret i "Local State" under os_crypt.encrypted_key.
fn legacy_dec(b: &[u8]) -> Option<Vec<u8>> {
    use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
    let body = b.strip_prefix(b"v10")?;
    if body.len() < 12 + 16 {
        return None;
    }
    let state: Value = serde_json::from_str(&std::fs::read_to_string(data_dir().join("Local State")).ok()?).ok()?;
    let wrapped = B64.decode(state["os_crypt"]["encrypted_key"].as_str()?).ok()?;
    let key = dpapi::unprotect(wrapped.strip_prefix(b"DPAPI")?)?;
    let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
    cipher.decrypt(Nonce::from_slice(&body[..12]), &body[12..]).ok()
}

#[cfg(windows)]
mod dpapi {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn run(input: &[u8], protect: bool) -> Option<Vec<u8>> {
        let inp = CRYPT_INTEGER_BLOB { cbData: input.len() as u32, pbData: input.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        use std::ptr::{null, null_mut};
        // SAFETY: inp peger på gyldig hukommelse i hele kaldet; out frigives med LocalFree
        unsafe {
            let ok = if protect {
                CryptProtectData(&inp, null(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            } else {
                CryptUnprotectData(&inp, null_mut(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            };
            if ok == 0 {
                return None;
            }
            let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            LocalFree(out.pbData as _);
            Some(v)
        }
    }
    pub fn protect(b: &[u8]) -> Option<Vec<u8>> {
        run(b, true)
    }
    pub fn unprotect(b: &[u8]) -> Option<Vec<u8>> {
        run(b, false)
    }
}

#[cfg(not(windows))]
mod dpapi {
    pub fn protect(_: &[u8]) -> Option<Vec<u8>> {
        None
    }
    pub fn unprotect(_: &[u8]) -> Option<Vec<u8>> {
        None
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn roundtrip() {
        let e = enc("hemmelig æøå");
        assert!(e.starts_with(PREFIX));
        assert_eq!(dec(&e), "hemmelig æøå");
        assert_eq!(dec(""), "");
        assert_eq!(dec("garbage"), "");
    }
}

// Kører mod de rigtige data (læser kun): cargo test legacy -- --ignored
#[cfg(all(test, windows))]
#[test]
#[ignore]
fn legacy_secrets_decrypt() {
    let hosts = read_hosts();
    let enc_count = hosts.iter().filter(|h| !h.password.is_empty()).count();
    let ok = hosts.iter().filter(|h| !h.password.is_empty() && !dec(&h.password).is_empty()).count();
    println!("hosts={} with_password={} decrypted={}", hosts.len(), enc_count, ok);
    assert_eq!(enc_count, ok);
}
