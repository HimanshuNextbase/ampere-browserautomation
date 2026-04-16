---
name: camoufox-browser
description: >
  Stealth browser automation with persistent sessions via browser-server API (port 9222).
  Camoufox (Firefox) bypasses bot detection. Sessions persist across calls — sign in once, stay signed in.
  Supports desktop proxy for residential IP routing.
---

# 🦊 Camoufox Browser — Persistent Stealth Automation

**Stealth Firefox browser** running as a persistent HTTP API on port 9222.
Sessions are saved to disk — cookies, logins, and state survive across calls.

✅ **Bypasses:** Google, Cloudflare bot detection  
✅ **Persistent sessions:** Sign in once, stay signed in forever  
✅ **Desktop proxy:** Route traffic through user's residential IP  
✅ **Actions:** Click, type, scroll, screenshot, extract text/HTML, evaluate JS

---

## ⚡ Best Practice: Text First, Screenshot Second

When browsing, always get **text/HTML content first** — it's faster and cheaper.
Only screenshot when you need to see visual layout (images, charts, CSS).

---

## 🔐 Authentication

All requests require the auth token as a query parameter:
```
?token=<contents of /data/browser-server-token>
```

```bash
TOKEN=$(cat /data/browser-server-token)
```

---

## 📡 API Reference

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

## 🔑 Key Concepts

### Sessions
- `sessionId` identifies a persistent browser profile
- Each session has its own cookies, localStorage, login state
- Profiles saved to `/data/browser-profiles/<sessionId>/`
- Use different session names for different accounts/sites

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
| `getText` | `selector?` | `{"type":"getText","selector":".content"}` (default: body) |
| `getHtml` | — | `{"type":"getHtml"}` |
| `evaluate` | `script` | `{"type":"evaluate","script":"document.title"}` |
| `scroll` | `amount?` | `{"type":"scroll","amount":500}` |
| `select` | `selector`, `value` | `{"type":"select","selector":"#country","value":"US"}` |
| `hover` | `selector` | `{"type":"hover","selector":".menu"}` |
| `goBack` | — | `{"type":"goBack"}` |
| `goForward` | — | `{"type":"goForward"}` |
| `detectCaptcha` | `timeout?` | `{"type":"detectCaptcha"}` — auto-detect captcha type + sitekey |
| `getCookies` | — | `{"type":"getCookies"}` |
| `setCookie` | `cookie` | `{"type":"setCookie","cookie":{"name":"x","value":"y","domain":".example.com"}}` |

### Special URLs
- `"__close__"` — Close a session: `{"url":"__close__","sessionId":"gmail"}`
- `"__current__"` — Act on current page without navigating
- `"__list__"` — List saved profiles

---

## 🚀 Examples

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

### Extract data from multiple pages
```bash
# Page 1
curl -X POST "http://localhost:9222/?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://store.com/products?page=1",
    "sessionId": "scraper",
    "actions": [{"type":"getText","selector":".product-list"}],
    "screenshot": false
  }'

# Page 2 (same session, cookies preserved)
curl -X POST "http://localhost:9222/?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://store.com/products?page=2",
    "sessionId": "scraper",
    "actions": [{"type":"getText","selector":".product-list"}],
    "screenshot": false
  }'
```

### Screenshot only
```bash
curl -X POST "http://localhost:9222/?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","screenshot":true,"fullPage":true}' \
  | jq -r '.screenshot' | base64 -d > /tmp/page.png
```

### Run JavaScript on page
```bash
curl -X POST "http://localhost:9222/?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "actions": [{"type":"evaluate","script":"document.querySelectorAll(\"a\").length"}],
    "screenshot": false
  }'
```

### Detect captcha on a page
```bash
curl -X POST "http://localhost:9222/?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/login",
    "actions": [{"type": "detectCaptcha"}],
    "screenshot": false
  }'
```

**Response `results[0]` contains detected captchas:**
```json
[
  {
    "type": "turnstile",
    "sitekey": "0x4AAAAAAABS7TtLxsNa7Z2e",
    "pageUrl": "https://example.com/login",
    "source": "dom:.cf-turnstile",
    "twoCaptchaParams": {
      "method": "turnstile",
      "sitekey": "0x4AAAAAAABS7TtLxsNa7Z2e",
      "pageurl": "https://example.com/login"
    }
  }
]
```

**Supported captcha types:** reCAPTCHA v2/v3/enterprise, hCaptcha, Cloudflare Turnstile,
FunCaptcha/Arkose, GeeTest v3/v4, Amazon WAF, DataDome, PerimeterX, KeyCaptcha,
Yandex SmartCaptcha, mtCaptcha, generic image captcha.

Each result includes `twoCaptchaParams` — ready to send to the 2Captcha API.

### Close a session
```bash
curl -X POST "http://localhost:9222/?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"__close__","sessionId":"myapp"}'
```

---

## 🌐 Desktop Proxy (Residential IP)

When the Ampere Desktop app connects, all browser traffic routes through the user's home network.

Check status:
```bash
curl "http://localhost:9222/?token=$TOKEN" | jq .desktopProxy
```
- `true` → Traffic routes through residential IP ✅
- `false` → Using server IP (may get blocked on some sites)

---

## 🐛 Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `{"error":"Unauthorized"}` | Missing/wrong token | Use `?token=$(cat /data/browser-server-token)` |
| Page loads but empty content | JS not rendered yet | Add `{"type":"wait","ms":3000}` before getText |
| Session lost between calls | Different sessionId | Use the same `sessionId` string |
| Site blocks/captcha | Server IP detected | Enable desktop proxy (residential IP) |
| `DISPLAY` errors in logs | Xvfb not running | `systemctl start xvfb` |

---

## 📖 File Structure

```
/root/.openclaw/skills/camoufox-browser/
├── SKILL.md                  # This file — full API docs
├── EXAMPLES.md               # More real-world examples
├── browser-server.js         # The persistent API server ⭐
├── enhanced-camoufox.py      # OAuth login helper
└── smart-login-v2.py         # Advanced login flows
```
