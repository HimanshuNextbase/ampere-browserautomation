---
name: camoufox-browser
description: >
  Stealth browser automation with persistent sessions via browser-server API (port 9222).
  Camoufox (Firefox) bypasses bot detection. Sessions persist across calls — sign in once, stay signed in.
  Supports desktop proxy for residential IP routing. Auto captcha detection and solving via CapSolver.
---

# Camoufox Browser — Persistent Stealth Automation

**Stealth Firefox browser** running as a persistent HTTP API on port 9222.
Sessions are saved to disk — cookies, logins, and state survive across calls.

✅ **Bypasses:** Google, Cloudflare bot detection  
✅ **Persistent sessions:** Sign in once, stay signed in forever  
✅ **Desktop proxy:** Route traffic through user's residential IP  
✅ **Actions:** Click, type, scroll, upload files, screenshot, extract text/HTML, evaluate JS
✅ **Captcha solving:** Auto-detect + solve captchas via CapSolver (Turnstile, reCAPTCHA, hCaptcha, etc.)

---

## Best Practice: Text First, Screenshot Second

When browsing, always get **text/HTML content first** — it's faster and cheaper.
Only screenshot when you need to see visual layout (images, charts, CSS).

---

## Authentication

All requests require the auth token as a query parameter:
```
?token=<contents of /data/browser-server-token>
```

```bash
TOKEN=$(cat /data/browser-server-token)
```

---

## API Reference

### GET `/?token=TOKEN` — Status
```bash
curl "http://localhost:9222/?token=$TOKEN"
```
Returns: `{ status, desktopProxy, sessions[], profileDir }`

### GET `/sessions?token=TOKEN` — List saved profiles
```bash
curl "http://localhost:9222/sessions?token=$TOKEN"
```

### POST `/?token=TOKEN` — Browse / Act
All browsing is done via POST with a JSON body:

```json
{
  "url": "https://example.com",
  "sessionId": "default",
  "actions": [],
  "screenshot": true,
  "fullPage": false,
  "timeout": 60000,
  "newTab": false,
  "closeBrowser": false
}
```

**Response:**
```json
{
  "success": true,
  "title": "Page Title",
  "url": "https://example.com",
  "screenshot": "<base64 PNG>",
  "results": [],
  "proxy": false,
  "session": "default"
}
```

---

## Key Concepts

### Sessions
- `sessionId` identifies a persistent browser profile
- Each session has its own cookies, localStorage, login state
- Profiles saved to `/data/browser-profiles/<sessionId>/`
- Use different session names for different accounts/sites
- Idle sessions auto-close after **15 minutes** to free RAM

### RAM Management
- Browser requires **400MB minimum** available RAM to launch
- If RAM is low (<512MB), idle sessions are **auto-closed** before launching a new one
- Below 400MB after cleanup, the request fails with an error
- To manually free RAM: close sessions with `{"url":"__close__","sessionId":"<id>"}`

### Actions
Actions execute sequentially after navigation:

| Action | Fields | Example |
|--------|--------|---------|
| `click` | `selector`, `timeout?` | `{"type":"click","selector":"#login-btn"}` |
| `type` | `selector`, `text` | `{"type":"type","selector":"input[name=email]","text":"user@example.com"}` |
| `press` | `selector?`, `key` | `{"type":"press","key":"Enter"}` |
| `wait` | `ms` | `{"type":"wait","ms":2000}` |
| `waitForSelector` | `selector`, `timeout?` | `{"type":"waitForSelector","selector":".results"}` |
| `waitForNavigation` | `timeout?` | `{"type":"waitForNavigation"}` |
| `getText` | `selector?`, `maxChars?` | `{"type":"getText","selector":".content","maxChars":800}` (default selector: body; default cap: 4000 chars) |
| `getHtml` | `selector?`, `maxChars?` | `{"type":"getHtml","selector":"#main","maxChars":1200}` (default cap: 4000 chars) |
| `evaluate` | `script` | `{"type":"evaluate","script":"document.title"}` |
| `scroll` | `amount?` | `{"type":"scroll","amount":500}` |
| `select` | `selector`, `value` | `{"type":"select","selector":"#country","value":"US"}` |
| `hover` | `selector` | `{"type":"hover","selector":".menu"}` |
| `goBack` | — | `{"type":"goBack"}` |
| `goForward` | — | `{"type":"goForward"}` |
| `getCookies` | — | `{"type":"getCookies"}` |
| `setCookie` | `cookie` | `{"type":"setCookie","cookie":{"name":"x","value":"y","domain":".example.com"}}` |
| `upload` | `selector`, `filePath` (or `filePaths`) | `{"type":"upload","selector":"input[type=file]","filePath":"/root/.openclaw/media/inbound/your.jpg"}` |
| `detectCaptcha` | `timeout?`, `maxRetries?`, `retryDelay?`, `summary?` | `{"type":"detectCaptcha","summary":true}` |
| `solveCaptcha` | `autoSubmit?`, `submitSelector?`, `captchaType?`, `detectTimeout?` | `{"type":"solveCaptcha"}` -- detect + solve + inject token via CapSolver |

