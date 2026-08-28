'use strict';

// v1.0.2 security/compatibility bootstrap.
// The original V4/room implementation is kept in vendor/server-core.js so
// existing behaviour stays unchanged while this wrapper enforces the web
// exposure boundary and protects the mixed HTTP/HTTPS TCP multiplexer.
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const Module = require('module');

const appRoot = __dirname;
const publicFiles = new Set([
  path.join(appRoot, 'index.html'),
  path.join(appRoot, 'app.js')
]);

// The v1.0.0 core used the install directory as a generic static root. Limit
// asynchronous file reads used by that static handler to the two web assets.
// Certificate loading and module loading use synchronous/internal reads and are
// therefore unaffected.
const realReadFile = fs.readFile;
fs.readFile = function guardedReadFile(file, ...args) {
  let resolved = null;
  try {
    if (typeof file === 'string' || Buffer.isBuffer(file)) resolved = path.resolve(String(file));
  } catch {}
  if (resolved && !publicFiles.has(resolved)) {
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      const error = Object.assign(new Error(`ENOENT: no such file or directory, open '${resolved}'`), {
        code: 'ENOENT', errno: -2, syscall: 'open', path: resolved
      });
      queueMicrotask(() => callback(error));
      return;
    }
  }
  return realReadFile.call(fs, file, ...args);
};

// Add baseline browser hardening to all HTTP responses without changing the
// protocol implementation in the core.
const realWriteHead = http.ServerResponse.prototype.writeHead;
http.ServerResponse.prototype.writeHead = function hardenedWriteHead(...args) {
  if (!this.headersSent) {
    if (!this.hasHeader('x-frame-options')) this.setHeader('x-frame-options', 'DENY');
    if (!this.hasHeader('permissions-policy')) this.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    if (!this.hasHeader('cross-origin-resource-policy')) this.setHeader('cross-origin-resource-policy', 'same-origin');
    if (this.socket?.encrypted && !this.hasHeader('strict-transport-security')) this.setHeader('strict-transport-security', 'max-age=31536000');
  }
  return realWriteHead.apply(this, args);
};

// The TLS build exposes one public TCP port for both plaintext HTTP and TLS.
// vendor/server-core.js consumes the first chunk to decide which loopback
// endpoint should receive the connection. If additional ClientHello/request
// chunks arrive before that loopback connection is ready, a flowing socket can
// otherwise emit and discard those chunks. Android Chrome is particularly good
// at exposing this race with a larger/fragmented TLS ClientHello.
//
// Guard the first `once("data")` handler installed by the raw TCP multiplexer:
// pause immediately after the discriminator chunk is delivered, keep later
// bytes buffered by Node, then resume only when the core attaches its upstream
// pipe. `http.Server` / `https.Server` internals do not use this exported
// net.createServer wrapper, so this is scoped to the explicit raw mux server.
const realCreateServer = net.createServer;
net.createServer = function hardenedCreateServer(...args) {
  const listenerIndex = args.findIndex(arg => typeof arg === 'function');

  if (listenerIndex >= 0) {
    const originalConnectionListener = args[listenerIndex];

    args[listenerIndex] = function guardedConnectionListener(socket) {
      const realOnce = socket.once;
      let firstDataGuardArmed = true;

      socket.once = function guardedOnce(event, listener) {
        if (firstDataGuardArmed && event === 'data' && typeof listener === 'function') {
          firstDataGuardArmed = false;
          socket.once = realOnce;

          return realOnce.call(socket, 'data', function pausedFirstChunk(...dataArgs) {
            socket.pause();

            const realPipe = socket.pipe;
            let pipeGuardArmed = true;

            socket.pipe = function guardedPipe(...pipeArgs) {
              if (pipeGuardArmed) {
                pipeGuardArmed = false;
                socket.pipe = realPipe;
              }
              const result = realPipe.apply(this, pipeArgs);
              socket.resume();
              return result;
            };

            try {
              return listener.apply(this, dataArgs);
            } catch (error) {
              socket.pipe = realPipe;
              socket.resume();
              throw error;
            }
          });
        }

        return realOnce.call(this, event, listener);
      };

      return originalConnectionListener.call(this, socket);
    };
  }

  const server = realCreateServer.apply(net, args);
  server.on('connection', socket => {
    socket.setTimeout(10_000, () => socket.destroy());
    socket.once('data', () => socket.setTimeout(0));
  });
  return server;
};

// Load the reviewed v1.0.0 core through a virtual root-level filename so its
// existing relative vendor/qrcode imports keep resolving correctly. The health
// endpoint version is sourced from VERSION.txt for release consistency.
const corePath = path.join(appRoot, 'vendor', 'server-core.js');
const virtualFilename = path.join(appRoot, 'server-core.js');
let source = fs.readFileSync(corePath, 'utf8');
let version = 'unknown';
try { version = fs.readFileSync(path.join(appRoot, 'VERSION.txt'), 'utf8').trim() || 'unknown'; } catch {}
source = source.replace("version: '1.0.0'", `version: ${JSON.stringify(version)}`);

const coreModule = new Module(virtualFilename, module);
coreModule.filename = virtualFilename;
coreModule.paths = Module._nodeModulePaths(appRoot);
coreModule._compile(source, virtualFilename);
