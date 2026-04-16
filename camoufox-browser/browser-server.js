const { firefox } = require('playwright-core');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { execSync } = require('child_process');
const { injectInterceptors, detectCaptchas, summarize, to2CaptchaParams } = require('./captcha-detector');
const { solveCaptcha, getBalance } = require('./captcha-solver');

// CapSolver API key — hardcoded default, overridable via env or file
const CAPSOLVER_KEY = process.env.CAPSOLVER_KEY || (() => {
  try { return fs.readFileSync('/data/capsolver-key', 'utf-8').trim(); } catch { return ''; }
})() || 'CAP-570555A8672DFC05B47D057D9F301C014C9E4B4ADAF65AF992A1A0776F1940F0';

const PROFILE_DIR = '/data/browser-profiles';
let sessions = new Map(); // sessionId -> { browser, context, page, profilePath }
let desktopAgent = null;
let pendingRequests = new Map();
let tunnelSockets = new Map();
let reqCounter = 0;

// Auth token — required on all HTTP/WS requests
const AUTH_TOKEN_PATH = '/data/browser-server-token';
let AUTH_TOKEN = '';
try {
  AUTH_TOKEN = fs.readFileSync(AUTH_TOKEN_PATH, 'utf-8').trim();
  console.log('[Auth] Token loaded from', AUTH_TOKEN_PATH);
} catch (e) {
  console.warn('[Auth] No token file at', AUTH_TOKEN_PATH, '— auth disabled');
}

function checkAuth(req) {
  if (!AUTH_TOKEN) return true; // no token file = auth disabled
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  return token === AUTH_TOKEN;
}

// Ensure profile directory exists
if (!fs.existsSync(PROFILE_DIR)) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
}

// ========== BROWSER SESSION MANAGEMENT ==========

async function getOrCreateSession(sessionId) {
  sessionId = sessionId || 'default';

  if (sessions.has(sessionId)) {
    const s = sessions.get(sessionId);
    if (s.browser && s.browser.isConnected()) return s;
    // Cleanup dead session
    sessions.delete(sessionId);
  }

  const profilePath = path.join(PROFILE_DIR, sessionId);
  if (!fs.existsSync(profilePath)) {
    fs.mkdirSync(profilePath, { recursive: true });
  }

  // RAM check before launching Firefox
  const memInfo = fs.readFileSync('/proc/meminfo', 'utf-8');
  const availMatch = memInfo.match(/MemAvailable:\s+(\d+)/);
  const availMB = availMatch ? parseInt(availMatch[1]) / 1024 : 0;
  if (availMB < 1024) {
    throw new Error(`Insufficient RAM: ${Math.round(availMB)}MB available, need 1024MB`);
  }

  // Find Camoufox Firefox binary
  let firefoxPath;
  try {
    firefoxPath = execSync('python3 -c "from camoufox.utils import get_binary_path; print(get_binary_path())"')
      .toString()
      .trim();
  } catch {
    // Fallback paths
    const fallbacks = [
      path.join(process.env.HOME || '/root', '.cache/camoufox/camoufox-bin'),
      path.join(process.env.HOME || '/root', '.camoufox/firefox/firefox'),
      '/usr/bin/firefox',
      '/usr/bin/firefox-esr',
    ];
    firefoxPath = fallbacks.find((p) => fs.existsSync(p)) || 'firefox';
  }

  const firefoxArgs = [];
  const proxyUrl = desktopAgent && desktopAgent.readyState === WebSocket.OPEN ? 'http://127.0.0.1:8899' : null;
  if (proxyUrl) {
    console.log(`[Session:${sessionId}] Launching Firefox (Camoufox) with proxy + profile`);
  } else {
    console.log(`[Session:${sessionId}] Launching Firefox (Camoufox) with profile (server IP)`);
  }

  const browser = await firefox.launch({
    executablePath: firefoxPath,
    headless: false,
    args: firefoxArgs,
    firefoxUserPrefs: {
      'toolkit.startup.max_resumed_crashes': -1,
    },
    env: {
      ...process.env,
      DISPLAY: process.env.DISPLAY || ':99',
    },
  });

  const contextOptions = {
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  };

  // Set proxy at context level for Firefox (when desktop agent connected)
  if (proxyUrl) {
    contextOptions.proxy = { server: proxyUrl };
  }

  const context = await browser.newContext(contextOptions);

  // When using proxy, abort non-essential slow resources to speed up page loads
  // Bot detection only checks document/XHR IPs, not CDN asset IPs
  if (proxyUrl) {
    await context.route('**/*', async (route) => {
      const resourceType = route.request().resourceType();
      // Let critical requests through normally
      if (['document', 'script', 'xhr', 'fetch', 'stylesheet'].includes(resourceType)) {
        return route.continue();
      }
      // Abort fonts and media to speed up proxy loads
      if (['font', 'media'].includes(resourceType)) {
        return route.abort();
      }
      // Let images and others continue but don't block on them
      return route.continue();
    });
  }

  // Inject captcha detection interceptors (hooks grecaptcha, hcaptcha, turnstile, etc.)
  await injectInterceptors(context);

  // Camoufox handles most stealth natively (webdriver, fingerprinting, etc.)
  // Only add minimal supplementary injections
  await context.addInitScript(() => {
    // Battery API
    navigator.getBattery = () =>
      Promise.resolve({
        charging: true,
        chargingTime: 0,
        dischargingTime: Infinity,
        level: 1,
        addEventListener: () => {},
        removeEventListener: () => {},
      });

    // 11. Notification permission
    Object.defineProperty(Notification, 'permission', { get: () => 'default' });
  });

  const page = await context.newPage();

  const session = { browser, context, page, profilePath, sessionId, lastUsed: Date.now() };
  sessions.set(sessionId, session);

  console.log(`[Session:${sessionId}] Profile: ${profilePath}`);
  return session;
}

