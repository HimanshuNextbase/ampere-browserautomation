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

- **Bypasses:** Google, Cloudflare bot detection
- **Persistent sessions:** Sign in once, stay signed in forever
- **Desktop proxy:** Route traffic through user's residential IP
- **Actions:** Click, type, scroll, screenshot, extract text/HTML, evaluate JS
- **Captcha solving:** Auto-detect + solve captchas via CapSolver (Turnstile, reCAPTCHA, hCaptcha, etc.)
- **File upload/download:** Upload files to websites, download results

---

## CRITICAL: Be Autonomous — Do Not Ask, Just Do

**NEVER ask the user questions like:**
- "Is there a login page?"
- "What should I click?"
- "How does this site work?"
- "Should I try X or Y?"
- "Can you describe the page layout?"

**INSTEAD, use the browser to figure it out yourself:**

1. **Navigate to the URL** with `getText` + `screenshot` to see what's there.
2. **Explore the page** with `findElements` to discover buttons, inputs, links.
3. **Try things** — click buttons, scroll, wait for dynamic content.
4. **If something doesn't work**, try a different approach (different selector, scroll down, wait longer, check iframes).
5. **Only ask the user if you genuinely need credentials** (username/password) that you cannot guess.

You have a full browser at your disposal. You can see pages, click buttons, fill forms, upload files, download files, solve captchas, and take screenshots. There is almost nothing you cannot figure out by exploring the page yourself.

**Workflow for ANY browser task the user gives you:**
```
Step 1: Go to the URL → getText + screenshot → understand the page
Step 2: Find interactive elements → findElements("button, a, input, [role=button], form")
Step 3: Do the task (fill forms, upload files, click buttons)
Step 4: Wait for results → wait + waitForSelector + screenshot
Step 5: Get the output (download, screenshotElement, getText)
Step 6: Return the result to the user
```

If the site has a captcha, solve it with `solveCaptcha`. If the site needs a file upload, use `uploadFileFromUrl`. If you need to click something but don't know the selector, use `clickText`. If content loads dynamically, use `wait` + `waitForSelector`.

**Do NOT give up.** If the first approach fails, try another. Scroll down, check iframes, try different selectors, wait longer. You have retry capability — use it. The user expects results, not questions.

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
  "closeBrowser": false,
  "autoCaptcha": true
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
| `getText` | `selector?` | `{"type":"getText","selector":".content"}` (default: body) |
| `getHtml` | -- | `{"type":"getHtml"}` |
| `evaluate` | `script` | `{"type":"evaluate","script":"document.title"}` |
| `scroll` | `amount?` | `{"type":"scroll","amount":500}` |
| `select` | `selector`, `value` | `{"type":"select","selector":"#country","value":"US"}` |
| `hover` | `selector` | `{"type":"hover","selector":".menu"}` |
| `goBack` | -- | `{"type":"goBack"}` |
| `goForward` | -- | `{"type":"goForward"}` |
| `detectCaptcha` | `timeout?` | `{"type":"detectCaptcha"}` -- auto-detect captcha type + sitekey |
| `solveCaptcha` | `autoSubmit?`, `submitSelector?`, `captchaType?`, `detectTimeout?` | `{"type":"solveCaptcha"}` -- detect + solve + inject token via CapSolver |
| `getCookies` | -- | `{"type":"getCookies"}` |
| `setCookie` | `cookie` | `{"type":"setCookie","cookie":{"name":"x","value":"y","domain":".example.com"}}` |
| `uploadFile` | `selector`, `files` | `{"type":"uploadFile","selector":"input[type=file]","files":["/tmp/photo.jpg"]}` |
| `uploadFileFromUrl` | `selector`, `fileUrl` | `{"type":"uploadFileFromUrl","selector":"input[type=file]","fileUrl":"https://example.com/photo.jpg"}` |
| `download` | `selector`, `savePath?` | `{"type":"download","selector":"a.download-btn"}` -- click + capture download |
| `screenshotElement` | `selector` | `{"type":"screenshotElement","selector":".result-image"}` -- screenshot one element |
| `waitForUrl` | `pattern`, `timeout?` | `{"type":"waitForUrl","pattern":"**/success**"}` -- wait for URL change |
| `getAttributes` | `selector` | `{"type":"getAttributes","selector":"#result"}` -- get all attributes of element |
| `findElements` | `selector` | `{"type":"findElements","selector":"button"}` -- list all matching elements |
| `clickText` | `text`, `exact?` | `{"type":"clickText","text":"Download"}` -- click by visible text |
| `dragAndDrop` | `source`, `target` | `{"type":"dragAndDrop","source":"#file","target":"#dropzone"}` |

