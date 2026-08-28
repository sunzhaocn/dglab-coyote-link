'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const QRCode = require('./vendor/qrcode/index');
const QRErrorCorrectLevel = require('./vendor/qrcode/QRErrorCorrectLevel');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const TLS_CERT_FILE = process.env.TLS_CERT_FILE || '';
const TLS_KEY_FILE = process.env.TLS_KEY_FILE || '';
const TLS_CA_FILE = process.env.TLS_CA_FILE || '';
const TLS_PFX_FILE = process.env.TLS_PFX_FILE || '';
const TLS_PFX_PASSPHRASE = process.env.TLS_PFX_PASSPHRASE || '';
const root = path.resolve(__dirname);
const MAX_PAYLOAD = 256 * 1024;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const ALLOW_CROSS_ORIGIN_WS = process.env.ALLOW_CROSS_ORIGIN_WS === '1';
const V4_IDLE_TIMEOUT_MS = Number(process.env.V4_IDLE_TIMEOUT || 5 * 60_000);
const V4_HEARTBEAT_MS = Number(process.env.V4_HEARTBEAT_INTERVAL || 30_000);
const ROOM_CLIENT_TIMEOUT_MS = Number(process.env.ROOM_CLIENT_TIMEOUT || 4500);

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8'
};

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type, 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'"
  });
  res.end(text);
}

function makeQr(text) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(text);
  qr.make();
  return qr;
}

function qrSvg(text) {
  const qr = makeQr(text);
  const count = qr.getModuleCount();
  const quiet = 4;
  const size = count + quiet * 2;
  let d = '';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

let CRC_TABLE;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  t.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}
function qrPng(text, scale = 6) {
  const qr = makeQr(text);
  const count = qr.getModuleCount();
  const quiet = 4;
  const modules = count + quiet * 2;
  const size = modules * scale;
  const stride = size + 1;
  const raw = Buffer.alloc(stride * size, 255);
  for (let y = 0; y < size; y++) raw[y * stride] = 0;
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (!qr.isDark(r, c)) continue;
      const x0 = (c + quiet) * scale;
      const y0 = (r + quiet) * scale;
      for (let y = y0; y < y0 + scale; y++) raw.fill(0, y * stride + 1 + x0, y * stride + 1 + x0 + scale);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function sendBuffer(res, status, data, type) {
  res.writeHead(status, {
    'content-type': type, 'content-length': data.length, 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer'
  });
  res.end(data);
}

function requestHandler(req, res) {
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) return sendText(res, 405, 'Method Not Allowed');
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/healthz') {
    return sendText(res, 200, JSON.stringify({ ok: true, service: 'dglab-coyote-link', version: '1.0.0', socket: 'v4', ts: Date.now() }), 'application/json; charset=utf-8');
  }
  if (u.pathname === '/api/qr.svg' || u.pathname === '/api/qr.png') {
    const text = u.searchParams.get('text') || '';
    if (!text || text.length > 2048) return sendText(res, 400, 'Bad QR data');
    try {
      if (u.pathname.endsWith('.png')) return sendBuffer(res, 200, qrPng(text), 'image/png');
      return sendText(res, 200, qrSvg(text), 'image/svg+xml; charset=utf-8');
    } catch { return sendText(res, 400, 'QR generation failed'); }
  }
  if (u.pathname === '/ws' || u.pathname === '/v4' || u.pathname === '/v4/') return sendText(res, 426, 'Upgrade Required');

  let requested;
  try { requested = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1)); }
  catch { return sendText(res, 400, 'Bad Request'); }
  const file = path.resolve(root, requested);
  if (file !== root && !file.startsWith(root + path.sep)) return sendText(res, 403, 'Forbidden');

  fs.readFile(file, (err, data) => {
    if (err) return sendText(res, err.code === 'ENOENT' ? 404 : 500, err.code === 'ENOENT' ? 'Not found' : 'Internal Server Error');
    res.writeHead(200, {
      'content-type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer'
    });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  });
}