async function closeSession(sessionId) {
  const s = sessions.get(sessionId);
  if (s) {
    await s.browser.close().catch(() => {});
    sessions.delete(sessionId);
    console.log(`[Session:${sessionId}] Closed`);
  }
}

// Close all sessions (e.g. when server shuts down)
async function closeAllSessions() {
  for (const [id, s] of sessions) {
    await s.browser.close().catch(() => {});
  }
  sessions.clear();
  console.log('[Sessions] All closed');
}

// Hot-swap proxy for all active sessions without losing state
async function swapProxyForAllSessions() {
  const proxyUrl = desktopAgent && desktopAgent.readyState === WebSocket.OPEN ? 'http://127.0.0.1:8899' : null;
  const mode = proxyUrl ? 'proxy (residential IP)' : 'direct (server IP)';
  console.log(`[ProxySwap] Switching ${sessions.size} session(s) to ${mode}`);

  for (const [id, s] of sessions) {
    if (!s.browser || !s.browser.isConnected()) continue;
    try {
      // 1. Save state from old context
      const cookies = await s.context.cookies().catch(() => []);
      const currentUrl = s.page.url();
      console.log(`[ProxySwap:${id}] Saving ${cookies.length} cookies, url: ${currentUrl}`);

      // 2. Close old context (not the browser — reuse same browser instance)
      await s.context.close().catch(() => {});

      // 3. Create new context with updated proxy
      const contextOptions = {
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
      };
      if (proxyUrl) {
        contextOptions.proxy = { server: proxyUrl };
      }
      const newContext = await s.browser.newContext(contextOptions);

      // Re-apply resource optimization for proxy mode
      if (proxyUrl) {
        await newContext.route('**/*', async (route) => {
          const resourceType = route.request().resourceType();
          if (['document', 'script', 'xhr', 'fetch', 'stylesheet'].includes(resourceType)) return route.continue();
          if (['font', 'media'].includes(resourceType)) return route.abort();
          return route.continue();
        });
      }

      // Re-inject captcha detection interceptors
      await injectInterceptors(newContext);

      // Re-inject stealth scripts
      await newContext.addInitScript(() => {
        navigator.getBattery = () =>
          Promise.resolve({
            charging: true,
            chargingTime: 0,
            dischargingTime: Infinity,
            level: 1,
            addEventListener: () => {},
            removeEventListener: () => {},
          });
        Object.defineProperty(Notification, 'permission', { get: () => 'default' });
      });

      // 4. Restore cookies
      if (cookies.length > 0) {
        await newContext.addCookies(cookies).catch(() => {});
      }

      // 5. Open new page and navigate back to where we were
      const newPage = await newContext.newPage();
      if (currentUrl && currentUrl !== 'about:blank') {
        await newPage.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }

      // 6. Update session references
      s.context = newContext;
      s.page = newPage;

      console.log(`[ProxySwap:${id}] Swapped to ${mode} — cookies restored, page reloaded`);
    } catch (err) {
      console.error(`[ProxySwap:${id}] Failed, closing session:`, err.message);
      await s.browser.close().catch(() => {});
      sessions.delete(id);
    }
  }
  console.log(`[ProxySwap] Done — ${sessions.size} session(s) active`);
}

