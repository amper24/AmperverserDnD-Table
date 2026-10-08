// Optional browser integration suite: NODE_PATH=/path/to/node_modules node tests/dice.browser.cjs
// Requires Playwright + Chromium (or @sparticuz/chromium in restricted environments).
// All results—local and server-authoritative—must appear in the journal only.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  let options = { headless: true };
  if (process.env.SPARTICUZ) { const pkg = require('@sparticuz/chromium'); const binary = pkg.default || pkg; options = { ...options, args: binary.args, executablePath: await binary.executablePath() }; }
  const browser = await chromium.launch(options);
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('https://dice.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/static/')) {
        const file = path.join(process.cwd(), url.pathname);
        await route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript' });
      } else await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css"></head><body><main style="padding:60px"><h1>Журнал бросков</h1><p>Все результаты хранятся в журнале, без экранных сцен.</p><button id="underlay">Стол остаётся интерактивным</button></main><script src="/static/common.js"></script><script src="/static/dice.js"></script><script src="/static/modules.js"></script></body></html>` });
    });
    await page.goto('https://dice.test/');
    const screenRollLayers = page.locator('.dice-global-stage, .dice-global-burst, .dice-global-canvas');
    await page.evaluate(() => {
      const rolls = [4, 6, 8, 10, 12, 20, 100].map(sides => ({ ...DiceEngine.evaluate('d' + sides), name: 'd' + sides }));
      DiceEngine.present({ label: 'Локальная проверка всех костей', rolls }, { local: true });
    });
    assert.equal(await page.locator('.dice-journal').count(), 1, 'the first result opens the journal');
    assert.equal(await page.locator('.dice-journal .dice-history-entry').first().locator('.dice-total').count(), 7);
    assert.equal(await screenRollLayers.count(), 0, 'a local multi-roll creates no central or full-screen display');
    await page.locator('#underlay').click(); // the table remains clickable because no overlay covers it
    await page.evaluate(() => DiceEngine.present(DiceEngine.evaluate('d20'), { local: true }));
    assert.equal(await page.locator('.dice-journal .dice-history-entry').count(), 2);
    assert.equal(await screenRollLayers.count(), 0, 'consecutive local rolls still only update the journal');

    // A network request waits for the server result; the authoritative response updates the journal only.
    const id = await page.evaluate(() => {
      window.sent = []; LS.setItem('dice-settings', JSON.stringify({ color: '#e35b82' }));
      window.TABLE_CTX = { isGM: true, ws: { send: m => { sent.push(m); return true; } } };
      return DiceEngine.submit({ type: 'roll', expr: 'd20+5', label: 'Серверная проверка' });
    });
    assert.equal(await page.evaluate(() => sent.length), 1);
    const msg = { type: 'chat', kind: 'roll', id: 42, at: '2026-09-29T12:00:00Z', user_id: 'one', name: 'Мастер', payload: { expr: 'd20+5', label: 'Серверная проверка', visibility: 'campaign', dice_color: '#e35b82', request_id: id, total: 25, parts: [{ term: 'd20', rolls: [20], kept: [20], kept_indices: [0], sides: 20 }, { term: '+5', value: 5 }] } };
    await page.evaluate(m => { DiceEngine.receive(m); DiceEngine.receive(m); }, msg);
    assert.equal(await page.locator('.dice-journal .dice-history-entry').count(), 3, 'duplicate server messages are ignored');
    assert.equal(await page.locator('.dice-journal .dice-history-entry').first().locator('.dice-total').textContent(), '25');
    assert.equal(await page.locator('.dice-journal .dice-history-entry').first().evaluate(e => getComputedStyle(e).getPropertyValue('--dice-color').trim()), '#e35b82');
    assert.equal(await screenRollLayers.count(), 0, 'a network result creates no screen-level display');
    assert.equal(await page.evaluate(() => sent[0].dice_color), '#e35b82');
    assert.equal(await page.evaluate(() => sent[0].visibility), 'campaign');
    await page.keyboard.press('Escape');

    const privateId = await page.evaluate(() => DiceEngine.submit({ type: 'roll', expr: 'd20', audience: 'self' }));
    assert.equal(await page.evaluate(() => sent[1].visibility), 'private');
    const privateMsg = { ...msg, id: 43, payload: { ...msg.payload, expr: 'd20', label: 'Личный бросок', visibility: 'private', request_id: privateId, total: 12, parts: [{ term: 'd20', rolls: [12], kept: [12], kept_indices: [0], sides: 20 }] } };
    await page.evaluate(m => DiceEngine.receive(m), privateMsg);
    assert.equal(await page.locator('.dice-journal .dice-history-entry').first().locator('.dice-result .dice-visibility').textContent(), 'Только вам');
    assert.equal(await screenRollLayers.count(), 0);
    await page.keyboard.press('Escape');

    // The shared audience setting applies to all roll entry points and keeps GM-only rolls private.
    await page.evaluate(() => { DiceEngine.dock(); document.querySelectorAll('.dice-audience').forEach(s => { s.value = 'gm'; s.dispatchEvent(new Event('change')); }); });
    const gmId = await page.evaluate(() => DiceEngine.submit({ type: 'roll', expr: 'd20', label: 'скрытый' }));
    assert.equal(await page.evaluate(() => sent.at(-1).gm_only), true);
    const gmMsg = { ...msg, id: 44, payload: { ...msg.payload, label: 'скрытый', gm_only: true, request_id: gmId, total: 7, parts: [{ term: 'd20', rolls: [7], kept: [7], kept_indices: [0], sides: 20 }] } };
    await page.evaluate(m => DiceEngine.receive(m), gmMsg);
    assert.equal(await page.locator('.dice-journal .dice-history-entry').first().locator('.dice-result .dice-visibility').textContent(), 'Только мастеру');
    await page.evaluate(() => document.querySelectorAll('.dice-audience').forEach(s => { s.value = 'all'; s.dispatchEvent(new Event('change')); }));
    await page.keyboard.press('Escape');
    const rejected = await page.evaluate(() => { TABLE_CTX.isGM = false; return DiceEngine.submit({ type: 'roll', expr: 'd20', audience: 'gm' }); });
    assert.equal(rejected, null); assert.equal(await page.evaluate(() => sent.length), 3);
    const disconnected = await page.evaluate(() => { TABLE_CTX.ws.send = () => false; return DiceEngine.submit({ expr: 'd20' }); });
    assert.equal(disconnected, null);

    // Offline attack + damage and repeat share the same journal schema as server results.
    await page.evaluate(() => { delete window.TABLE_CTX; DiceEngine.present({ label: 'Атака + урон', rolls: DiceEngine.evaluateBatch([{ kind: 'attack', expr: 'd20+5' }, { kind: 'damage', expr: 'd8+3' }], () => .999) }, { local: true }); });
    assert.deepEqual(await page.locator('.dice-journal .dice-history-entry').first().locator('.dice-total').allTextContents(), ['25', '19']);
    await page.getByRole('button', { name: 'Повторить', exact: true }).first().click();
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.dice-journal .dice-history-entry').count(), 7);
    assert.equal(await page.locator('.dice-journal .dice-history-entry').first().locator('.dice-result-row').count(), 2, 'repeated damage is not doubled twice');
    assert.equal(await screenRollLayers.count(), 0);
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => DiceEngine.openPanel());
    assert.equal(await page.locator('.dice-journal').count(), 1);
    assert.equal(await page.locator('.modal-bg').count(), 0);
    const entriesBeforeValidation = await page.locator('.dice-journal .dice-history-entry').count();
    await page.locator('.dice-journal').getByLabel('Формула броска').fill('2d6++4');
    await page.locator('.dice-journal').getByRole('button', { name: 'Бросить', exact: true }).click();
    assert.equal(await page.locator('.dice-journal .dice-history-entry').count(), entriesBeforeValidation, 'invalid formulas do not appear as results');
    await page.locator('.dice-journal').getByLabel('Формула броска').fill('2d6+4');
    await page.locator('.dice-journal').getByRole('button', { name: 'Бросить', exact: true }).click();
    assert.ok(await page.locator('.dice-journal .dice-history-entry').first().locator('.dice-total').textContent());
    assert.equal(await screenRollLayers.count(), 0, 'the local formula result is journal-only');
    await page.keyboard.press('Escape');

    await page.evaluate(() => { window.parallelSent = []; TABLE_CTX = { isGM: true, ws: { send: m => { parallelSent.push(m); return true; } } }; DiceEngine.dock({ gm: true }); });
    await page.locator('.dice-dock .dice button').filter({ hasText: 'к6' }).click({ modifiers: ['Shift'] });
    assert.equal(await page.evaluate(() => parallelSent[0].type), 'multi');
    assert.equal(await page.evaluate(() => parallelSent[0].rolls.length), 2);
    const formula = page.locator('.dice-dock input[aria-label="Формула броска"]');
    await page.locator('.dice-dock .seg').getByRole('button', { name: 'Преим.' }).click();
    await formula.fill('d20+5'); await formula.press('Enter');
    assert.equal(await page.evaluate(() => parallelSent.at(-1).expr), '2d20kh1+5');
    await page.locator('.dice-dock .seg').getByRole('button', { name: 'Помеха' }).click();
    await formula.fill('2d20kh1+5'); await formula.press('Enter');
    assert.equal(await page.evaluate(() => parallelSent.at(-1).expr), '2d20kl1+5', 'disadvantage replaces an existing advantage keep rule');
    await formula.fill('2d6+3'); await formula.press('Enter');
    assert.equal(await page.evaluate(() => parallelSent.at(-1).expr), '4d6kl2+3', 'disadvantage applies to non-d20 formulas too');
    await page.evaluate(() => Modules.roll('d8+2', 'Урон', { kind: 'damage', mode: 'adv' }));
    assert.equal(await page.evaluate(() => parallelSent.at(-1).expr), '2d8kh1+2');
    assert.equal(await screenRollLayers.count(), 0, 'no supported entry point can create a result overlay');
    assert.deepEqual(errors, []);
    console.log('PASS: local/network journal-only results, no center-screen layers, privacy, deduplication, formula modes, validation, mobile UI');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
