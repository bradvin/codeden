---
section: security
---

- **Trusted proxy rules.** A request that names a trusted origin's host counts as coming from another device even from this computer, so it can't use the install token or reach `/mcp`. A request a proxy forwards for any other host (a client can put `127.0.0.1` in `Host`) is refused, so nothing through a proxy passes as this computer. Sign-in throttling through it keys on the forwarded address with one shared limit, and Tailscale identity headers are never trusted.
