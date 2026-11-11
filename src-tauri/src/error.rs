// Fejl sendes til brugerfladen som { code, key, params, message }.
// key er en tekst i renderer/strings.js, så fejlen vises på brugerens sprog;
// message er den rå tekst, der bruges hvis der ikke er nogen key.
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize)]
pub struct Error {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<&'static str>,
    pub params: Map<String, Value>,
    pub message: String,
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn key(key: &'static str) -> Self {
        Error { code: None, key: Some(key), params: Map::new(), message: key.into() }
    }
    pub fn msg(m: impl ToString) -> Self {
        Error { code: None, key: None, params: Map::new(), message: m.to_string() }
    }
    pub fn code(mut self, code: &'static str) -> Self {
        self.code = Some(code);
        self
    }
    pub fn param(mut self, k: &str, v: impl ToString) -> Self {
        self.params.insert(k.into(), Value::String(v.to_string()));
        self
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        use std::io::ErrorKind::*;
        let (code, key) = match e.kind() {
            ConnectionRefused => ("ECONNREFUSED", "m.refused"),
            TimedOut => ("ETIMEDOUT", "m.timeout"),
            HostUnreachable | NetworkUnreachable => ("EHOSTUNREACH", "m.unreachable"),
            NotFound => ("ENOENT", "err.notFound"),
            PermissionDenied => ("EACCES", "err.denied"),
            _ => return Error::msg(e),
        };
        Error { code: Some(code), key: Some(key), params: Map::new(), message: e.to_string() }
    }
}

impl From<russh::Error> for Error {
    fn from(e: russh::Error) -> Self {
        match e {
            russh::Error::IO(io) => io.into(),
            russh::Error::ConnectionTimeout | russh::Error::KeepaliveTimeout => {
                Error::key("m.timeout").code("ETIMEDOUT")
            }
            russh::Error::Disconnect | russh::Error::HUP => Error::key("err.closed"),
            e => Error::msg(e),
        }
    }
}

impl From<russh_sftp::client::error::Error> for Error {
    fn from(e: russh_sftp::client::error::Error) -> Self {
        use russh_sftp::protocol::StatusCode::*;
        if let russh_sftp::client::error::Error::Status(s) = &e {
            match s.status_code {
                NoSuchFile => return Error::key("err.notFound"),
                PermissionDenied => return Error::key("err.denied"),
                Failure => return Error::key("err.failed"),
                _ => {}
            }
        }
        Error::msg(e)
    }
}

impl From<tauri::Error> for Error {
    fn from(e: tauri::Error) -> Self {
        Error::msg(e)
    }
}
