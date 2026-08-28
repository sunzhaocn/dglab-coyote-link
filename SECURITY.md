# Security Policy

## Supported version

Security fixes target the latest public release of CoyoteLink.

| Version | Supported |
| --- | --- |
| 1.x | Yes |
| 0.x | No; upgrade to the latest release |

## Reporting a vulnerability

If the repository has GitHub **Private Vulnerability Reporting** enabled, use that channel for security-sensitive reports.

Otherwise, open a minimal public issue that does **not** include exploit details, private keys, tokens, certificates, passwords, private room identifiers, server logs containing secrets, or deployment credentials. The maintainer can then choose a private channel for follow-up.

## Deployment secrets

Never commit the following to Git:

- `/etc/dglab-mutual/config.env`
- TLS private keys (`*.key`, private-key PEM files, PFX/P12 files)
- copied production `domains/*/ssl/` directories
- server credentials or shell history containing them

The included `.gitignore` blocks common secret-bearing deployment files, but it cannot prevent every accidental commit.

The HTTP server intentionally uses a static-file allowlist. Source files, deployment scripts, backups and `domains/*/ssl/` are not web-readable routes. If you modify `server.js`, keep this boundary intact and test that `/server.js` and a representative private-key path return `404`.

## Device-control safety

CoyoteLink contains software fail-safes such as emergency stop, heartbeat timeouts and disconnect handling. These are best-effort controls over browser, WebSocket, APP and device links; they are not a hardware safety system and cannot guarantee zero-latency shutdown under every failure mode.

Test changes at low intensity and keep a physical means of stopping/disconnecting the device available during development.

## v1.0.1 security fix

Versions before v1.0.1 could expose files from the deployment directory through the generic static-file handler. Upgrade to v1.0.1 or later. The server now serves only an explicit public-file allowlist.
