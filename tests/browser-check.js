'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const createFixture = require('./helpers/http-fixture');

(async () => {
  const fixture = await createFixture();
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
    const payload = 'movie" data-audit-injected="yes <img src=x onerror=alert(1)>.mp4';
    fixture.videos[0].filename = payload;
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(fixture.url);
      await page.locator('#login-screen').waitFor({ state: 'visible' });
      await page.locator('#login-email').fill('admin@example.test');
      await page.locator('#login-pass').fill('fixture-password');
      await page.locator('#login-form button[type=submit]').click();
      await page.locator('#app').waitFor({ state: 'visible' });
      const cookies = await context.cookies();
      assert.equal(cookies.find(c => c.name === 'encodium_session').httpOnly, true);
      assert.equal(await page.evaluate(() => localStorage.getItem('enc_token')), null);
      // Exercise the same persisted-tab path used after a reload on mobile.
      await page.evaluate(() => localStorage.setItem('enc_activeTab', 'library'));
      await page.reload();
      await page.locator('.mb-card-name').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.mb-card-name').textContent(), payload);
      assert.equal(await page.locator('.mb-play-btn').getAttribute('data-fname'), payload);
      assert.equal(await page.locator('[data-audit-injected]').count(), 0);
      await page.locator('.mb-card-cb').check();
      await page.locator('#lib-encode-sel').click();
      await page.locator('#encode-preset').selectOption('cpu_h265');
      await page.locator('#encode-replace').uncheck();
      const before = fixture.calls.filter(c => c.enqueue).length;
      // Simulate a lost response AFTER the server has accepted the mutation.
      await page.route('**/api/encode/enqueue', async route => {
        await route.fetch();
        await route.abort('failed');
      });
      await page.locator('#encode-modal-submit').click();
      await page.waitForTimeout(2500); // Retry delay used to be 2 seconds.
      assert.equal(fixture.calls.filter(c => c.enqueue).length, before + 1);
      await page.unroute('**/api/encode/enqueue');
      await page.locator('#encode-modal-cancel').click();
      await page.locator('.mb-play-btn').click();
      await page.locator('#player-modal').waitFor({ state: 'visible' });
      assert.match(await page.locator('#player-modal video').getAttribute('src'), /\/api\/stream\/1$/);
      await page.keyboard.press('Escape');
      // The fixture is intentionally not a decodable video; player/network
      // media errors are expected, uncaught JS exceptions are not.
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS browser ${viewport.width}x${viewport.height}: login, cookie, library, quote payload, selection, enqueue once, player`);
    }
  } finally {
    await browser?.close();
    await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
