/**
 * Captcha Auto-Detector for Playwright pages
 *
 * Detects: reCAPTCHA v2, reCAPTCHA v3, hCaptcha, Cloudflare Turnstile,
 *          FunCaptcha/Arkose, GeeTest v3/v4, Amazon WAF, KeyCaptcha,
 *          Yandex SmartCaptcha, DataDome, PerimeterX/HUMAN, mtCaptcha
 *
 * Two detection strategies:
 *   1. DOM inspection  — scan selectors/iframes/scripts after page load
 *   2. JS interception — hook globals (grecaptcha, hcaptcha, turnstile, etc.)
 *                        to catch dynamically-rendered captchas + extract params
 *
 * Usage:
 *   const { injectInterceptors, detectCaptchas } = require('./captcha-detector');
 *
 *   // Before navigation — inject hooks for dynamic captchas
 *   await injectInterceptors(page);
 *
 *   // After navigation / page load
 *   await page.goto('https://example.com');
 *   const captchas = await detectCaptchas(page);
 *   // => [{ type: 'recaptcha_v2', sitekey: '6Le...', pageUrl: '...', ... }]
 */

// ============================================================
// 1. JS Interceptors — inject BEFORE navigation via addInitScript
// ============================================================

const INTERCEPTOR_SCRIPT = `
(() => {
  // Store detected captchas on window so we can read them later
  window.__detectedCaptchas = window.__detectedCaptchas || [];

  function pushCaptcha(entry) {
    // Dedupe by type + sitekey
    const exists = window.__detectedCaptchas.some(
      c => c.type === entry.type && c.sitekey === entry.sitekey
    );
    if (!exists) window.__detectedCaptchas.push(entry);
  }

  // --- reCAPTCHA v2/v3 ---
  let _origRender, _origExecute;

  function patchGrecaptcha() {
    if (!window.grecaptcha) return;

    if (window.grecaptcha.render && !window.grecaptcha.render.__hooked) {
      _origRender = window.grecaptcha.render;
      window.grecaptcha.render = function(container, params) {
        const sitekey = params && params.sitekey;
        const size = params && params.size;
        pushCaptcha({
          type: size === 'invisible' ? 'recaptcha_v2_invisible' : 'recaptcha_v2',
          sitekey: sitekey || '',
          source: 'interceptor:grecaptcha.render',
        });
        return _origRender.apply(this, arguments);
      };
      window.grecaptcha.render.__hooked = true;
    }

    if (window.grecaptcha.execute && !window.grecaptcha.execute.__hooked) {
      _origExecute = window.grecaptcha.execute;
      window.grecaptcha.execute = function(sitekey, options) {
        if (typeof sitekey === 'string') {
          pushCaptcha({
            type: 'recaptcha_v3',
            sitekey: sitekey,
            action: options && options.action,
            source: 'interceptor:grecaptcha.execute',
          });
        }
        return _origExecute.apply(this, arguments);
      };
      window.grecaptcha.execute.__hooked = true;
    }
  }

  // --- hCaptcha ---
  function patchHcaptcha() {
    if (!window.hcaptcha || !window.hcaptcha.render) return;
    if (window.hcaptcha.render.__hooked) return;

    const _origHRender = window.hcaptcha.render;
    window.hcaptcha.render = function(container, params) {
      const sitekey = params && params.sitekey;
      pushCaptcha({
        type: 'hcaptcha',
        sitekey: sitekey || '',
        source: 'interceptor:hcaptcha.render',
      });
      return _origHRender.apply(this, arguments);
    };
    window.hcaptcha.render.__hooked = true;
  }

  // --- Cloudflare Turnstile ---
  function patchTurnstile() {
    if (!window.turnstile || !window.turnstile.render) return;
    if (window.turnstile.render.__hooked) return;

    const _origTRender = window.turnstile.render;
    window.turnstile.render = function(container, params) {
      const sitekey = params && params.sitekey;
      pushCaptcha({
        type: 'turnstile',
        sitekey: sitekey || '',
        source: 'interceptor:turnstile.render',
      });
      return _origTRender.apply(this, arguments);
    };
    window.turnstile.render.__hooked = true;
  }

  // --- GeeTest v4 ---
  function patchGeeTest() {
    if (!window.initGeetest4) return;
    if (window.initGeetest4.__hooked) return;

    const _origGT4 = window.initGeetest4;
    window.initGeetest4 = function(config, callback) {
      pushCaptcha({
        type: 'geetest_v4',
        captchaId: config && config.captchaId,
        source: 'interceptor:initGeetest4',
      });
      return _origGT4.apply(this, arguments);
    };
    window.initGeetest4.__hooked = true;
  }

  // Poll to catch late-loaded SDKs
  let patchAttempts = 0;
  const patcher = setInterval(() => {
    patchGrecaptcha();
    patchHcaptcha();
    patchTurnstile();
    patchGeeTest();
    if (++patchAttempts > 30) clearInterval(patcher); // stop after 15s
  }, 500);
})();
`;