### Output caps (token/payload saver)
- By default, results are capped server-side to avoid huge responses:
  - `resultMaxChars` (default: 4000)
  - `resultMaxItems` (default: 50)
- Override per action with `maxChars` / `maxItems`.

### Special URLs
- `"__close__"` -- Close a session: `{"url":"__close__","sessionId":"gmail"}`
- `"__current__"` -- Act on current page without navigating
- `"__list__"` -- List saved profiles

---

## Captcha Detection and Solving

### Supported captcha types

| Type | Detection | Solving (CapSolver) |
|------|-----------|-------------------|
| Cloudflare Turnstile | `.cf-turnstile`, iframe, script tag | `AntiTurnstileTaskProxyLess` |
| reCAPTCHA v2 | `.g-recaptcha`, iframe, `grecaptcha.render()` hook | `ReCaptchaV2TaskProxyLess` |
| reCAPTCHA v3 | Script tag, `grecaptcha.execute()` hook | `ReCaptchaV3TaskProxyLess` |
| reCAPTCHA Enterprise | iframe | `ReCaptchaV2EnterpriseTaskProxyLess` |
| hCaptcha | `.h-captcha`, iframe, `hcaptcha.render()` hook | `HCaptchaTaskProxyLess` |
| FunCaptcha/Arkose | iframe, `[data-public-key]` | `FunCaptchaTaskProxyLess` |
| GeeTest v3/v4 | `.geetest_*` elements, `initGeetest4()` hook | `GeeTestTaskProxyLess` |
| Amazon WAF | iframe, `#captcha-container` | `AntiAwsWafTaskProxyLess` |
| Cloudflare Challenge | `#challenge-form`, `#challenge-running` | -- |
| DataDome | iframe, script tag | -- |
| PerimeterX/HUMAN | `#px-captcha` | -- |

### Detect captcha
```bash
curl -X POST "http://localhost:9222/?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/login",
    "actions": [{"type": "detectCaptcha"}],
    "screenshot": false
  }'
```

**Response `results[0]`:**
```json
[
  {
    "type": "turnstile",
    "sitekey": "0x4AAAAAAABS7TtLxsNa7Z2e",
    "pageUrl": "https://example.com/login",
    "source": "dom:.cf-turnstile",
    "capSolverTask": {
      "type": "AntiTurnstileTaskProxyLess",
      "websiteURL": "https://example.com/login",
      "websiteKey": "0x4AAAAAAABS7TtLxsNa7Z2e"
    }
  }
]
```

### Solve captcha (one action does everything)
```bash
curl -X POST "http://localhost:9222/?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/login",
    "actions": [
      {"type": "type", "selector": "input[name=email]", "text": "user@example.com"},
      {"type": "type", "selector": "input[name=password]", "text": "secret"},
      {"type": "solveCaptcha", "autoSubmit": true}
    ],
    "screenshot": true
  }'
```

`solveCaptcha` does: detect captcha -> pick best match (prefers entries with sitekey) -> send to CapSolver API -> inject token into page -> optionally click submit.

**Response:**
```json
{
  "success": true,
  "results": [
    {
      "solved": true,
      "type": "turnstile",
      "solution": { "token": "1.ksX8VP3P..." },
      "injection": { "injected": true, "type": "turnstile", "tokenLength": 517 }
    }
  ]
}
```

**If solving fails, the error is returned (not swallowed):**
```json
{
  "solved": false,
  "error": "CapSolver error: ERROR_CAPTCHA_UNSOLVABLE",
  "action": "solveCaptcha",
  "pickedCaptcha": { "type": "turnstile", "sitekey": "0x4AAA...", "source": "dom:.cf-turnstile" },
  "allDetected": [...]
}
```