// ========== API SERVER (port 9222) ==========

const apiServer = http.createServer(async (req, res) => {
  // Auth check on all HTTP requests
  if (!checkAuth(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Unauthorized' }));
  }

  const pathname = new URL(req.url, 'http://localhost').pathname;

  // GET = status
  if (req.method === 'GET' && pathname === '/') {
    const sessionList = [];
    for (const [id, s] of sessions) {
      sessionList.push({ id, profile: s.profilePath, active: s.browser.isConnected() });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        status: 'ok',
        desktopProxy: !!desktopAgent,
        sessions: sessionList,
        profileDir: PROFILE_DIR,
      }),
    );
  }

  // GET /sessions — list profiles
  if (req.method === 'GET' && pathname === '/sessions') {
    const profiles = fs.readdirSync(PROFILE_DIR).filter((f) => fs.statSync(path.join(PROFILE_DIR, f)).isDirectory());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ profiles }));
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    return res.end();
  }

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    try {
      const {
        url,
        actions = [],
        screenshot = true,
        fullPage = false,
        timeout = 60000, // 60s default (proxy mode can be slow)
        sessionId = 'default', // User's profile ID
        newTab = false, // Open in new tab (keep existing tabs)
        closeBrowser = false, // Close session after
      } = JSON.parse(body);

      // Special actions
      if (url === '__close__') {
        await closeSession(sessionId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, message: `Session ${sessionId} closed` }));
      }

      if (url === '__list__') {
        const profiles = fs
          .readdirSync(PROFILE_DIR)
          .filter((f) => fs.statSync(path.join(PROFILE_DIR, f)).isDirectory());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ profiles }));
      }

      const session = await getOrCreateSession(sessionId);
      session.lastUsed = Date.now();

      let page;
      if (newTab) {
        page = await session.context.newPage();
      } else {
        page = session.page;
      }

      // Navigate
      if (url && url !== '__current__') {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      }

      // Execute actions
      const results = [];
      for (const action of actions) {
        try {
          if (action.type === 'click') {
            await page.click(action.selector, { timeout: action.timeout || 10000 });
          } else if (action.type === 'type') {
            await page.fill(action.selector, action.text);
          } else if (action.type === 'press') {
            await page.press(action.selector || 'body', action.key);
          } else if (action.type === 'wait') {
            await page.waitForTimeout(action.ms || 1000);
          } else if (action.type === 'waitForSelector') {
            await page.waitForSelector(action.selector, { timeout: action.timeout || 10000 });
          } else if (action.type === 'waitForNavigation') {
            await page.waitForLoadState('domcontentloaded', { timeout: action.timeout || 15000 });
          } else if (action.type === 'evaluate') {
            results.push(await page.evaluate(action.script));
          } else if (action.type === 'scroll') {
            await page.evaluate((px) => window.scrollBy(0, px), action.amount || 500);
          } else if (action.type === 'getText') {
            results.push(await page.innerText(action.selector || 'body'));
          } else if (action.type === 'getHtml') {
            results.push(await page.content());
          } else if (action.type === 'select') {
            await page.selectOption(action.selector, action.value);
          } else if (action.type === 'hover') {
            await page.hover(action.selector);
          } else if (action.type === 'goBack') {
            await page.goBack({ waitUntil: 'domcontentloaded' });
          } else if (action.type === 'goForward') {
            await page.goForward({ waitUntil: 'domcontentloaded' });
          } else if (action.type === 'detectCaptcha') {
            const captchas = await detectCaptchas(page, { timeout: action.timeout || 5000 });
            const mapped = captchas.map(c => ({
              ...c,
              capSolverTask: (() => { try { const { buildCapSolverTask } = require('./captcha-solver'); return buildCapSolverTask(c) || undefined; } catch { return undefined; } })(),
            }));
            console.log(`[Captcha] ${summarize(captchas)}`);
            results.push(mapped);
          } else if (action.type === 'solveCaptcha') {
            // Auto detect + solve + inject in one action
            const apiKey = action.apiKey || CAPSOLVER_KEY;
            if (!apiKey) throw new Error('No CapSolver API key. Set CAPSOLVER_KEY env or pass apiKey in action.');

            // Step 1: Detect
            const captchas = await detectCaptchas(page, { timeout: action.detectTimeout || 5000 });
            console.log(`[Captcha] Detected: ${summarize(captchas)}`);

            if (captchas.length === 0) {
              results.push({ solved: false, reason: 'No captcha detected on page' });
            } else {
              // Solve the first (or specified) captcha
              const targetType = action.captchaType; // optional: force a specific type
              const captcha = targetType
                ? captchas.find(c => c.type === targetType) || captchas[0]
                : captchas[0];

              const solveResult = await solveCaptcha(apiKey, page, captcha, {
                autoInject: action.autoInject !== false,
                autoSubmit: action.autoSubmit || false,
                submitSelector: action.submitSelector,
              });

              results.push(solveResult);
            }
          } else if (action.type === 'getCookies') {
            results.push(await session.context.cookies());
          } else if (action.type === 'setCookie') {
            await session.context.addCookies([action.cookie]);
          }
        } catch (actionErr) {
          results.push({ error: actionErr.message, action: action.type });
        }
      }

      // Screenshot
      let screenshotB64 = null;
      if (screenshot) {
        screenshotB64 = (await page.screenshot({ fullPage })).toString('base64');
      }

      const title = await page.title();
      const pageUrl = page.url();

      // Close tab if it was a new one
      if (newTab) await page.close();
      if (closeBrowser) await closeSession(sessionId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          title,
          url: pageUrl,
          screenshot: screenshotB64,
          results,
          proxy: !!desktopAgent,
          sessionId,
        }),
      );
    } catch (e) {
      console.error('[API Error]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
  });
});