function httpsRedirectHandler(req, res) {
  const host = String(req.headers.host || '').replace(/[\r\n]/g, '');
  if (!host) return sendText(res, 400, 'Host required');
  let target;
  try { target = new URL(req.url || '/', `https://${host}`).toString(); }
  catch { return sendText(res, 400, 'Bad Request'); }
  res.writeHead(308, {
    location: target, 'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff'
  });
  res.end(`HTTPS required: ${target}`);
}

function createTlsOptions() {
  if (TLS_PFX_FILE) {
    const options = { pfx: fs.readFileSync(TLS_PFX_FILE) };
    if (TLS_PFX_PASSPHRASE) options.passphrase = TLS_PFX_PASSPHRASE;
    return options;
  }
  if (TLS_CERT_FILE || TLS_KEY_FILE) {
    if (!TLS_CERT_FILE || !TLS_KEY_FILE) throw new Error('TLS_CERT_FILE and TLS_KEY_FILE must both be set');
    const options = { cert: fs.readFileSync(TLS_CERT_FILE), key: fs.readFileSync(TLS_KEY_FILE) };
    if (TLS_CA_FILE) options.ca = fs.readFileSync(TLS_CA_FILE);
    return options;
  }
  return null;
}

function createTransport() {
  const tlsOptions = createTlsOptions();
  if (!tlsOptions) {
    const appServer = http.createServer(requestHandler);
    return {
      listener: appServer, appServer, redirectServer: null, secure: false,
      start(port, host, cb) { appServer.listen(port, host, cb); },
      close(cb) { appServer.close(cb); }
    };
  }

  // One *public* configured TCP port accepts both protocols. Two ephemeral
  // loopback-only helper ports terminate HTTP and HTTPS internally; they are not
  // exposed by the firewall and do not touch the user's existing 80/443 sites.
  const appServer = https.createServer(tlsOptions, requestHandler);
  const redirectServer = http.createServer(httpsRedirectHandler);
  let tlsPort = 0, httpPort = 0;
  const listener = net.createServer(socket => {
    socket.once('data', first => {
      if (!first || first.length === 0) return socket.destroy();
      const looksTls = first[0] === 0x16 || first[0] === 0x80;
      const targetPort = looksTls ? tlsPort : httpPort;
      if (!targetPort) return socket.destroy();
      const upstream = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
        upstream.write(first);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    });
  });

  return {
    listener, appServer, redirectServer, secure: true,
    start(port, host, cb) {
      appServer.listen(0, '127.0.0.1', () => {
        tlsPort = appServer.address().port;
        redirectServer.listen(0, '127.0.0.1', () => {
          httpPort = redirectServer.address().port;
          listener.listen(port, host, cb);
        });
      });
    },
    close(cb) {
      let pending = 3;
      const done = () => { if (--pending === 0) cb?.(); };
      try { listener.close(done); } catch { done(); }
      try { appServer.close(done); } catch { done(); }
      try { redirectServer.close(done); } catch { done(); }
    }
  };
}

const transport = createTransport();
const server = transport.appServer;
const listener = transport.listener;
const clients = new Set();
const rooms = new Map();

// DG-LAB official Socket V4 relay model, ported from dungeonlab-open/dglab-websocket-server/v4-server.ts.
const v4ControllersById = new Map();
const v4ControlledClients = new Map(); // controller client -> Map(clientId, controlled client)
const v4ClientToController = new Map();
const v4IdleTimers = new Map();

function frame(opcode, payload = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len <= 0xffff) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

function wsSend(client, data) {
  if (client.closed || client.socket.destroyed) return;
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  client.socket.write(frame(0x1, Buffer.from(text, 'utf8')));
}

function rawWsClose(client, code = 1000, reason = '') {
  if (client.closed) return;
  client.closed = true;
  const reasonBuf = Buffer.from(String(reason).slice(0, 120), 'utf8');
  const payload = Buffer.alloc(2 + reasonBuf.length); payload.writeUInt16BE(code, 0); reasonBuf.copy(payload, 2);
  try { client.socket.write(frame(0x8, payload)); } catch {}
  try { client.socket.end(); } catch {}
}

