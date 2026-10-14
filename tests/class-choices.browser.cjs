// Браузерный тест классовых выборов в мастере создания (настоящий Chromium):
// 1) боевой стиль воина 2014 — варианты и проверка берутся из набора class_rules;
// 2) «Посвящённый в магию» 2024 через предысторию «Прислужник» — список задан предысторией,
//    заговоры и заклинание выбираются в панели шага «Заклинания».
// Фикстура: реальные скрипты фронта, каталог — из data_seed (srd_2014 / srd_2024), наборы — из static/presets.
const { chromium } = require('playwright');
const fs = require('node:fs');
const loadSrd = require('./fixtures/srd.cjs');
const path = require('node:path');
const assert = require('node:assert/strict');
const browserLaunchOptions = require('./browser-launch.cjs');

const SCRIPTS = ['common.js', 'presets.js', 'dice.js', 'formulas.js', 'equipment.js', 'mechanics.js', 'modules.js', 'compendium.js', 'class-rules.js', 'character-builder.js', 'builder-dialog.js'];
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"></head><body>${SCRIPTS.map(f => `<script src="/static/${f}"></script>`).join('')}</body></html>`;
// Каталог — как у сервера: набор SRD плюс собранные из него черты (data_seed/feats_*.json).
const SEEDS = {
  2014: loadSrd('data_seed/srd_2014.json').concat(loadSrd('data_seed/feats_2014.json')),
  2024: loadSrd('data_seed/srd_2024.json').concat(loadSrd('data_seed/feats_2024.json')),
};
const catalog = (edition, category) => SEEDS[edition].filter(r => r.category === category).map(r => ({ ...r, id: r.slug, source: `SRD ${edition}` }));

async function openWizard(browser, edition = '2014') {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://classes.test/**', async route => {
    const url = new URL(route.request().url());
    const json = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: FIXTURE });
    if (url.pathname.startsWith('/static/')) {
      const f = path.join(process.cwd(), url.pathname);
      return route.fulfill({ body: fs.readFileSync(f), contentType: f.endsWith('.css') ? 'text/css' : 'text/javascript' });
    }
    if (url.pathname === '/api/compendium') {
      const edition = url.searchParams.get('edition') === '2024' ? 2024 : 2014;
      return json(catalog(edition, url.searchParams.get('category')));
    }
    return json([]);
  });
  await page.goto('https://classes.test/fixture');
  await page.waitForFunction(() => window.Presets && window.Presets.classRules('2014', 'fighter'));
  await page.evaluate(() => { window.__dialog = newCharacterDialog({}).then(r => { window.__result = r; }, e => { window.__error = String(e); }); });
  // Шаг «Концепция»: редакция и имя (без имени переход через «Пропустить шаг»).
  if (edition !== '2014') await page.locator('select:has(option[value="2024"])').first().selectOption(edition);
  await page.getByRole('button', { name: /^(Далее|Пропустить шаг)$/ }).first().click();
  return { page, errors };
}

async function scenarioFighter(browser) {
  const { page, errors } = await openWizard(browser);
  await page.locator('select[aria-label="Классы"]').selectOption('srd14-fighter');
  const panel = page.locator('.builder-panel').filter({ hasText: 'Боевой стиль' }).first();
  await panel.waitFor();
  const defense = panel.locator('label.builder-choice-option', { hasText: 'Защита' });
  assert.equal(await defense.count(), 1, 'вариант «Защита» из набора class_rules показан');
  await defense.click();
  await page.waitForFunction(() => document.querySelector('.builder-panel .builder-choice-option.on') !== null);
  assert.equal(await panel.locator('label.builder-choice-option.on', { hasText: 'Защита' }).count(), 1, 'выбранный вариант отмечен');
  assert.equal(await panel.locator('.builder-counter.ok').count(), 1, 'счётчик панели стал «готово»');
  assert.deepEqual(errors, [], `ошибки страницы: ${errors.join('; ')}`);
  await page.close();
}