/**
 * Inject JS interceptors into the page context.
 * Call this BEFORE navigation (or on context via context.addInitScript).
 */
async function injectInterceptors(pageOrContext) {
  await pageOrContext.addInitScript(INTERCEPTOR_SCRIPT);
}

// ============================================================
// 2. DOM Detection — run AFTER page load
// ============================================================

/**
 * Detect all captchas on a Playwright page.
 * Returns an array of detected captcha objects.
 *
 * Uses a retry strategy: scans immediately, then retries up to maxRetries
 * times with delays to catch slow-loading captchas (especially through proxies).
 *
 * @param {import('playwright-core').Page} page
 * @param {object} [options]
 * @param {number} [options.timeout=5000] - Initial wait (ms) for captcha widgets to render
 * @param {number} [options.maxRetries=3] - Number of additional scan attempts if first scan finds nothing
 * @param {number} [options.retryDelay=2000] - Delay (ms) between retries
 * @returns {Promise<Array<{type: string, sitekey?: string, pageUrl: string, ...}>>}
 */
async function detectCaptchas(page, options = {}) {
  const { timeout = 5000, maxRetries = 3, retryDelay = 2000 } = options;

  // Initial wait for captcha widgets to render
  if (timeout > 0) {
    // Try to wait for common captcha selectors first (faster than blind timeout)
    const captchaSelectors = [
      '.g-recaptcha', 'iframe[src*="recaptcha"]',
      '.h-captcha', 'iframe[src*="hcaptcha"]',
      '.cf-turnstile', 'iframe[src*="challenges.cloudflare.com"]',
      'iframe[src*="arkoselabs"]',
      '[class*="geetest"]',
      '#px-captcha',
      '#captcha-container',
    ].join(', ');

    try {
      await page.waitForSelector(captchaSelectors, { timeout });
    } catch {
      // No known captcha selector appeared within timeout — still run DOM scan
      // (script tags, interceptor results, or less common captchas may still be present)
    }
  }

  const pageUrl = page.url();

  // Run scan, retry if empty (captcha may still be loading through proxy)
  let detected = await runDomScan(page);

  for (let retry = 0; retry < maxRetries && detected.length === 0; retry++) {
    await page.waitForTimeout(retryDelay);
    detected = await runDomScan(page);
  }

  return detected.map(c => ({ ...c, pageUrl }));
}

/**
 * Single DOM scan pass — called by detectCaptchas (possibly multiple times).
 */
