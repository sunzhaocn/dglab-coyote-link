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

## Device-control safety

CoyoteLink contains software fail-safes such as emergency stop, heartbeat timeouts and disconnect handling. These are best-effort controls over browser, WebSocket, APP and device links; they are not a hardware safety system and cannot guarantee zero-latency shutdown under every failure mode.

Test changes at low intensity and keep a physical means of stopping/disconnecting the device available during development.