function peers(room) { return rooms.get(room) || new Set(); }
function broadcast(room, data, except = null) { const set = rooms.get(room); if (!set) return; for (const c of set) if (c !== except) wsSend(c, data); }
function leaveRoom(client) {
  if (!client.room) return;
  const room = client.room; const set = rooms.get(room); client.room = null;
  if (!set) return; set.delete(client); broadcast(room, { type: 'peer', peerId: client.peerId, online: false }); if (!set.size) rooms.delete(room);
}
function roomClose(client, code = 1000, reason = '') { leaveRoom(client); rawWsClose(client, code, reason); clients.delete(client); }
function rateAllowed(client, max = 100) {
  const now = Date.now(); if (!client.rate || now - client.rate.start >= 1000) client.rate = { start: now, count: 0 };
  client.rate.count += 1; return client.rate.count <= max;
}

function handleRoomMessage(client, text) {
  let m; try { m = JSON.parse(text); } catch { return; }
  client.lastRoomAt = Date.now();
  if (!rateAllowed(client, 100)) return;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'join') {
    const room = String(m.room || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{8,12}$/.test(room)) return wsSend(client, { type: 'error', message: '房间号需 8–12 位，仅限英文字母和数字' });
    leaveRoom(client); const set = peers(room);
    if (set.size >= 2) return wsSend(client, { type: 'error', message: '该房间已有两人' });
    client.room = room; client.lastRoomAt = Date.now(); rooms.set(room, set); set.add(client); wsSend(client, { type: 'joined', peerId: client.peerId, room });
    for (const p of set) if (p !== client) { wsSend(client, { type: 'peer', peerId: p.peerId, online: true }); wsSend(p, { type: 'peer', peerId: client.peerId, online: true }); }
    return;
  }
  if (m.type === 'ping') return wsSend(client, { type: 'pong', ts: m.ts });
  if (!client.room) return;
  if (['presence', 'control', 'control_delta', 'wave_custom', 'touch_control', 'stop'].includes(m.type)) { m.peerId = client.peerId; broadcast(client.room, m, client); }
}

