// Login med SSH-nøgle i ét klik: lav ~/.ssh/id_ed25519, hvis den mangler, læg den
// offentlige nøgle i serverens authorized_keys, tjek at den virker, og skift hosten til nøgle.
use crate::error::{Error, Result};
use crate::ssh::{self, Opts};
use crate::store;
use russh::keys::ssh_key::{private::Ed25519Keypair, LineEnding};
use russh::keys::PrivateKey;
use russh::Disconnect;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::AppHandle;

fn comment() -> String {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "skal".into());
    let pc = std::env::var("COMPUTERNAME").unwrap_or_default();
    let raw = if pc.is_empty() { user } else { format!("{user}@{pc}") };
    raw.chars().filter(|c| c.is_ascii_alphanumeric() || "@._-".contains(*c)).collect()
}

// Returnerer (sti, offentlig nøgle, nyoprettet?)
fn ensure_key() -> Result<(PathBuf, String, bool)> {
    let dir = dirs::home_dir().ok_or_else(|| Error::msg("no home folder"))?.join(".ssh");
    let path = dir.join("id_ed25519");
    let pub_path = dir.join("id_ed25519.pub");
    if path.exists() {
        if let Ok(p) = std::fs::read_to_string(&pub_path) {
            return Ok((path, p.trim().to_string(), false));
        }
        // Uden .pub-fil: afled den offentlige nøgle (kun muligt uden passphrase)
        let text = std::fs::read_to_string(&path)?;
        let k = russh::keys::decode_secret_key(&text, None).map_err(|_| Error::key("key.noPub"))?;
        let p = k.public_key().to_openssh().map_err(Error::msg)?;
        return Ok((path, p, false));
    }
    let (private, p) = new_key()?;
    std::fs::create_dir_all(&dir)?;
    std::fs::write(&path, private)?;
    std::fs::write(&pub_path, format!("{p}\n"))?;
    Ok((path, p, true))
}

// Ny ed25519-nøgle uden passphrase: (privat i OpenSSH-format, offentlig linje)
fn new_key() -> Result<(String, String)> {
    let mut seed = [0u8; 32];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut seed).map_err(|_| Error::msg("rng"))?;
    let mut k = PrivateKey::from(Ed25519Keypair::from_seed(&seed));
    k.set_comment(comment());
    let private = k.to_openssh(LineEnding::LF).map_err(Error::msg)?.to_string();
    Ok((private, k.public_key().to_openssh().map_err(Error::msg)?))
}

// Tilføj nøglen én gang; sørg for linjeskift, hvis filen ikke slutter med et
fn install_script(pubkey: &str) -> String {
    format!("sh -c '{}'", install_body(pubkey).replace('\'', r"'\''"))
}
fn install_body(pubkey: &str) -> String {
    let f = "~/.ssh/authorized_keys";
    format!(
        "umask 077; mkdir -p ~/.ssh && touch {f} && \
         if ! grep -qxF '{pubkey}' {f}; then [ -s {f} ] && [ -n \"$(tail -c1 {f})\" ] && echo >> {f}; echo '{pubkey}' >> {f}; fi && \
         grep -qxF '{pubkey}' {f} && echo SKAL_OK"
    )
}

#[tauri::command]
pub async fn key_setup(app: AppHandle, host_id: String, password: Option<String>) -> Result<Value> {
    let h = store::find_host(&host_id).ok_or_else(|| Error::key("err.hostGone"))?;
    let (path, pubkey, created) = ensure_key()?;
    if pubkey.contains('\'') || pubkey.contains('\n') {
        return Err(Error::key("key.noPub"));
    }

    let (conn, _) = ssh::open(&app, &h, Opts { password, passphrase: None, interactive: true }).await?;
    let out = ssh::exec(&conn, &install_script(&pubkey)).await;
    let _ = conn.disconnect(Disconnect::ByApplication, "", "en").await;
    let out = out?;
    if !out.contains("SKAL_OK") {
        return Err(Error::key("key.installFailed").param("err", out.trim()));
    }

    // Prøv nøglen alene (uden adgangskode som reserve), før hosten skiftes over
    let key_path = path.to_string_lossy().into_owned();
    let test = store::Host { auth_type: "key".into(), key_path: key_path.clone(), password: String::new(), passphrase: String::new(), ..h.clone() };
    match ssh::open(&app, &test, Opts { password: None, passphrase: None, interactive: false }).await {
        Ok((c, _)) => {
            let _ = c.disconnect(Disconnect::ByApplication, "", "en").await;
        }
        // Nøglen har en passphrase – den spørges der om ved næste forbindelse
        Err(e) if e.code == Some("NEED_PASSPHRASE") => {}
        Err(_) => return Err(Error::key("key.testFailed")),
    }

    let mut hosts = store::read_hosts();
    if let Some(x) = hosts.iter_mut().find(|x| x.id == host_id) {
        x.auth_type = "key".into();
        x.key_path = key_path.clone();
        x.passphrase.clear();
    }
    store::write_hosts(&hosts)?;
    Ok(json!({ "keyPath": key_path, "created": created }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_key_roundtrips() {
        let (private, public) = new_key().unwrap();
        let k = russh::keys::decode_secret_key(&private, None).unwrap();
        assert_eq!(k.public_key().to_openssh().unwrap(), public);
        assert!(public.starts_with("ssh-ed25519 AAAA") && !public.contains('\''));
        assert_ne!(new_key().unwrap().0, private);
    }

    // Kører installationsscriptet mod en midlertidig HOME (springes over uden sh, fx Git Bash)
    #[test]
    fn install_script_adds_key_once() {
        let home = std::env::temp_dir().join(format!("skal-keytest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        let ak = home.join(".ssh").join("authorized_keys");
        std::fs::write(&ak, "ssh-rsa AAAAold other").unwrap(); // uden afsluttende linjeskift
        let key = "ssh-ed25519 AAAAtest me@pc";
        let run = || std::process::Command::new("sh").arg("-c").arg(install_body(key)).env("HOME", &home).output();
        let Ok(out) = run() else { return };
        assert!(String::from_utf8_lossy(&out.stdout).contains("SKAL_OK"), "{out:?}");
        run().unwrap();
        assert_eq!(std::fs::read_to_string(&ak).unwrap(), "ssh-rsa AAAAold other\nssh-ed25519 AAAAtest me@pc\n");
        std::fs::remove_dir_all(home).unwrap();
    }
}
