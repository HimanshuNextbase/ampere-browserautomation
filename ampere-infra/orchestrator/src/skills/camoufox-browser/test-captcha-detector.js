/**
 * Test script for captcha-detector.js
 *
 * Usage:
 *   node test-captcha-detector.js [url]
 *
 * Examples:
 *   node test-captcha-detector.js https://www.google.com/recaptcha/api2/demo
 *   node test-captcha-detector.js https://accounts.hcaptcha.com/demo
 *   node test-captcha-detector.js https://nopecha.com/demo/turnstile
 *   node test-captcha-detector.js                                    # runs all test URLs
 *
 * Requirements:
 *   npm install playwright-core
 *   npx playwright install firefox    (or use system Firefox)
 */

const { firefox, chromium } = require('playwright-core');
const { injectInterceptors, detectCaptchas, summarize } = require('./captcha-detector');

// Well-known demo/test pages for each captcha type
const TEST_URLS = [
  { label: 'reCAPTCHA v2',       url: 'https://www.google.com/recaptcha/api2/demo' },
  { label: 'reCAPTCHA v2 invis', url: 'https://www.google.com/recaptcha/api2/demo?invisible=true' },
  { label: 'hCaptcha',           url: 'https://accounts.hcaptcha.com/demo' },
  { label: 'Turnstile',          url: 'https://nopecha.com/demo/turnstile' },
  { label: 'FunCaptcha',         url: 'https://nopecha.com/demo/funcaptcha' },
  { label: 'No captcha (plain)', url: 'https://example.com' },
];

async function testUrl(browser, label, url) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  // Inject interceptors before any navigation
  await injectInterceptors(context);

  const page = await context.newPage();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${label}`);
  console.log(`URL:     ${url}`);
  console.log('='.repeat(60));

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });

    // Detect captchas (waits 3s for dynamic rendering)
    const captchas = await detectCaptchas(page, { timeout: 3000 });

    if (captchas.length === 0) {
      console.log('Result:  NO CAPTCHA DETECTED');
    } else {
      console.log(`Result:  ${captchas.length} captcha(s) found\n`);
      captchas.forEach((c, i) => {
        console.log(`  [${i + 1}] Type:    ${c.type}`);
        if (c.sitekey)   console.log(`      Sitekey: ${c.sitekey}`);
        if (c.publicKey) console.log(`      PubKey:  ${c.publicKey}`);
        if (c.captchaId) console.log(`      ID:      ${c.captchaId}`);
        if (c.action)    console.log(`      Action:  ${c.action}`);
        if (c.imageSrc)  console.log(`      Image:   ${c.imageSrc.substring(0, 80)}...`);
        console.log(`      Source:  ${c.source}`);
        console.log(`      Page:    ${c.pageUrl}`);
      });
    }

    console.log(`\nSummary: ${summarize(captchas)}`);
  } catch (err) {
    console.log(`ERROR:   ${err.message}`);
  }

  await context.close();
}

async function main() {
  const customUrl = process.argv[2];

  console.log('Captcha Detector Test');
  console.log('Launching Firefox...\n');

  let browser;
  try {
    // Try Firefox first (matches your Camoufox setup)
    browser = await firefox.launch({ headless: true });
    console.log('Using: Firefox');
  } catch {
    // Fall back to Chromium if Firefox not installed
    try {
      browser = await chromium.launch({ headless: true });
      console.log('Using: Chromium (Firefox not available)');
    } catch (e) {
      console.error('No browser available. Run: npx playwright install firefox');
      process.exit(1);
    }
  }

  try {
    if (customUrl) {
      await testUrl(browser, 'Custom URL', customUrl);
    } else {
      for (const t of TEST_URLS) {
        await testUrl(browser, t.label, t.url);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('Done.');
}

main().catch(console.error);