function v4CreateClientId() {
  let id; do { id = crypto.randomBytes(4).toString('hex'); } while (v4ControllersById.has(id) || [...clients].some(c => c.v4ClientId === id));
  return id;
}
function v4CancelIdle(controller) { const t = v4IdleTimers.get(controller); if (t) clearTimeout(t); v4IdleTimers.delete(controller); }
function v4StartIdle(controller) {
  v4CancelIdle(controller);
  const timer = setTimeout(() => {
    v4IdleTimers.delete(controller);
    if (!controller.closed) { wsSend(controller, { type: 'idle_timeout' }); v4Close(controller, 4002, 'idle_timeout'); }
  }, V4_IDLE_TIMEOUT_MS);
  timer.unref?.(); v4IdleTimers.set(controller, timer);
}
function v4Open(client) {
  const id = v4CreateClientId(); client.v4ClientId = id; wsSend(client, { type: 'hello', clientId: id });
  if (client.v4Tid) {
    const controller = v4ControllersById.get(client.v4Tid);
    if (!controller || controller.closed) { wsSend(client, { type: 'error', code: 'controller_not_found' }); return v4Close(client, 4001, 'controller_not_found'); }
    const map = v4ControlledClients.get(controller);
    if (!map) { wsSend(client, { type: 'error', code: 'controller_not_found' }); return v4Close(client, 4001, 'controller_not_found'); }
    map.set(id, client); v4ClientToController.set(client, controller); v4CancelIdle(controller);
    wsSend(client, { type: 'controller_attached', clientId: client.v4Tid });
    wsSend(controller, { type: 'client_attached', clientId: id });
  } else {
    v4ControllersById.set(id, client); v4ControlledClients.set(client, new Map()); v4StartIdle(client);
  }
}
function v4HandleMessage(client, text) {
  if (!rateAllowed(client, 160)) return;
  let m; try { m = JSON.parse(text); } catch { return; }
  if (!m || typeof m !== 'object') return;
  if (m.type === 'ping') return wsSend(client, { type: 'pong', ts: Date.now() });
  if (m.type === 'pong' || m.type !== 'message') return;
  const id = client.v4ClientId; if (!id) return;
  if (v4ControllersById.has(id)) {
    if (typeof m.clientId !== 'string') return wsSend(client, { type: 'error', code: 'bad_request', message: 'message.clientId is required' });
    const controlled = v4ControlledClients.get(client)?.get(m.clientId);
    if (!controlled || controlled.closed) return wsSend(client, { type: 'error', code: 'client_not_found', clientId: m.clientId });
    return wsSend(controlled, { type: 'message', data: m.data });
  }
  const controller = v4ClientToController.get(client);
  if (controller && !controller.closed) wsSend(controller, { type: 'message', clientId: id, data: m.data });
}
function v4Detach(client) {
  const id = client.v4ClientId; if (!id) return;
  if (v4ControllersById.has(id)) {
    v4ControllersById.delete(id); v4CancelIdle(client);
    const map = v4ControlledClients.get(client); v4ControlledClients.delete(client);
    if (map) for (const [cid, c] of map) { v4ClientToController.delete(c); if (!c.closed) { wsSend(c, { type: 'controller_disconnected', clientId: id }); rawWsClose(c, 4000, 'controller_disconnected'); clients.delete(c); } }
    return;
  }
  const controller = v4ClientToController.get(client); v4ClientToController.delete(client);
  if (controller) {
    const map = v4ControlledClients.get(controller); map?.delete(id);
    if (!controller.closed) { wsSend(controller, { type: 'client_disconnected', clientId: id }); if (!map || map.size === 0) v4StartIdle(controller); }
  }
}
function v4Close(client, code = 1000, reason = '') { v4Detach(client); rawWsClose(client, code, reason); clients.delete(client); }

function parseFrames(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  while (client.buffer.length >= 2) {
    const b0 = client.buffer[0], b1 = client.buffer[1], fin = !!(b0 & 0x80), opcode = b0 & 0x0f, masked = !!(b1 & 0x80);
    let len = b1 & 0x7f, offset = 2;
    if (!masked) return (client.kind === 'v4' ? v4Close : roomClose)(client, 1002, 'client frames must be masked');
    if (len === 126) { if (client.buffer.length < 4) return; len = client.buffer.readUInt16BE(2); offset = 4; }
    else if (len === 127) { if (client.buffer.length < 10) return; const big = client.buffer.readBigUInt64BE(2); if (big > BigInt(MAX_PAYLOAD)) return (client.kind === 'v4' ? v4Close : roomClose)(client, 1009, 'message too large'); len = Number(big); offset = 10; }
    if (len > MAX_PAYLOAD) return (client.kind === 'v4' ? v4Close : roomClose)(client, 1009, 'message too large');
    if (client.buffer.length < offset + 4 + len) return;
    const mask = client.buffer.subarray(offset, offset + 4); offset += 4;
    const payload = Buffer.from(client.buffer.subarray(offset, offset + len)); client.buffer = client.buffer.subarray(offset + len);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    if (opcode === 0x8) return (client.kind === 'v4' ? v4Close : roomClose)(client, 1000, 'bye');
    if (opcode === 0x9) { try { client.socket.write(frame(0xA, payload)); } catch {} continue; }
    if (opcode === 0xA) { client.isAlive = true; continue; }
    if (opcode !== 0x0 && opcode !== 0x1) return (client.kind === 'v4' ? v4Close : roomClose)(client, 1003, 'unsupported frame');
    if (opcode === 0x1) client.fragments = [payload]; else if (!client.fragments) return (client.kind === 'v4' ? v4Close : roomClose)(client, 1002, 'unexpected continuation'); else client.fragments.push(payload);
    const total = client.fragments.reduce((n, p) => n + p.length, 0); if (total > MAX_PAYLOAD) return (client.kind === 'v4' ? v4Close : roomClose)(client, 1009, 'message too large');
    if (fin) { const message = Buffer.concat(client.fragments).toString('utf8'); client.fragments = null; (client.kind === 'v4' ? v4HandleMessage : handleRoomMessage)(client, message); }
  }
}

