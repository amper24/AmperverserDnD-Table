// ---------------------------------------------------------------------------
// table-page.js — страница «Настройки компании» (/table/<кампания>).
//
// Пять секций:
//   «Участники»  — аккаунты кампании: имя/email, роль, присутствие на столе,
//                  персонажи участника, действия мастера (роль, исключить, пригласить);
//   «Права»      — система прав целиком (static/core/permissions-ui.js): свои роли,
//                  их возможности, матрица «слой × роль» и назначение роли участнику;
//   «Персонажи»  — доступные по правам листы: «На стол»/«Убрать со стола», лист;
//                  у листов показываются зависимости от отключённых наборов;
//   «На столе»   — токены сцены: HP, скрытность, владелец, удаление;
//   «Наборы правил» — подключение и отключение наборов кампании (только мастер).
//
// Права приходят с сервера (GET кампании: role + permissions) и проверяются
// через Access.can(); сервер остаётся источником правды и отвечает 403/ошибкой WS.
// Роли и их возможности — отдельные эндпоинты /roles и /layer-permissions (только
// с возможностью table.manage_roles); раздел «Права» монтирует Permissions.mount.
// Данные — существующие HTTP API (кампании, сцены, персонажи, ассеты) и те же
// сообщения WebSocket, что у стола (item_upsert/item_delete), без нового сервера.
// Зависимости: common.js, access.js, asset-kinds.js, pack-dependencies.js, table-model.js.
// ---------------------------------------------------------------------------
(async function () {
  const app = document.getElementById('app');
  const APP_NAME = 'Edge Tablet';
  const A = window.Access;
  const LAYER = window.AssetKinds.LAYER;
  const T = window.TableModel;
  const cid = (location.pathname.match(/^\/table\/([\w-]+)/) || [])[1] || '';
  const me = await API.get('/api/auth/me').catch(() => null);
  if (!me) { go('/login?next=' + encodeURIComponent(location.pathname), true); return; }
  if (!cid) {
    app.append(el('div', { class: 'center' }, el('div', { class: 'card auth' }, el('h2', {}, 'Кампания не указана'), el('a', { href: '/' }, 'На главную'))));
    return;
  }
  let camp = await API.get('/api/campaigns/' + cid).catch(() => null);
  if (!camp) {
    app.append(el('div', { class: 'center' }, el('div', { class: 'card auth' }, el('h2', {}, 'Нет доступа'), el('p', { class: 'muted' }, 'Кампания не найдена или вы не её участник.'), el('a', { href: '/campaigns' }, 'К кампаниям'))));
    return;
  }
  document.title = 'Настройки компании: ' + camp.name + ' — ' + APP_NAME;

  // ---------- права (с сервера; локальная матрица — запасной вариант) ----------
  let perms = A.perms(camp);
  if (camp.role !== 'gm' && camp.role !== 'player') {
    try {
      const roles = await API.get(`/api/campaigns/${cid}/roles`).then(r => r || []);
      const myRole = roles.find(r => r.name === camp.role);
      if (myRole) perms = myRole.capabilities || [];
    } catch { /* оставить локальные права по роли */ }
  }
  let can = cap => A.can(perms, cap);
  let isGM = () => can(A.CAP.manageScene);

  // ---------- состояние ----------
  let scenes = [];
  let sceneId = camp.active_scene_id || null;
  let scene = null;
  let characters = [];   // листы, доступные по правам (сервер уже отфильтровал)
  let tokens = [];       // элементы слоя персонажей на сцене
  let members = camp.members || [];
  let rulesUi = null;    // раздел «Права» (Permissions.mount) — только с table.manage_roles
  const campaignRoles = () => (rulesUi ? rulesUi.roles : []);
  let online = null;     // Set(user_id) из presence; null — присутствие ещё не приходило
  let tokenAssets = null;
  let enabledPacks = [];
  let availablePacks = [];
  let charFilter = 'all';
  let search = '';

  // ---------- каркас страницы (стиль как у листа персонажа) ----------
  // Шапка общая (Nav): «Стол» ведёт на стол этой кампании (Nav.tableHref → /c/<cid>),
  // поэтому локальные «К столу/Кампании/Персонажи/Справочник» больше не дублируются.
  app.append(Nav.header({ me, current: location.pathname }));

  const page = el('main', { class: 'page table-admin-page' });
  app.append(page);

  const roleBadge = el('span', { class: 'badge ' + camp.role, title: 'Ваша роль в кампании' }, A.label(camp.role));
  const inviteBtn = el('button', { class: 'small', title: 'Создать ссылку-приглашение', onclick: () => inviteDialog() }, icon('link'), ' Пригласить');
  const mapBtn = el('a', { class: 'btn primary', href: '/c/' + cid, title: 'Открыть виртуальный стол' }, icon('map'), ' Войти на карту');
  const header = el('header', { class: 'table-admin-header' },
    el('div', { class: 'table-admin-heading' },
      el('div', { class: 'table-admin-eyebrow' }, icon('users', 13), ' КАМПАНИЯ'),
      el('div', { class: 'table-admin-title-row' }, el('h1', {}, 'Настройки компании'), roleBadge),
      el('p', {}, camp.name + ' · Участники, права, наборы правил и доступ к столу.')),
    el('div', { class: 'table-admin-actions' }, inviteBtn, mapBtn));
  const sceneBar = el('div', { class: 'table-admin-scenebar' });
  const membersCount = el('span', { class: 'section-count' });
  const membersBox = el('div', { class: 'table-member-list' });
  const searchInput = el('input', { class: 'table-search', placeholder: 'Поиск по имени…', oninput: e => { search = e.target.value.trim().toLowerCase(); renderCharacters(); } });
  const filterSel = el('select', { class: 'table-filter', title: 'Фильтр персонажей', onchange: e => { charFilter = e.target.value; renderCharacters(); } },
    el('option', { value: 'all' }, 'Все персонажи'),
    el('option', { value: 'mine' }, 'Мои персонажи'),
    el('option', { value: 'table' }, 'На столе'),
    el('option', { value: 'off' }, 'Не на столе'));
  const charCounter = el('span', { class: 'section-count' });
  const charsBox = el('div', { class: 'table-roster-list' });
  const tokenCounter = el('span', { class: 'section-count' });
  const tokensBox = el('div', { class: 'table-roster-list' });
  const hint = el('div', { class: 'table-admin-note' });
  const rulesBox = el('div', { class: 'perms' });
  const packsBox = el('div', { class: 'campaign-packs-settings' });

  const sectionNav = el('nav', { class: 'table-admin-tabs', 'aria-label': 'Разделы кампании' });
  const membersCard = el('section', { class: 'card table-admin-section', 'data-sec': 'members' },
    el('div', { class: 'table-section-head' },
      el('div', {}, el('div', { class: 'table-section-kicker' }, 'КОМАНДА'), el('h2', {}, 'Участники'), el('p', {}, 'Игроки и роли в этой кампании.')),
      membersCount), membersBox);
  const rulesCard = el('section', { class: 'card table-admin-section', 'data-sec': 'rules' },
    el('div', { class: 'table-section-head' },
      el('div', {}, el('div', { class: 'table-section-kicker' }, 'ДОСТУП'), el('h2', {}, 'Права и роли'), el('p', {}, 'Настройте возможности ролей и доступ к слоям стола.'))),
    rulesBox);
  const charactersCard = el('section', { class: 'card table-admin-section', 'data-sec': 'characters' },
    el('div', { class: 'table-section-head table-section-head-tools' },
      el('div', {}, el('div', { class: 'table-section-kicker' }, 'ЛИСТЫ'), el('h2', {}, 'Персонажи'), el('p', {}, 'Мастер видит всех; игрок — своих и расшаренных.')),
      el('div', { class: 'table-section-tools' }, searchInput, filterSel, charCounter)),
    charsBox);
  const tokensCard = el('section', { class: 'card table-admin-section', 'data-sec': 'tokens' },
    el('div', { class: 'table-section-head' },
      el('div', {}, el('div', { class: 'table-section-kicker' }, 'СЦЕНА'), el('h2', {}, 'Токены на столе'), el('p', {}, 'Хиты, видимость и владелец токена.')),
      tokenCounter), tokensBox);
  const packsCard = el('section', { class: 'card table-admin-section', 'data-sec': 'packs' },
    el('div', { class: 'table-section-head' },
      el('div', {}, el('div', { class: 'table-section-kicker' }, 'ПРАВИЛА'), el('h2', {}, 'Наборы правил'), el('p', {}, 'Наборы, подключённые к кампании, доступны её участникам.'))),
    packsBox);
  const sectionDefs = [
    { id: 'members', label: 'Участники', icon: 'users', element: membersCard },
    ...(can(A.CAP.manageRoles) ? [{ id: 'rules', label: 'Права', icon: 'shield', element: rulesCard }] : []),
    { id: 'characters', label: 'Персонажи', icon: 'sheet', element: charactersCard },
    { id: 'tokens', label: 'На столе', icon: 'target', element: tokensCard },
    { id: 'packs', label: 'Наборы правил', icon: 'box', element: packsCard }
  ];
  const sectionButtons = new Map();
  for (const section of sectionDefs) {
    const button = el('button', { class: 'table-admin-tab', type: 'button', 'aria-current': 'false', onclick: () => activateSection(section.id) }, icon(section.icon, 15), section.label);
    sectionButtons.set(section.id, button);
    sectionNav.append(button);
  }
  function activateSection(id) {
    for (const section of sectionDefs) {
      const active = section.id === id;
      section.element.classList.toggle('active', active);
      const button = sectionButtons.get(section.id);
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    }
  }
  page.append(header, sceneBar, sectionNav, membersCard, rulesCard, charactersCard, tokensCard, packsCard, hint);
  activateSection('members');

  // ---------- WebSocket: те же сообщения, что у стола ----------
  const ws = { sock: null, q: [], send(m) { if (this.sock?.readyState === 1) { this.sock.send(JSON.stringify(m)); return true; } this.q.push(m); return false; } };
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const s = new WebSocket(`${proto}://${location.host}/ws/${cid}` + (LS.getItem('dnd_token') ? `?token=${LS.getItem('dnd_token')}` : ''));
    ws.sock = s;
    s.onopen = () => { while (ws.q.length) s.send(JSON.stringify(ws.q.shift())); };
    s.onmessage = e => { try { handleWs(JSON.parse(e.data)); } catch { } };
    s.onclose = () => setTimeout(connect, 1500);
  }
  function handleWs(m) {
    if (m.scene_id && scene?.id && m.scene_id !== scene.id) return;
    switch (m.type) {
      case 'error':
        toast(m.message || 'Недостаточно прав', 4000);
        break;
      case 'presence':
        online = new Set((m.users || []).map(u => u.user_id));
        renderMembers();
        break;
      case 'packs_changed':
        loadPacks();
        break;
      case 'item_upsert':
        if (m.item?.layer === LAYER.character) {
          // Скрытые токены игроку не показываем (GET сцены их уже отфильтровал).
          if (!isGM() && m.item.data?.hidden) { tokens = tokens.filter(t => t.id !== m.item.id); renderTokens(); renderCharacters(); break; }
          upsertToken(m.item); renderTokens(); renderCharacters();
        }
        break;
      case 'item_delete':
        if (tokens.some(t => t.id === m.id)) { tokens = tokens.filter(t => t.id !== m.id); renderTokens(); renderCharacters(); }
        break;
      case 'character_update': {
        const c = m.character; if (!c) break;
        const i = characters.findIndex(x => x.id === c.id);
        if (i >= 0) characters[i] = c; else if (c.campaign_id === cid && (isGM() || c.owner_id === me.id || c.sheet?.shared)) characters.push(c);
        const token = tokenOf(c.id);
        const sheetHp = c.sheet?.hp;
        if (token && sheetHp && !CharacterHp.same(token.data?.hp, sheetHp)) {
          patchToken(token, { hp: CharacterHp.fromSheet(sheetHp) }, { fromSheet: true });
        }
        renderCharacters(); renderTokens(); renderMembers();
        break;
      }
      case 'active_scene':
        camp.active_scene_id = m.scene_id;
        if (!isGM()) { sceneId = m.scene_id; loadScene(sceneId).then(renderAll); }
        else renderSceneBar();
        break;
    }
  }
  function upsertToken(item) { const i = tokens.findIndex(t => t.id === item.id); if (i >= 0) tokens[i] = item; else tokens.push(item); }
  const tokenOf = characterId => tokens.find(t => t.data?.character_id === characterId) || null;
  const memberName = uid => members.find(m => m.user_id === uid)?.name || '';

  // ---------- сцена ----------
  async function loadScene(sid) {
    sceneId = sid || null;
    scene = sceneId ? await API.get(`/api/campaigns/${cid}/scenes/${sceneId}`).catch(() => null) : null;
    tokens = (scene?.items || []).filter(it => it.layer === LAYER.character);
    renderSceneBar();
  }
  function renderSceneBar() {
    sceneBar.innerHTML = '';
    if (!scenes.length) { sceneBar.append(el('span', { class: 'muted' }, 'В кампании пока нет сцен — их создаёт мастер.')); return; }
    if (isGM()) {
      const sel = el('select', { class: 'scene-picker', title: 'Сцена, на которой ставим токены', onchange: e => { loadScene(e.target.value).then(renderAll); } },
        ...scenes.map(s => el('option', { value: s.id, selected: s.id === sceneId ? '' : null }, s.name + (s.id === camp.active_scene_id ? ' (активная)' : ''))));
      sceneBar.append(el('span', { class: 'muted' }, 'Сцена:'), sel);
    } else {
      const name = scenes.find(s => s.id === sceneId)?.name || 'мастер ещё не выбрал сцену';
      sceneBar.append(el('span', { class: 'muted' }, 'Сцена: ' + name));
    }
  }

  // ---------- участники ----------
  function renderMembers() {
    membersBox.innerHTML = '';
    membersCount.textContent = members.length === 1 ? '1 участник' : `${members.length} участников`;
    if (!members.length) {
      membersBox.append(el('div', { class: 'table-empty-state' }, icon('users', 22), el('span', {}, 'В кампании пока нет участников.')));
      return;
    }
    for (const m of members) membersBox.append(memberRow(m));
  }

  /// Подпись роли: «Мастер»/«Игрок» для системных, имя своей роли — как есть.
  function roleLabel(name) {
    if (name === 'gm' || name === 'player') return A.label(name);
    const own = campaignRoles().find(r => r.name === name);
    return own ? own.name : A.label(name);
  }

  function memberRow(m) {
    const chars = characters.filter(c => c.owner_id === m.user_id);
    const badge = el('span', { class: 'badge ' + m.role, title: m.role === 'gm' ? 'Мастер кампании' : 'Роль: ' + roleLabel(m.role) }, roleLabel(m.role));
    const avatar = el('div', { class: 'portrait table-member-avatar' }, icon(m.user_id === me.id ? 'user' : 'users', 20));
    if (m.avatar_asset_id) assetURL(m.avatar_asset_id).then(u => { avatar.innerHTML = ''; avatar.append(el('img', { src: u, alt: '' })); }).catch(() => { });
    const charChips = chars.map(c => el('a', { class: 'chip', href: withTok('/sheet/' + c.id), target: '_blank', title: 'Открыть лист персонажа' }, icon('sheet', 12), ' ', c.name));
    const isOnline = online === null ? null : online.has(m.user_id);
    const identity = el('div', { class: 'table-member-identity' }, avatar,
      el('div', { class: 'table-member-info' },
        el('div', { class: 'table-member-name' }, m.name, m.user_id === me.id ? el('span', { class: 'muted small' }, 'Вы') : null),
        el('div', { class: 'table-member-meta' }, m.email || 'Почта не указана'),
        charChips.length ? el('div', { class: 'table-member-characters' }, ...charChips) : el('div', { class: 'table-member-no-characters' }, 'Персонажи не привязаны')));
    const row = el('article', { class: 'table-member' }, identity);

    if (can(A.CAP.manageMembers)) {
      // Владельца кампании нельзя ни разжаловать, ни исключить — сервер это тоже запрещает.
      const isOwner = m.user_id === camp.owner_id;
      const roleSel = el('select', { class: 'table-role-select', title: isOwner ? 'Владелец кампании всегда мастер' : 'Роль участника',
        onchange: async e => {
          const next = e.target.value;
          try { await API.patch(`/api/campaigns/${cid}/members/${m.user_id}`, { role: next }); await reloadCampaign(); toast('Роль обновлена'); }
          catch (err) { toast('Не удалось: ' + err.message, 4000); e.target.value = m.role; }
        } },
        ...roleOptions(m.role));
      roleSel.disabled = isOwner;
      row.append(roleSel);
    } else row.append(badge);

    row.append(el('span', { class: 'table-member-presence' + (isOnline ? ' online' : '') },
      el('i', { 'aria-hidden': 'true' }), isOnline === null ? 'Статус загружается' : isOnline ? 'В сети' : 'Не в сети'));
    if (can(A.CAP.manageMembers) && m.user_id !== camp.owner_id && m.user_id !== me.id) {
      row.append(el('button', { class: 'small danger table-member-remove', title: 'Исключить из кампании', 'aria-label': 'Исключить ' + m.name, onclick: () => kickMember(m) }, icon('trash')));
    }
    return row;
  }

  /// Варианты роли для участника: «Игрок», свои роли кампании, «Мастер».
  /// Текущее значение остаётся в списке, даже если роли не загружены (нет прав на них).
  function roleOptions(current) {
    const options = [el('option', { value: 'player', selected: current === 'player' ? '' : null }, 'Игрок')];
    for (const role of campaignRoles().filter(role => !role.is_system)) {
      options.push(el('option', { value: role.name, selected: current === role.name ? '' : null }, role.name));
    }
    options.push(el('option', { value: 'gm', selected: current === 'gm' ? '' : null }, 'Мастер'));
    if (current && !options.some(option => option.value === current)) {
      options.unshift(el('option', { value: current, selected: '' }, roleLabel(current)));
    }
    return options;
  }

  async function reloadCampaign() {
    const fresh = await API.get('/api/campaigns/' + cid).catch(() => null);
    if (!fresh) return;
    camp = fresh;
    members = fresh.members || [];
    perms = A.perms(camp);
    can = cap => A.can(perms, cap);
    renderAll();
  }

  async function kickMember(m) {
    if (!confirm('Исключить «' + m.name + '» из кампании? Персонажи останутся.')) return;
    try { await API.del(`/api/campaigns/${cid}/members/${m.user_id}`); await reloadCampaign(); toast('Участник исключён'); }
    catch (e) { toast('Не удалось: ' + e.message, 4000); }
  }

  async function inviteDialog() {
    const roleSel = el('select', { style: 'width:auto', title: 'Роль по ссылке' },
      el('option', { value: 'player' }, 'Игрок'), el('option', { value: 'gm' }, 'Мастер'));
    const role = await modal('Пригласить в кампанию',
      el('div', {}, el('div', { class: 'field' }, el('label', {}, 'Кого приглашаем'), roleSel),
        el('p', { class: 'muted small' }, 'Ссылка действует, пока её не удалят в настройках кампании.')),
      [{ label: 'Создать ссылку', cls: 'primary', fn: () => roleSel.value }]);
    if (!role) return;
    try {
      const inv = await API.post(`/api/campaigns/${cid}/invites`, { role });
      const url = location.origin + inv.url;
      const copy = el('button', { class: 'small primary', onclick: () => copyText(url, 'Ссылка скопирована') }, icon('copy'), ' Скопировать');
      await modal('Ссылка-приглашение', el('div', {},
        el('p', { class: 'muted small' }, 'Отправьте ссылку — участник войдёт в кампанию с ролью «' + A.label(role) + '».'),
        el('input', { value: url, readonly: '' }),
        el('div', { class: 'row', style: 'margin-top:8px' }, copy)), []);
    } catch (e) { toast('Не удалось создать приглашение: ' + e.message, 4000); }
  }

  // ---------- персонажи ----------
  function canPlaceCharacter(c) {
    if (can(A.CAP.placeAnyCharacter)) return true;
    return can(A.CAP.placeCharacter) && c.owner_id === me.id;
  }
  function canMoveToken(token) {
    if (can(A.CAP.moveAnyToken)) return true;
    return can(A.CAP.moveOwnToken) && token?.data?.owner_id === me.id;
  }
  function classLine(c) {
    const s = c.sheet || {};
    return [s.race, s.class, s.level ? s.level + ' ур.' : null].filter(Boolean).join(' · ');
  }

  const canManagePacks = () => camp.role === 'gm';
  const packLabel = p => PackDependencies.label(p, [...enabledPacks, ...availablePacks]);
  function missingPacks(c) { return PackDependencies.missing(c.sheet, enabledPacks); }

  async function loadPacks() {
    enabledPacks = await API.get(`/api/campaigns/${cid}/packs`).catch(() => []);
    availablePacks = canManagePacks() ? await API.get('/api/packs?scope=all').catch(() => []) : [];
    renderPacks();
    renderCharacters();
  }

  async function enablePacks(ids) {
    try {
      for (const id of ids) await API.post(`/api/campaigns/${cid}/packs/${id}`, {});
      await loadPacks();
      toast(ids.length === 1 ? 'Набор подключён к кампании' : `Подключено наборов: ${ids.length}`);
    } catch (e) {
      await loadPacks();
      toast('Не удалось подключить набор: ' + e.message, 4000);
    }
  }

  function renderPacks() {
    packsBox.innerHTML = '';
    if (!enabledPacks.length) packsBox.append(el('p', { class: 'muted' }, 'К кампании пока не подключён ни один набор правил.'));
    for (const pack of enabledPacks) {
      const users = characters.filter(c => PackDependencies.fromSheet(c.sheet).some(d => d.id === pack.id));
      const row = el('div', { class: 'row', style: 'margin:6px 0' },
        el('span', { class: 'grow' }, packLabel(pack), ' ', el('span', { class: 'muted small' }, `${pack.entries ?? 0} записей${users.length ? ` · используется в ${users.length} персонажах` : ''}`)));
      if (canManagePacks()) row.append(el('button', { class: 'small danger', onclick: async () => {
        const warning = users.length ? ` Набор используется в ${users.length} персонажах; сохранённые снимки останутся, но записи набора перестанут быть доступны.` : '';
        if (!confirm(`Отключить «${packLabel(pack)}» от кампании?${warning}`)) return;
        try { await API.del(`/api/campaigns/${cid}/packs/${pack.id}`); await loadPacks(); toast('Набор отключён'); }
        catch (e) { toast('Не удалось отключить набор: ' + e.message, 4000); }
      } }, 'Отключить'));
      packsBox.append(row);
    }
    if (!canManagePacks()) {
      packsBox.append(el('p', { class: 'muted small' }, 'Подключать и отключать наборы может мастер кампании. Если персонажу не хватает набора, попросите мастера подключить его.'));
      return;
    }
    const enabled = new Set(enabledPacks.map(p => p.id));
    const available = availablePacks.filter(p => !enabled.has(p.id));
    if (!available.length) {
      packsBox.append(el('p', { class: 'muted small' }, 'Нет доступных наборов для подключения. Добавьте или импортируйте набор в разделе «Наборы» кампании.'));
      return;
    }
    const select = el('select', { 'aria-label': 'Набор для подключения' }, ...available.map(p => el('option', { value: p.id }, `${packLabel(p)} (${p.entries ?? 0})`)));
    packsBox.append(el('div', { class: 'row', style: 'margin-top:10px' }, select,
      el('button', { class: 'small primary', onclick: () => enablePacks([select.value]) }, 'Подключить')));
  }

  function renderCharacters() {
    const all = characters;
    const shown = all.filter(c => {
      if (search && !String(c.name || '').toLowerCase().includes(search)) return false;
      const on = !!tokenOf(c.id);
      if (charFilter === 'mine' && c.owner_id !== me.id) return false;
      if (charFilter === 'table' && !on) return false;
      if (charFilter === 'off' && on) return false;
      return true;
    });
    charsBox.innerHTML = '';
    charCounter.textContent = shown.length === all.length ? String(all.length) : `${shown.length} из ${all.length}`;
    if (!all.length) {
      charsBox.append(el('div', { class: 'table-empty-state' }, icon('user', 22), el('span', {}, can(A.CAP.editOwn) ? 'Пока нет персонажей — создайте лист в кампании или откройте расшаренный.' : 'Нет доступных персонажей.')));
      return;
    }
    if (!shown.length) { charsBox.append(el('div', { class: 'table-empty-state' }, icon('search', 22), el('span', {}, 'Никого не найдено.'))); return; }
    for (const c of shown) charsBox.append(characterRow(c));
  }

  function characterRow(c) {
    const token = tokenOf(c.id);
    const owner = memberName(c.owner_id) || (c.owner_id === me.id ? me.name : '');
    const avatarId = c.sheet?.token_asset_id || c.portrait_asset_id;
    const img = el('div', { class: 'portrait table-row-avatar' }, icon('user', 22));
    if (avatarId) assetURL(avatarId).then(u => { img.innerHTML = ''; img.append(el('img', { src: u, alt: '' })); }).catch(() => { });
    const sub = [owner ? 'владелец: ' + owner : null, token ? 'на столе' : 'не на столе', token?.data?.hidden ? 'скрыт' : null].filter(Boolean).join(' · ');
    const missing = missingPacks(c);
    const missingNotice = missing.length ? el('div', { class: 'row', style: 'justify-content:flex-start;gap:6px;margin-top:4px' },
      el('span', { class: 'small', style: 'color:var(--danger,#e18a36)' }, `Недостающие наборы: ${missing.map(p => packLabel(p)).join(', ')}`),
      canManagePacks() ? el('button', { class: 'small', onclick: () => enablePacks(missing.map(p => p.id)) }, 'Подключить') : el('span', { class: 'muted small' }, 'Попросите мастера подключить их.')) : null;
    const row = el('div', { class: 'item table-roster-item' }, img,
      el('div', { class: 'table-roster-info' },
        el('b', {}, c.name, classLine(c) ? el('span', { class: 'muted small' }, ' · ' + classLine(c)) : null),
        el('div', { class: 'muted small' }, sub), missingNotice));
    const hp = c.sheet?.hp;
    row.append(el('span', { class: 'muted small', title: 'Хиты листа персонажа' }, 'HP ' + (hp?.current ?? 0) + '/' + (hp?.max ?? 0)));

    const acts = el('div', { class: 'row', style: 'flex:0;gap:4px' });
    if (scene && !token && canPlaceCharacter(c)) {
      acts.append(el('button', { class: 'small primary', title: 'Поставить токен в центр активной карты', onclick: () => addToken(c) }, icon('plus'), ' На стол'));
    }
    if (token && canMoveToken(token)) {
      acts.append(el('button', { class: 'small danger', title: 'Убрать токен со стола (лист останется)', onclick: () => removeToken(c.name, token) }, icon('trash'), ' Убрать со стола'));
    }
    acts.append(el('a', { class: 'btn small', href: withTok('/sheet/' + c.id), target: '_blank', title: 'Открыть лист персонажа' }, icon('sheet'), ' Лист'));
    // Токен-аватар: мастеру — для любого токена; игроку — только для своего персонажа без токена.
    if ((token && can(A.CAP.manageMembersTokens)) || (!token && c.owner_id === me.id)) {
      acts.append(el('button', { class: 'small', title: 'Выбрать токен-аватар', onclick: () => pickAvatar(c, token) }, icon('image')));
    }
    row.append(acts);
    return row;
  }

  // ---------- токены на столе ----------
  function renderTokens() {
    tokensBox.innerHTML = '';
    tokenCounter.textContent = tokens.length === 1 ? '1 токен' : `${tokens.length} токенов`;
    if (!scene) { tokensBox.append(el('div', { class: 'table-empty-state' }, icon('map', 22), el('span', {}, 'Мастер ещё не выбрал сцену.'))); return; }
    if (!tokens.length) { tokensBox.append(el('div', { class: 'table-empty-state' }, icon('target', 22), el('span', {}, 'На этой сцене пока нет токенов.'))); return; }
    for (const t of tokens) tokensBox.append(tokenRow(t));
  }

  function tokenRow(t) {
    const d = t.data || {};
    const char = d.character_id ? characters.find(c => c.id === d.character_id) : null;
    const name = d.name || char?.name || (d.monster ? 'Монстр' : 'NPC');
    const owner = memberName(d.owner_id);
    const sub = [owner ? 'владелец: ' + owner : (d.monster ? 'монстр' : (char ? '' : 'NPC')), d.hidden ? 'скрыт' : null].filter(Boolean).join(' · ');
    const img = el('div', { class: 'portrait table-row-avatar' }, icon(char ? 'user' : 'skull', 20));
    if (d.asset_id) assetURL(d.asset_id).then(u => { img.innerHTML = ''; img.append(el('img', { src: u, alt: '' })); }).catch(() => { });
    const row = el('div', { class: 'item table-roster-item' }, img,
      el('div', { class: 'table-roster-info' }, el('b', {}, name), el('div', { class: 'muted small' }, sub || 'токен')));

    const editable = canMoveToken(t);
    const hp = d.hp || { cur: 0, max: 0 };
    const cur = el('input', { type: 'number', value: hp.cur ?? 0, style: 'width:64px', title: 'Текущие хиты', onchange: e => patchToken(t, { hp: { ...hp, cur: +e.target.value } }) });
    const max = el('input', { type: 'number', value: hp.max ?? 0, style: 'width:64px', title: 'Максимум хитов', onchange: e => patchToken(t, { hp: { ...hp, max: +e.target.value } }) });
    cur.disabled = !editable; max.disabled = !editable;
    row.append(el('span', { class: 'row', style: 'flex:0;gap:4px' }, el('span', { class: 'muted small' }, 'HP'), cur, el('span', { class: 'muted' }, '/'), max));

    if (can(A.CAP.manageMembersTokens)) {
      const hid = el('input', { type: 'checkbox', style: 'width:auto', checked: d.hidden ? '' : null, title: 'Скрыт от игроков', onchange: e => patchToken(t, { hidden: e.target.checked }) });
      row.append(el('label', { class: 'muted small', style: 'flex:0;white-space:nowrap' }, hid, ' скрыт'));
      const ownerSel = el('select', { style: 'width:auto;max-width:170px', title: 'Владелец токена', onchange: e => patchToken(t, { owner_id: e.target.value || undefined }) },
        el('option', { value: '' }, '— мастер —'),
        ...members.map(m => el('option', { value: m.user_id, selected: d.owner_id === m.user_id ? '' : null }, m.name)));
      row.append(ownerSel);
    }
    const acts = el('div', { class: 'row', style: 'flex:0;gap:4px' });
    if (d.character_id && (char || can(A.CAP.editAny))) acts.append(el('a', { class: 'btn small', href: withTok('/sheet/' + d.character_id), target: '_blank', title: 'Лист персонажа' }, icon('sheet')));
    if (editable) acts.append(el('button', { class: 'small danger', title: 'Убрать со стола', onclick: () => removeToken(name, t) }, icon('trash')));
    row.append(acts);
    return row;
  }

  // ---------- изменения ----------
  function patchToken(token, patch, opts = {}) {
    const oldHp = token.data?.hp;
    token.data = { ...(token.data || {}), ...patch };
    if (token.data.owner_id === undefined) delete token.data.owner_id;
    if (!opts.fromSheet && token.data.character_id && patch.hp && !CharacterHp.same(oldHp, patch.hp)) {
      CharacterHp.write(token.data.character_id, patch.hp);
    }
    ws.send({ type: 'item_upsert', scene_id: scene.id, item: { id: token.id, layer: token.layer, z: token.z, data: token.data } });
    renderTokens();
    renderCharacters();
  }

  /// Позиция нового токена: центр активной карты (или 0,0), соседние клетки — если место занято.
  function tokenSpot() {
    const g = T.gridSize(scene.grid);
    const b = T.boardBounds(scene);
    const cx = b ? b.x + b.w / 2 : 0;
    const cy = b ? b.y + b.h / 2 : 0;
    const taken = new Set(tokens.map(t => `${t.data?.x ?? 0}:${t.data?.y ?? 0}`));
    for (let i = 0; i < 64; i++) {
      const col = i % 8, row = Math.floor(i / 8);
      const p = { x: Math.round((cx + col * g) * 100) / 100, y: Math.round((cy + row * g) * 100) / 100 };
      if (!taken.has(`${p.x}:${p.y}`)) return p;
    }
    return { x: cx, y: cy };
  }

  async function addToken(c) {
    if (!scene) return toast('Мастер ещё не выбрал сцену');
    if (tokenOf(c.id)) return toast('Этот персонаж уже на столе');
    if (!canPlaceCharacter(c)) return toast('Нет прав ставить этого персонажа на стол', 4000);
    const g = T.gridSize(scene.grid);
    let assetId = c.sheet?.token_asset_id || c.portrait_asset_id;
    if (!assetId) {
      if (!tokenAssets) tokenAssets = await API.get('/api/assets?kind=token').catch(() => []);
      assetId = (tokenAssets.find(a => a.name === 'NPC') || tokenAssets[0])?.id;
    }
    if (!assetId) return toast('В библиотеке нет токенов — загрузите изображение в «Библиотеке ресурсов»');
    const hp = c.sheet?.hp;
    const pos = tokenSpot();
    const data = {
      type: 'image', asset_id: assetId, x: pos.x, y: pos.y, w: g, h: g, name: c.name,
      hp: { cur: hp?.current ?? 10, max: hp?.max ?? 10 },
      owner_id: c.owner_id || me.id, character_id: c.id,
    };
    ws.send({ type: 'item_upsert', scene_id: scene.id, item: { layer: LAYER.character, z: 1, data } });
    toast('«' + c.name + '» на столе');
  }

  function removeToken(name, token) {
    if (!confirm('Убрать «' + name + '» со стола? Токен будет удалён, персонаж останется.')) return;
    ws.send({ type: 'item_delete', scene_id: scene.id, id: token.id });
  }

  async function pickAvatar(c, token) {
    if (!tokenAssets) tokenAssets = await API.get('/api/assets?kind=token').catch(() => []);
    if (!tokenAssets.length) return toast('В библиотеке нет токенов');
    let chosen = null;
    const grid = el('div', { class: 'asset-grid' });
    for (const a of tokenAssets) {
      const btn = el('button', { class: 'asset', title: a.name, onclick: () => { chosen = a.id; grid.querySelectorAll('.asset').forEach(x => x.classList.remove('active')); btn.classList.add('active'); } }, el('span', {}, a.name));
      assetURL(a.id).then(u => btn.prepend(el('img', { src: u, alt: '' }))).catch(() => { });
      grid.append(btn);
    }
    const ok = await modal('Токен-аватар: ' + c.name, el('div', { style: 'max-height:50vh;overflow:auto' }, grid), [{ label: 'Выбрать', cls: 'primary', fn: () => chosen }]);
    if (!ok) return;
    if (!token) {
      try {
        const full = await API.get('/api/characters/' + c.id);
        full.sheet.token_asset_id = ok;
        const saved = await API.patch('/api/characters/' + c.id, { sheet: full.sheet });
        c.sheet = saved.sheet;
      } catch (e) { toast('Не удалось сохранить аватар: ' + e.message, 4000); }
    }
    if (token) patchToken(token, { asset_id: ok }); else renderCharacters();
  }

  // ---------- отрисовка целиком ----------
  function renderAll() {
    roleBadge.textContent = A.label(camp.role);
    roleBadge.className = 'badge ' + camp.role;
    inviteBtn.classList.toggle('hidden', !can(A.CAP.invite));
    renderSceneBar();
    renderMembers();
    renderCharacters();
    renderTokens();
    hint.textContent = scene ? 'Изменения сразу видны всем на столе.' : 'Мастер ещё не выбрал сцену: смотреть можно, ставить токены — нет.';
  }

  // ---------- старт ----------
  scenes = await API.get(`/api/campaigns/${cid}/scenes`).catch(() => []);
  sceneId = camp.active_scene_id || scenes[0]?.id || null;
  await loadScene(sceneId);
  characters = await API.get('/api/characters?campaign_id=' + cid).catch(() => []);
  await loadPacks();

  // Раздел «Права» — только тем, кто может менять роли (по умолчанию мастер).
  if (can(A.CAP.manageRoles)) {
    const rulesCard = page.querySelector('[data-sec=rules]');
    rulesCard.classList.remove('hidden');
    rulesUi = await Permissions.mount(rulesBox, {
      cid,
      members: () => members,
      // Роль могли переименовать/удалить: сервер уже перевёл участников на «Игрока».
      onChanged: () => reloadCampaign(),
    });
  }

  renderAll();
  connect();
})();
