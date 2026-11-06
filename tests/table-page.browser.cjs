// Точечный браузерный тест страницы «Участники кампании» (/table/<кампания>):
// участники-аккаунты (имя/email/роль/онлайн), список персонажей, «На стол» для
// чужого персонажа у мастера и его недоступность у игрока, действия мастера
// (смена роли, исключение, приглашение). HTTP API и WebSocket подменяются
// через page.route/page.routeWebSocket, сервер не нужен.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

// Роли кампании и права на слои (ответы /roles и /layer-permissions).
const ROLES = [
  {
    id: 'r1', name: 'Смотритель карты', description: 'Двигает карту, листов не трогает', is_system: false,
    capabilities: ['campaign.read', 'character.read_own', 'character.read_shared', 'table.read', 'table.move_any_token'],
  },
];
const LAYER_PERMS = [
  { role_id: 'r1', role_name: 'Смотритель карты', layer_id: 'map', can_read: true, can_write: false, can_create: false },
  { role_id: 'r1', role_name: 'Смотритель карты', layer_id: 'character', can_read: true, can_write: false, can_create: false },
];

const SCRIPTS = ['core/common', 'core/nav', 'core/access', 'core/character-hp', 'core/asset-kinds', 'core/permissions-ui', 'table/table-model', 'table/table-page'];

// Права берём из static/core/access.js — того же модуля, что и страница.
function accessModule() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('static/core/access.js', 'utf8'), ctx);
  return ctx.window.Access;
}
const Access = accessModule();
const GM_PERMS = Array.from(Access.ALL);
const PLAYER_PERMS = Array.from(Access.PLAYER);

const MEMBERS = [
  { user_id: 'u1', name: 'Мастер', email: 'gm@test', role: 'gm' },
  { user_id: 'u2', name: 'Игрок', email: 'pl@test', role: 'player' },
  { user_id: 'u3', name: 'Гость', email: 'guest@test', role: 'player' },
];
const SCENES = [{ id: 'sc1', name: 'Подземелье' }, { id: 'sc2', name: 'Таверна' }];
const SCENE = {
  id: 'sc1', name: 'Подземелье', grid: { size: 70, type: 'square', visible: true, scale: '5 фт' },
  active_map_id: 'm1', fog: { enabled: false, by_map: {} },
  items: [
    { id: 'm1', layer: 'map', z: -100, data: { type: 'image', x: 350, y: 350, w: 700, h: 700, name: 'Карта' } },
    { id: 't1', layer: 'character', z: 1, data: { type: 'image', x: 350, y: 350, w: 70, h: 70, name: 'Ария', character_id: 'ch1', hp: { cur: 12, max: 18 }, owner_id: 'u1' } },
    { id: 't2', layer: 'character', z: 1, data: { type: 'image', x: 420, y: 350, w: 70, h: 70, name: 'Гоблин', monster: true, hp: { cur: 7, max: 7 }, owner_id: 'u1', hidden: true } },
    { id: 'p1', layer: 'prop', z: 0, data: { type: 'image', x: 0, y: 0, w: 70, h: 70, name: 'Бочка' } },
  ],
};
const CHARACTERS_GM = [
  { id: 'ch1', name: 'Ария', owner_id: 'u1', campaign_id: 'camp-1', sheet: { race: 'Эльф', class: 'Волшебник', level: 3, hp: { current: 12, max: 18 } } },
  { id: 'ch2', name: 'Борин', owner_id: 'u2', campaign_id: 'camp-1', sheet: { race: 'Дварф', class: 'Воин', level: 2, hp: { current: 20, max: 20 } } },
  { id: 'ch3', name: 'Клара', owner_id: 'u3', campaign_id: 'camp-1', sheet: { race: 'Полурослик', class: 'Плут', level: 1, shared: true, hp: { current: 8, max: 8 } } },
];

