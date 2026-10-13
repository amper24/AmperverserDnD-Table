// Браузерный тест мастера повышения уровня (настоящий Chromium через Playwright):
// волшебник 2014 повышается с 1 на 2 уровень через все шаги мастера (LevelUp.open).
// Регрессия: шаг «Обзор» рисует панель «Дальше по классу» (upcoming) — раньше она падала
// с ReferenceError («edition is not defined»), и мастер ломался после первого же «Далее».
// Фикстура: реальные скрипты фронта, каталог — из data_seed, наборы — из static/presets.
const { chromium } = require('playwright');
const fs = require('node:fs');
const loadSrd = require('./fixtures/srd.cjs');
const path = require('node:path');
const assert = require('node:assert/strict');
const browserLaunchOptions = require('./browser-launch.cjs');

const SCRIPTS = ['common.js', 'presets.js', 'dice.js', 'formulas.js', 'equipment.js', 'mechanics.js', 'node-params-form.js', 'node-registry.js', 'node-menu.js', 'mechanics-graph.js', 'modules.js', 'compendium.js', 'class-rules.js', 'levelup.js'];
const NODE_SCRIPTS = require('../tools/nodes/node-loader.cjs').nodeFiles().map(f => `<script src="/${path.relative(process.cwd(), f).split(path.sep).join('/')}"></script>`).join('');
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"></head><body>${SCRIPTS.map(f => f === 'node-registry.js' ? `<script src="/static/${f}"></script>` + NODE_SCRIPTS : `<script src="/static/${f}"></script>`).join('')}</body></html>`;
const SEED = loadSrd('data_seed/srd_2014.json');
const catalog = category => SEED.filter(r => r.category === category).map(r => ({ ...r, id: r.slug, source: 'SRD 2014' }));

(async () => {
  const browser = await chromium.launch(await browserLaunchOptions());
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://levelup.test/**', async route => {
      const url = new URL(route.request().url());
      const json = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
      if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: FIXTURE });
      if (url.pathname.startsWith('/static/')) {
        const f = path.join(process.cwd(), url.pathname);
        return route.fulfill({ body: fs.readFileSync(f), contentType: f.endsWith('.css') ? 'text/css' : 'text/javascript' });
      }
      if (url.pathname === '/api/compendium') return json(catalog(url.searchParams.get('category')));
      return json([]);
    });
    await page.goto('https://levelup.test/fixture');
    await page.waitForFunction(() => window.Presets && window.Presets.classRules('2014', 'wizard') && window.LevelUp);

    // Лист волшебника 1 уровня; мастер меняет его на месте и возвращает true после применения.
    await page.evaluate(() => {
      window.__sheet = { edition: '2014', level: 1, class: 'Волшебник', subclass: '', abilities: { str: 10, dex: 14, con: 14, int: 16, wis: 10, cha: 10 }, skills: [], expertise: [], features: [], hp: { max: 8, current: 8, temp: 0, hit_dice: '1d6' }, spells: { ability: 'int', slots: {}, known: [] }, proficiency_bonus: 2, classes: [{ name: 'Волшебник', level: 1, hit_die: 6 }] };
      window.__done = window.LevelUp.open({ sheet: window.__sheet, campaignId: null, onApply: () => {} }).then(ok => { window.__ok = ok; });
    });

    // Шаг «Класс»: каталог загружен, класс выбран по листу.
    const shell = page.locator('.lu-shell');
    await shell.locator('.lu-kick', { hasText: 'Какой класс повышаем' }).waitFor();
    await shell.getByRole('button', { name: 'Далее →' }).click();

    // Шаг «Обзор» — регрессия: панель «Дальше по классу» (upcoming) должна отрисоваться без ошибок страницы.
    await shell.locator('.lu-kick', { hasText: 'Что вы получаете' }).waitFor();
    await shell.getByText('Дальше по классу').waitFor();
    assert.ok(await shell.locator('.lu-up-row').count() > 0, 'в «Дальше по классу» есть строки будущих уровней');
    assert.deepEqual(errors, [], `ошибки страницы на шаге «Обзор»: ${errors.join('; ')}`);
    await shell.getByRole('button', { name: 'Далее →' }).click();

    // Шаг «Здоровье»: среднее значение выбрано по умолчанию.
    await shell.locator('.lu-kick', { hasText: 'Кость хитов' }).waitFor();
    await shell.getByRole('button', { name: 'Далее →' }).click();

    // Шаг «Подкласс»: выбираем «Школу Воплощения».
    await shell.locator('.lu-kick', { hasText: 'Ваш путь и его умения' }).waitFor();
    await shell.locator('.lu-pick.sub', { hasText: 'Школа Воплощения' }).first().click();
    await page.waitForFunction(() => document.querySelector('.lu-pick.sub.on') !== null);
    await shell.getByRole('button', { name: 'Далее →' }).click();

    // Шаг «Заклинания»: в книгу добавляются два заклинания 1 круга.
    await shell.locator('.lu-kick', { hasText: 'Заклинания и заговоры' }).waitFor();
    for (let i = 0; i < 2; i++) await shell.locator('.lu-sp-main[aria-pressed="false"]').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.lu-sp-main[aria-pressed="true"]').length === 2);
    await shell.getByRole('button', { name: 'Далее →' }).click();

    // Шаг «Итог»: подтверждаем повышение; мастер закрывается, лист изменён на месте.
    await shell.locator('.lu-kick', { hasText: 'Проверьте изменения' }).waitFor();
    await shell.getByRole('button', { name: 'Повысить до 2 уровня' }).click();
    await page.waitForFunction(() => window.__ok === true);
    const sheet = await page.evaluate(() => window.__sheet);
    assert.equal(sheet.level, 2, 'уровень листа повышен');
    assert.equal(sheet.classes[0].level, 2, 'уровень класса повышен');
    assert.equal(sheet.classes[0].subclass, 'Школа Воплощения', 'подкласс записан');
    assert.ok(sheet.hp.max > 8, 'максимум хитов вырос');
    assert.equal(sheet.spells.known.filter(s => s.level === 1).length, 2, 'два новых заклинания в книге');
    assert.deepEqual(errors, [], `ошибки страницы: ${errors.join('; ')}`);
    await page.close();
    console.log('OK: мастер повышения уровня проходит все шаги, волшебник 1 → 2');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
