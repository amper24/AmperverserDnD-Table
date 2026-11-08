// ---------------------------------------------------------------------------
// packs.js — мастерская наборов: создание и наполнение homebrew-наборов,
// соавторы, доступ по ссылке, публикация в каталог, клонирование,
// импорт/экспорт.
// Даёт: window.Packs.
// Зависимости: common.js; лениво: Modules, Compendium.
// Загружается только в index.html (слой 5).
// ---------------------------------------------------------------------------
// Мастерская наборов: создание и наполнение homebrew-наборов (папки, записи всех категорий),
// соавторы, доступ по ссылке, публикация в каталог, клонирование, импорт/экспорт.
window.Packs = (function () {
  const M = () => window.Modules;
  const C = () => window.Compendium;
  const CAT_ICON = { spell: 'star', monster: 'skull', npc: 'user', lore: 'book', race: 'user', subrace: 'user', class: 'shield', subclass: 'shield', background: 'book', feat: 'scroll', condition: 'zap', item: 'box' };
  const state = { scope: 'mine', packId: null, folder: '', category: '', q: '' };
  let sideRequest = 0;
  let openRequest = 0;

  function download(name, obj) { const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }); const a = el('a', { href: URL.createObjectURL(blob), download: name.replace(/[^\wа-яё\- ]/gi, '') + '.json' }); a.click(); }
  function shareURL(code) { return location.origin + '/packs/join/' + code; }
  // Копирование ссылки — общий помощник (static/common.js, window.copyText).
  const copyText = window.copyText;
  function fmtDate(s) { if (!s) return ''; const d = new Date(s.replace(' ', 'T')); return isNaN(d) ? s : d.toLocaleDateString('ru-RU'); }

  const STANDARD_LICENSES = [
    ['', 'Не выбрана'],
    ['CC BY 4.0', 'CC BY 4.0 — указание авторства'],
    ['CC BY-SA 4.0', 'CC BY-SA 4.0 — авторство и ShareAlike'],
    ['CC0 1.0', 'CC0 1.0 — отказ от прав (где применимо)'],
    ['CC BY-NC 4.0', 'CC BY-NC 4.0 — атрибуция, только некоммерческое использование'],
    ['MIT', 'MIT — для кода; обычно не подходит для текста правил'],
    ['Apache-2.0', 'Apache-2.0 — для кода; не лицензия на чужие тексты'],
    ['BSD 3-Clause', 'BSD 3-Clause — для кода; не лицензия на чужие тексты'],
    ['GPL-3.0-or-later', 'GPL-3.0-or-later — для кода; не лицензия на чужие тексты'],
    ['OGL 1.0a', 'OGL 1.0a — только для контента, опубликованного под OGL'],
    ['ORC', 'ORC — только для контента под лицензией ORC'],
    ['All rights reserved', 'All rights reserved — без открытой публикации'],
    ['__custom', 'Другая лицензия…'],
  ];
  const privateOnlyLicense = value => /all rights reserved|все права защищены/i.test(String(value || ''));
  function licenseControl(value = '') {
    const selected = STANDARD_LICENSES.some(([key]) => key && key !== '__custom' && key === value) ? value : (value ? '__custom' : '');
    const select = el('select', {}, ...STANDARD_LICENSES.map(([key, label]) => el('option', { value: key, selected: selected === key ? '' : null }, label)));
    const custom = el('input', { class: selected === '__custom' ? '' : 'hidden', value: selected === '__custom' ? value : '', placeholder: 'Напишите название или URL лицензии' });
    select.addEventListener('change', () => custom.classList.toggle('hidden', select.value !== '__custom'));
    return { element: el('div', {}, select, custom), value: () => select.value === '__custom' ? custom.value.trim() : select.value };
  }

  // ---------- страница ----------
  function page() {
    const root = el('div', { class: 'packs' });
    const side = el('div', { class: 'packs-side' });
    const main = el('div', { class: 'packs-main' });
    root.append(side, main);
    const fromHash = location.hash.match(/^#pack=(\w+)/);
    if (fromHash) { state.packId = fromHash[1]; }
    renderSide(); if (state.packId) openPack(state.packId); else renderIntro();

    async function renderSide() {
      const request = ++sideRequest;
      side.innerHTML = '';
      const tabs = el('div', { class: 'tabs', style: 'margin-bottom:8px' }, ...[['mine', 'Мои'], ['subscribed', 'Подписки'], ['public', 'Каталог']].map(([k, v]) => el('button', { class: state.scope === k ? 'active' : '', onclick: () => { state.scope = k; renderSide(); if (k === 'public') renderCatalog(); } }, v)));
      const list = el('div', { class: 'list' });
      const fileInp = el('input', { type: 'file', accept: 'application/json', class: 'hidden' });
      fileInp.addEventListener('change', async () => { const f = fileInp.files[0]; if (!f) return; try { const j = JSON.parse(await f.text()); const p = await API.post('/api/packs/import', { name: j.name || f.name.replace(/\.json$/, ''), description: j.description || '', entries: j.entries || [], folders: j.folders || [], tags: j.tags || '', edition: j.edition || '', locale: j.locale || '', i18n: j.i18n || {}, license: j.license || '', source_url: j.source_url || '', attribution: j.attribution || '' }); toast(`Импортирован «${p.name}»: ${p.entries} записей`); await renderSide(); openPack(p.id); } catch (e) { toast('Ошибка импорта: ' + e.message, 4000); } fileInp.value = ''; });
      side.append(tabs, el('div', { class: 'row', style: 'margin-bottom:8px;gap:4px' }, el('button', { class: 'primary small', onclick: createPack }, '+ Набор'), el('button', { class: 'small', onclick: () => fileInp.click() }, 'Импорт'), fileInp, el('span', { class: 'grow' }), Lang.select()), list);
      if (state.scope === 'public') { list.append(el('p', { class: 'muted small' }, 'Каталог открыт справа.')); return; }
      let packs;
      try { packs = await API.get('/api/packs?scope=' + state.scope + '&sort=updated'); }
      catch (e) { if (request === sideRequest) list.append(el('div', { class: 'muted small' }, 'Не удалось загрузить список: ' + e.message, el('button', { class: 'small', onclick: renderSide }, 'Повторить'))); return; }
      if (request !== sideRequest) return;
      if (!packs.length) list.append(el('p', { class: 'muted small' }, state.scope === 'mine' ? 'Создайте первый набор — свои предметы, заклинания, NPC, расы, монстры и правила в одном месте.' : 'Подписок пока нет. Откройте ссылку набора от друга или найдите набор в каталоге.'));
      for (const p of packs) {
        list.append(el('div', { class: 'item' + (p.id === state.packId ? ' active' : ''), onclick: () => openPack(p.id) }, el('span', { class: 'lst-ico' }, icon('box', 18)),
          el('div', { class: 'grow' }, el('div', {}, Lang.packName(p), p.is_public ? el('span', { class: 'badge', style: 'margin-left:6px' }, 'в каталоге') : null, p.editor && !p.mine ? el('span', { class: 'badge', style: 'margin-left:6px' }, 'соавтор') : null),
            el('div', { class: 'muted small' }, `${p.entries} зап. · ${p.mine ? 'мой' : p.owner_name}${p.subscribers ? ' · ' + p.subscribers + ' подп.' : ''}`))));
      }
    }

    function renderIntro() {
      openRequest++;
      main.innerHTML = '';
      main.append(el('div', { class: 'card', style: 'max-width:720px' }, el('h1', {}, 'Мастерская наборов'),
        el('p', {}, 'Набор — ваша коллекция контента для игры: предметы, заклинания, NPC, монстры, расы, классы, черты, состояния и лор. Внутри набора можно завести свои папки (например «Оружие гильдии», «Жители Тавернтона», «Домашние правила»).'),
        el('ul', {}, el('li', {}, 'Записи из набора видны вам в справочнике и на листах персонажей; их можно перетаскивать в инвентарь и на стол.'),
          el('li', {}, 'Мастер подключает набор к кампании — и он становится виден всем игрокам за столом.'),
          el('li', {}, 'Поделитесь ссылкой — получатель подпишется на набор и сможет использовать его в своих кампаниях. Соавторы могут добавлять и править записи.'),
          el('li', {}, 'Опубликуйте набор в каталог — другие мастера смогут подписаться или скопировать его к себе и доработать.')),
        el('div', { class: 'row', style: 'gap:8px;margin-top:12px' }, el('button', { class: 'primary', onclick: createPack }, 'Создать набор'), el('button', { onclick: () => { state.scope = 'public'; renderSide(); renderCatalog(); } }, 'Открыть каталог'))));
    }

    async function createPack() {
      const name = el('input', { placeholder: 'Например: Хроники Тавернтона' }), desc = el('textarea', { style: 'min-height:70px', placeholder: 'Что внутри, для какой кампании или сеттинга' }), tags = el('input', { placeholder: 'Например: фэнтези, север, магические предметы' });
      const license = licenseControl();
      const ed = el('select', {}, el('option', { value: '' }, 'Любая редакция'), el('option', { value: '2014' }, 'D&D 5e 2014'), el('option', { value: '2024' }, 'D&D 5e 2024'));
      setTimeout(() => name.focus(), 50);
      const ok = await modal('Новый набор', el('div', {}, el('div', { class: 'field' }, el('label', {}, 'Название'), name), el('div', { class: 'field' }, el('label', {}, 'Описание'), desc), el('div', { class: 'field' }, el('label', {}, 'Теги через запятую'), tags), el('div', { class: 'field' }, el('label', {}, 'Редакция правил'), ed), el('div', { class: 'field' }, el('label', {}, 'Лицензия'), license.element), el('p', { class: 'muted small' }, 'Лицензию и атрибуцию можно уточнить в настройках набора перед публикацией.')), [{ label: 'Создать', cls: 'primary', fn: () => name.value.trim() || false }]);
      if (!ok) return;
      const p = await API.post('/api/packs', { name: ok, description: desc.value, tags: tags.value, edition: ed.value, license: license.value() });
      state.scope = 'mine'; await renderSide(); openPack(p.id);
    }

    // ---------- рабочее пространство набора ----------
    async function openPack(pid) {
      const request = ++openRequest;
      state.packId = pid; state.folder = ''; state.category = ''; state.q = '';
      history.replaceState(null, '', '/packs#pack=' + pid);
      main.innerHTML = '';
      let p;
      try { p = await API.get('/api/packs/' + pid); } catch (e) { if (request === openRequest) main.append(el('p', { class: 'muted' }, 'Набор недоступен: ' + e.message)); return; }
      if (request !== openRequest) return;
      const canEdit = p.mine || p.editor || window.ME?.is_root;
      side.querySelectorAll('.item').forEach(x => x.classList.remove('active'));
      const head = el('div', { class: 'pack-head' });
      const cover = el('div', { class: 'pack-cover' });
      if (p.cover_asset_id) assetURL(p.cover_asset_id).then(u => cover.append(el('img', { src: u }))).catch(() => cover.append(icon('box', 28))); else cover.append(icon('box', 28));
      const badges = el('div', { class: 'row', style: 'gap:4px;flex-wrap:wrap;margin:4px 0' }, p.is_public ? el('span', { class: 'badge gm' }, 'в каталоге') : el('span', { class: 'badge' }, 'приватный'), p.edition ? el('span', { class: 'badge' }, p.edition) : null, p.license ? el('span', { class: 'badge' }, p.license) : null, ...(p.tags || '').split(',').map(t => t.trim()).filter(Boolean).map(t => el('span', { class: 'badge' }, t)),
        el('span', { class: 'muted small' }, `${p.entries} записей · ${p.subscribers} подписчиков · v${p.version} · обновлён ${fmtDate(p.updated_at || p.created_at)}`));
      const actions = el('div', { class: 'row', style: 'gap:4px;flex-wrap:wrap' });
      if (canEdit) actions.append(el('button', { class: 'primary small', onclick: () => newEntry() }, '+ Запись'));
      if (p.mine) actions.append(el('button', { class: 'small', onclick: () => settings(p) }, 'Настройки'), el('button', { class: 'small', onclick: () => sharing(p) }, 'Доступ и публикация'));
      if (!p.mine) actions.append(p.subscribed ? el('button', { class: 'small', onclick: async () => { await API.del(`/api/packs/${pid}/subscribe`); toast('Подписка отменена'); renderSide(); openPack(pid); } }, 'Отписаться') : el('button', { class: 'small primary', onclick: async () => { await API.post(`/api/packs/${pid}/subscribe`, {}); toast('Набор добавлен в подписки'); state.scope = 'subscribed'; renderSide(); openPack(pid); } }, 'Подписаться'));
      if (!privateOnlyLicense(p.license) || p.mine) actions.append(el('button', { class: 'small', onclick: async () => { const c = await API.post(`/api/packs/${pid}/clone`, {}); toast('Копия создана'); state.scope = 'mine'; await renderSide(); openPack(c.id); } }, 'Клонировать к себе'),
        el('button', { class: 'small', onclick: async () => download(p.name, await API.get(`/api/packs/${pid}/export`)) }, 'Экспорт JSON'));
      else actions.append(el('span', { class: 'muted small' }, 'Клонирование и экспорт запрещены условиями лицензии.'));
      if (canEdit) { const fi = el('input', { type: 'file', accept: 'application/json', class: 'hidden' }); fi.addEventListener('change', async () => { const f = fi.files[0]; if (!f) return; try { const j = JSON.parse(await f.text()); const r = await API.post('/api/packs/import', { into: pid, entries: j.entries || [], folders: j.folders || [] }); toast(`Добавлено записей: ${r.added}`); openPack(pid); } catch (e) { toast('Ошибка: ' + e.message, 4000); } }); actions.append(el('button', { class: 'small', onclick: () => fi.click() }, 'Импорт в набор'), fi); }
      if (p.mine) actions.append(el('button', { class: 'small danger', onclick: async () => { if (confirm(`Удалить набор «${p.name}» со всеми записями? Подписчики потеряют доступ.`)) { await API.del('/api/packs/' + pid); state.packId = null; history.replaceState(null, '', '/packs'); renderSide(); renderIntro(); } } }, 'Удалить'));
      head.append(cover, el('div', { class: 'grow' }, el('h1', { style: 'margin:0' }, Lang.packName(p)), el('div', { class: 'muted small' }, 'Автор: ' + (p.owner_name || '—')), badges, Lang.packDesc(p) ? el('p', { style: 'margin:6px 0' }, Lang.packDesc(p)) : null,
        p.source_url && /^https?:\/\//i.test(p.source_url) ? el('a', { class: 'small', href: p.source_url, target: '_blank', rel: 'noopener noreferrer' }, 'Источник / текст лицензии') : null,
        p.attribution ? el('details', { class: 'pack-attribution' }, el('summary', {}, 'Атрибуция и условия использования'), el('p', { class: 'muted small', style: 'white-space:pre-wrap' }, p.attribution)) : null,
        actions));
      main.append(head);

      // папки + категории | список | карточка
      const work = el('div', { class: 'pack-work' });
      const folders = el('div', { class: 'pack-folders' });
      const listWrap = el('div', { class: 'pack-list' });
      const q = el('input', { placeholder: 'Поиск в наборе…' });
      const lst = el('div', { class: 'list lst', style: 'flex:1;overflow:auto;margin-top:6px' });
      listWrap.append(q, lst);
      const det = el('div', { class: 'det pack-det' }, el('p', { class: 'muted' }, canEdit ? 'Выберите запись или создайте новую. Записи можно перетаскивать на лист персонажа и на стол.' : 'Выберите запись.'));
      work.append(folders, listWrap, det);
      main.append(work);
      let timer; q.addEventListener('input', () => { clearTimeout(timer); state.q = q.value; timer = setTimeout(loadList, 250); });

      function renderFolders() {
        folders.innerHTML = '';
        const item = (label, active, onclick, count, extra) => el('div', { class: 'pack-folder' + (active ? ' active' : ''), onclick }, el('span', { class: 'grow' }, label), count != null ? el('span', { class: 'muted small' }, count) : null, extra || null);
        folders.append(item('Все записи', !state.folder && !state.category, () => { state.folder = ''; state.category = ''; renderFolders(); loadList(); }, p.entries));
        folders.append(el('div', { class: 'pack-folder-h' }, el('span', { class: 'grow' }, 'Папки'), canEdit ? el('button', { class: 'small ghost', title: 'Новая папка', onclick: async () => { const n = await prompt2('Название папки', 'Например: Жители Тавернтона'); if (!n) return; const r = await API.post(`/api/packs/${pid}/folders`, { folders: [...(p.folders || []), n] }); p.folders = r.folders; renderFolders(); } }, '+') : null));
        if (!(p.folders || []).length) folders.append(el('div', { class: 'muted small', style: 'padding:2px 8px' }, canEdit ? 'Папки — свои рубрики внутри набора.' : 'Нет папок'));
        for (const f of p.folders || []) folders.append(item(f, state.folder === f, () => { state.folder = f; state.category = ''; renderFolders(); loadList(); }, null, canEdit ? el('span', { class: 'folder-menu' }, el('button', { class: 'small ghost', title: 'Переименовать', onclick: async ev => { ev.stopPropagation(); const n = await prompt2('Новое название папки', '', f); if (!n || n === f) return; const items = await API.get(`/api/compendium?pack_id=${pid}&folder=${encodeURIComponent(f)}&limit=3000`); for (const e of items) { e.data.folder = n; await API.patch('/api/compendium/' + e.id, { category: e.category, name: e.name, data: e.data, pack_id: pid }); } const r = await API.post(`/api/packs/${pid}/folders`, { folders: (p.folders || []).map(x => x === f ? n : x) }); p.folders = r.folders; if (state.folder === f) state.folder = n; renderFolders(); loadList(); } }, icon('edit', 12)),
          el('button', { class: 'small ghost', title: 'Удалить папку (записи останутся)', onclick: async ev => { ev.stopPropagation(); if (!confirm(`Удалить папку «${f}»? Записи останутся в наборе.`)) return; const r = await API.post(`/api/packs/${pid}/folders`, { folders: (p.folders || []).filter(x => x !== f) }); p.folders = r.folders; if (state.folder === f) state.folder = ''; renderFolders(); loadList(); } }, icon('close', 12))) : null));
        folders.append(el('div', { class: 'pack-folder-h' }, 'Категории'));
        for (const [k, v] of Object.entries(CAT_NAMES)) { const n = p.by_category?.[k] || 0; if (!n && !canEdit) continue; folders.append(item(v, state.category === k && !state.folder, () => { state.category = k; state.folder = ''; renderFolders(); loadList(); }, n)); }
      }

      let listRequest = 0;
      async function loadList() {
        const request = ++listRequest;
        const params = new URLSearchParams({ pack_id: pid, limit: '3000' });
        if (state.category) params.set('category', state.category); if (state.folder) params.set('folder', state.folder); if (state.q) params.set('q', state.q);
        lst.innerHTML = '';
        lst.append(el('p', { class: 'muted small', style: 'padding:8px' }, 'Ищем записи…'));
        let items;
        try { items = await API.get('/api/compendium?' + params); }
        catch (e) { if (request === listRequest) lst.replaceChildren(el('div', { class: 'muted small', style: 'padding:8px' }, 'Не удалось загрузить записи: ' + e.message)); return; }
        if (request !== listRequest) return;
        lst.innerHTML = '';
        if (!items.length) lst.append(el('p', { class: 'muted small', style: 'padding:8px' }, canEdit ? 'Пусто. Нажмите «+ Запись».' : 'Пусто'));
        let lastCat = null;
        for (const e of items) {
          if (!state.category && e.category !== lastCat) { lastCat = e.category; lst.append(el('div', { class: 'muted small', style: 'padding:6px 4px 2px;text-transform:uppercase;letter-spacing:.5px' }, CAT_NAMES[e.category] || e.category)); }
          e.pack_name = Lang.packName(p); e._mine = canEdit;
          const ico = e.data?.asset_id ? M().docIcon(e.data, 'box', 16) : e.category === 'item' ? M().itemIcon({ type: e.data?.type, icon: e.data?.icon }) : icon(CAT_ICON[e.category] || 'box', 16);
          const it = el('div', { class: 'item', draggable: 'true' }, el('span', { class: 'lst-ico' }, ico), el('span', { class: 'grow' }, e.name, e.data?.role ? el('span', { class: 'muted small' }, ' · ' + e.data.role) : null), e.data?.folder && !state.folder ? el('span', { class: 'badge', title: 'Папка' }, e.data.folder) : null);
          it.addEventListener('click', () => { lst.querySelectorAll('.item').forEach(x => x.classList.remove('active')); it.classList.add('active'); showEntry(e); });
          it.addEventListener('dragstart', ev => { ev.dataTransfer.setData('application/x-compendium', JSON.stringify(e)); if (e.category === 'item') ev.dataTransfer.setData('application/x-item', JSON.stringify({ item: M().itemFromCompendium(e) })); if (e.category === 'spell') ev.dataTransfer.setData('application/x-spell', JSON.stringify({ spell: M().spellFromCompendium(e) })); if (e.category === 'skill') ev.dataTransfer.setData('application/x-skill', JSON.stringify({ entry: e, key: e.data?.key || '', name: e.name })); ev.dataTransfer.setData('text/plain', e.name); ev.dataTransfer.effectAllowed = 'copy'; });
          lst.append(it);
        }
      }

      function showEntry(e) {
        det.innerHTML = '';
        det.append(C().renderData(e, { packMine: canEdit, onChanged: refresh }));
        if (canEdit && (p.folders || []).length) {
          const sel = el('select', { onchange: async () => { const raw = await API.rawEntry(e); const rd = { ...(raw.data || {}) }; if (sel.value) rd.folder = sel.value; else delete rd.folder; await API.patch('/api/compendium/' + e.id, { category: raw.category, name: raw.name, data: rd, pack_id: pid }); toast('Перемещено'); refresh(); } }, el('option', { value: '' }, '— без папки'), ...p.folders.map(f => el('option', { value: f, selected: e.data?.folder === f ? '' : null }, f)));
          det.append(el('div', { class: 'row', style: 'margin-top:8px;gap:6px;align-items:center' }, el('span', { class: 'muted small' }, 'Папка:'), sel));
        }
      }
      async function refresh() { try { p = await API.get('/api/packs/' + pid); } catch { } renderFolders(); loadList(); renderSide(); }
      function newEntry() {
        C().editEntry(null, { packId: pid, category: state.category || 'item', folders: p.folders || [], folder: state.folder || undefined, onSaved: refresh });
      }
      renderFolders(); loadList();
    }

    // ---------- настройки набора ----------
    async function settings(p) {
      const d = { name: p.name, description: p.description || '', tags: p.tags || '', edition: p.edition || '', cover_asset_id: p.cover_asset_id || null, locale: p.locale || 'ru', i18n: JSON.parse(JSON.stringify(p.i18n || {})), license: p.license || '', source_url: p.source_url || '', attribution: p.attribution || '' };
      const license = licenseControl(d.license);
      const f = (l, n) => el('div', { class: 'field' }, el('label', {}, l), n);
      // перевод названия и описания набора на второй язык (необязательно)
      const other = () => d.locale === 'en' ? 'ru' : 'en';
      const tr = () => (d.i18n[other()] = d.i18n[other()] || {});
      const trBox = el('div', {});
      const drawTr = () => { const l = other(); trBox.replaceChildren(el('p', { class: 'muted small' }, `Перевод набора на ${Lang.LANGS[l]} — необязательно. Показывается, когда выбран этот язык; если пусто, берётся основной текст.`),
        f(`Название (${l.toUpperCase()})`, el('input', { value: d.i18n[l]?.name || '', oninput: e => { tr().name = e.target.value; } })),
        f(`Описание (${l.toUpperCase()})`, el('textarea', { style: 'min-height:60px', oninput: e => { tr().description = e.target.value; } }, d.i18n[l]?.description || ''))); };
      const localeSel = el('select', { onchange: e => { d.locale = e.target.value; drawTr(); } }, ...Object.entries(Lang.LANGS).map(([k, v]) => el('option', { value: k, selected: d.locale === k ? '' : null }, v)));
      drawTr();
      const form = el('div', {},  f('Название', el('input', { value: d.name, oninput: e => d.name = e.target.value })), f('Описание', el('textarea', { style: 'min-height:80px', oninput: e => d.description = e.target.value }, d.description)),
        el('div', { class: 'row' }, f('Теги (через запятую)', el('input', { value: d.tags, placeholder: 'сеттинг, предметы, NPC', oninput: e => d.tags = e.target.value })), f('Редакция', el('select', { onchange: e => d.edition = e.target.value }, ...[['', 'Любая'], ['2014', '2014'], ['2024', '2024']].map(([k, v]) => el('option', { value: k, selected: d.edition === k ? '' : null }, v))))),
        f('Язык записей набора', localeSel), trBox,
        f('Лицензия', license.element),
        f('Источник / текст лицензии (URL)', el('input', { type: 'url', value: d.source_url, placeholder: 'https://…', oninput: e => d.source_url = e.target.value })),
        f('Атрибуция (автор, источник, требуемая формулировка)', el('textarea', { style: 'min-height:90px', placeholder: 'Кого и как указать; отметка изменений; обязательный текст лицензии', oninput: e => d.attribution = e.target.value }, d.attribution)),
        el('p', { class: 'muted small' }, 'Публикуйте только материалы, на которые у вас есть права. Для CC BY и OGL укажите точную атрибуцию и обязательные notices. MIT/Apache/BSD/GPL обычно лицензируют код, а не тексты правил. «All rights reserved» разрешает приватное использование, но не публикацию в каталоге. Заполнение полей не заменяет юридическую проверку.'),
        M().imagePicker(d, 'cover_asset_id', { kind: AssetKinds.forUsage('cover'), label: 'Обложка набора' }));
      const ok = await modal('Настройки набора', form, [{ label: 'Сохранить', cls: 'primary', fn: () => d.name.trim() || false }], { wide: true });
      if (!ok) return;
      d.license = license.value();
      const nextIsPublic = p.is_public && !privateOnlyLicense(d.license);
      try {
        await API.patch('/api/packs/' + p.id, { ...d, is_public: nextIsPublic });
        toast(p.is_public && !nextIsPublic ? 'Сохранено; набор снят с открытой публикации из-за лицензии' : 'Сохранено');
        renderSide(); openPack(p.id);
      } catch (e) { toast('Ошибка: ' + e.message, 4000); }
    }

    // ---------- доступ: ссылка, соавторы, публикация ----------
    async function sharing(p) {
      const box = el('div');
      const draw = async () => {
        box.innerHTML = '';
        // ссылка
        const linkBox = el('div', { class: 'field' }, el('label', {}, 'Ссылка для друзей'));
        if (p.share_code) { const inp = el('input', { value: shareURL(p.share_code), readonly: '' }); linkBox.append(el('div', { class: 'row', style: 'gap:4px' }, inp, el('button', { class: 'small', onclick: () => copyText(inp.value) }, 'Копировать'), el('button', { class: 'small', title: 'Старая ссылка перестанет работать', onclick: async () => { const r = await API.post(`/api/packs/${p.id}/share`, {}); p.share_code = r.share_code; draw(); } }, 'Сменить'), el('button', { class: 'small danger', onclick: async () => { await API.del(`/api/packs/${p.id}/share`); p.share_code = null; draw(); } }, 'Отозвать')), el('p', { class: 'muted small' }, 'Кто откроет ссылку — подпишется на набор: увидит его в справочнике и сможет подключить к своей кампании. Редактировать он не сможет.')); }
        else linkBox.append(el('div', {}, el('button', { class: 'small', onclick: async () => { const r = await API.post(`/api/packs/${p.id}/share`, {}); p.share_code = r.share_code; draw(); } }, 'Создать ссылку')), el('p', { class: 'muted small' }, 'Ссылка даёт доступ на чтение любому, у кого она есть.'));
        box.append(linkBox);
        // соавторы
        const eds = await API.get(`/api/packs/${p.id}/editors`);
        const edBox = el('div', { class: 'field' }, el('label', {}, 'Соавторы (могут добавлять и править записи)'));
        eds.forEach(u => edBox.append(el('div', { class: 'row', style: 'margin:2px 0' }, el('span', { class: 'grow' }, u.name, ' ', el('span', { class: 'muted small' }, u.email)), el('button', { class: 'small danger', onclick: async () => { await API.del(`/api/packs/${p.id}/editors/${u.id}`); draw(); } }, 'Убрать'))));
        const em = el('input', { placeholder: 'email зарегистрированного пользователя', type: 'email' });
        edBox.append(el('div', { class: 'row', style: 'gap:4px;margin-top:4px' }, em, el('button', { class: 'small', onclick: async () => { if (!em.value.trim()) return; try { await API.post(`/api/packs/${p.id}/editors`, { email: em.value.trim() }); em.value = ''; draw(); } catch (e) { toast(e.message, 3000); } } }, 'Добавить')));
        box.append(edBox);
        // публикация
        const pubBox = el('div', { class: 'field' }, el('label', {}, 'Каталог'));
        if (p.is_public) pubBox.append(el('p', { class: 'small' }, `Набор опубликован ${fmtDate(p.published_at)}: любой пользователь может найти его в каталоге, подписаться или клонировать.`),
          el('button', { class: 'small', onclick: async () => { await API.patch('/api/packs/' + p.id, { name: p.name, description: p.description, tags: p.tags, edition: p.edition, cover_asset_id: p.cover_asset_id, locale: p.locale || 'ru', i18n: p.i18n || {}, license: p.license || '', source_url: p.source_url || '', attribution: p.attribution || '', is_public: false }); p.is_public = false; toast('Снято с публикации'); draw(); } }, 'Снять с публикации'));
        else {
          const allRightsReserved = privateOnlyLicense(p.license);
          if (allRightsReserved) pubBox.append(el('p', { class: 'muted small' }, 'Наборы с лицензией «Все права защищены» нельзя публиковать в открытом каталоге. Оставьте набор приватным или выберите лицензию, разрешающую распространение.'));
          else {
          const needsAttribution = p.license && !/cc0/i.test(p.license) && !String(p.attribution || '').trim();
          pubBox.append(el('p', { class: 'muted small' }, 'Публикация открывает набор всем пользователям каталога: они смогут подписаться, читать и клонировать его. Укажите лицензию и атрибуцию, проверьте права на все записи.'),
            (!p.license || needsAttribution) ? el('div', { class: 'row', style: 'justify-content:flex-start;gap:8px' }, el('span', { class: 'muted small' }, !p.license ? 'Лицензия не указана.' : 'Нужна атрибуция.'),
              el('button', { class: 'small', onclick: async () => { await settings(p); try { Object.assign(p, await API.get('/api/packs/' + p.id)); } catch { } draw(); } }, 'Заполнить в настройках')) : null);
          const confirmRights = el('input', { type: 'checkbox' });
          pubBox.append(el('label', { class: 'row', style: 'justify-content:flex-start;gap:8px;margin:8px 0' }, confirmRights, 'Подтверждаю, что имею право публиковать материалы и указал требуемую атрибуцию.'),
            el('button', { class: 'small primary', onclick: async () => {
              if (!p.license || needsAttribution) { toast('Сначала заполните лицензию и атрибуцию в настройках набора', 4000); return; }
              if (!confirmRights.checked) { toast('Подтвердите право на публикацию', 3000); return; }
              try { const updated = await API.patch('/api/packs/' + p.id, { name: p.name, description: p.description, tags: p.tags, edition: p.edition, cover_asset_id: p.cover_asset_id, locale: p.locale || 'ru', i18n: p.i18n || {}, license: p.license, source_url: p.source_url || '', attribution: p.attribution, is_public: true }); Object.assign(p, updated); toast('Опубликовано'); draw(); }
              catch (e) { toast(e.message, 4000); }
            } }, 'Опубликовать в каталоге'));
          }
        }
        box.append(pubBox);
      };
      await draw();
      await modal('Доступ и публикация', box, [], { wide: true });
      renderSide(); openPack(p.id);
    }

    // ---------- каталог ----------
    async function renderCatalog() {
      openRequest++;
      state.packId = null; history.replaceState(null, '', '/packs');
      main.innerHTML = '';
      const q = el('input', { placeholder: 'Поиск по названию, описанию, тегам или лицензии…', 'aria-label': 'Поиск наборов', style: 'min-width:220px;flex:2' });
      const tagSel = el('select', { 'aria-label': 'Фильтр по тегу' }, el('option', { value: '' }, 'Все теги'));
      const editionSel = el('select', { 'aria-label': 'Фильтр по редакции' }, ...[['', 'Все редакции'], ['2014', 'D&D 5e · 2014'], ['2024', 'D&D 5e · 2024']].map(([v, n]) => el('option', { value: v }, n)));
      const sort = el('select', { 'aria-label': 'Сортировка наборов' }, el('option', { value: 'popular' }, 'Популярные'), el('option', { value: 'updated' }, 'Недавно обновлённые'), el('option', { value: 'name' }, 'По названию'));
      const grid = el('div', { class: 'cards', style: 'margin-top:12px' });
      const pager = el('div', { class: 'pack-catalog-pager', 'aria-live': 'polite' });
      const filters = el('div', { class: 'pack-catalog-filters' }, q, tagSel, editionSel, sort);
      main.append(el('h1', {}, 'Каталог наборов'), el('p', { class: 'muted' }, 'Опубликованные наборы. Поиск по названию, описанию, тегам и лицензии; фильтры по тегам и редакции.'), filters, grid, pager);
      const PAGE_SIZE = 24;
      let offset = 0, requestId = 0, total = 0;
      let timer, tagRequest;
      async function loadTags() {
        const version = {}; tagRequest = version;
        try {
          const packs = await API.get('/api/packs?scope=public&sort=name');
          if (tagRequest !== version) return;
          const counts = new Map();
          for (const p of packs) for (const t of String(p.tags || '').split(',').map(x => x.trim()).filter(Boolean)) counts.set(t, (counts.get(t) || 0) + 1);
          tagSel.replaceChildren(el('option', { value: '' }, 'Все теги'), ...[...counts].sort(([a], [b]) => a.localeCompare(b, 'ru')).map(([t, n]) => el('option', { value: t }, `${t} · ${n}`)));
        } catch { /* tag filter remains optional if the catalog is unavailable */ }
      }
      async function load(reset = false) {
        if (reset) offset = 0;
        const request = ++requestId;
        const params = new URLSearchParams({ scope: 'public', sort: sort.value, limit: String(PAGE_SIZE), offset: String(offset), with_total: 'true' });
        if (q.value.trim()) params.set('q', q.value.trim());
        if (tagSel.value) params.set('tag', tagSel.value);
        if (editionSel.value) params.set('edition', editionSel.value);
        grid.innerHTML = '';
        pager.innerHTML = '';
        grid.append(el('p', { class: 'muted' }, 'Загружаем каталог…'));
        try {
          const response = await API.get('/api/packs?' + params);
          if (request !== requestId) return;
          const visible = Array.isArray(response) ? response : (response.items || []);
          total = Number(response.total ?? visible.length);
          grid.innerHTML = '';
          if (!visible.length) grid.append(el('p', { class: 'muted' }, 'Наборов под эти фильтры не найдено. Измените запрос или фильтры.'));
          for (const p of visible) {
            const cover = el('div', { class: 'pack-cover small' });
            if (p.cover_asset_id) assetURL(p.cover_asset_id).then(u => cover.append(el('img', { src: u }))).catch(() => cover.append(icon('box', 22))); else cover.append(icon('box', 22));
            grid.append(el('div', { class: 'card pack-card' }, el('div', { class: 'row', style: 'align-items:flex-start;gap:10px' }, cover, el('div', { class: 'grow' }, el('b', {}, Lang.packName(p)), el('div', { class: 'muted small' }, `${p.owner_name} · ${p.entries} записей · ${p.subscribers} подп.${p.edition ? ' · ' + p.edition : ''}`))),
              el('div', { class: 'row', style: 'gap:4px;flex-wrap:wrap;margin-top:6px' }, p.license ? el('span', { class: 'badge' }, p.license) : el('span', { class: 'badge', style: 'border-color:var(--danger);color:var(--danger)' }, 'лицензия не указана'), ...(p.tags || '').split(',').map(t => t.trim()).filter(Boolean).map(t => el('span', { class: 'badge' }, t))),
              el('p', { class: 'small', style: 'margin:8px 0;max-height:60px;overflow:hidden' }, Lang.packDesc(p)),
              el('div', { class: 'row', style: 'gap:4px;flex-wrap:wrap' }, el('button', { class: 'small', onclick: () => openPack(p.id) }, 'Открыть'),
                p.mine ? el('span', { class: 'badge' }, 'мой') : p.subscribed ? el('button', { class: 'small', onclick: async () => { await API.del(`/api/packs/${p.id}/subscribe`); load(); renderSide(); } }, 'Отписаться') : el('button', { class: 'small primary', onclick: async () => { await API.post(`/api/packs/${p.id}/subscribe`, {}); toast('Добавлено в подписки'); load(); renderSide(); } }, 'Подписаться'),
                !privateOnlyLicense(p.license) || p.mine ? el('button', { class: 'small', onclick: async () => { const c = await API.post(`/api/packs/${p.id}/clone`, {}); toast('Копия создана'); state.scope = 'mine'; await renderSide(); openPack(c.id); } }, 'Клонировать') : null)));
          }
          const first = total ? offset + 1 : 0;
          const last = Math.min(offset + visible.length, total);
          pager.append(el('button', { class: 'small', disabled: offset <= 0 ? '' : null, onclick: () => { offset = Math.max(0, offset - PAGE_SIZE); load(); } }, '← Назад'),
            el('span', { class: 'muted small', 'aria-label': 'Результаты каталога' }, total ? `${first}–${last} из ${total}` : '0 наборов'),
            el('button', { class: 'small', disabled: offset + visible.length >= total ? '' : null, onclick: () => { offset += PAGE_SIZE; load(); } }, 'Дальше →'));
        } catch (e) {
          if (request !== requestId) return;
          grid.innerHTML = '';
          grid.append(el('div', { class: 'card' }, el('p', {}, 'Не удалось загрузить каталог.'), el('p', { class: 'muted small' }, e.message), el('button', { class: 'small', onclick: () => load() }, 'Повторить')));
        }
      }
      q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load(true), 250); });
      tagSel.addEventListener('change', () => load(true)); editionSel.addEventListener('change', () => load(true)); sort.addEventListener('change', () => load(true));
      loadTags(); load(true);
    }

    return root;
  }

  // ---------- /packs/join/<code> ----------
  async function joinPage(code) {
    const root = el('div', { class: 'page' });
    let p;
    try { p = await API.get('/api/packs/join/' + code); } catch (e) { root.append(el('div', { class: 'card', style: 'max-width:520px;margin:40px auto' }, el('h2', {}, 'Ссылка недействительна'), el('p', { class: 'muted' }, e.message), el('a', { href: '/packs', class: 'btn' }, 'К наборам'))); return root; }
    const cats = Object.entries(p.by_category || {}).map(([k, n]) => `${CAT_NAMES[k] || k}: ${n}`).join(', ');
    const card = el('div', { class: 'card', style: 'max-width:560px;margin:40px auto' }, el('div', { class: 'muted small' }, 'Вас приглашают в набор'), el('h1', { style: 'margin:4px 0' }, Lang.packName(p)), el('div', { class: 'muted small' }, `Автор: ${p.owner_name} · ${p.entries} записей${p.edition ? ' · ' + p.edition : ''}`),
      Lang.packDesc(p) ? el('p', {}, Lang.packDesc(p)) : null,
      p.license ? el('p', { class: 'small' }, 'Лицензия: ', p.license) : null,
      p.source_url && /^https?:\/\//i.test(p.source_url) ? el('p', { class: 'small' }, el('a', { href: p.source_url, target: '_blank', rel: 'noopener noreferrer' }, 'Источник / лицензия')) : null,
      p.attribution ? el('details', {}, el('summary', {}, 'Атрибуция'), el('p', { class: 'muted small', style: 'white-space:pre-wrap' }, p.attribution)) : null,
      cats ? el('p', { class: 'small' }, cats) : null,
      el('div', { class: 'row', style: 'gap:8px;margin-top:12px' },  p.mine ? el('a', { href: '/packs#pack=' + p.id, class: 'btn primary' }, 'Это ваш набор — открыть') : el('button', { class: 'primary', onclick: async () => { const r = await API.post('/api/packs/join/' + code, {}); toast(`Набор «${r.name}» добавлен`); location.href = '/packs#pack=' + r.id; } }, p.subscribed ? 'Открыть (вы уже подписаны)' : 'Добавить набор'), el('a', { href: '/packs', class: 'btn' }, 'Отмена')),
      el('p', { class: 'muted small', style: 'margin-top:10px' }, 'После добавления записи набора появятся в вашем справочнике, а мастер сможет подключить его к кампании.'));
    root.append(card);
    return root;
  }

  return { page, joinPage };
})();