async function openPage(browser, { me, camp, characters, sceneItems, presence }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const sent = [];
  const patched = [];       // PATCH /layer-permissions и /roles — что ушло на сервер
  const created = [];       // POST /roles — какие роли создавали
  page.on('pageerror', error => errors.push(error.message));

  const answers = {
    '/api/auth/me': me,
    [`/api/campaigns/${camp.id}`]: camp,
    [`/api/campaigns/${camp.id}/scenes`]: SCENES,
    [`/api/campaigns/${camp.id}/scenes/sc1`]: { ...SCENE, items: sceneItems },
    [`/api/characters?campaign_id=${camp.id}`]: characters,
    '/api/assets?kind=token': [{ id: 'tok-a', name: 'NPC' }],
    [`/api/campaigns/${camp.id}/roles`]: ROLES,
    [`/api/campaigns/${camp.id}/layer-permissions`]: LAYER_PERMS,
  };

  await page.route('https://table-page.test/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/static/')) {
      const type = path.extname(url.pathname) === '.css' ? 'text/css' : 'text/javascript';
      return route.fulfill({ body: fs.readFileSync(path.join(process.cwd(), url.pathname)), contentType: type });
    }
    if (url.pathname === `/api/campaigns/${camp.id}/invites` && route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}');
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 'abc123', role: body.role || 'player', url: '/join/abc123' }) });
    }
    if (url.pathname.startsWith('/api/campaigns/') && url.pathname.includes('/members/')) {
      return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    }
    // Права: матрица слоёв (PATCH) и роли (POST/PATCH) — записываем тела, отвечаем ok.
    if (url.pathname.endsWith('/layer-permissions') && route.request().method() === 'PATCH') {
      patched.push(JSON.parse(route.request().postData() || '{}'));
      return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    }
    if (url.pathname.endsWith('/roles') && route.request().method() === 'POST') {
      created.push(JSON.parse(route.request().postData() || '{}'));
      return route.fulfill({ contentType: 'application/json', body: '{"id":"r2","ok":true}' });
    }
    if (/\/roles\/[\w-]+$/.test(url.pathname) && route.request().method() === 'PATCH') {
      patched.push(JSON.parse(route.request().postData() || '{}'));
      return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    }
    if (!url.pathname.startsWith('/api/')) {
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/css/style.css"><link rel="stylesheet" href="/static/core/nav.css"><div id="app"></div>' +
          SCRIPTS.map(name => `<script src="/static/${name}.js"></script>`).join(''),
      });
    }
    const body = answers[url.pathname + url.search] || answers[url.pathname];
    if (body !== undefined) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"not found"}' });
  });

  await page.routeWebSocket(/\/ws\//, ws => {
    ws.onMessage(m => sent.push(JSON.parse(m)));
    const sendPresence = () => { try { ws.send(JSON.stringify({ type: 'presence', users: presence })); } catch { } };
    sendPresence();
    setTimeout(sendPresence, 100);
  });

  await page.goto('https://table-page.test/table/' + camp.id);
  await page.waitForSelector('[data-sec=members] .item');
  return { page, errors, sent, patched, created };
}

async function waitSent(pred, message, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.fail(message);
}