**Options for `solveCaptcha`:**

| Field | Default | Description |
|-------|---------|-------------|
| `autoInject` | `true` | Inject solved token into page DOM |
| `autoSubmit` | `false` | Click submit button after injection |
| `submitSelector` | auto-detect | Custom CSS selector for submit button |
| `captchaType` | auto-detect | Force a specific captcha type (e.g. `"turnstile"`) |
| `detectTimeout` | `5000` | How long to wait for captcha to appear (ms) |

**CapSolver API key** is built into the skill. Override order:
1. `CAPSOLVER_KEY` environment variable
2. `/data/capsolver-key` file
3. Built-in default key

---

## Examples

### Simple page scrape
```bash
curl -X POST "http://localhost:9222/?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://news.ycombinator.com",
    "actions": [{"type":"getText","selector":".titleline"}],
    "screenshot": false
  }'
```

### Login and stay signed in
```bash
# Call 1: Sign in (session saved automatically)
curl -X POST "http://localhost:9222/?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://app.example.com/login",
    "sessionId": "myapp",
    "actions": [
      {"type":"type","selector":"input[name=email]","text":"user@example.com"},
      {"type":"type","selector":"input[name=password]","text":"secret123"},
      {"type":"click","selector":"button[type=submit]"},
      {"type":"waitForNavigation"}
    ]
  }'

# Call 2: Still signed in! Same session.
curl -X POST "http://localhost:9222/?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://app.example.com/dashboard",
    "sessionId": "myapp",
    "actions": [{"type":"getText","selector":".stats"}],
    "screenshot": true
  }'
```

### Login with captcha solving
```bash
curl -X POST "http://localhost:9222/?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://site-with-turnstile.com/login",
    "sessionId": "protected-site",
    "actions": [
      {"type":"type","selector":"input[name=email]","text":"user@example.com"},
      {"type":"type","selector":"input[name=password]","text":"secret"},
      {"type":"solveCaptcha","autoSubmit":true},
      {"type":"waitForNavigation"}
    ]
  }'
```

### Screenshot only
```bash
curl -X POST "http://localhost:9222/?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","screenshot":true,"fullPage":true}' \
  | jq -r '.screenshot' | base64 -d > /tmp/page.png
```

### Free RAM by closing a session
```bash
curl -X POST "http://localhost:9222/?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "actions": [{"type":"evaluate","script":"document.querySelectorAll(\"a\").length"}],
    "screenshot": false
  }'
```

### Close a session
```bash
curl -X POST "http://localhost:9222/?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"__close__","sessionId":"myapp"}'
```

---

## Desktop Proxy (Residential IP)

When the Ampere Desktop app connects, all browser traffic routes through the user's home network.

Check status:
```bash
curl "http://localhost:9222/?token=$TOKEN" | jq .desktopProxy
```
- `true` -> Traffic routes through residential IP
- `false` -> Using server IP (may get blocked on some sites)

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `{"error":"Unauthorized"}` | Missing/wrong token | Use `?token=$(cat /data/browser-server-token)` |
| `Insufficient RAM: XXXmb` | Too many sessions open | Close idle sessions: `{"url":"__close__","sessionId":"..."}` |
| Page loads but empty content | JS not rendered yet | Add `{"type":"wait","ms":3000}` before getText |
| Session lost between calls | Different sessionId | Use the same `sessionId` string |
| Site blocks/captcha | Server IP detected | Enable desktop proxy (residential IP), or use `solveCaptcha` |
| `solveCaptcha` returns `solved:false` | Empty sitekey picked | Check `allDetected` in error response; captcha may need longer `detectTimeout` |
| `DISPLAY` errors in logs | Xvfb not running | `systemctl start xvfb` |

---

## File Structure

```
/root/.openclaw/skills/camoufox-browser/
├── SKILL.md                  # This file — full API docs
├── EXAMPLES.md               # More real-world examples
├── browser-server.js         # The persistent API server
├── captcha-detector.js       # Auto-detect captcha type + extract sitekey
├── captcha-solver.js         # CapSolver API integration (solve + inject)
├── enhanced-camoufox.py      # OAuth login helper
└── smart-login-v2.py         # Advanced login flows
```
