// ---------------------------------------------------------------------------
// table-page.js — страница «Участники стола» (/table/<кампания>): персонажи
// кампании и токены сцены, поиск/фильтр, добавление токена на сцену и
// удаление со сцены, HP/скрытность/владелец, токен-аватар, «Войти на карту».
// Даёт: страницу; наружу ничего не экспортирует.
// Зависимости: common.js, asset-kinds.js, table-model.js.
// Данные — существующие HTTP API (кампании, сцены, персонажи, ассеты) и те же
// сообщения WebSocket, что у стола (item_upsert/item_delete), без нового сервера.
// ---------------------------------------------------------------------------
(async function () {
  const app = document.getElementById('app');
  const APP_NAME = 'Edge Tablet';
  const LAYER = window.AssetKinds.LAYER;
  const T = window.TableModel;
  const cid = (location.pathname.match(/^\/table\/([\w-]+)/) || [])[1] || '';
  const me = await API.get('/api/auth/me').catch(() => null);
  if (!me) { go('/login?next=' + encodeURIComponent(location.pathname), true); return; }
  if (!cid) {
    app.append(el('div', { class: 'center' }, el('div', { class: 'card auth' }, el('h2', {}, 'Кампания не указана'), el('a', { href: '/' }, 'На главную'))));
    return;
  }
  const camp = await API.get('/api/campaigns/' + cid).catch(() => null);
  if (!camp) {
    app.append(el('div', { class: 'center' }, el('div', { class: 'card auth' }, el('h2', {}, 'Нет доступа'), el('p', { class: 'muted' }, 'Кампания не найдена или вы не её участник.'), el('a', { href: '/campaigns' }, 'К кампаниям'))));
    return;
  }
  const isGM = camp.role === 'gm';
  document.title = 'Участники: ' + camp.name + ' — ' + APP_NAME;

  // ---------- состояние ----------
  let scenes = await API.get(`/api/campaigns/${cid}/scenes`).catch(() => []);
  let sceneId = camp.active_scene_id || scenes[0]?.id || null;
  let scene = null;
  let characters = [];
  let tokens = []; // элементы сцены на слое персонажей
  let tokenAssets = null; // кэш токенов для выбора аватара

  // ---------- каркас страницы (стиль как у листа персонажа) ----------
  app.append(el('div', { class: 'topbar' },
    el('a', { href: '/', class: 'brand' }, APP_NAME),
    el('nav', { class: 'mainnav' },
      el('a', { href: '/c/' + cid }, 'К столу'),
      el('a', { href: '/campaigns' }, 'Кампании'),
      el('a', { href: '/characters' }, 'Персонажи'),
      el('a', { href: '/compendium' }, 'Справочник')),
    el('span', { class: 'spacer' }),
    Theme.button(),
    el('span', { class: 'userbox' }, el('a', { href: '/profile', class: 'userlink', title: 'Профиль' }, me.name))));

  const page = el('div', { class: 'page' });
  app.append(page);
  const sceneBar = el('div', { class: 'row', style: 'margin-bottom:10px;flex-wrap:wrap' });
  const search = el('input', { placeholder: 'Поиск по имени…', style: 'max-width:260px', oninput: () => renderList() });
  const filter = el('select', { style: 'width:auto;max-width:220px', title: 'Фильтр участников', onchange: () => renderList() },
    el('option', { value: '' }, 'Все участники'),
    el('option', { value: 'scene' }, 'В игре (на сцене)'),
    el('option', { value: 'hidden' }, 'Скрытые'),
    el('option', { value: 'off' }, 'Не на сцене'));
  const counter = el('span', { class: 'muted small' });
  const listBox = el('div', { class: 'list' });
  const hint = el('div', { class: 'muted small', style: 'margin-top:10px' });
  page.append(
    el('div', { class: 'row', style: 'margin-bottom:14px;flex-wrap:wrap' },
      el('h1', { style: 'flex:1' }, 'Участники стола'),
      el('a', { class: 'btn primary', href: '/c/' + cid, title: 'Открыть виртуальный стол' }, icon('map'), ' Войти на карту')),
    el('p', { class: 'muted' }, 'Персонажи кампании и токены сцены. «На сцену» создаёт токен на слое персонажей, «Убрать» удаляет его со сцены. HP, скрытность, владелец и токен-аватар настраиваются здесь; сам стол — по кнопке «Войти на карту».'),
    sceneBar,
    el('div', { class: 'row', style: 'margin-bottom:8px;flex-wrap:wrap' }, search, filter, counter),
    listBox, hint);

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
      case 'item_upsert':
        if (m.item?.layer === LAYER.character) {
          // Скрытые токены игроку не показываем (как и на столе; GET сцены их уже отфильтровал).
          if (!isGM && m.item.data?.hidden) { tokens = tokens.filter(t => t.id !== m.item.id); renderList(); break; }
          upsertToken(m.item); renderList();
        }
        break;
      case 'item_delete':
        if (tokens.some(t => t.id === m.id)) { tokens = tokens.filter(t => t.id !== m.id); renderList(); }
        break;
      case 'character_update': {
        const c = m.character; if (!c) break;
        const i = characters.findIndex(x => x.id === c.id);
        if (i >= 0) characters[i] = c; else if (c.campaign_id === cid) characters.push(c);
        renderList(); break;
      }
      case 'active_scene':
        if (!isGM) { sceneId = m.scene_id; loadScene(sceneId).then(renderList); }
        break;
    }
  }
  function upsertToken(item) { const i = tokens.findIndex(t => t.id === item.id); if (i >= 0) tokens[i] = item; else tokens.push(item); }

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
    if (isGM) {
      const sel = el('select', { style: 'width:auto;max-width:260px', title: 'Сцена, на которой добавляем токены', onchange: e => { loadScene(e.target.value).then(renderList); } },
        ...scenes.map(s => el('option', { value: s.id, selected: s.id === sceneId ? '' : null }, s.name + (s.id === camp.active_scene_id ? ' (активная)' : ''))));
      sceneBar.append(el('span', { class: 'muted' }, 'Сцена:'), sel);
    } else {
      const name = scenes.find(s => s.id === sceneId)?.name || 'мастер ещё не выбрал сцену';
      sceneBar.append(el('span', { class: 'muted' }, 'Сцена: ' + name));
    }
  }

  // ---------- участники ----------
  function participants() {
    const out = [];
    const tokenOf = id => tokens.find(t => t.data?.character_id === id) || null;
    const known = new Set();
    for (const c of characters) { known.add(c.id); out.push({ key: 'c:' + c.id, kind: 'character', character: c, token: tokenOf(c.id), name: c.name }); }
    for (const t of tokens) {
      const ch = t.data?.character_id;
      if (ch && known.has(ch)) continue;
      out.push({ key: 't:' + t.id, kind: 'token', character: null, token: t, name: t.data?.name || (t.data?.monster ? 'Монстр' : 'NPC') });
    }
    return out;
  }
  const onScene = p => !!p.token;
  const isHidden = p => !!p.token?.data?.hidden;
  function canEdit(p) {
    if (isGM) return true;
    if (p.kind === 'character') return p.character.owner_id === me.id;
    return p.token?.data?.owner_id === me.id;
  }

  function renderList() {
    const q = search.value.trim().toLowerCase();
    const f = filter.value;
    const all = participants();
    const shown = all.filter(p => {
      if (q && !String(p.name).toLowerCase().includes(q)) return false;
      if (f === 'scene' && !onScene(p)) return false;
      if (f === 'hidden' && !isHidden(p)) return false;
      if (f === 'off' && onScene(p)) return false;
      return true;
    });
    listBox.innerHTML = '';
    counter.textContent = shown.length === all.length ? String(all.length) : `${shown.length} из ${all.length}`;
    if (!all.length) listBox.append(el('p', { class: 'muted' }, 'Пока никого: создайте персонажа в кампании или перетащите NPC/монстра на стол.'));
    else if (!shown.length) listBox.append(el('p', { class: 'muted' }, 'Никого не найдено.'));
    for (const p of shown) listBox.append(row(p));
    hint.textContent = scene ? 'Изменения сразу видны всем на столе.' : 'Мастер ещё не выбрал сцену: смотреть можно, добавлять токены — нет.';
  }

  function row(p) {
    const d = p.token?.data || {};
    const editable = canEdit(p);
    const avatarId = d.asset_id || p.character?.sheet?.token_asset_id || p.character?.portrait_asset_id;
    const img = el('div', { class: 'portrait', style: 'width:44px;height:44px;flex:0 0 44px' }, icon(p.character ? 'user' : 'skull', 22));
    if (avatarId) assetURL(avatarId).then(u => { img.innerHTML = ''; img.append(el('img', { src: u, alt: '' })); }).catch(() => { });
    const who = p.character
      ? ((camp.members || []).find(m => m.user_id === p.character.owner_id)?.name || 'персонаж игрока')
      : (d.monster ? 'монстр' : 'NPC');
    const sub = [who, onScene(p) ? 'на сцене' : 'не на сцене', isHidden(p) ? 'скрыт' : ''].filter(Boolean).join(' · ');
    const classLine = p.character ? [p.character.sheet?.race, p.character.sheet?.class, p.character.sheet?.level && p.character.sheet.level + ' ур.'].filter(Boolean).join(' ') : '';
    const rowEl = el('div', { class: 'item', style: 'align-items:center;gap:8px;flex-wrap:wrap' }, img,
      el('div', { style: 'flex:1;min-width:150px' },
        el('b', {}, p.name, classLine ? el('span', { class: 'muted small' }, ' · ' + classLine) : null),
        el('div', { class: 'muted small' }, sub)));

    if (p.token) {
      const hp = d.hp || { cur: 0, max: 0 };
      const cur = el('input', { type: 'number', value: hp.cur ?? 0, style: 'width:64px', title: 'Текущие хиты', onchange: e => patchToken(p.token, { hp: { ...hp, cur: +e.target.value } }) });
      const max = el('input', { type: 'number', value: hp.max ?? 0, style: 'width:64px', title: 'Максимум хитов', onchange: e => patchToken(p.token, { hp: { ...hp, max: +e.target.value } }) });
      cur.disabled = !editable; max.disabled = !editable;
      rowEl.append(el('span', { class: 'row', style: 'flex:0;gap:4px' }, el('span', { class: 'muted small' }, 'HP'), cur, el('span', { class: 'muted' }, '/'), max));
    } else if (p.character) {
      rowEl.append(el('span', { class: 'muted small', title: 'Хиты листа персонажа' }, 'HP ' + (p.character.sheet?.hp?.current ?? 0) + '/' + (p.character.sheet?.hp?.max ?? 0)));
    }

    if (isGM && p.token) {
      const hid = el('input', { type: 'checkbox', style: 'width:auto', checked: d.hidden ? '' : null, title: 'Скрыт от игроков', onchange: e => patchToken(p.token, { hidden: e.target.checked }) });
      rowEl.append(el('label', { class: 'muted small', style: 'flex:0;white-space:nowrap' }, hid, ' скрыт'));
      const owner = el('select', { style: 'width:auto;max-width:170px', title: 'Владелец токена', onchange: e => patchToken(p.token, { owner_id: e.target.value || undefined }) },
        el('option', { value: '' }, '— мастер —'),
        ...(camp.members || []).map(m => el('option', { value: m.user_id, selected: d.owner_id === m.user_id ? '' : null }, m.name)));
      rowEl.append(owner);
    }

    const acts = el('div', { class: 'row', style: 'flex:0;gap:4px' });
    if (!p.token && p.character && scene && (isGM || p.character.owner_id === me.id)) {
      acts.append(el('button', { class: 'small primary', title: 'Создать токен на слое персонажей', onclick: () => addToken(p) }, icon('plus'), ' На сцену'));
    }
    if (p.character) acts.append(el('a', { class: 'btn small', href: withTok('/sheet/' + p.character.id), target: '_blank', title: 'Лист персонажа' }, icon('sheet')));
    // Токен-аватар: мастеру — для любого токена; игроку — только для своего персонажа без
    // токена (у существующего токена сервер разрешает игроку менять лишь позицию/HP/состояния).
    if ((p.token && isGM) || (p.character && !p.token && p.character.owner_id === me.id)) {
      acts.append(el('button', { class: 'small', title: 'Выбрать токен-аватар', onclick: () => pickAvatar(p) }, icon('image')));
    }
    if (p.token && editable) {
      acts.append(el('button', { class: 'small danger', title: 'Убрать со сцены', onclick: () => removeToken(p) }, icon('trash')));
    }
    rowEl.append(acts);
    return rowEl;
  }

  // ---------- изменения ----------
  function patchToken(token, patch) {
    token.data = { ...(token.data || {}), ...patch };
    if (token.data.owner_id === undefined) delete token.data.owner_id;
    ws.send({ type: 'item_upsert', scene_id: scene.id, item: { id: token.id, layer: token.layer, z: token.z, data: token.data } });
    renderList();
  }
  async function addToken(p) {
    if (!scene) return toast('Сначала мастер должен выбрать сцену');
    const g = T.gridSize(scene.grid);
    let assetId = p.character?.sheet?.token_asset_id || p.character?.portrait_asset_id;
    if (!assetId) { if (!tokenAssets) tokenAssets = await API.get('/api/assets?kind=token').catch(() => []); assetId = (tokenAssets.find(a => a.name === 'NPC') || tokenAssets[0])?.id; }
    if (!assetId) return toast('В библиотеке нет токенов — загрузите изображение в «Библиотеке ресурсов»');
    const b = T.boardBounds(scene);
    const center = b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : { x: 0, y: 0 };
    const n = tokens.length;
    const pos = T.snapPos(center.x + (n % 4) * g, center.y + Math.floor(n / 4) * g, g, g, { grid: scene.grid, snap: true });
    const hp = p.character?.sheet?.hp;
    const data = { type: 'image', asset_id: assetId, x: pos.x, y: pos.y, w: g, h: g, name: p.name, hp: { cur: hp?.current ?? 10, max: hp?.max ?? 10 }, owner_id: p.character?.owner_id || me.id, character_id: p.character.id };
    ws.send({ type: 'item_upsert', scene_id: scene.id, item: { layer: LAYER.character, z: 1, data } });
    toast('Токен добавлен на сцену');
  }
  function removeToken(p) {
    if (!p.token) return;
    if (!confirm('Убрать «' + p.name + '» со сцены? Токен будет удалён, персонаж останется.')) return;
    ws.send({ type: 'item_delete', scene_id: scene.id, id: p.token.id });
  }
  async function pickAvatar(p) {
    if (!tokenAssets) tokenAssets = await API.get('/api/assets?kind=token').catch(() => []);
    if (!tokenAssets.length) return toast('В библиотеке нет токенов');
    let chosen = null;
    const grid = el('div', { class: 'asset-grid' });
    for (const a of tokenAssets) {
      const b = el('button', { class: 'asset', title: a.name, onclick: () => { chosen = a.id; grid.querySelectorAll('.asset').forEach(x => x.classList.remove('active')); b.classList.add('active'); } }, el('span', {}, a.name));
      assetURL(a.id).then(u => b.prepend(el('img', { src: u, alt: '' }))).catch(() => { });
      grid.append(b);
    }
    const ok = await modal('Токен-аватар: ' + p.name, el('div', { style: 'max-height:50vh;overflow:auto' }, grid), [{ label: 'Выбрать', cls: 'primary', fn: () => chosen }]);
    if (!ok) return;
    if (p.kind === 'character') {
      try {
        const full = await API.get('/api/characters/' + p.character.id);
        full.sheet.token_asset_id = ok;
        const saved = await API.patch('/api/characters/' + p.character.id, { sheet: full.sheet });
        p.character.sheet = saved.sheet;
      } catch (e) { toast('Не удалось сохранить аватар: ' + e.message, 4000); }
    }
    if (p.token) patchToken(p.token, { asset_id: ok }); else renderList();
  }

  // ---------- старт ----------
  await loadScene(sceneId);
  characters = await API.get('/api/characters?campaign_id=' + cid).catch(() => []);
  renderSceneBar();
  renderList();
  connect();
})();