(async () => {
  const browser = await chromium.launch(await require('./browser-launch.cjs')());
  try {
    // ======================= Мастер =======================
    const gmCamp = {
      id: 'camp-1', name: 'Тестовая кампания', role: 'gm', owner_id: 'u1', active_scene_id: 'sc1',
      permissions: GM_PERMS, members: MEMBERS,
    };
    const gm = await openPage(browser, {
      me: { id: 'u1', name: 'Мастер', email: 'gm@test' }, camp: gmCamp,
      characters: CHARACTERS_GM, sceneItems: SCENE.items,
      presence: [
        { user_id: 'u1', name: 'Мастер', role: 'gm', connections: 2 },
        { user_id: 'u2', name: 'Игрок', role: 'player', connections: 1 },
      ],
    });
    {
      const { page, errors, sent } = gm;
      // ---- заголовок и роль ----
      assert.equal(await page.locator('h1', { hasText: 'Участники кампании' }).count(), 1, 'страница участников открылась');
      assert.equal((await page.locator('h1').first().innerText()).includes('Участники кампании'), true);
      assert.equal(await page.locator('.badge.gm').first().innerText(), 'Мастер', 'бейдж роли мастера');
      const joinHref = await page.getByRole('link', { name: /Войти на карту/ }).getAttribute('href');
      assert.equal(joinHref, '/c/camp-1', 'кнопка «Войти на карту» ведёт на стол кампании');

      // ---- участники-аккаунты: имя, email, роль, онлайн ----
      const members = page.locator('[data-sec=members] .item');
      assert.equal(await members.count(), 3, 'три участника-аккаунта');
      const playerRow = members.filter({ hasText: 'pl@test' });
      const playerText = await playerRow.innerText();
      assert.ok(playerText.includes('Игрок'), 'имя участника');
      assert.ok(playerText.includes('pl@test'), 'email виден мастеру');
      assert.ok(playerText.includes('онлайн'), 'присутствие из хаба (presence)');
      const guestText = await members.filter({ hasText: 'guest@test' }).innerText();
      assert.ok(guestText.includes('—'), 'без presence — прочерк');
      // роль: селект у игрока, у владельца заблокирован
      assert.equal(await playerRow.locator('select').count(), 1, 'мастер меняет роль селектом');
      assert.equal(await playerRow.locator('select').inputValue(), 'player');
      const ownerRow = members.filter({ hasText: 'gm@test' }).first();
      assert.equal(await ownerRow.locator('select').isDisabled(), true, 'владельца кампании разжаловать нельзя');
      // исключение — только мастеру и только не владельца
      assert.equal(await page.locator('[data-sec=members] [title="Исключить из кампании"]').count(), 2, 'исключить можно игроков, но не владельца');
      // персонажи участника показаны в его строке
      assert.ok(playerText.includes('Борин'), 'персонаж участника виден в строке');
      assert.ok((await ownerRow.innerText()).includes('Ария'));

      // ---- персонажи: все, «На стол» для чужого персонажа ----
      const chars = page.locator('[data-sec=characters] .item');
      assert.equal(await chars.count(), 3, 'мастер видит всех персонажей кампании');
      const borin = chars.filter({ hasText: 'Борин' });
      assert.ok((await borin.innerText()).includes('владелец: Игрок'), 'владелец персонажа');
      assert.ok((await borin.innerText()).includes('Воин'), 'класс и уровень');
      const aria = chars.filter({ hasText: 'Ария' });
      assert.equal(await aria.getByRole('button', { name: /На стол/ }).count(), 0, 'персонаж уже на столе');
      assert.equal(await aria.getByRole('button', { name: /Убрать со стола/ }).count(), 1, 'убрать токен можно');
      assert.equal(await borin.getByRole('button', { name: /На стол/ }).count(), 1, 'чужого персонажа мастер ставит на стол');

      // Клик «На стол» у чужого персонажа: токен на character-слое с его character_id/owner_id.
      await borin.getByRole('button', { name: /На стол/ }).click();
      await waitSent(() => sent.some(m => m.type === 'item_upsert' && m.item?.data?.character_id === 'ch2'), 'мастер не поставил чужого персонажа на стол');
      const place = sent.find(m => m.type === 'item_upsert' && m.item?.data?.character_id === 'ch2');
      assert.equal(place.item.layer, 'character', 'токен создаётся на слое персонажей');
      assert.equal(place.scene_id, 'sc1', 'токен ставится на выбранную сцену');
      assert.equal(place.item.data.owner_id, 'u2', 'владелец токена — владелец персонажа');
      // Центр карты (350,350) занят токеном Арии — новый токен встаёт в соседнюю клетку,
      // сохраняя привязку к сетке от центра.
      assert.equal(place.item.data.y, 350, 'по вертикали — центр карты');
      assert.equal((place.item.data.x - 350) % 70, 0, 'смещение от центра кратно клетке');
      assert.ok(place.item.data.x >= 350 && place.item.data.x < 700, 'токен в пределах карты');

      // ---- «На столе»: токены сцены, HP/скрытность/владелец ----
      const tokens = page.locator('[data-sec=tokens] .item');
      assert.equal(await tokens.count(), 2, 'два токена на сцене');
      const goblin = tokens.filter({ hasText: 'Гоблин' });
      assert.equal(await goblin.locator('input[type=checkbox]').isChecked(), true, 'скрытность видна мастеру');
      assert.equal(await goblin.locator('select').count(), 1, 'мастер назначает владельца токена');
      const ariaToken = tokens.filter({ hasText: 'Ария' });
      const hp = await ariaToken.locator('input[type=number]').evaluateAll(els => els.map(e => e.value));
      assert.deepEqual(hp, ['12', '18'], 'HP токена');

      // ---- приглашение: ссылка создаётся ----
      await page.getByRole('button', { name: /Пригласить/ }).click();
      await page.locator('.modal select').selectOption('gm');
      await page.getByRole('button', { name: 'Создать ссылку' }).click();
      await page.waitForSelector('.modal input', { timeout: 3000 });
      const inviteUrl = await page.locator('.modal input').last().inputValue();
      assert.match(inviteUrl, /\/join\/abc123$/, 'приглашение создаёт ссылку');

      assert.deepEqual(errors, [], 'нет ошибок страницы');
    }

    // -- центр карты свободен: токен появляется ровно в центре --
    {
      const camp = {
        id: 'camp-1', name: 'Тестовая кампания', role: 'gm', owner_id: 'u1', active_scene_id: 'sc1',
        permissions: GM_PERMS, members: MEMBERS,
      };
      const empty = await openPage(browser, {
        me: { id: 'u1', name: 'Мастер', email: 'gm@test' }, camp,
        characters: [CHARACTERS_GM[1]], sceneItems: [SCENE.items[0]], presence: [],
      });
      const row = empty.page.locator('[data-sec=characters] .item', { hasText: 'Борин' });
      await row.getByRole('button', { name: /На стол/ }).click();
      await waitSent(() => empty.sent.some(m => m.type === 'item_upsert' && m.item?.data?.character_id === 'ch2'), 'токен не создан');
      const place = empty.sent.find(m => m.type === 'item_upsert' && m.item?.data?.character_id === 'ch2');
      assert.deepEqual([place.item.data.x, place.item.data.y], [350, 350], 'токен ровно в центре активной карты');
      assert.deepEqual(empty.errors, [], 'нет ошибок страницы');
    }
    // ======================= Права: роли, участники и матрица слоёв =======================
    {
      const rulesCamp = {
        id: 'camp-1', name: 'Тестовая кампания', role: 'gm', owner_id: 'u1', active_scene_id: 'sc1',
        permissions: GM_PERMS,
        members: [...MEMBERS, { user_id: 'u4', name: 'Смотритель', email: 'watch@test', role: 'Смотритель карты' }],
      };
      const rp = await openPage(browser, {
        me: { id: 'u1', name: 'Мастер', email: 'gm@test' }, camp: rulesCamp,
        characters: CHARACTERS_GM, sceneItems: SCENE.items, presence: [],
      });
      const { page, errors, patched } = rp;
      // Раздел «Права» живёт на странице участников (раньше — модалка со стола).
      const rules = page.locator('[data-sec=rules]');
      assert.equal(await rules.isVisible(), true, 'раздел «Права» виден мастеру');
      const card = rules.locator('.role-card[data-role="r1"]');
      await card.waitFor({ timeout: 5000 });
      const cardText = await card.innerText();
      assert.ok(cardText.includes('Смотритель карты'), 'своя роль в списке');
      assert.ok(cardText.includes('5 из 18'), 'сводка возможностей роли');
      assert.ok(cardText.includes('1 участник'), 'участники роли посчитаны');
      assert.equal(await rules.locator('.role-card.system').count(), 2, 'системные роли показаны для справки');

      // Роль участника: в списке есть своя роль и она выбрана.
      const watchRow = page.locator('[data-sec=members] .item', { hasText: 'watch@test' });
      assert.equal(await watchRow.locator('select').inputValue(), 'Смотритель карты', 'участник со своей ролью');
      assert.equal(await watchRow.locator('select option[value="Смотритель карты"]').count(), 1, 'своя роль в списке назначения');

      // Матрица: строка «Карта», столбец роли. «З» сразу включает изменение слоя и сохраняет.
      const mapCell = rules.locator('.perms-matrix td[data-role="r1"][data-layer="map"]');
      const writeBtn = mapCell.locator('[data-flag=write]');
      assert.equal(await writeBtn.getAttribute('class'), 'perm-toggle', 'по умолчанию карту менять нельзя');
      await writeBtn.click();
      await waitSent(() => patched.length > 0, 'PATCH прав на слой не ушёл');
      assert.deepEqual(patched[0], { role_id: 'r1', layer_id: 'map', can_read: true, can_write: true, can_create: false }, 'включили «изменять» на карте');
      assert.equal(await writeBtn.getAttribute('class'), 'perm-toggle on', 'переключатель сразу показывает новое состояние');
      assert.equal(await mapCell.locator('[data-flag=read]').getAttribute('class'), 'perm-toggle on', 'чтение остаётся включённым');
      assert.deepEqual(errors, [], 'нет ошибок страницы');
    }

    const plCamp = {
      id: 'camp-1', name: 'Тестовая кампания', role: 'player', owner_id: 'u1', active_scene_id: 'sc1',
      permissions: PLAYER_PERMS,
      // сервер не отдаёт игроку email участников
      members: MEMBERS.map(m => ({ user_id: m.user_id, name: m.name, role: m.role })),
    };
    const playerCharacters = [
      { id: 'ch2', name: 'Борин', owner_id: 'u2', campaign_id: 'camp-1', sheet: { race: 'Дварф', class: 'Воин', level: 2, hp: { current: 20, max: 20 } } },
      { id: 'ch3', name: 'Клара', owner_id: 'u3', campaign_id: 'camp-1', sheet: { race: 'Полурослик', class: 'Плут', level: 1, shared: true, hp: { current: 8, max: 8 } } },
    ];
    const playerSceneItems = [
      SCENE.items[0], // карта (слой map)
      SCENE.items[1], // токен Арии (чужой персонаж)
      { id: 't3', layer: 'character', z: 1, data: { type: 'image', x: 490, y: 350, w: 70, h: 70, name: 'Гоблин 2', monster: true, hp: { cur: 7, max: 7 }, owner_id: 'u1' } },
    ];
    const pl = await openPage(browser, {
      me: { id: 'u2', name: 'Игрок', email: 'pl@test' }, camp: plCamp,
      characters: playerCharacters, sceneItems: playerSceneItems,
      presence: [{ user_id: 'u1', name: 'Мастер', role: 'gm', connections: 1 }, { user_id: 'u2', name: 'Игрок', role: 'player', connections: 1 }],
    });
    {
      const { page, errors, sent } = pl;
      assert.equal(await page.locator('.badge.player').first().innerText(), 'Игрок', 'бейдж роли игрока');

      // ---- участники: имена/роли видны, действий мастера нет ----
      const members = page.locator('[data-sec=members] .item');
      assert.equal(await members.count(), 3, 'игрок видит список участников');
      assert.ok((await members.filter({ hasText: 'Мастер' }).first().innerText()).includes('Мастер'), 'роль мастера видна');
      assert.ok(!(await members.first().innerText()).includes('@'), 'email участников игроку не показывают');
      assert.equal(await page.locator('[data-sec=members] select').count(), 0, 'смена роли недоступна игроку');
      assert.equal(await page.locator('[data-sec=members] [title="Исключить из кампании"]').count(), 0, 'исключение недоступно игроку');
      assert.equal(await page.getByRole('button', { name: /Пригласить/ }).isVisible(), false, 'приглашение скрыто у игрока');
      assert.equal(await page.locator('[data-sec=rules]').isVisible(), false, 'раздел «Права» скрыт без возможности «Роли и права»');

      // ---- персонажи: только свои и расшаренные, «На стол» только для своего ----
      const chars = page.locator('[data-sec=characters] .item');
      assert.equal(await chars.count(), 2, 'игрок видит своих и расшаренных');
      const borin = chars.filter({ hasText: 'Борин' });
      const klara = chars.filter({ hasText: 'Клара' });
      assert.equal(await borin.getByRole('button', { name: /На стол/ }).count(), 1, 'своего персонажа игрок ставит сам');
      assert.equal(await klara.getByRole('button', { name: /На стол/ }).count(), 0, 'расшаренного чужого — нельзя');
      await borin.getByRole('button', { name: /На стол/ }).click();
      await waitSent(() => sent.some(m => m.type === 'item_upsert' && m.item?.data?.character_id === 'ch2'), 'игрок не поставил своего персонажа');

      // ---- «На столе»: чужой токен только для чтения ----
      const tokens = page.locator('[data-sec=tokens] .item');
      assert.equal(await tokens.count(), 2);
      const ariaToken = tokens.filter({ hasText: 'Ария' });
      assert.equal(await ariaToken.locator('input[type=number]').first().isDisabled(), true, 'чужой токен не редактируется');
      assert.equal(await ariaToken.getByRole('button', { name: /Убрать со стола/ }).count(), 0, 'чужой токен нельзя убрать');
      assert.equal(await page.locator('[data-sec=tokens] select').count(), 0, 'владельца токена назначает мастер');
      assert.equal(await page.locator('[data-sec=tokens] input[type=checkbox]').count(), 0, 'скрытность — только мастер');

      assert.deepEqual(errors, [], 'нет ошибок страницы');
    }

    console.log('PASS table page browser: участники-аккаунты (имя/email/роль/онлайн), раздел «Права» (свои роли, назначение роли, матрица слоёв), персонажи, «На стол» у мастера для чужого и у игрока для своего, действия мастера, приглашение');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
