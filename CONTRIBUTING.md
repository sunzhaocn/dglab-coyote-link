# Contributing to CoyoteLink

Contributions are welcome, especially protocol compatibility fixes, mobile browser fixes, deployment robustness improvements and reproducible device-state bugs.

## Before opening an issue

Include:

- CoyoteLink version (`/healthz` or `VERSION.txt`)
- browser + OS
- DG-LAB APP version if known
- device model/firmware if known
- whether the problem occurs with A, B or both channels
- exact reproduction steps
- expected vs actual behavior

Remove domains, room IDs, certificate paths, private keys and other secrets from logs/screenshots.

## Development

No npm install is required for the current source tree; the QR implementation is vendored.

```bash
node --check app.js
node --check server.js
node --check tls-scan.js
bash -n deploy.sh
bash -n update.sh
```

Start a local server:

```bash
PORT=8787 HOST=127.0.0.1 node server.js
curl http://127.0.0.1:8787/healthz
```

## Pull requests

- Keep protocol changes focused and explain the relevant V4 action/event semantics.
- Preserve disconnect/zeroing behavior unless the change explicitly replaces it with an equally safe mechanism.
- Do not claim physical-device behavior was tested unless it actually was.
- For UI changes, test at least one narrow mobile viewport and one desktop viewport.
- Update `CHANGELOG.md` for user-visible changes.
- Keep third-party and upstream license notices intact.