async function runDomScan(page) {
  return page.evaluate(() => {
    const results = [];

    function push(entry) {
      const exists = results.some(
        r => r.type === entry.type && r.sitekey === entry.sitekey
      );
      if (!exists) results.push(entry);
    }

    function getSitekey(el) {
      return (
        el.getAttribute('data-sitekey') ||
        el.getAttribute('data-site-key') ||
        el.getAttribute('data-key') ||
        ''
      );
    }

    // ── reCAPTCHA v2 ──
    document.querySelectorAll('.g-recaptcha').forEach(el => {
      push({
        type: 'recaptcha_v2',
        sitekey: getSitekey(el),
        source: 'dom:.g-recaptcha',
      });
    });

    document.querySelectorAll('iframe').forEach(iframe => {
      const src = iframe.src || '';
      if (src.includes('recaptcha/api2/anchor') || src.includes('recaptcha/api2/bframe')) {
        const m = src.match(/[?&]k=([^&]+)/);
        push({
          type: 'recaptcha_v2',
          sitekey: m ? m[1] : '',
          source: 'dom:iframe[recaptcha]',
        });
      }
      if (src.includes('recaptcha/enterprise')) {
        const m = src.match(/[?&]k=([^&]+)/);
        push({
          type: 'recaptcha_enterprise',
          sitekey: m ? m[1] : '',
          source: 'dom:iframe[recaptcha-enterprise]',
        });
      }
    });

    // ── reCAPTCHA v3 ──
    document.querySelectorAll('script').forEach(script => {
      const src = script.src || '';
      const m = src.match(/recaptcha\/api\.js\?.*render=([^&]+)/);
      if (m && m[1] !== 'explicit') {
        push({
          type: 'recaptcha_v3',
          sitekey: m[1],
          source: 'dom:script[recaptcha-v3]',
        });
      }
    });

    // ── hCaptcha ──
    document.querySelectorAll('.h-captcha').forEach(el => {
      push({
        type: 'hcaptcha',
        sitekey: getSitekey(el),
        source: 'dom:.h-captcha',
      });
    });

    document.querySelectorAll('iframe').forEach(iframe => {
      const src = iframe.src || '';
      if (src.includes('hcaptcha.com/captcha')) {
        const m = src.match(/sitekey=([^&]+)/);
        push({
          type: 'hcaptcha',
          sitekey: m ? m[1] : '',
          source: 'dom:iframe[hcaptcha]',
        });
      }
    });

    // ── Cloudflare Turnstile ──
    // 1. Widget container div (most reliable — present in initial HTML)
    document.querySelectorAll('.cf-turnstile').forEach(el => {
      push({
        type: 'turnstile',
        sitekey: getSitekey(el),
        source: 'dom:.cf-turnstile',
      });
    });

    // 2. Turnstile div may also use id="cf-turnstile" or data-turnstile-* attrs
    document.querySelectorAll('[data-turnstile-sitekey]').forEach(el => {
      push({
        type: 'turnstile',
        sitekey: el.getAttribute('data-turnstile-sitekey') || '',
        source: 'dom:[data-turnstile-sitekey]',
      });
    });

    // 3. Turnstile iframe (appears after JS renders the widget)
    document.querySelectorAll('iframe').forEach(iframe => {
      const src = iframe.src || '';
      if (src.includes('challenges.cloudflare.com')) {
        const m = src.match(/[?&]k=([^&]+)/);
        push({
          type: 'turnstile',
          sitekey: m ? m[1] : '',
          source: 'dom:iframe[turnstile]',
        });
      }
    });

    // 4. Turnstile script tag (catches it even before widget renders)
    document.querySelectorAll('script').forEach(script => {
      const src = script.src || '';
      if (src.includes('challenges.cloudflare.com/turnstile')) {
        // Try to find sitekey from a nearby .cf-turnstile div or any element with data-sitekey
        let sitekey = '';
        const widget = document.querySelector('.cf-turnstile') ||
                       document.querySelector('[data-sitekey]') ||
                       document.querySelector('[data-turnstile-sitekey]');
        if (widget) {
          sitekey = widget.getAttribute('data-sitekey') ||
                    widget.getAttribute('data-turnstile-sitekey') || '';
        }
        // Also check render= param in script URL: api.js?render=explicit&onload=...
        if (!sitekey) {
          const renderMatch = src.match(/[?&]render=([^&]+)/);
          if (renderMatch && renderMatch[1] !== 'explicit') {
            sitekey = renderMatch[1];
          }
        }
        push({
          type: 'turnstile',
          sitekey,
          source: 'dom:script[turnstile]',
        });
      }
    });

    // 5. Turnstile response input (hidden input created by Turnstile after solving)
    const turnstileInput = document.querySelector('input[name="cf-turnstile-response"]') ||
                           document.querySelector('[name*="turnstile"]');
    if (turnstileInput && results.every(r => r.type !== 'turnstile')) {
      // Turnstile is present but we haven't detected it via other methods
      const form = turnstileInput.closest('form');
      let sitekey = '';
      if (form) {
        const widget = form.querySelector('.cf-turnstile') || form.querySelector('[data-sitekey]');
        if (widget) sitekey = widget.getAttribute('data-sitekey') || '';
      }
      push({
        type: 'turnstile',
        sitekey,
        source: 'dom:input[turnstile-response]',
      });
    }

    // ── Cloudflare Challenge Page (full-page interstitial) ──
    if (
      document.querySelector('#challenge-form') ||
      document.querySelector('#cf-challenge-running') ||
      document.querySelector('.cf-browser-verification') ||
      document.querySelector('#challenge-running') ||
      document.querySelector('#challenge-stage')
    ) {
      push({
        type: 'cloudflare_challenge',
        sitekey: '',
        source: 'dom:cloudflare-challenge-page',
      });
    }

    // ── FunCaptcha / Arkose Labs ──
    document.querySelectorAll('iframe').forEach(iframe => {
      const src = iframe.src || '';
      if (src.includes('arkoselabs.com') || src.includes('funcaptcha.com')) {
        const m = src.match(/[?&]pk=([^&]+)/) || src.match(/\/([0-9A-F]{8}-[0-9A-F-]+)\//i);
        push({
          type: 'funcaptcha',
          publicKey: m ? m[1] : '',
          source: 'dom:iframe[arkose]',
        });
      }
    });

    document.querySelectorAll('[data-public-key]').forEach(el => {
      push({
        type: 'funcaptcha',
        publicKey: el.getAttribute('data-public-key') || '',
        source: 'dom:[data-public-key]',
      });
    });

    // ── GeeTest v3 ──
    if (document.querySelector('.geetest_radar_tip') ||
        document.querySelector('.geetest_btn') ||
        document.querySelector('.geetest_panel')) {
      push({
        type: 'geetest_v3',
        source: 'dom:geetest-v3-elements',
      });
    }

    // ── GeeTest v4 ──
    if (document.querySelector('.geetest_box_wrap') ||
        document.querySelector('[class*="geetest_fourth"]')) {
      push({
        type: 'geetest_v4',
        source: 'dom:geetest-v4-elements',
      });
    }

    // ── Amazon WAF / AWS WAF ──
    document.querySelectorAll('iframe').forEach(iframe => {
      const src = iframe.src || '';
      if (src.includes('awswaf') || src.includes('captcha.awswaf')) {
        push({ type: 'amazon_waf', source: 'dom:iframe[awswaf]' });
      }
    });
    if (document.querySelector('#captcha-container') &&
        document.querySelector('script[src*="awswaf"]')) {
      push({ type: 'amazon_waf', source: 'dom:#captcha-container+awswaf' });
    }

    // ── KeyCaptcha ──
    if (document.querySelector('script[src*="KeyCaptcha"]') ||
        document.querySelector('#div_for_keycaptcha')) {
      push({ type: 'keycaptcha', source: 'dom:keycaptcha' });
    }

    // ── Yandex SmartCaptcha ──
    document.querySelectorAll('.smart-captcha').forEach(el => {
      push({
        type: 'yandex_smart',
        sitekey: getSitekey(el),
        source: 'dom:.smart-captcha',
      });
    });
    if (document.querySelector('script[src*="smartcaptcha"]')) {
      push({ type: 'yandex_smart', source: 'dom:script[smartcaptcha]' });
    }

    // ── DataDome ──
    document.querySelectorAll('iframe').forEach(iframe => {
      const src = iframe.src || '';
      if (src.includes('datadome.co') || src.includes('captcha-delivery.com')) {
        push({ type: 'datadome', source: 'dom:iframe[datadome]' });
      }
    });
    if (document.querySelector('script[src*="datadome"]')) {
      push({ type: 'datadome', source: 'dom:script[datadome]' });
    }

    // ── PerimeterX / HUMAN ──
    if (document.querySelector('#px-captcha') ||
        document.querySelector('[class*="px-captcha"]')) {
      push({ type: 'perimeterx', source: 'dom:#px-captcha' });
    }

    // ── mtCaptcha ──
    if (document.querySelector('.mtcaptcha') ||
        document.querySelector('script[src*="mtcaptcha"]')) {
      push({
        type: 'mtcaptcha',
        sitekey: document.querySelector('.mtcaptcha')?.getAttribute('data-sitekey') || '',
        source: 'dom:mtcaptcha',
      });
    }

    // ── Generic image CAPTCHA (fallback heuristic) ──
    // Only fire if no known captcha type was already detected
    if (results.length === 0) {
      const captchaInputs = document.querySelectorAll(
        'input[name*="captcha" i], input[id*="captcha" i], input[placeholder*="captcha" i]'
      );
      const visibleInputs = Array.from(captchaInputs).filter(
        el => el.type !== 'hidden' && el.offsetParent !== null
      );
      if (visibleInputs.length > 0) {
        let imgSrc = '';
        visibleInputs.forEach(input => {
          const parent = input.closest('form') || input.parentElement;
          if (parent) {
            const img = parent.querySelector('img');
            if (img) imgSrc = img.src || '';
          }
        });
        push({
          type: 'image_captcha',
          imageSrc: imgSrc,
          source: 'dom:input[captcha]+img',
        });
      }
    }

    // ── Merge with interceptor results ──
    if (window.__detectedCaptchas) {
      window.__detectedCaptchas.forEach(c => {
        const exists = results.some(
          r => r.type === c.type && (r.sitekey === c.sitekey || (!r.sitekey && !c.sitekey))
        );
        if (!exists) results.push(c);
      });
    }

    return results;
  });
}

// ============================================================
// 3. Convenience helpers
// ============================================================

/**
 * Quick summary string for logging.
 */
function summarize(captchas) {
  if (captchas.length === 0) return 'No captcha detected';
  return captchas
    .map(c => {
      const key = c.sitekey || c.publicKey || c.captchaId || '';
      return `${c.type}${key ? ` (key: ${key.substring(0, 20)}...)` : ''} [${c.source}]`;
    })
    .join(', ');
}

/**
 * Map detected captcha to 2Captcha API method and params.
 * Returns null if the type is not solvable via 2Captcha.
 */
function to2CaptchaParams(captcha) {
  const base = { pageurl: captcha.pageUrl };

  switch (captcha.type) {
    case 'recaptcha_v2':
      return { method: 'userrecaptcha', googlekey: captcha.sitekey, ...base };
    case 'recaptcha_v2_invisible':
      return { method: 'userrecaptcha', googlekey: captcha.sitekey, invisible: 1, ...base };
    case 'recaptcha_v3':
      return { method: 'userrecaptcha', googlekey: captcha.sitekey, version: 'v3', action: captcha.action || '', min_score: 0.3, ...base };
    case 'recaptcha_enterprise':
      return { method: 'userrecaptcha', googlekey: captcha.sitekey, enterprise: 1, ...base };
    case 'hcaptcha':
      return { method: 'hcaptcha', sitekey: captcha.sitekey, ...base };
    case 'turnstile':
      return { method: 'turnstile', sitekey: captcha.sitekey, ...base };
    case 'funcaptcha':
      return { method: 'funcaptcha', publickey: captcha.publicKey, ...base };
    case 'geetest_v4':
      return { method: 'geetest_v4', captcha_id: captcha.captchaId, ...base };
    case 'image_captcha':
      return { method: 'base64', body: captcha.imageSrc || '', ...base };
    default:
      return null;
  }
}

module.exports = { injectInterceptors, detectCaptchas, summarize, to2CaptchaParams };
