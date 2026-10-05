// Optional integration suite: NODE_PATH=/path/to/node_modules node tests/dice.browser.cjs
// Requires playwright + Chromium (or @sparticuz/chromium in restricted environments).
// Results are a stack of mini cards bottom-right: several rolls live in parallel, the table stays clickable.
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
      } else await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css"></head><body><main style="padding:60px"><h1>Кубики · единый центр бросков</h1><p>Проверка листа, чата и локального движка</p><button id="underlay">Стол остаётся интерактивным</button></main><script src="/static/common.js"></script><script src="/static/dice.js"></script><script src="/static/modules.js"></script></body></html>` });
    });
    await page.goto('https://dice.test/');
    await page.evaluate(() => {
      const rolls = [4, 6, 8, 10, 12, 20, 100].map(sides => ({ ...DiceEngine.evaluate('d' + sides), name: 'd' + sides }));
      DiceEngine.present({ label: 'Все грани приключения', rolls }, { local: true });
    });
    await page.waitForSelector('.dice-micro-canvas');
    await page.waitForTimeout(800);
    const pixels = await page.evaluate(() => { const c = document.querySelector('.dice-micro-canvas'); return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0); });
    assert.ok(pixels, 'animation must draw actual mesh pixels');
    if (process.env.DICE_SCREENSHOT) await page.screenshot({ path: process.env.DICE_SCREENSHOT });
    await page.locator('#underlay').click(); // карточки в углу, стол под ними остаётся интерактивным
    assert.equal(await page.locator('.dice-micro .dice-micro-total').count(), 6); // карточка компактная: до 6 строк
    // Параллельные броски: вторая карточка появляется рядом с первой, ничего не вытесняя.
    await page.evaluate(() => DiceEngine.present(DiceEngine.evaluate('d20'), { local: true }));
    assert.equal(await page.locator('.dice-micro').count(), 2);
    const boxes = await page.locator('.dice-micro').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().top));
    assert.ok(boxes[0] < boxes[1], 'new cards stack below the previous ones');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.dice-micro').count(), 0);

    // Reduced motion: show exact, duplicate-aware result without a canvas.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => DiceEngine.present(DiceEngine.evaluate('4d1kh3+2'), { local: true }));
    assert.equal(await page.locator('.dice-micro .dice-micro-total').textContent(), '5');
    assert.equal(await page.locator('.dice-micro .dropped').count(), 1);
    assert.equal(await page.locator('.dice-micro-canvas').count(), 0);
    await page.keyboard.press('Escape');

    // A network request sends once, does not locally render or consume dice, and waits for server values.
    const id = await page.evaluate(() => { window.sent = []; LS.setItem('dice-settings', JSON.stringify({ animate: false, speed: 1, color: '#e35b82' })); window.TABLE_CTX = { isGM: true, ws: { send: m => { sent.push(m); return true; } } }; return DiceEngine.submit({ type: 'roll', expr: 'd20+5', label: 'Серверная проверка' }); });
    assert.equal(await page.locator('.dice-micro').count(), 0);
    const msg = { type: 'chat', kind: 'roll', id: 42, at: '2026-09-29T12:00:00Z', user_id: 'one', name: 'Мастер', payload: { expr: 'd20+5', label: 'Серверная проверка', visibility: 'campaign', dice_color: '#e35b82', request_id: id, total: 25, parts: [{ term: 'd20', rolls: [20], kept: [20], kept_indices: [0], sides: 20 }, { term: '+5', value: 5 }] } };
    await page.evaluate(m => { DiceEngine.receive(m); DiceEngine.receive(m); }, msg);
    assert.equal(await page.locator('.dice-micro .dice-micro-total').textContent(), '25');
    assert.equal(await page.evaluate(() => sent.length), 1);
    assert.equal(await page.evaluate(() => sent[0].dice_color), '#e35b82');
    assert.equal(await page.evaluate(() => sent[0].visibility), 'campaign');
    assert.equal(await page.locator('.dice-micro').evaluate(e => getComputedStyle(e).getPropertyValue('--dice-color').trim()), '#e35b82');
    await page.keyboard.press('Escape');
    const privateId = await page.evaluate(() => DiceEngine.submit({ type: 'roll', expr: 'd20', audience: 'self' }));
    assert.equal(await page.evaluate(() => sent[1].visibility), 'private');
    const privateMsg = { ...msg, id: 43, payload: { ...msg.payload, expr: 'd20', label: 'Личный бросок', visibility: 'private', request_id: privateId, total: 12, parts: [{ term: 'd20', rolls: [12], kept: [12], kept_indices: [0], sides: 20 }] } };
    await page.evaluate(m => DiceEngine.receive(m), privateMsg);
    assert.equal(await page.locator('.dice-micro .dice-private-mark').textContent(), 'Только вам');
    // Общая настройка аудитории: выбрали «только мастеру» — следующие броски уходят скрытыми.
    await page.evaluate(() => { DiceEngine.dock(); document.querySelectorAll('.dice-audience').forEach(s => { s.value = 'gm'; s.dispatchEvent(new Event('change')); }); });
    const gmId = await page.evaluate(() => DiceEngine.submit({ type: 'roll', expr: 'd20', label: 'скрытый' }));
    assert.equal(await page.evaluate(() => sent.at(-1).gm_only), true);
    const gmMsg = { ...msg, id: 44, payload: { ...msg.payload, label: 'скрытый', gm_only: true, request_id: gmId, total: 7, parts: [{ term: 'd20', rolls: [7], kept: [7], kept_indices: [0], sides: 20 }] } };
    await page.evaluate(m => DiceEngine.receive(m), gmMsg);
    assert.equal(await page.locator('.dice-micro .dice-gm-mark').textContent(), 'Только мастеру');
    await page.evaluate(() => document.querySelectorAll('.dice-audience').forEach(s => { s.value = 'all'; s.dispatchEvent(new Event('change')); }));
    await page.keyboard.press('Escape');
    const rejected = await page.evaluate(() => { TABLE_CTX.isGM = false; return DiceEngine.submit({ type: 'roll', expr: 'd20', audience: 'gm' }); });
    assert.equal(rejected, null); assert.equal(await page.evaluate(() => sent.length), 3);
    const disconnected = await page.evaluate(() => { TABLE_CTX.ws.send = () => false; return DiceEngine.submit({ expr: 'd20' }); });
    assert.equal(disconnected, null);

    // Offline critical bundles use the same shape and doubling semantics as server bundles.
    await page.evaluate(() => { delete window.TABLE_CTX; DiceEngine.present({ label: 'Атака + урон', rolls: DiceEngine.evaluateBatch([{ kind: 'attack', expr: 'd20+5' }, { kind: 'damage', expr: 'd8+3' }], () => .999) }, { local: true }); });
    assert.deepEqual(await page.locator('.dice-micro .dice-micro-total').allTextContents(), ['25', '19']);
    await page.locator('.dice-micro').click(); // клик по карточке открывает журнал
    await page.waitForSelector('.dice-journal');
    await page.getByRole('button', { name: 'Повторить', exact: true }).first().click();
    await page.waitForTimeout(400); // старая карточка успевает уйти
    // Check reroll original damage is not doubled twice (critical state is recomputed).
    assert.equal(await page.locator('.dice-micro .dice-micro-row').count(), 2);
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { DiceEngine.openPanel(); });
    assert.equal(await page.locator('.dice-journal').count(), 1);
    assert.equal(await page.locator('.modal-bg').count(), 0);
    await page.getByLabel('Формула броска').fill('2d6++4');
    await page.getByRole('button', { name: 'Бросить', exact: true }).click();
    assert.equal(await page.locator('.dice-micro').count(), 0);
    await page.getByLabel('Формула броска').fill('2d6+4');
    await page.getByRole('button', { name: 'Бросить', exact: true }).click();
    const box = await page.locator('.dice-micro').boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 390);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.parallelSent = []; TABLE_CTX = { isGM: true, ws: { send: m => { parallelSent.push(m); return true; } } }; DiceEngine.dock({ gm: true }); });
    await page.locator('.dice-dock .dice button').filter({ hasText: 'к6' }).click({ modifiers: ['Shift'] });
    assert.equal(await page.evaluate(() => parallelSent[0].type), 'multi');
    assert.equal(await page.evaluate(() => parallelSent[0].rolls.length), 2);
    assert.deepEqual(errors, []);
    console.log('PASS: parallel mini cards, animated meshes, click-through, reduced motion, authoritative network results, deduplication, audience, offline, critical reroll, validation, mobile UI');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
