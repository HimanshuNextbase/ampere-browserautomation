/**
 * CapSolver integration — solve captchas detected by captcha-detector.js
 *
 * Flow: detectCaptcha → solveCaptcha → inject token into page
 *
 * API docs: https://docs.capsolver.com/en/api/
 */

const https = require('https');

const CAPSOLVER_API = 'https://api.capsolver.com';

// ============================================================
// 1. Core API helpers
// ============================================================

function apiRequest(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const fullUrl = CAPSOLVER_API + endpoint;

    console.log(`[CapSolver] API request: POST ${fullUrl}`);

    const parsed = new URL(fullUrl);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        console.log(`[CapSolver] API response: ${res.statusCode}, body length: ${chunks.length}`);
        try {
          const result = JSON.parse(chunks);
          if (result.errorId && result.errorId !== 0) {
            const errMsg = `CapSolver error: ${result.errorCode} — ${result.errorDescription}`;
            console.error(`[CapSolver] ${errMsg}`);
            reject(new Error(errMsg));
          } else {
            resolve(result);
          }
        } catch (e) {
          const errMsg = `CapSolver response parse error (status ${res.statusCode}): ${chunks.substring(0, 300)}`;
          console.error(`[CapSolver] ${errMsg}`);
          reject(new Error(errMsg));
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[CapSolver] Request error: ${err.message}`);
      reject(new Error(`CapSolver request failed: ${err.message}`));
    });
    req.setTimeout(30000, () => {
      req.destroy();
      console.error('[CapSolver] Request timed out (30s)');
      reject(new Error('CapSolver API timeout (30s)'));
    });
    req.write(data);
    req.end();
  });
}

async function createTask(clientKey, task) {
  console.log(`[CapSolver] createTask: ${task.type}`);
  const res = await apiRequest('/createTask', { clientKey, task });

  // Some tasks return solution immediately (sync)
  if (res.status === 'ready' && res.solution) {
    console.log('[CapSolver] Solved immediately (sync)');
    return res.solution;
  }

  // Async — need to poll
  if (!res.taskId) {
    throw new Error('CapSolver: no taskId returned');
  }

  return pollTaskResult(clientKey, res.taskId);
}

async function pollTaskResult(clientKey, taskId, maxWaitMs = 120000) {
  const startTime = Date.now();
  const pollInterval = 3000; // 3 seconds as recommended
  let attempt = 0;

  // Initial delay before first poll
  await sleep(2000);

  while (Date.now() - startTime < maxWaitMs) {
    attempt++;
    const res = await apiRequest('/getTaskResult', { clientKey, taskId });

    if (res.status === 'ready') {
      console.log(`[CapSolver] Solved after ${attempt} poll(s), ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
      return res.solution;
    }

    if (res.status === 'failed') {
      throw new Error(`CapSolver task failed: ${res.errorCode || 'unknown'}`);
    }

    // status is 'idle' or 'processing' — keep polling
    await sleep(pollInterval);
  }

  throw new Error(`CapSolver: timed out after ${maxWaitMs / 1000}s (${attempt} polls)`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// 2. Map detected captcha → CapSolver task
// ============================================================

function buildCapSolverTask(captcha) {
  const url = captcha.pageUrl;

  switch (captcha.type) {
    case 'recaptcha_v2':
      return {
        type: 'ReCaptchaV2TaskProxyLess',
        websiteURL: url,
        websiteKey: captcha.sitekey,
      };

    case 'recaptcha_v2_invisible':
      return {
        type: 'ReCaptchaV2TaskProxyLess',
        websiteURL: url,
        websiteKey: captcha.sitekey,
        isInvisible: true,
      };

    case 'recaptcha_v3':
      return {
        type: 'ReCaptchaV3TaskProxyLess',
        websiteURL: url,
        websiteKey: captcha.sitekey,
        pageAction: captcha.action || '',
      };

    case 'recaptcha_enterprise':
      return {
        type: 'ReCaptchaV2EnterpriseTaskProxyLess',
        websiteURL: url,
        websiteKey: captcha.sitekey,
      };

    case 'hcaptcha':
      return {
        type: 'HCaptchaTaskProxyLess',
        websiteURL: url,
        websiteKey: captcha.sitekey,
      };

    case 'turnstile':
      return {
        type: 'AntiTurnstileTaskProxyLess',
        metadata: { type: 'turnstile' },
        websiteURL: url,
        websiteKey: captcha.sitekey,
      };

    case 'funcaptcha':
      return {
        type: 'FunCaptchaTaskProxyLess',
        websiteURL: url,
        websitePublicKey: captcha.publicKey,
      };

    case 'geetest_v4':
      return {
        type: 'GeeTestTaskProxyLess',
        websiteURL: url,
        captchaId: captcha.captchaId,
      };

    case 'amazon_waf':
      return {
        type: 'AntiAwsWafTaskProxyLess',
        websiteURL: url,
      };

    default:
      return null;
  }
}

// ============================================================
// 3. Inject solved token into page
// ============================================================

async function injectSolution(page, captchaType, solution) {
  switch (captchaType) {
    case 'recaptcha_v2':
    case 'recaptcha_v2_invisible':
    case 'recaptcha_v3':
    case 'recaptcha_enterprise': {
      const token = solution.gRecaptchaResponse;
      if (!token) throw new Error('No gRecaptchaResponse in solution');

      await page.evaluate((tok) => {
        // Set the textarea that reCAPTCHA uses
        const textarea = document.querySelector('#g-recaptcha-response') ||
                         document.querySelector('[name="g-recaptcha-response"]');
        if (textarea) {
          textarea.style.display = 'block';
          textarea.value = tok;
          textarea.style.display = 'none';
        }

        // Also set for all frames (multi-widget support)
        document.querySelectorAll('[name="g-recaptcha-response"]').forEach(el => {
          el.value = tok;
        });

        // Trigger callback if registered
        if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
          for (const clientId in window.___grecaptcha_cfg.clients) {
            const client = window.___grecaptcha_cfg.clients[clientId];
            // Walk the client object to find the callback
            const findCallback = (obj, depth = 0) => {
              if (!obj || depth > 5) return null;
              if (typeof obj === 'function') return obj;
              if (typeof obj === 'object') {
                for (const key of Object.keys(obj)) {
                  if (key === 'callback' && typeof obj[key] === 'function') return obj[key];
                  const found = findCallback(obj[key], depth + 1);
                  if (found) return found;
                }
              }
              return null;
            };
            const cb = findCallback(client);
            if (cb) cb(tok);
          }
        }
      }, token);

      return { injected: true, type: captchaType, tokenLength: token.length };
    }

    case 'hcaptcha': {
      const token = solution.gRecaptchaResponse; // CapSolver uses same field name
      if (!token) throw new Error('No gRecaptchaResponse in solution');

      await page.evaluate((tok) => {
        // hCaptcha textarea
        const textarea = document.querySelector('[name="h-captcha-response"]') ||
                         document.querySelector('[name="g-recaptcha-response"]');
        if (textarea) textarea.value = tok;

        // hCaptcha iframe response
        document.querySelectorAll('[name="h-captcha-response"]').forEach(el => el.value = tok);

        // Trigger hcaptcha callback
        if (window.hcaptcha) {
          try {
            // Try the getRespKey approach
            const iframes = document.querySelectorAll('iframe[src*="hcaptcha"]');
            iframes.forEach(iframe => {
              const widgetId = iframe.getAttribute('data-hcaptcha-widget-id');
              if (widgetId && window.hcaptcha.execute) {
                // Callback is internal
              }
            });
          } catch {}
        }
      }, token);

      return { injected: true, type: captchaType, tokenLength: token.length };
    }

    case 'turnstile': {
      const token = solution.token;
      if (!token) throw new Error('No token in Turnstile solution');

      await page.evaluate((tok) => {
        // 1. Set all Turnstile hidden inputs
        document.querySelectorAll('input[name="cf-turnstile-response"]').forEach(el => el.value = tok);
        document.querySelectorAll('[name*="turnstile"]').forEach(el => {
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = tok;
        });

        // 2. Trigger data-callback on the widget div (named global function)
        document.querySelectorAll('.cf-turnstile').forEach(w => {
          const cbName = w.getAttribute('data-callback');
          if (cbName && typeof window[cbName] === 'function') {
            window[cbName](tok);
          }
        });

        // 3. Walk Turnstile's internal widget registry to find and fire callbacks
        //    Turnstile stores widgets internally — we need to trigger their success callbacks
        if (window.turnstile && window.turnstile._widgets) {
          // turnstile._widgets is a Map of widgetId -> widget config
          try {
            const widgets = window.turnstile._widgets;
            if (widgets instanceof Map) {
              widgets.forEach((widget) => {
                if (widget && typeof widget.callback === 'function') widget.callback(tok);
              });
            } else if (typeof widgets === 'object') {
              Object.values(widgets).forEach((widget) => {
                if (widget && typeof widget.callback === 'function') widget.callback(tok);
              });
            }
          } catch {}
        }

        // 4. Dispatch change/input events on the response inputs to trigger form listeners
        document.querySelectorAll('input[name="cf-turnstile-response"]').forEach(el => {
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });

        // 5. Try to find callback from Turnstile's shadow DOM iframe message handler
        //    Some sites listen for a postMessage from the Turnstile iframe
        try {
          window.postMessage({ source: 'turnstile', event: 'complete', token: tok }, '*');
        } catch {}

      }, token);

      // 6. Also try clicking the Turnstile checkbox (inside its iframe) to visually complete
      try {
        const turnstileFrame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]');
        await turnstileFrame.locator('input[type="checkbox"], .mark').click({ timeout: 3000 });
      } catch {
        // iframe click may fail (cross-origin) — that's OK, token is injected
      }

      return { injected: true, type: captchaType, tokenLength: token.length };
    }

    case 'funcaptcha': {
      const token = solution.token;
      if (!token) throw new Error('No token in FunCaptcha solution');

      await page.evaluate((tok) => {
        const input = document.querySelector('#FunCaptcha-Token') ||
                      document.querySelector('[name="fc-token"]') ||
                      document.querySelector('input[name*="funcaptcha"]');
        if (input) input.value = tok;
      }, token);

      return { injected: true, type: captchaType, tokenLength: token.length };
    }

    case 'geetest_v4': {
      // GeeTest v4 solution has multiple fields — typically needs form submission
      return { injected: false, type: captchaType, solution, note: 'GeeTest v4 requires manual form field injection' };
    }

    case 'amazon_waf': {
      const cookie = solution.cookie;
      if (!cookie) throw new Error('No cookie in AWS WAF solution');

      // AWS WAF solution is a cookie — inject it and reload
      await page.evaluate((cookieStr) => {
        document.cookie = cookieStr;
      }, cookie);

      return { injected: true, type: captchaType, note: 'Cookie injected, page reload recommended' };
    }

    default:
      return { injected: false, type: captchaType, solution, note: 'Auto-injection not supported for this type' };
  }
}