// ========== WebSocket for Desktop Agent ==========

const wss = new WebSocketServer({ server: apiServer });

wss.on('connection', (ws, req) => {
  // Auth check on WS upgrade
  if (!checkAuth(req)) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  console.log('[Agent] Desktop connected from', req.socket.remoteAddress);
  desktopAgent = ws;

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'http-response') {
        const pending = pendingRequests.get(msg.reqId);
        if (pending) {
          pendingRequests.delete(msg.reqId);
          if (msg.error) {
            pending.res.writeHead(502);
            pending.res.end('Desktop proxy error: ' + msg.error);
          } else {
            pending.res.writeHead(msg.statusCode || 200, msg.headers || {});
            if (msg.body) pending.res.end(Buffer.from(msg.body, 'base64'));
            else pending.res.end();
          }
        }
      } else if (msg.type === 'connect-response') {
        const pending = pendingRequests.get(msg.reqId);
        if (pending && pending.socket) {
          if (msg.error) {
            pending.socket.end();
            tunnelSockets.delete(msg.reqId);
          } else {
            // Send 200 to client — data forwarding already handled by proxyServer.on("connect")
            pending.socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          }
          pendingRequests.delete(msg.reqId);
        }
      } else if (msg.type === 'tunnel-data') {
        const s = tunnelSockets.get(msg.reqId);
        if (s && s.socket) s.socket.write(Buffer.from(msg.data, 'base64'));
      } else if (msg.type === 'tunnel-end') {
        const s = tunnelSockets.get(msg.reqId);
        if (s && s.socket) {
          s.socket.end();
          tunnelSockets.delete(msg.reqId);
        }
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      } else if (msg.type === 'hello') {
        console.log('[Agent] Desktop says hello:', msg.userAgent || 'unknown');
        ws.send(JSON.stringify({ type: 'welcome', message: 'Proxy tunnel ready' }));
        // Hot-swap all sessions to use proxy without losing state
        await swapProxyForAllSessions();
        ws.send(JSON.stringify({ type: 'ack', message: 'Desktop proxy connected! Browsers will use your IP.' }));
      }
    } catch (e) {
      console.error('[Agent] Bad message:', e.message);
    }
  });

  ws.on('close', async () => {
    console.log('[Agent] Desktop disconnected');
    desktopAgent = null;
    for (const [id, p] of pendingRequests) {
      if (p.res) {
        p.res.writeHead(502);
        p.res.end('Desktop disconnected');
      }
      if (p.socket) p.socket.end();
    }
    pendingRequests.clear();
    tunnelSockets.clear();
    // Hot-swap all sessions back to direct (server IP) without losing state
    await swapProxyForAllSessions();
  });
});

