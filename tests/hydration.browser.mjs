import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = process.env.HYDRATION_BASE_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});

async function checkHydration(name, injectedAttribute) {
  const page = await browser.newPage();
  const warnings = [];
  page.on('console', message => {
    if (/hydration|server rendered html/i.test(message.text())) {
      warnings.push(message.text());
    }
  });
  page.on('pageerror', error => warnings.push(error.message));

  if (injectedAttribute) {
    await page.addInitScript(({ element, name }) => {
      const inject = () => {
        const target = document.querySelector(element);
        if (target) {
          target.setAttribute(name, 'injected');
          return true;
        }
        return false;
      };
      if (!inject()) {
        const observer = new MutationObserver(() => {
          if (inject()) observer.disconnect();
        });
        observer.observe(document, { childList: true, subtree: true });
      }
    }, injectedAttribute);
  }

  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => localStorage.getItem('sunday-room:v1') !== null);
  if (injectedAttribute) {
    const value = await page.locator(injectedAttribute.element).getAttribute(injectedAttribute.name);
    assert.equal(value, 'injected', `${name} did not retain the injected attribute`);
  }
  console.log(`${name}: ${warnings.length} hydration warning(s)`);
  if (warnings.length) console.log((warnings[0].match(/\n-\s+data-[^\n]+/)?.[0] || warnings[0].slice(0, 180)).trim());
  await page.close();
  return warnings;
}

try {
  const clean = await checkHydration('clean');
  const root = await checkHydration('injected html', { element: 'html', name: 'data-mbtss-nonce' });
  const child = await checkHydration('injected body', { element: 'body', name: 'data-hydration-control' });
  assert.equal(clean.length, 0, 'Clean document has a hydration warning');
  assert.equal(root.length, 0, 'Injected root attribute has a hydration warning');
  assert.ok(child.some(warning => warning.includes('data-hydration-control')), 'Injected child attribute should still warn');
} finally {
  await browser.close();
}