// ============================================================
// 4. Main solver function — detect + solve + inject
// ============================================================

/**
 * Solve a captcha on the page.
 *
 * @param {string} clientKey - CapSolver API key
 * @param {import('playwright-core').Page} page
 * @param {object} captcha - Single detected captcha object from detectCaptchas()
 * @param {object} [options]
 * @param {boolean} [options.autoInject=true] - Inject solution token into page
 * @param {boolean} [options.autoSubmit=false] - Click submit button after injection
 * @param {string} [options.submitSelector] - Custom submit button selector
 * @returns {Promise<{solved: boolean, type: string, solution: object, injection: object}>}
 */
async function solveCaptcha(clientKey, page, captcha, options = {}) {
  const { autoInject = true, autoSubmit = false, submitSelector, allCaptchas = [] } = options;

  // Build CapSolver task
  const task = buildCapSolverTask(captcha);
  if (!task) {
    throw new Error(`Unsupported captcha type for solving: ${captcha.type}`);
  }

  console.log(`[CapSolver] Solving ${captcha.type} on ${captcha.pageUrl}, sitekey: ${captcha.sitekey || 'N/A'}`);

  let solution;
  try {
    solution = await createTask(clientKey, task);
  } catch (firstErr) {
    console.warn(`[CapSolver] First attempt failed: ${firstErr.message}`);

    // Retry with alternative sitekeys if available (some sites have multiple Turnstile widgets)
    const alternatives = allCaptchas.filter(c =>
      c.type === captcha.type && c.sitekey && c.sitekey !== captcha.sitekey
    );

    for (const alt of alternatives) {
      try {
        console.log(`[CapSolver] Retrying with alternative sitekey: ${alt.sitekey?.substring(0, 20)}...`);
        const altTask = buildCapSolverTask(alt);
        if (altTask) {
          solution = await createTask(clientKey, altTask);
          console.log(`[CapSolver] Alternative sitekey worked!`);
          break;
        }
      } catch (retryErr) {
        console.warn(`[CapSolver] Alternative also failed: ${retryErr.message}`);
      }
    }

    if (!solution) {
      // Last resort for Turnstile: try clicking the checkbox directly in the iframe
      if (captcha.type === 'turnstile') {
        console.log('[CapSolver] All API attempts failed, trying direct iframe click...');
        try {
          const frame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]').first();
          await frame.locator('body').click({ timeout: 5000 });
          await page.waitForTimeout(5000);
          // Check if turnstile resolved after click
          const resolved = await page.evaluate(() => {
            const input = document.querySelector('input[name="cf-turnstile-response"]');
            return input && input.value && input.value.length > 10;
          });
          if (resolved) {
            console.log('[CapSolver] Direct iframe click resolved the Turnstile!');
            return { solved: true, type: captcha.type, solution: { method: 'iframe-click' }, injection: { injected: true, type: 'turnstile', method: 'browser-native' } };
          }
        } catch (clickErr) {
          console.warn('[CapSolver] iframe click failed:', clickErr.message);
        }
      }
      throw firstErr; // Re-throw original error
    }
  }

  console.log(`[CapSolver] Got solution for ${captcha.type}`);

  let injection = { injected: false };

  // Inject into page
  if (autoInject) {
    injection = await injectSolution(page, captcha.type, solution);
    console.log(`[CapSolver] Injection: ${JSON.stringify(injection)}`);
  }

  // Auto-submit if requested
  if (autoSubmit && injection.injected) {
    const selector = submitSelector || 'button[type="submit"], input[type="submit"], form button:last-of-type';
    try {
      await page.click(selector, { timeout: 5000 });
      console.log('[CapSolver] Auto-submitted form');
      injection.submitted = true;
    } catch (e) {
      console.log('[CapSolver] Auto-submit failed:', e.message);
      injection.submitted = false;
    }
  }

  return {
    solved: true,
    type: captcha.type,
    solution,
    injection,
  };
}

/**
 * Check CapSolver account balance.
 */
async function getBalance(clientKey) {
  const res = await apiRequest('/getBalance', { clientKey });
  return res.balance;
}

module.exports = { solveCaptcha, getBalance, buildCapSolverTask, createTask, injectSolution };