// ========== LOCAL PROXY (port 8899) for desktop tunnel ==========

const proxyServer = http.createServer((req, res) => {
  if (!desktopAgent || desktopAgent.readyState !== WebSocket.OPEN) {
    res.writeHead(502);
    return res.end('No desktop proxy connected');
  }
  const reqId = ++reqCounter;
  pendingRequests.set(reqId, { res });
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    desktopAgent.send(
      JSON.stringify({
        type: 'http-request',
        reqId,
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: chunks.length > 0 ? Buffer.concat(chunks).toString('base64') : null,
      }),
    );
  });
  setTimeout(() => {
    if (pendingRequests.has(reqId)) {
      pendingRequests.delete(reqId);
      res.writeHead(504);
      res.end('Timeout');
    }
  }, 60000);
});

proxyServer.on('connect', (req, clientSocket, head) => {
  if (!desktopAgent || desktopAgent.readyState !== WebSocket.OPEN) {
    clientSocket.end('HTTP/1.1 502 No proxy\r\n\r\n');
    return;
  }
  const reqId = ++reqCounter;
  pendingRequests.set(reqId, { socket: clientSocket });
  tunnelSockets.set(reqId, { socket: clientSocket });
  desktopAgent.send(
    JSON.stringify({
      type: 'connect-request',
      reqId,
      host: req.url,
      head: head.length > 0 ? head.toString('base64') : null,
    }),
  );
  clientSocket.on('data', (chunk) => {
    if (desktopAgent && desktopAgent.readyState === WebSocket.OPEN) {
      desktopAgent.send(JSON.stringify({ type: 'tunnel-data', reqId, data: chunk.toString('base64') }));
    }
  });
  clientSocket.on('end', () => {
    if (desktopAgent && desktopAgent.readyState === WebSocket.OPEN) {
      desktopAgent.send(JSON.stringify({ type: 'tunnel-end', reqId }));
    }
    tunnelSockets.delete(reqId);
  });
  clientSocket.on('error', () => tunnelSockets.delete(reqId));
  setTimeout(() => {
    if (pendingRequests.has(reqId)) {
      pendingRequests.delete(reqId);
      clientSocket.end();
    }
  }, 60000);
});

proxyServer.listen(8899, '127.0.0.1', () => console.log('[Proxy] Tunnel proxy on 127.0.0.1:8899'));

// ========== CLEANUP ==========

// Auto-close idle sessions (30 min)
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > 30 * 60 * 1000) {
      console.log(`[Session:${id}] Idle timeout, closing`);
      closeSession(id);
    }
  }
}, 60000);

process.on('uncaughtException', (err) => console.error('[FATAL]', err.message));
process.on('unhandledRejection', (err) => console.error('[REJECTION]', err));

apiServer.listen(9222, '127.0.0.1', () => {
  console.log('[API] Browser server on :9222 (profiles + proxy + WS)');
  console.log('[Profiles] ' + PROFILE_DIR);
  console.log('[Ready] Waiting for requests...');
});
