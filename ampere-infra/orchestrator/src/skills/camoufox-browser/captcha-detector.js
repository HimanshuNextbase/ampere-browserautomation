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
  // Hook grecaptcha.render and grecaptcha.execute
  let _origRender, _origExecute;

  function patchGrecaptcha() {
    if (!window.grecaptcha) return;

    if (window.grecaptcha.render && !window.grecaptcha.render.__hooked) {
      _origRender = window.grecaptcha.render;
      window.grecaptcha.render = function(container, params) {
        const sitekey = params && params.sitekey;
        const size = params && params.size; // 'invisible' = v2 invisible
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
 * @param {import('playwright-core').Page} page
 * @param {object} [options]
 * @param {number} [options.timeout=2000] - Extra wait (ms) for lazy-loaded captchas
 * @returns {Promise<Array<{type: string, sitekey?: string, pageUrl: string, ...}>>}
 */
async function detectCaptchas(page, options = {}) {
  const { timeout = 2000 } = options;

  // Give dynamic captchas a moment to render
  if (timeout > 0) {
    await page.waitForTimeout(timeout);
  }

  const pageUrl = page.url();

  const detected = await page.evaluate(() => {
    const results = [];

    function push(entry) {
      const exists = results.some(
        r => r.type === entry.type && r.sitekey === entry.sitekey
      );
      if (!exists) results.push(entry);
    }

    // Helper: extract sitekey from element's data attributes
    function getSitekey(el) {
      return (
        el.getAttribute('data-sitekey') ||
        el.getAttribute('data-site-key') ||
        el.getAttribute('data-key') ||
        ''
      );
    }

    // ── reCAPTCHA v2 ──
    // Visible checkbox widget
    document.querySelectorAll('.g-recaptcha').forEach(el => {
      push({
        type: 'recaptcha_v2',
        sitekey: getSitekey(el),
        source: 'dom:.g-recaptcha',
      });
    });

    // reCAPTCHA iframe
    document.querySelectorAll('iframe').forEach(iframe => {
      const src = iframe.src || '';
      if (src.includes('recaptcha/api2/anchor') || src.includes('recaptcha/api2/bframe')) {
        // Extract sitekey from iframe src: &k=SITEKEY
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

    // ── reCAPTCHA v3 (script tag, no visible widget) ──
    document.querySelectorAll('script').forEach(script => {
      const src = script.src || '';
      // render=SITEKEY in the script URL means v3
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
    document.querySelectorAll('.cf-turnstile').forEach(el => {
      push({
        type: 'turnstile',
        sitekey: getSitekey(el),
        source: 'dom:.cf-turnstile',
      });
    });

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

    // ── Cloudflare Challenge Page (full-page interstitial) ──
    if (
      document.querySelector('#challenge-form') ||
      document.querySelector('#cf-challenge-running') ||
      document.querySelector('.cf-browser-verification')
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

    // Arkose container div
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
    // Look for common patterns: img near an input with captcha-related names
    const captchaInputs = document.querySelectorAll(
      'input[name*="captcha" i], input[id*="captcha" i], input[placeholder*="captcha" i]'
    );
    if (captchaInputs.length > 0) {
      // Check if there's a nearby image (likely the captcha image)
      let imgSrc = '';
      captchaInputs.forEach(input => {
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

  // Attach pageUrl to every result
  return detected.map(c => ({ ...c, pageUrl }));
}

// ============================================================
// 3. Convenience: detect + summarize
// ============================================================

/**
 * Quick summary string for logging.
 * @param {Array} captchas - Output from detectCaptchas()
 * @returns {string}
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

module.exports = { injectInterceptors, detectCaptchas, summarize };
