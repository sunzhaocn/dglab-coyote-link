'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const getArg = (name, fallback = '') => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const sslDir = path.resolve(getArg('--dir', '.'));
const domain = getArg('--domain', '');
const activeDir = path.join(sslDir, 'active');
const exts = new Set(['.pem', '.crt', '.cer', '.key']);

function filesIn(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, ent.name);
    if (path.resolve(p) === path.resolve(activeDir)) continue;
    if (ent.isFile() && exts.has(path.extname(ent.name).toLowerCase())) out.push(p);
    if (ent.isDirectory()) {
      for (const sub of fs.readdirSync(p, { withFileTypes: true })) {
        const q = path.join(p, sub.name);
        if (sub.isFile() && exts.has(path.extname(sub.name).toLowerCase())) out.push(q);
      }
    }
  }
  return out.sort();
}

function pubDer(key) {
  const pub = key && key.type === 'public' ? key : crypto.createPublicKey(key);
  return pub.export({ type: 'spki', format: 'der' });
}
function samePublicKey(a, b) {
  const x = pubDer(a), y = pubDer(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function certPriority(p) {
  const n = path.basename(p).toLowerCase();
  if (/fullchain|full_chain|bundle/.test(n)) return 0;
  if (/cert|certificate/.test(n) || /\.(crt|cer)$/.test(n)) return 1;
  return 2;
}
function keyPriority(p) {
  const n = path.basename(p).toLowerCase();
  if (/privkey|private/.test(n)) return 0;
  if (/key/.test(n) || /\.key$/.test(n)) return 1;
  return 2;
}

const certs = [], keys = [];
for (const f of filesIn(sslDir)) {
  const buf = fs.readFileSync(f);
  try { certs.push({ file: f, cert: new crypto.X509Certificate(buf) }); } catch {}
  try { keys.push({ file: f, key: crypto.createPrivateKey(buf) }); } catch {}
}
certs.sort((a,b) => certPriority(a.file)-certPriority(b.file) || a.file.localeCompare(b.file));
keys.sort((a,b) => keyPriority(a.file)-keyPriority(b.file) || a.file.localeCompare(b.file));

const matches = [];
for (const c of certs) {
  for (const k of keys) {
    try {
      if (!samePublicKey(c.cert.publicKey, k.key)) continue;
      let hostMatch = null;
      if (domain) {
        try { hostMatch = Boolean(c.cert.checkHost(domain)); } catch { hostMatch = null; }
      }
      matches.push({
        ok: true, cert: c.file, key: k.file, hostMatch, subject: c.cert.subject, validTo: c.cert.validTo,
        expiry: Number.isFinite(Date.parse(c.cert.validTo)) ? Date.parse(c.cert.validTo) : 0
      });
    } catch {}
  }
}
if (matches.length) {
  matches.sort((a,b) => b.expiry - a.expiry || certPriority(a.cert)-certPriority(b.cert) || a.cert.localeCompare(b.cert));
  const best = matches[0];
  delete best.expiry;
  process.stdout.write(JSON.stringify(best));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: false, reason: 'no_matching_pair', files: filesIn(sslDir) }));
process.exit(2);