### Special URLs
- `"__close__"` -- Close a session: `{"url":"__close__","sessionId":"gmail"}`
- `"__current__"` -- Act on current page without navigating
- `"__list__"` -- List saved profiles

---

## Captcha Detection and Solving

### Auto-captcha (enabled by default)

Captchas are **automatically detected and solved** during automation. You do NOT need to add `solveCaptcha` actions manually in most cases.

Auto-captcha triggers:
- **After navigation** — if the page you navigated to has a captcha, it's solved before actions run
- **After click** — if clicking a button triggers a captcha page, it's solved automatically
- **After clickText** — same as click
- **After waitForNavigation** — if a redirect lands on a captcha page

The auto-captcha uses a fast 1.5s scan (no retries) to avoid slowing down every action. If it detects a captcha with a valid sitekey, it solves it via CapSolver and injects the token.

To disable auto-captcha for a specific request, set `"autoCaptcha": false` in the POST body.

You can still use `{"type": "solveCaptcha"}` explicitly for cases where you want to force captcha solving (e.g., captcha appears after a wait/delay, not immediately after click).

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
  -d '{"url":"__close__","sessionId":"old-session"}'
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

## Agent Strategy Guide

**IMPORTANT: You CAN and SHOULD use this skill for complex browser automation tasks.**
If a user asks you to browse a website, upload files, download results, fill forms, or interact with web apps — use this skill. **NEVER say "no", "I can't", or ask the user how the site works.** You have a real browser — open the site and look at it yourself. Follow these strategies:

### Strategy 1: Explore first, act second
Before clicking blindly, understand the page:
```json
{"actions": [
  {"type": "getText", "selector": "body"},
  {"type": "findElements", "selector": "button, a, input, [role=button]"}
]}
```
This tells you what's on the page and what you can interact with.

### Strategy 2: Use screenshots when text isn't enough
If getText returns confusing content (SPA, dynamic app), take a screenshot:
```json
{"actions": [], "screenshot": true}
```
Then read the screenshot to visually understand the layout.

### Strategy 3: Upload files to websites
```json
{"actions": [
  {"type": "uploadFileFromUrl", "selector": "input[type=file]", "fileUrl": "https://example.com/image.jpg"},
  {"type": "wait", "ms": 3000},
  {"type": "screenshot"}
]}
```
If the file input is hidden (drag-and-drop zones), find it with:
```json
{"actions": [{"type": "findElements", "selector": "input[type=file]"}]}
```
Hidden file inputs still work with `uploadFile` — Playwright bypasses visibility.

### Strategy 4: Handle dynamic content (SPAs)
After clicking a button, content may load asynchronously. Don't just getText immediately:
```json
{"actions": [
  {"type": "click", "selector": "#generate-btn"},
  {"type": "wait", "ms": 5000},
  {"type": "waitForSelector", "selector": ".result, .output, .download, [class*=result]", "timeout": 30000},
  {"type": "getText", "selector": "body"}
]}
```

### Strategy 5: Download results
```json
{"actions": [
  {"type": "download", "selector": "a[download], .download-btn, a[href*=download]"}
]}
```
Response includes `base64` of the file (if < 5MB). For images, use `screenshotElement`:
```json
{"actions": [
  {"type": "screenshotElement", "selector": "img.result, canvas, .output-image"}
]}
```

### Strategy 6: Multi-step workflows
Break complex tasks into multiple API calls with the SAME sessionId:
```
Call 1: Navigate + explore page structure
Call 2: Upload file + wait for processing  
Call 3: Click generate + wait for result
Call 4: Download/screenshot result
```
The session preserves all state between calls.

### Strategy 7: Find clickable elements by text
When you don't know the selector:
```json
{"actions": [{"type": "clickText", "text": "Generate"}, {"type": "wait", "ms": 3000}]}
```