async function scenarioMagicInitiate(browser) {
  // Редакция 2024, предыстория «Прислужник» даёт «Посвящённый в магию (Жрец)».
  const { page, errors } = await openWizard(browser, '2024');
  await page.locator('select[aria-label="Предыстории"]').selectOption('srd24-acolyte');
  await page.waitForTimeout(100);
  // Переходы до шага «Заклинания» (шаг 5): без блокировок.
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Далее' }).first().click();
  const panel = page.locator('.builder-magic-initiate');
  await panel.waitFor();
  // Список задан предысторией: только «Жрец».
  const lists = panel.locator('label.builder-choice-option:has(input[type="radio"])');
  assert.equal(await lists.count(), 1, 'список задан предысторией');
  assert.match(await lists.first().innerText(), /Жрец/);
  // Характеристики — из набора черты (int, wis, cha).
  const abilityOptions = await panel.locator('select').first().locator('option').allInnerTexts();
  assert.deepEqual(abilityOptions.filter(t => t !== 'Выберите…'), ['Интеллект', 'Мудрость', 'Харизма']);
  await panel.locator('select').first().selectOption('wis');
  // Два заговора из списка жреца (чекбоксы), третий отключён.
  const boxes = panel.locator('input[type="checkbox"]');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  assert.equal(await panel.locator('input[type="checkbox"]:disabled').count() > 0, true, 'после двух заговоров остальные отключены');
  // Заклинание 1 уровня.
  const firstLevel = panel.locator('select').nth(1);
  const firstOptions = await firstLevel.locator('option').allInnerTexts();
  assert.ok(firstOptions.length > 1, 'есть заклинания 1 уровня для жреца');
  await firstLevel.selectOption({ index: 1 });
  await page.waitForFunction(() => document.querySelector('.builder-magic-initiate .builder-counter.ok') !== null);
  assert.deepEqual(errors, [], `ошибки страницы: ${errors.join('; ')}`);
  await page.close();
}

async function scenarioHumanFeat(browser) {
  // Редакция 2024, человек: «черта происхождения» выбирается из черт игрока. Умения классов и черты рас
  // (записи категории «Черты» с полем data.kind) в этот список не попадают — иначе человек выбирал бы
  // «Тёмное зрение» или «Ярость», а список разрастался бы на сотни записей.
  const { page, errors } = await openWizard(browser, '2024');
  await page.locator('select[aria-label="Расы"]').selectOption('srd24-human');
  const panel = page.locator('.builder-panel').filter({ hasText: 'Универсальность · черта происхождения' }).first();
  await panel.waitFor();
  const names = (await panel.locator('label.builder-choice-option b').allInnerTexts()).map(s => s.trim()).sort();
  // Черта игрока — запись категории «Черты» без поля data.kind (у черт-умений оно есть: race/class/subclass).
  const expected = SEEDS[2024].filter(e => e.category === 'feat' && !e.data.kind && !e.data.prerequisites).map(e => e.name).sort();
  assert.deepEqual(names, expected, 'в списке только черты происхождения');
  assert.equal(await panel.locator('label.builder-choice-option').count(), expected.length);
  assert.deepEqual(errors, [], `ошибки страницы: ${errors.join('; ')}`);
  await page.close();
}

(async () => {
  // Отдельный браузер на сценарий: сборка @sparticuz/chromium работает в одном процессе.
  for (const [name, scenario] of [['боевой стиль воина 2014', scenarioFighter], ['Посвящённый в магию 2024', scenarioMagicInitiate],
    ['черта происхождения человека 2024', scenarioHumanFeat]]) {
    const browser = await chromium.launch(await browserLaunchOptions());
    try { await scenario(browser); console.log(`class-choices.browser: ${name} — PASS`); }
    finally { await browser.close(); }
  }
})().catch(e => { console.error('class-choices.browser: FAIL', (e && e.stack) || e); process.exit(1); });
