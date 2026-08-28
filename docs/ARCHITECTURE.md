# Architecture

CoyoteLink is intentionally small: one Node.js process serves the static UI, room WebSocket and DG-LAB Socket V4 relay on one public port.

```text
Browser A ── /ws ──┐
                    │
Browser B ── /ws ──┼── CoyoteLink server
                    │
Browser controller ─/v4── DG-LAB APP ── local device
```

## Components

### `server.js`

- Serves only the allowlisted browser assets `index.html` / `app.js`; the application directory is not a generic static root
- Implements `/ws` room relay
- Implements `/v4` Socket V4 relay framing/RPC transport
- Provides `/healthz`
- Generates QR PNG/SVG locally
- In SSL mode multiplexes plaintext HTTP and TLS on the configured public port, redirecting plaintext HTTP to HTTPS

### `app.js`

- Room join/leave and presence
- DG-LAB V4 controller session in the browser
- Device snapshot/patch merge
- A/B intensity target/actual state
- `AddIntensity` `±1` control and closed-loop correction
- Built-in/custom waveform dispatch
- Touch-mode pointer state machine
- Authorization, emergency-stop and timeout behavior

### Deployment scripts

- `deploy.sh`: Linux install/repair/update/uninstall
- `update.sh`: program-only update, health check and rollback
- `tls-scan.js`: finds matching certificate/private-key pairs
- `deploy.ps1`: Windows Server deployment

## Important ownership model

The **browser owns the V4 controller session**. The server relays it but does not persist a controller session on behalf of a closed/suspended browser. This is why background operation is not promised and page visibility changes trigger safety behavior.

## Control model

- `AddIntensity(t=3)` is used for relative `+/-` changes.
- `SetIntensity(t=7,v=0)` is used for explicit zero/reset.
- `AppendPulseData(t=0)` is used for waveform frames.
- Actual intensity is read from APP device-state updates when available and may be reconciled using `devices.get`.

See `OFFICIAL_SOCKET.md` for protocol references.
