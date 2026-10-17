// Gør private nøgler spiselige for ssh2.
// ssh2 forstår kun OpenSSH-, PEM (PKCS#1/SEC1)- og PPK v2 RSA/DSA-nøgler.
// Her konverteres PuTTY .ppk (v2 og v3, alle nøgletyper, med/uden passphrase)
// og PKCS#8 ("BEGIN PRIVATE KEY") til OpenSSH-formatet.
'use strict';
const crypto = require('crypto');
const { utils } = require('ssh2');
const { t: tr } = require('./renderer/strings.js');

class KeyError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}

// ---------- SSH wire-format ----------
function reader(buf) {
  let off = 0;
  return {
    string() {
      if (off + 4 > buf.length) throw new KeyError('BAD_KEY', tr('kc.corrupt'));
      const len = buf.readUInt32BE(off); off += 4;
      if (off + len > buf.length) throw new KeyError('BAD_KEY', tr('kc.corrupt'));
      const v = buf.subarray(off, off + len); off += len; return v;
    },
  };
}
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const sshString = (b) => { b = Buffer.isBuffer(b) ? b : Buffer.from(b); return Buffer.concat([u32(b.length), b]); };
function mpint(b) {
  let i = 0; while (i < b.length - 1 && b[i] === 0) i++;
  b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return sshString(b);
}

function buildOpenSSH(pubBlob, privEntry, comment) {
  const check = crypto.randomBytes(4);
  let priv = Buffer.concat([check, check, privEntry, sshString(comment || '')]);
  const pad = []; for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i);
  priv = Buffer.concat([priv, Buffer.from(pad)]);
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'), sshString('none'), sshString('none'), sshString(''),
    u32(1), sshString(pubBlob), sshString(priv),
  ]);
  const b64 = body.toString('base64').replace(/.{1,70}/g, '$&\n');
  return Buffer.from(`-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}-----END OPENSSH PRIVATE KEY-----\n`);
}

