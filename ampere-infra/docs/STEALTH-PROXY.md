# Ampere Stealth Proxy - Browser Automation via Desktop Proxy

## Overview

This feature enables browser automation that **bypasses captcha and bot detection** by routing traffic through the user's desktop network (residential IP) instead of cloud IPs.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         USER'S SERVER (Pro/Business)                     │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Chromium + playwright-core                                     │   │
│  │  - Persistent profiles per user                                 │   │
│  │  - All HTTP/SOCKS traffic → proxy tunnel                        │   │
│  │  - Canvas/WebGL fingerprint randomization                       │   │
│  │  - Human-like behavior (typing, clicking, scrolling)            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              ↓ SOCKS/HTTP proxy                          │
│                         WebSocket connection                             │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↑
                                    ↓ WebSocket (control channel)
┌─────────────────────────────────────────────────────────────────────────┐
│                         USER'S DESKTOP                                  │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Ampere Desktop App - Lightweight Proxy Agent                   │   │
│  │  - NO browser runs here (lightweight!)                          │   │
│  │  - SOCKS/HTTP proxy server (local port)                         │   │
│  │  - Tunnels requests to target websites                          │   │
│  │  - Returns responses back to server                             │   │
│  │  - Uses user's residential IP                                   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              ↓ User's Residential IP                     │
└─────────────────────────────────────────────────────────────────────────┘
```

## How It Works

1. **User installs stealth-proxy feature** → `installFeature('stealth-proxy')` (requires Pro/Business plan)
2. **Container gets**: Chromium, playwright-core, browser-server.js (systemd service on port 9222)
3. **Networking**: incus proxy device → unix socket → Caddy route (same pattern as gateway)
4. **User opens Ampere Desktop** → Connects via WebSocket to portal → relayed to container browser-server
5. **Desktop starts local proxy** → HTTP proxy on localhost
6. **Container launches Chromium** → Configured to use desktop as proxy
7. **Target website sees** → Residential IP (not cloud IP) ✅

## Network Path

```
Desktop App → portal.ampere.sh (WS) → Caddy on server:8443 → unix socket → container:9222 (browser-server)
```

Same pattern as gateway chat:
- **Incus proxy device**: `browser-proxy` → `listen=unix:/run/ampere/<container>-browser.sock` → `connect=tcp:127.0.0.1:9222`
- **Caddy route**: `handle_path /browser/<instance_id>/*` → `reverse_proxy unix//run/ampere/<container>-browser.sock`
- **Auth**: Token stored in DB column `browser_server_token` + container file `/data/browser-server-token`

## API Endpoints

### GET /api/my/proxy-status
Check if user has active desktop proxy agent connected.

### WS /api/my/proxy-agent
WebSocket endpoint for desktop proxy agents. Portal authenticates via Firebase token, then relays bidirectionally to container browser-server.

### GET /instances/:id/browser-info (internal)
Returns `{ server_ip, browser_server_token, container_name, instance_id }`. Used by portal server-side only.

## Plan Requirements

- **Pro or Business plan required** (enforced in `installFeature`)
- RAM check: 1GB minimum available before launching Chrome
- Free/Starter users get error: "Stealth Proxy requires a Pro or Business plan"

## Files

### Orchestrator
- `src/skills/ampere-stealth-proxy/browser-server.js` — Browser automation server (port 9222, localhost only)
- `src/skills/ampere-stealth-proxy/SKILL.md` — Skill metadata
- `src/skills.ts` — `pushStealthProxySkill()` pushes skill files to container
- `src/instances.ts` — `installFeature('stealth-proxy')` handles full install flow
- `src/caddy.ts` — `addRoute()` extended with `hasBrowser` flag
- `src/db.ts` — `browser_server_token` column migration

### Portal
- `src/proxy/index.ts` — Feature-flagged plugin (`ENABLE_STEALTH_PROXY=true`)
- `src/proxy/ws-handler.ts` — WebSocket relay (desktop ↔ container)
- `src/proxy/http-routes.ts` — `/api/my/proxy-status`
- `src/proxy/agent-store.ts` — In-memory agent connection tracking

## Install Flow

1. Plan check (Pro/Business only)
2. Install Chromium in container (`apt-get install chromium-browser`)
3. Push skill files (browser-server.js, SKILL.md)
4. `npm install ws playwright-core` (with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`)
5. Generate auth token → `/data/browser-server-token` + DB column
6. Create systemd service → `browser-server.service`
7. Add incus proxy device (unix socket)
8. Regenerate Caddy config with browser route

## Migration Support

When an instance with stealth-proxy migrates to a new server:
- Browser proxy incus device is re-added on target
- Caddy route includes browser path on target server

## Security

1. **Authentication** — Browser-server requires token on all HTTP/WS requests
2. **Token isolation** — Stored in dedicated DB column, accessed via internal `/browser-info` endpoint only
3. **Localhost binding** — browser-server listens on `127.0.0.1:9222` (accessed only via incus proxy)
4. **No internet exposure** — Unix socket + Caddy, identical to gateway pattern
5. **Plan gating** — Pro/Business only
6. **RAM guard** — 1GB minimum check before Chrome launch
7. **Feature flag** — Portal routes only registered when `ENABLE_STEALTH_PROXY=true`
