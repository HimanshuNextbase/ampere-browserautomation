# Camoufox Browser API — Examples

All examples use the browser-server HTTP API on port 9222.

```bash
TOKEN=$(cat /data/browser-server-token)
API="http://localhost:9222/?token=$TOKEN"
```

---

## 📰 Scraping

### 1. Get page text
```bash
curl -X POST "$API" -H "Content-Type: application/json" \
  -d '{"url":"https://news.ycombinator.com","actions":[{"type":"getText","selector":"body"}],"screenshot":false}'
```

### 2. Get specific elements
```bash
curl -X POST "$API" -H "Content-Type: application/json" \
  -d '{"url":"https://news.ycombinator.com","actions":[{"type":"getText","selector":".titleline"}],"screenshot":false}'
```

### 3. Get full page HTML
```bash
curl -X POST "$API" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","actions":[{"type":"getHtml"}],"screenshot":false}'
```

### 4. Extract data with JavaScript
```bash
curl -X POST "$API" -H "Content-Type: application/json" \
  -d '{"url":"https://news.ycombinator.com","actions":[{"type":"evaluate","script":"[...document.querySelectorAll(\".titleline > a\")].map(a => ({title: a.textContent, href: a.href}))"}],"screenshot":false}'
```

### 5. Wait for dynamic content
```bash
curl -X POST "$API" -H "Content-Type: application/json" \
  -d '{"url":"https://spa-site.com","actions":[{"type":"waitForSelector","selector":".loaded-content","timeout":10000},{"type":"getText","selector":".loaded-content"}],"screenshot":false}'
```

---

## 🔐 Login & Sessions

### 6. Login to a site (session persists)
```bash
curl -X POST "$API" -H "Content-Type: application/json" \
  -d '{
    "url":"https://app.example.com/login",
    "sessionId":"myapp",
    "actions":[
      {"type":"type","selector":"input[name=email]","text":"user@example.com"},
      {"type":"type","selector":"input[name=password]","text":"secret123"},
      {"type":"click","selector":"button[type=submit]"},
      {"type":"waitForNavigation"}
    ]
  }'
```

### 7. Access authenticated page (same session = still logged in)
```bash
curl -X POST "$API" -H "Content-Type: application/json" \
  -d '{
    "url":"https://app.example.com/dashboard",
    "sessionId":"myapp",
    "actions":[{"type":"getText","selector":".stats"}]
  }'
```

### 8. Get cookies from session
```bash
curl -X POST "$API" -H "Content-Type: application/json" \
  -d '{
    "url":"__current__",
    "sessionId":"myapp",
    "actions":[{"type":"getCookies"}],
    "screenshot":false
  }'
```

---

## 📸 Screenshots

### 9. Full page screenshot
```bash
curl -X POST "$API" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","screenshot":true,"fullPage":true}' \
  | jq -r '.screenshot' | base64 -d > /tmp/page.png
```

### 10. Viewport screenshot (no scroll)
```bash
curl -X POST "$API" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","screenshot":true,"fullPage":false}' \
  | jq -r '.screenshot' | base64 -d > /tmp/viewport.png
```

---

## 📝 Form Filling

### 11. Fill and submit a form
```bash
curl -X POST "$API" -H "Content-Type: application/json" \
  -d '{
    "url":"https://site.com/contact",
    "actions":[
      {"type":"type","selector":"input[name=name]","text":"John Doe"},
      {"type":"type","selector":"input[name=email]","text":"john@example.com"},
      {"type":"type","selector":"textarea[name=message]","text":"Hello!"},
      {"type":"click","selector":"button[type=submit]"},
      {"type":"wait","ms":2000}
    ]
  }'
```

### 12. Select dropdown + checkbox
```bash
curl -X POST "$API" -H "Content-Type: application/json" \
  -d '{
    "url":"https://site.com/preferences",
    "sessionId":"mysite",
    "actions":[
      {"type":"select","selector":"#country","value":"US"},
      {"type":"click","selector":"input[name=newsletter]"},
      {"type":"click","selector":"button.save"}
    ]
  }'
```

---

## 🎯 Multi-Step Workflows

### 13. Search and extract results
```bash
curl -X POST "$API" -H "Content-Type: application/json" \
  -d '{
    "url":"https://search-site.com",
    "actions":[
      {"type":"type","selector":"input.search","text":"AI automation"},
      {"type":"press","selector":"input.search","key":"Enter"},
      {"type":"waitForSelector","selector":".results"},
      {"type":"getText","selector":".results"}
    ]
  }'
```

### 14. Navigate through multiple pages
```bash
# Page 1
curl -X POST "$API" -H "Content-Type: application/json" \
  -d '{"url":"https://store.com/products?page=1","sessionId":"scraper","actions":[{"type":"getText","selector":".product-list"}],"screenshot":false}'

# Page 2 (same session)
curl -X POST "$API" -H "Content-Type: application/json" \
  -d '{"url":"https://store.com/products?page=2","sessionId":"scraper","actions":[{"type":"getText","selector":".product-list"}],"screenshot":false}'
```

### 15. Scroll and load more content
```bash
curl -X POST "$API" -H "Content-Type: application/json" \
  -d '{
    "url":"https://infinite-scroll-site.com",
    "actions":[
      {"type":"scroll","amount":2000},
      {"type":"wait","ms":2000},
      {"type":"scroll","amount":2000},
      {"type":"wait","ms":2000},
      {"type":"getText","selector":"body"}
    ],
    "screenshot":false
  }'
```

---

## 🔧 Session Management

### 16. List all saved profiles
```bash
curl "$API" | jq '.sessions'
```

### 17. Close a session
```bash
curl -X POST "$API" -H "Content-Type: application/json" \
  -d '{"url":"__close__","sessionId":"myapp"}'
```

### 18. Check desktop proxy status
```bash
curl "$API" | jq '.desktopProxy'
```

---

## 💡 Tips

1. **Use `sessionId`** to keep sessions separate per site/account
2. **`screenshot: false`** for text-only tasks (faster, less data)
3. **`waitForSelector`** before `getText` on JS-heavy pages
4. **`evaluate`** for complex data extraction (runs JS in page context)
5. **`__current__`** as URL to act on current page without navigating
6. Different `sessionId` = different browser profile = different login

---

**Full API docs:** `/root/.openclaw/skills/camoufox-browser/SKILL.md`