// ---------- PPK ----------
function parsePPKText(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const head = {}; let i = 0; const take = (n) => { const out = lines.slice(i, i + n).join(''); i += n; return out; };
  while (i < lines.length) {
    const m = lines[i++].match(/^([\w-]+):\s?(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'Public-Lines') head.public = Buffer.from(take(+v), 'base64');
    else if (k === 'Private-Lines') head.private = Buffer.from(take(+v), 'base64');
    else head[k] = v;
  }
  const ver = text.startsWith('PuTTY-User-Key-File-3') ? 3 : text.startsWith('PuTTY-User-Key-File-2') ? 2 : 0;
  if (!ver) throw new KeyError('BAD_KEY', tr('kc.unknownPpk'));
  head.type = head[`PuTTY-User-Key-File-${ver}`];
  head.version = ver;
  return head;
}

async function argon2(head, passphrase, length) {
  const { argon2id, argon2i, argon2d } = require('hash-wasm');
  const fn = { Argon2id: argon2id, Argon2i: argon2i, Argon2d: argon2d }[head['Key-Derivation']];
  if (!fn) throw new KeyError('BAD_KEY', tr('kc.unknownKdf', { x: head['Key-Derivation'] }));
  return Buffer.from(await fn({
    password: passphrase, salt: Buffer.from(head['Argon2-Salt'], 'hex'),
    memorySize: +head['Argon2-Memory'], iterations: +head['Argon2-Passes'],
    parallelism: +head['Argon2-Parallelism'], hashLength: length, outputType: 'binary',
  }));
}

async function convertPPK(text, passphrase) {
  const h = parsePPKText(text);
  const encrypted = h.Encryption && h.Encryption !== 'none';
  if (encrypted && h.Encryption !== 'aes256-cbc') throw new KeyError('BAD_KEY', tr('kc.unknownEnc', { x: h.Encryption }));
  if (encrypted && !passphrase) throw new KeyError('NEED_PASSPHRASE', tr('kc.needPass'));

  let priv = h.private, macKey, macAlg;
  if (h.version === 3) {
    macAlg = 'sha256';
    if (encrypted) {
      const k = await argon2(h, passphrase, 80);
      const d = crypto.createDecipheriv('aes-256-cbc', k.subarray(0, 32), k.subarray(32, 48));
      d.setAutoPadding(false);
      priv = Buffer.concat([d.update(priv), d.final()]);
      macKey = k.subarray(48, 80);
    } else macKey = Buffer.alloc(0);
  } else {
    macAlg = 'sha1';
    const pp = encrypted ? passphrase : '';
    if (encrypted) {
      const sha = (n) => crypto.createHash('sha1').update(Buffer.concat([u32(n), Buffer.from(pp)])).digest();
      const key = Buffer.concat([sha(0), sha(1)]).subarray(0, 32);
      const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      d.setAutoPadding(false);
      priv = Buffer.concat([d.update(priv), d.final()]);
    }
    macKey = crypto.createHash('sha1').update('putty-private-key-file-mac-key' + pp).digest();
  }

  const mac = crypto.createHmac(macAlg, macKey).update(Buffer.concat([
    sshString(h.type), sshString(h.Encryption || 'none'), sshString(h.Comment || ''),
    sshString(h.public), sshString(priv),
  ])).digest('hex');
  if (mac !== (h['Private-MAC'] || '').toLowerCase()) {
    throw encrypted
      ? new KeyError('BAD_PASSPHRASE', tr('kc.badPass'))
      : new KeyError('BAD_KEY', tr('kc.badMac'));
  }

  // Byg OpenSSH-nøglens private del ud fra PPK's offentlige og private blobs
  const pub = reader(h.public); pub.string(); // type
  const pr = reader(priv);
  let entry;
  if (h.type === 'ssh-rsa') {
    const e = pub.string(), n = pub.string();
    const d = pr.string(), p = pr.string(), q = pr.string(), iqmp = pr.string();
    entry = Buffer.concat([sshString(h.type), mpint(n), mpint(e), mpint(d), mpint(iqmp), mpint(p), mpint(q)]);
  } else if (h.type === 'ssh-ed25519') {
    const A = pub.string(); const seed = pr.string();
    entry = Buffer.concat([sshString(h.type), sshString(A), sshString(Buffer.concat([seed, A]))]);
  } else if (h.type === 'ssh-dss' || h.type.startsWith('ecdsa-sha2-')) {
    // Offentlige felter i samme rækkefølge + den private skalar
    entry = Buffer.concat([h.public, mpint(pr.string())]);
  } else {
    throw new KeyError('BAD_KEY', tr('kc.unsupportedType', { x: h.type }));
  }
  return buildOpenSSH(h.public, entry, h.Comment);
}

// ---------- PKCS#8 / generisk PEM via Node crypto ----------
function convertPKCS8(text, passphrase) {
  const encrypted = text.includes('ENCRYPTED');
  if (encrypted && !passphrase) throw new KeyError('NEED_PASSPHRASE', tr('kc.needPass'));
  let key;
  try { key = crypto.createPrivateKey({ key: text, format: 'pem', passphrase: passphrase || undefined }); }
  catch (e) {
    if (encrypted) throw new KeyError('BAD_PASSPHRASE', tr('kc.badPass'));
    throw new KeyError('BAD_KEY', tr('kc.readFail', { err: e.message }));
  }
  const t = key.asymmetricKeyType;
  if (t === 'rsa') return Buffer.from(key.export({ type: 'pkcs1', format: 'pem' }));
  if (t === 'ec') return Buffer.from(key.export({ type: 'sec1', format: 'pem' }));
  if (t === 'ed25519') {
    const jwk = key.export({ format: 'jwk' });
    const seed = Buffer.from(jwk.d, 'base64url'), A = Buffer.from(jwk.x, 'base64url');
    const pubBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(A)]);
    const entry = Buffer.concat([sshString('ssh-ed25519'), sshString(A), sshString(Buffer.concat([seed, A]))]);
    return buildOpenSSH(pubBlob, entry, '');
  }
  throw new KeyError('BAD_KEY', tr('kc.unsupportedType', { x: t }));
}

// ---------- Indgang ----------
// Returnerer { key, passphrase } klar til ssh2, eller kaster KeyError.
async function loadPrivateKey(buf, passphrase) {
  const text = buf.toString('utf8').replace(/^\uFEFF/, '').trim();
  let key = buf, pass = passphrase || undefined;

  if (/^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-\S+|sk-\S+) AAAA/.test(text) || text.startsWith('---- BEGIN SSH2 PUBLIC KEY')) {
    throw new KeyError('BAD_KEY', tr('kc.isPublic'));
  }
  if (text.startsWith('PuTTY-User-Key-File-')) {
    key = await convertPPK(text, passphrase); pass = undefined;
  } else if (/^-----BEGIN (ENCRYPTED )?PRIVATE KEY-----/.test(text)) {
    key = convertPKCS8(text, passphrase); pass = undefined;
  } else if (!text.startsWith('-----BEGIN')) {
    throw new KeyError('BAD_KEY', tr('kc.notKey'));
  }

  // Lad ssh2 validere resultatet, så fejl kommer her med en forståelig besked
  const parsed = utils.parseKey(key, pass);
  if (parsed instanceof Error) {
    const m = parsed.message;
    if (/no passphrase/i.test(m)) throw new KeyError('NEED_PASSPHRASE', tr('kc.needPass'));
    if (/decrypt|bad passphrase|integrity check/i.test(m)) throw new KeyError('BAD_PASSPHRASE', tr('kc.badPass'));
    throw new KeyError('BAD_KEY', m);
  }
  return { key, passphrase: pass };
}

module.exports = { loadPrivateKey, KeyError };