### Strategy 8: Debug when stuck
If you can't find an element, use evaluate to inspect the DOM:
```json
{"actions": [{"type": "evaluate", "script": "document.querySelectorAll('iframe').length"}]}
```
Check for iframes, shadow DOM, or lazy-loaded content:
```json
{"actions": [{"type": "evaluate", "script": "JSON.stringify(Array.from(document.querySelectorAll('iframe')).map(f => f.src))"}]}
```

### Common patterns

**Upload image to a web tool and get result:**
```bash
# Step 1: Go to site + upload
curl -X POST "http://localhost:9222/?token=$TOKEN" -H "Content-Type: application/json" -d '{
  "url": "https://tool-site.com",
  "sessionId": "task1",
  "actions": [
    {"type": "uploadFileFromUrl", "selector": "input[type=file]", "fileUrl": "https://example.com/photo.jpg"},
    {"type": "wait", "ms": 3000}
  ], "screenshot": true
}'

# Step 2: Click generate and wait
curl -X POST "http://localhost:9222/?token=$TOKEN" -H "Content-Type: application/json" -d '{
  "url": "__current__",
  "sessionId": "task1",
  "actions": [
    {"type": "clickText", "text": "Generate"},
    {"type": "wait", "ms": 10000}
  ], "screenshot": true
}'

# Step 3: Download or screenshot result
curl -X POST "http://localhost:9222/?token=$TOKEN" -H "Content-Type: application/json" -d '{
  "url": "__current__",
  "sessionId": "task1",
  "actions": [
    {"type": "screenshotElement", "selector": "img.result, .output img, canvas"}
  ]
}'
```

**Use an online image/AI tool (upload → process → download):**
```bash
# Step 1: Go to the tool, explore what's on the page
TOKEN=$(cat /data/browser-server-token)
curl -X POST "http://localhost:9222/?token=$TOKEN" -H "Content-Type: application/json" -d '{
  "url": "https://some-image-tool.com",
  "sessionId": "img-task",
  "actions": [
    {"type": "findElements", "selector": "input[type=file], button, a, [role=button]"},
    {"type": "getText", "selector": "body"}
  ], "screenshot": true
}'

# Step 2: Upload the input image (works even with hidden file inputs / drag-drop zones)
curl -X POST "http://localhost:9222/?token=$TOKEN" -H "Content-Type: application/json" -d '{
  "url": "__current__",
  "sessionId": "img-task",
  "actions": [
    {"type": "uploadFileFromUrl", "selector": "input[type=file]", "fileUrl": "https://example.com/photo.jpg"},
    {"type": "wait", "ms": 5000}
  ], "screenshot": true
}'

# Step 3: If there is a captcha, solve it. Then click process/generate button.
curl -X POST "http://localhost:9222/?token=$TOKEN" -H "Content-Type: application/json" -d '{
  "url": "__current__",
  "sessionId": "img-task",
  "actions": [
    {"type": "solveCaptcha"},
    {"type": "clickText", "text": "Generate"},
    {"type": "wait", "ms": 10000},
    {"type": "findElements", "selector": "img, canvas, a[download], [class*=result], [class*=output]"}
  ], "screenshot": true
}'

# Step 4: Download or screenshot the result
curl -X POST "http://localhost:9222/?token=$TOKEN" -H "Content-Type: application/json" -d '{
  "url": "__current__",
  "sessionId": "img-task",
  "actions": [
    {"type": "screenshotElement", "selector": "img.result, .output img, canvas, [class*=result] img"}
  ]
}'

# Step 5: Clean up
curl -X POST "http://localhost:9222/?token=$TOKEN" -H "Content-Type: application/json" -d '{
  "url": "__close__", "sessionId": "img-task"
}'
```

**Handle sites behind captcha:**
```bash
curl -X POST "http://localhost:9222/?token=$TOKEN" -H "Content-Type: application/json" -d '{
  "url": "https://protected-site.com",
  "sessionId": "captcha-task",
  "actions": [
    {"type": "solveCaptcha", "autoSubmit": true},
    {"type": "wait", "ms": 3000},
    {"type": "getText", "selector": "body"}
  ], "screenshot": true
}'
```

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