server.on('upgrade', (req, socket, head) => {
  let u; try { u = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
  const pathname = u.pathname;
  if (pathname !== '/ws' && pathname !== '/v4' && pathname !== '/v4/') { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'], version = req.headers['sec-websocket-version'], upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (!key || version !== '13' || upgrade !== 'websocket') { socket.destroy(); return; }
  if (pathname === '/ws' && !ALLOW_CROSS_ORIGIN_WS && req.headers.origin && req.headers.host) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) { socket.destroy(); return; } } catch { socket.destroy(); return; }
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const client = {
    socket, kind: (pathname === '/v4' || pathname === '/v4/') ? 'v4' : 'room', peerId: crypto.randomUUID(), room: null,
    v4Tid: (pathname === '/v4' || pathname === '/v4/') ? (u.searchParams.get('tid') || u.searchParams.get('targetId') || null) : null,
    v4ClientId: null, buffer: Buffer.alloc(0), fragments: null, isAlive: true, closed: false, rate: null, lastRoomAt: Date.now()
  };
  clients.add(client); socket.setNoDelay(true); socket.setKeepAlive(true, 30000);
  socket.on('data', chunk => parseFrames(client, chunk));
  socket.on('close', () => { if (!client.closed) { if (client.kind === 'v4') v4Detach(client); else leaveRoom(client); } client.closed = true; clients.delete(client); });
  socket.on('error', () => { if (!client.closed) { if (client.kind === 'v4') v4Detach(client); else leaveRoom(client); } client.closed = true; clients.delete(client); });
  if (client.kind === 'v4') v4Open(client);
  if (head && head.length) parseFrames(client, head);
});

const heartbeat = setInterval(() => {
  for (const client of clients) {
    if (!client.isAlive) { (client.kind === 'v4' ? v4Close : roomClose)(client, 1001, 'heartbeat timeout'); continue; }
    client.isAlive = false; try { client.socket.write(frame(0x9, Buffer.from('hb'))); } catch { (client.kind === 'v4' ? v4Close : roomClose)(client, 1001, 'heartbeat failed'); }
  }
}, 30000); heartbeat.unref();

const v4BusinessHeartbeat = setInterval(() => { for (const c of clients) if (c.kind === 'v4' && !c.closed) wsSend(c, { type: 'heartbeat' }); }, V4_HEARTBEAT_MS); v4BusinessHeartbeat.unref();

const roomLeaseMonitor = setInterval(() => {
  const now = Date.now();
  for (const c of [...clients]) {
    if (c.kind !== 'room' || c.closed || !c.room) continue;
    if (now - (c.lastRoomAt || 0) > ROOM_CLIENT_TIMEOUT_MS) roomClose(c, 4008, 'room heartbeat timeout');
  }
}, 1000); roomLeaseMonitor.unref();

function shutdown(signal) {
  console.log(`[shutdown] ${signal}`); clearInterval(heartbeat); clearInterval(v4BusinessHeartbeat); clearInterval(roomLeaseMonitor);
  for (const c of [...clients]) (c.kind === 'v4' ? v4Close : roomClose)(c, 1001, 'server shutdown');
  transport.close(() => process.exit(0)); setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
transport.start(PORT, HOST, () => console.log(`DG-LAB Mutual Web + official Socket V4 relay listening on ${transport.secure ? 'HTTP→HTTPS + HTTPS' : 'HTTP'}://${HOST}:${PORT}`));
