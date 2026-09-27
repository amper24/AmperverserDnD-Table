// Точка входа: маршрутизация, авторизация, лобби, страница кампании.
(async function () {
  const app = document.getElementById('app');
  const APP_NAME = 'Edge Tablet';
  let me = null;
  try { me = await API.get('/api/auth/me'); } catch { me = null; }

  const path = location.pathname.replace(/\/+$/, '') || '/';
  const joinMatch = path.match(/^\/join\/([\w-]+)/);
  const campMatch = path.match(/^\/c\/(\w+)/);
  const SECTION_CARDS = [
    ['/campaigns', 'Кампании', 'Создать кампанию, пригласить игроков по ссылке, открыть стол.'],
    ['/characters', 'Персонажи', 'Листы персонажей: характеристики, инвентарь, заклинания, умения.'],
    ['/compendium', 'Справочник', 'Расы, классы, заклинания, предметы, бестиарий — SRD на русском.'],
    ['/library', 'Библиотека ресурсов', 'Ваши карты, токены, портреты и объекты для стола.'],
    ['/packs', 'Наборы', 'Свои коллекции правил и предметов. Импорт, экспорт, подключение к кампаниям.'],
  ];
  const SECTIONS = { '/campaigns': 'camps', '/characters': 'chars', '/compendium': 'comp', '/library': 'library', '/packs': 'packs' };

  if (path === '/login' || path === '/register') { renderAuth(path === '/register' ? 'register' : 'login'); return; }
  if (joinMatch) { if (!me) { location.replace('/login?next=' + encodeURIComponent(path)); return; } renderJoin(joinMatch[1]); return; }
  if (campMatch) { if (!me) { location.replace('/login?next=' + encodeURIComponent(path)); return; } renderCampaign(campMatch[1]); return; }
  if (SECTIONS[path]) { if (!me) { location.replace('/login?next=' + encodeURIComponent(path)); return; } renderSection(SECTIONS[path]); return; }
  if (!me) renderLanding(); else renderHome();

  // ================= Общее: шапка =================
  function brand() { return el('a', { href: '/', class: 'brand' }, APP_NAME); }
  function topbar(active) {
    const nav = el('nav', { class: 'mainnav' }, ...Object.entries({ camps: ['Кампании', '/campaigns'], chars: ['Персонажи', '/characters'], comp: ['Справочник', '/compendium'], library: ['Библиотека', '/library'], packs: ['Наборы', '/packs'] })
      .map(([k, [t, href]]) => el('a', { href, class: active === k ? 'active' : '' }, t)));
    return el('div', { class: 'topbar' }, brand(), nav, el('span', { class: 'spacer' }), Theme.button(),
      me ? el('span', { class: 'userbox' }, el('button', { class: 'link', title: 'Изменить имя', onclick: async () => { const n = await prompt2('Ваше имя', '', me.name); if (n) { await API.patch('/api/auth/me', { name: n }); location.reload(); } } }, me.name),
        el('button', { class: 'small', onclick: async () => { await API.post('/api/auth/logout'); location.href = '/'; } }, 'Выйти'))
        : el('span', {}, el('a', { href: '/login', class: 'btn small' }, 'Войти'), ' ', el('a', { href: '/register', class: 'btn small primary' }, 'Регистрация')));
  }

  // ================= Страница входа / регистрации (отдельная) =================
  function renderAuth(startMode) {
    app.innerHTML = '';
    document.title = (startMode === 'register' ? 'Регистрация' : 'Вход') + ' — ' + APP_NAME;
    const next = new URLSearchParams(location.search).get('next') || '/';
    if (me) { location.replace(next); return; }
    let mode = startMode, pendingEmail = '';
    const box = el('div', { class: 'card auth' });
    const err = el('div', { class: 'auth-err' });
    const f = (label, input) => el('div', { class: 'field' }, el('label', {}, label), input);
    const inp = (attrs) => el('input', { ...attrs, onkeydown: e => { if (e.key === 'Enter') box.querySelector('button.primary')?.click(); } });
    function show(m) { mode = m; err.textContent = ''; box.innerHTML = ''; box.append(...views[m]()); history.replaceState(null, '', (m === 'register' ? '/register' : '/login') + location.search); setTimeout(() => box.querySelector('input')?.focus(), 30); }
    const busy = async (btn, fn) => { btn.disabled = true; err.textContent = ''; try { await fn(); } catch (e) { err.textContent = e.message; } finally { btn.disabled = false; } };
    const tabs = () => el('div', { class: 'tabs auth-tabs' }, el('button', { class: mode === 'login' ? 'active' : '', onclick: () => show('login') }, 'Вход'), el('button', { class: mode === 'register' ? 'active' : '', onclick: () => show('register') }, 'Регистрация'));
    const google = () => el('button', { class: 'google', disabled: '', title: 'Появится позже' }, el('span', { class: 'g' }, 'G'), 'Войти через Google', el('span', { class: 'badge' }, 'скоро'));
    const codeHint = (r) => r.sent ? `Код отправлен на ${pendingEmail}. Проверьте почту и папку «Спам».` : 'Почтовый сервер не настроен — код показан ниже (режим разработки).';
    const toVerify = (r) => { show('verify'); box.querySelector('.code-info').textContent = codeHint(r); if (r.dev_code) box.querySelector('input.code').value = r.dev_code; };
    const views = {
      login() {
        const email = inp({ type: 'email', placeholder: 'you@example.com', autocomplete: 'email' }), pw = inp({ type: 'password', placeholder: 'Пароль', autocomplete: 'current-password' });
        const btn = el('button', { class: 'primary wide', onclick: () => busy(btn, async () => {
          pendingEmail = email.value.trim();
          const r = await API.post('/api/auth/login', { email: pendingEmail, password: pw.value });
          if (r.need_verify) return toVerify(r);
          location.href = next;
        }) }, 'Войти');
        return [tabs(), f('Почта', email), f('Пароль', pw), btn, err, el('div', { class: 'auth-links' }, el('a', { href: '#', onclick: e => { e.preventDefault(); pendingEmail = email.value.trim(); show('reset'); } }, 'Забыли пароль?')), el('div', { class: 'or' }, 'или'), google()];
      },
      register() {
        const name = inp({ placeholder: 'Имя', autocomplete: 'nickname', maxlength: 64 }), email = inp({ type: 'email', placeholder: 'you@example.com', autocomplete: 'email' }), pw = inp({ type: 'password', placeholder: 'минимум 8 символов', autocomplete: 'new-password' }), pw2 = inp({ type: 'password', placeholder: 'ещё раз', autocomplete: 'new-password' });
        const btn = el('button', { class: 'primary wide', onclick: () => busy(btn, async () => {
          if (pw.value.length < 8) throw new Error('Пароль должен быть не короче 8 символов');
          if (pw.value !== pw2.value) throw new Error('Пароли не совпадают');
          pendingEmail = email.value.trim();
          toVerify(await API.post('/api/auth/register', { email: pendingEmail, password: pw.value, name: name.value.trim() || null }));
        }) }, 'Создать аккаунт');
        return [tabs(), f('Имя', name), f('Почта', email), f('Пароль', pw), f('Повторите пароль', pw2), btn, err, el('p', { class: 'muted small' }, 'На почту придёт 6-значный код подтверждения.'), el('div', { class: 'or' }, 'или'), google()];
      },
      verify() {
        const code = inp({ class: 'code', placeholder: '000000', inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code' });
        const btn = el('button', { class: 'primary wide', onclick: () => busy(btn, async () => { await API.post('/api/auth/verify', { email: pendingEmail, code: code.value.trim() }); location.href = next; }) }, 'Подтвердить и войти');
        const resend = el('button', { class: 'wide', onclick: () => busy(resend, async () => { const r = await API.post('/api/auth/request-code', { email: pendingEmail }); box.querySelector('.code-info').textContent = codeHint(r); if (r.dev_code) code.value = r.dev_code; }) }, 'Отправить код ещё раз');
        return [el('h2', {}, 'Подтвердите почту'), el('p', { class: 'muted small code-info' }), f('Код из письма', code), btn, err, resend, el('div', { class: 'auth-links' }, el('a', { href: '#', onclick: e => { e.preventDefault(); show('login'); } }, 'Назад ко входу'))];
      },
      reset() {
        const email = inp({ type: 'email', placeholder: 'you@example.com', value: pendingEmail, autocomplete: 'email' }), code = inp({ class: 'code', placeholder: '000000', inputmode: 'numeric', maxlength: 6 }), pw = inp({ type: 'password', placeholder: 'новый пароль (8+ символов)', autocomplete: 'new-password' });
        const step2 = el('div', { class: 'hidden' }, el('p', { class: 'muted small code-info' }), f('Код из письма', code), f('Новый пароль', pw));
        const btn = el('button', { class: 'primary wide', onclick: () => busy(btn, async () => {
          pendingEmail = email.value.trim();
          if (step2.classList.contains('hidden')) { const r = await API.post('/api/auth/request-code', { email: pendingEmail }); step2.classList.remove('hidden'); step2.querySelector('.code-info').textContent = codeHint(r); if (r.dev_code) code.value = r.dev_code; btn.textContent = 'Сменить пароль и войти'; code.focus(); return; }
          await API.post('/api/auth/reset-password', { email: pendingEmail, code: code.value.trim(), password: pw.value }); location.href = next;
        }) }, 'Прислать код');
        return [el('h2', {}, 'Восстановление пароля'), el('p', { class: 'muted small' }, 'Пришлём код на почту — по нему зададите новый пароль. Так же можно задать пароль старому аккаунту, у которого его не было.'), f('Почта', email), step2, btn, err, el('div', { class: 'auth-links' }, el('a', { href: '#', onclick: e => { e.preventDefault(); show('login'); } }, 'Назад ко входу'))];
      },
    };
    show(mode);
    app.append(el('div', { class: 'authpage' }, el('div', { class: 'authwrap' }, el('div', { class: 'row', style: 'width:100%' }, brand(), el('span', { class: 'spacer' }), Theme.button()), next !== '/' ? el('p', { class: 'muted small' }, 'Войдите, чтобы продолжить') : null, box, el('p', { class: 'muted small', style: 'text-align:center' }, el('a', { href: '/' }, 'На главную')))));
  }

  // ================= Главная: лендинг (гость) =================
  function sectionCards() { return el('div', { class: 'sections' }, ...SECTION_CARDS.map(([href, t, d]) => el('a', { href: me ? href : '/login?next=' + encodeURIComponent(href), class: 'card section-card' }, el('b', {}, t), el('p', {}, d), el('span', { class: 'go' }, icon('arrow'))))); }
  function renderLanding() {
    app.innerHTML = ''; document.title = APP_NAME + ' — виртуальный стол для D&D';
    app.append(el('div', { class: 'home' }, topbar(),
      el('section', { class: 'hero' }, el('div', { class: 'hero-text' },
        el('h1', {}, APP_NAME), el('p', { class: 'lead' }, 'Виртуальный стол для D&D: карты, токены, туман войны, кубики в чате, листы персонажей с перетаскиваемыми предметами и заклинаниями, справочник на русском и свои наборы правил.'),
        el('div', { class: 'hero-cta' }, el('a', { href: '/register', class: 'btn primary big' }, 'Создать аккаунт'), el('a', { href: '/login', class: 'btn big' }, 'Войти')))),
      el('section', { class: 'wrap' }, el('h2', {}, 'Разделы'), sectionCards()),
      el('section', { class: 'wrap' }, el('h2', {}, 'Как начать'), el('ol', { class: 'steps' },
        el('li', {}, el('b', {}, 'Зарегистрируйтесь'), ' — почта, пароль и код подтверждения из письма.'), el('li', {}, el('b', {}, 'Создайте кампанию'), ' и отправьте игрокам ссылку-приглашение.'),
        el('li', {}, el('b', {}, 'Загрузите карту'), ' перетаскиванием, добавьте токены и персонажей.'), el('li', {}, el('b', {}, 'Играйте'), ' — кубики, туман, инициатива, листы и предметы синхронизируются мгновенно.'))),
      el('footer', { class: 'home-foot' }, APP_NAME, ' · самостоятельный хостинг: ', el('code', {}, 'cargo run --release'), ' · Docker · Pterodactyl')));
  }
  // ================= Главная: панель пользователя =================
  async function renderHome() {
    app.innerHTML = ''; document.title = APP_NAME;
    const page = el('div', { class: 'page' });
    app.append(topbar(), page);
    page.append(el('h1', {}, 'Добро пожаловать, ' + me.name), sectionCards());
    const [camps, chars] = await Promise.all([API.get('/api/campaigns').catch(() => []), API.get('/api/characters').catch(() => [])]);
    const two = el('div', { class: 'two' });
    const cl = el('div', { class: 'card' }, el('div', { class: 'row' }, el('h2', { style: 'flex:1;margin:0' }, 'Кампании'), el('a', { href: '/campaigns', class: 'btn small' }, 'Все')));
    if (!camps.length) cl.append(el('p', { class: 'muted' }, 'Пока нет кампаний.'));
    camps.slice(0, 5).forEach(c => cl.append(el('a', { href: '/c/' + c.id, class: 'item' }, el('span', { class: 'grow' }, c.name), el('span', { class: 'badge ' + c.role }, c.role === 'gm' ? 'мастер' : 'игрок'))));
    const ch = el('div', { class: 'card' }, el('div', { class: 'row' }, el('h2', { style: 'flex:1;margin:0' }, 'Персонажи'), el('a', { href: '/characters', class: 'btn small' }, 'Все')));
    if (!chars.length) ch.append(el('p', { class: 'muted' }, 'Пока нет персонажей.'));
    chars.slice(0, 5).forEach(c => ch.append(el('a', { href: '/sheet/' + c.id, target: '_blank', class: 'item' }, el('span', { class: 'grow' }, c.name), el('span', { class: 'muted small' }, [c.sheet?.race, c.sheet?.class, c.sheet?.level && c.sheet.level + ' ур.'].filter(Boolean).join(' · ')))));
    two.append(cl, ch); page.append(two);
  }

  // ================= Присоединение =================
  async function renderJoin(codeStr) {
    app.innerHTML = '';
    try {
      const info = await API.get('/api/join/' + codeStr);
      app.append(el('div', { class: 'center' }, el('div', { class: 'card auth' }, el('h2', {}, 'Приглашение'), el('p', {}, 'Кампания ', el('b', {}, info.campaign_name), ' · роль: ', info.role === 'gm' ? 'мастер' : 'игрок'),
        el('button', { class: 'primary wide', onclick: async () => { await API.post('/api/join/' + codeStr); location.href = '/c/' + info.campaign_id; } }, 'Присоединиться'), el('p', {}, el('a', { href: '/' }, 'На главную')))));
    } catch (e) { app.append(el('div', { class: 'center' }, el('div', { class: 'card auth' }, el('h2', {}, 'Ошибка'), el('p', {}, e.message), el('a', { href: '/' }, 'На главную')))); }
  }

  // ================= Разделы =================
  async function renderSection(k) {
    app.innerHTML = '';
    const page = el('div', { class: 'page' });
    app.append(topbar(k), page);
    const views = { camps: lobbyCampaigns, chars: lobbyCharacters, comp: () => el('div', { class: 'fill' }, Compendium.widget({})), library: lobbyLibrary, packs: () => el('div', {}, el('h1', {}, 'Наборы'), Compendium.packsPanel()) };
    const titles = { camps: 'Кампании', chars: 'Персонажи', comp: 'Справочник', library: 'Библиотека ресурсов', packs: 'Наборы' };
    document.title = titles[k] + ' — ' + APP_NAME;
    const r = await views[k]();
    page.append(r);
  }
  async function lobbyCampaigns() {
    const wrap = el('div');
    const list = await API.get('/api/campaigns');
    wrap.append(el('div', { class: 'row', style: 'margin-bottom:14px' }, el('h1', { style: 'flex:1' }, 'Кампании'),
      el('button', { class: 'primary', style: 'flex:0;white-space:nowrap', onclick: async () => { const n = await prompt2('Название кампании', 'Затерянные рудники'); if (n) { const c = await API.post('/api/campaigns', { name: n }); location.href = '/c/' + c.id; } } }, 'Новая кампания'),
      el('button', { style: 'flex:0;white-space:nowrap', onclick: async () => { const c = await prompt2('Код или ссылка приглашения'); if (c) location.href = '/join/' + c.split('/').pop(); } }, 'Присоединиться по ссылке')));
    const g = el('div', { class: 'grid' });
    if (!list.length) g.append(el('p', { class: 'muted' }, 'Пока нет кампаний. Создайте свою или присоединитесь по ссылке-приглашению.'));
    for (const c of list) g.append(el('div', { class: 'card camp-card', onclick: () => location.href = '/c/' + c.id }, el('div', { class: 'row' }, el('h2', { style: 'flex:1;margin:0' }, c.name), el('span', { class: 'badge ' + c.role }, c.role === 'gm' ? 'мастер' : 'игрок')), el('p', { class: 'muted' }, c.description || 'Без описания'), el('div', { class: 'muted small' }, `${c.members_count || c.members?.length || ''} участников`.replace(/^ /, ''))));
    wrap.append(g);
    return wrap;
  }
  async function lobbyCharacters() {
    const wrap = el('div');
    const list = await API.get('/api/characters');
    wrap.append(el('div', { class: 'row', style: 'margin-bottom:14px' }, el('h1', { style: 'flex:1' }, 'Персонажи'),
      el('button', { class: 'primary', style: 'flex:0;white-space:nowrap', onclick: async () => { const n = await prompt2('Имя персонажа', 'Торин'); if (n) { const c = await API.post('/api/characters', { name: n }); window.open('/sheet/' + c.id, '_blank'); location.reload(); } } }, 'Новый персонаж')));
    const g = el('div', { class: 'grid' });
    if (!list.length) g.append(el('p', { class: 'muted' }, 'Персонажей пока нет.'));
    for (const c of list) g.append(charCard(c, () => location.reload()));
    wrap.append(g);
    return wrap;
  }
  function charCard(c, onChange) {
    const s = c.sheet || {};
    const img = el('div', { class: 'portrait', style: 'width:56px;height:56px;flex:0 0 56px' }, icon('user', 28));
    if (c.portrait_asset_id) assetURL(c.portrait_asset_id).then(u => { img.innerHTML = ''; img.append(el('img', { src: u })); });
    return el('div', { class: 'card camp-card', onclick: () => window.open('/sheet/' + c.id, '_blank') }, el('div', { class: 'row' }, img, el('div', { style: 'flex:1' }, el('b', {}, c.name), el('div', { class: 'muted' }, [s.race, s.class, s.level && s.level + ' ур.'].filter(Boolean).join(' · ') || 'Новый персонаж'), el('div', { class: 'muted small' }, c.campaign_name ? 'Кампания: ' + c.campaign_name : 'Вне кампании')),
      el('button', { class: 'small danger', style: 'flex:0', onclick: async e => { e.stopPropagation(); if (confirm('Удалить персонажа?')) { await API.del('/api/characters/' + c.id); onChange(); } } }, icon('trash'))));
  }
  // Библиотека ресурсов: все изображения пользователя (карты, токены, портреты, объекты) + встроенные
  async function lobbyLibrary() {
    const wrap = el('div');
    const kindSel = el('select', {}, ...[['', 'Все типы'], ['map', 'Карты'], ['token', 'Токены'], ['prop', 'Объекты'], ['portrait', 'Портреты']].map(([k, v]) => el('option', { value: k }, v)));
    const upKind = el('select', {}, ...[['token', 'Токен'], ['map', 'Карта'], ['prop', 'Объект'], ['portrait', 'Портрет']].map(([k, v]) => el('option', { value: k }, v)));
    const file = el('input', { type: 'file', accept: 'image/*', multiple: '', class: 'hidden' });
    const showBuiltin = el('input', { type: 'checkbox', style: 'width:auto' });
    const grid = el('div', { class: 'asset-grid' });
    wrap.append(el('div', { class: 'row', style: 'margin-bottom:14px;flex-wrap:wrap' }, el('h1', { style: 'flex:1' }, 'Библиотека ресурсов'), kindSel, el('label', { class: 'muted small', style: 'flex:0;white-space:nowrap' }, showBuiltin, ' встроенные'), upKind, el('button', { class: 'primary', style: 'flex:0;white-space:nowrap', onclick: () => file.click() }, 'Загрузить'), file),
      el('p', { class: 'muted small' }, 'Изображения сжимаются в WebP и хранятся в базе. Ресурсы доступны во всех ваших кампаниях — перетаскивайте их на стол из панели «Ассеты».'), grid);
    async function refresh() {
      const list = await API.get('/api/assets' + (kindSel.value ? '?kind=' + kindSel.value : ''));
      grid.innerHTML = '';
      const shown = list.filter(a => showBuiltin.checked || !a.builtin);
      if (!shown.length) grid.append(el('p', { class: 'muted' }, 'Пусто. Загрузите изображения.'));
      for (const a of shown) {
        const im = el('div', { class: 'thumb' });
        assetURL(a.id).then(u => im.append(el('img', { src: u })));
        grid.append(el('div', { class: 'asset' }, im, el('div', { class: 'row' }, el('span', { class: 'grow ellipsis', title: a.name }, a.name), a.builtin ? el('span', { class: 'badge' }, 'встроенный') : el('button', { class: 'small danger', onclick: async () => { if (confirm('Удалить?')) { await API.del('/api/assets/' + a.id); refresh(); } } }, icon('trash'))),
          el('div', { class: 'muted small' }, `${{ map: 'карта', token: 'токен', prop: 'объект', portrait: 'портрет' }[a.kind] || a.kind} · ${a.width}×${a.height}`)));
      }
    }
    file.addEventListener('change', async () => { for (const f of file.files) { const fd = new FormData(); fd.append('file', f); fd.append('name', f.name.replace(/\.[^.]+$/, '')); fd.append('kind', upKind.value); toast('Загрузка ' + f.name + '…'); await API.upload('/api/assets', fd); } file.value = ''; refresh(); });
    kindSel.addEventListener('change', refresh); showBuiltin.addEventListener('change', refresh);
    refresh();
    return wrap;
  }

  // ================= Кампания / стол =================
  async function renderCampaign(cid) {
    let camp;
    try { camp = await API.get('/api/campaigns/' + cid); } catch (e) { app.innerHTML = ''; app.append(el('div', { class: 'center' }, el('div', { class: 'card auth' }, el('h2', {}, 'Нет доступа'), el('p', {}, e.message), el('a', { href: '/' }, 'В лобби')))); return; }
    const isGM = camp.role === 'gm';
    window.TABLE_CTX = { isGM, campaign: camp, user: me, roll: (expr, label, gm_only) => ws.send({ type: 'roll', expr, label, gm_only }), ws: { send: (m) => ws.send(m) } };
    document.title = camp.name + ' — ' + APP_NAME;
    app.innerHTML = '';
    const root = el('div', { id: 'table' });
    app.append(root);

    // ---- верхняя панель ----
    const sceneSel = el('select', { style: 'width:auto;max-width:220px' });
    const presence = el('div', { class: 'presence' });
    const layerSel = el('select', { style: 'width:auto', title: 'Активный слой (для клика и загрузки файлов)', onchange: e => Table.setActiveLayer(e.target.value) }, ...['character', 'prop', 'map'].filter(l => isGM || l === 'character').map(l => el('option', { value: l }, Table.LAYER_NAMES[l])));
    const toggleSide = el('button', { class: 'small', onclick: () => root.classList.toggle('no-side') }, icon('menu'));
    const bar = el('div', { class: 'tbar' }, el('a', { href: '/', title: 'На главную', class: 'brand small' }, APP_NAME), el('b', {}, camp.name), el('span', { class: 'badge ' + camp.role }, isGM ? 'Мастер' : 'Игрок'), el('span', { class: 'sep' }));
    if (isGM) bar.append(el('span', { class: 'muted' }, 'Сцена:'), sceneSel, el('button', { class: 'small', title: 'Показать игрокам', onclick: () => API.post(`/api/campaigns/${cid}/active-scene`, { scene_id: sceneSel.value }).then(() => toast('Сцена показана игрокам')) }, 'Показать игрокам'), el('span', { class: 'sep' }));
    bar.append(el('span', { class: 'muted' }, 'Слой:'), layerSel, el('span', { class: 'spacer' }), presence, el('span', { class: 'sep' }), Theme.button(), toggleSide);
    root.append(bar);

    const canvasWrap = el('div', { id: 'canvasWrap' });
    const side = el('div', { id: 'side' });
    root.append(canvasWrap, side);

    // ---- WebSocket ----
    const ws = { sock: null, q: [], send(m) { if (this.sock?.readyState === 1) this.sock.send(JSON.stringify(m)); } };
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const s = new WebSocket(`${proto}://${location.host}/ws/${cid}` + (localStorage.getItem('dnd_token') ? `?token=${localStorage.getItem('dnd_token')}` : ''));
      ws.sock = s;
      s.onmessage = e => { const m = JSON.parse(e.data); handleWs(m); };
      s.onclose = () => setTimeout(connect, 1500);
    }

    // ---- сцены ----
    let scenes = await API.get(`/api/campaigns/${cid}/scenes`);
    let currentSceneId = camp.active_scene_id || scenes[0]?.id;
    async function loadScene(sid) {
      if (!sid) { canvasWrap.innerHTML = '<div class="center muted">Мастер ещё не выбрал сцену</div>'; return; }
      currentSceneId = sid;
      const sc = await API.get(`/api/campaigns/${cid}/scenes/${sid}`);
      if (!Table.state()) Table.init({ campaign: camp, user: me, isGM, scene: sc, ws, container: canvasWrap, onOpenSheet: openSheet, onAssetsChanged: () => panels.assets.refresh?.(), onSelect: () => {} });
      else Table.setScene(sc);
      if (isGM) sceneSel.value = sid;
      panels.scenes.refresh?.();
    }
    function refreshSceneSel() { sceneSel.innerHTML = ''; scenes.forEach(s => sceneSel.append(el('option', { value: s.id, selected: s.id === currentSceneId ? '' : null }, s.name + (s.id === camp.active_scene_id ? ' (активная)' : '')))); }
    sceneSel.addEventListener('change', () => loadScene(sceneSel.value));
    refreshSceneSel();

    // ---- боковые панели ----
    const tabs = el('div', { class: 'tabs' });
    const pane = el('div', { class: 'pane' });
    side.append(tabs, pane);
    const panels = {
      chat: { title: 'Чат', name: 'Чат', build: buildChat },
      chars: { title: 'Герои', name: 'Персонажи', build: buildChars },
      assets: { title: 'Ассеты', name: 'Ассеты', build: buildAssets },
      comp: { title: 'Справ.', name: 'Справочник', build: () => el('div', { style: 'height:100%' }, Compendium.widget({ campaignId: cid, isGM })) },
      init: { title: 'Иниц.', name: 'Инициатива', build: buildInitiative },
    };
    if (isGM) { panels.scenes = { title: 'Сцены', name: 'Сцены', build: buildScenes }; panels.settings = { title: icon('settings'), name: 'Настройки', build: buildSettings }; }
    const paneEls = {};
    let curPanel = 'chat';
    for (const [k, p] of Object.entries(panels)) tabs.append(el('button', { 'data-k': k, title: p.name, onclick: () => showPanel(k) }, p.title));
    function showPanel(k) { curPanel = k; tabs.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.k === k)); pane.innerHTML = ''; if (!paneEls[k]) paneEls[k] = panels[k].build(); pane.append(paneEls[k]); }
    showPanel('chat');
    if (!panels.scenes) panels.scenes = {};

    // ---- чат ----
    let chatLog, initList, initState = { order: [], turn: 0, round: 1 };
    function buildChat() {
      const w = el('div', { id: 'chat' });
      chatLog = el('div', { id: 'chatLog' });
      const inp = el('input', { placeholder: 'Сообщение или /r 2d6+3' });
      const send = () => { const t = inp.value.trim(); if (!t) return; ws.send({ type: 'chat', text: t }); inp.value = ''; };
      inp.addEventListener('keydown', e => e.key === 'Enter' && send());
      const dice = el('div', { class: 'dice' }, ...['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100', '2d20kh1', '2d20kl1'].map(d => el('button', { onclick: () => ws.send({ type: 'roll', expr: d, label: d.includes('kh') ? 'преимущество' : d.includes('kl') ? 'помеха' : null }) }, d)));
      if (isGM) dice.append(el('button', { title: 'Скрытый бросок d20 (видит только мастер)', onclick: () => ws.send({ type: 'roll', expr: 'd20', label: 'скрытый', gm_only: true }) }, 'скрытый d20'));
      w.append(chatLog, dice, el('div', { class: 'row' }, inp, el('button', { style: 'flex:0', onclick: send }, icon('send'))));
      API.get(`/api/campaigns/${cid}/chat`).then(hist => { hist.forEach(addMsg); });
      return w;
    }
    function addMsg(m) {
      if (!chatLog) return;
      const d = el('div', { class: 'msg ' + m.kind });
      const who = el('div', { class: 'who' }, m.name, ' · ', new Date(m.at).toLocaleTimeString().slice(0, 5));
      if (m.kind === 'roll') {
        const p = m.payload;
        d.append(who, el('div', { class: 'row' }, el('span', { class: 'total' }, p.total), el('span', {}, p.label ? p.label + ' ' : '', el('span', { class: 'muted' }, p.expr))),
          el('div', { class: 'detail' }, p.parts.map(x => x.rolls ? `${x.term}: [${x.rolls.map(r => x.kept && !x.kept.includes(r) ? `~${r}~` : r).join(', ')}]` : x.term).join(' ')), p.gm_only ? el('div', { class: 'detail' }, 'только мастер') : null);
      } else if (m.kind === 'card') { d.append(who, Modules.renderChatCard(m.payload, {})); }
      else if (m.kind === 'system') { d.append(el('div', { class: 'muted small' }, (m.payload.text || ''))); }
      else d.append(who, Modules.rich(m.payload.text || '', {}, {}));
      chatLog.append(d); chatLog.scrollTop = chatLog.scrollHeight;
    }

    // ---- персонажи ----
    function buildChars() {
      const w = el('div');
      const list = el('div', { class: 'list' });
      const refresh = async () => {
        const chars = await API.get('/api/characters?campaign_id=' + cid);
        const mine = isGM ? [] : await API.get('/api/characters');
        list.innerHTML = '';
        list.append(el('h3', {}, 'В кампании'));
        for (const c of chars) {
          const it = el('div', { class: 'item', draggable: 'true' }, el('span', { class: 'grow' }, c.name, ' ', el('span', { class: 'muted' }, [c.sheet.race, c.sheet.class, c.sheet.level && c.sheet.level + ' ур.'].filter(Boolean).join(' '))),
            el('button', { class: 'small', title: 'Открыть поверх стола', onclick: e => { e.stopPropagation(); openSheet(c.id); } }, icon('sheet')),
            el('button', { class: 'small', title: 'В отдельном окне', onclick: e => { e.stopPropagation(); window.open('/sheet/' + c.id, 'sheet_' + c.id, 'width=1000,height=800'); } }, icon('window')));
          it.addEventListener('dragstart', ev => { ev.dataTransfer.setData('application/x-character', JSON.stringify(c)); ev.dataTransfer.effectAllowed = 'copy'; });
          it.addEventListener('click', () => openSheet(c.id));
          // передача предмета: перетащите карточку предмета с листа (или из справочника) на персонажа
          it.addEventListener('dragover', ev => { if (Modules.hasType(ev, 'application/x-item', 'application/x-spell')) { ev.preventDefault(); it.classList.add('dragover'); } });
          it.addEventListener('dragleave', () => it.classList.remove('dragover'));
          it.addEventListener('drop', async ev => {
            it.classList.remove('dragover'); ev.preventDefault();
            const p = Modules.getDrag(ev, 'application/x-item'); const sp = Modules.getDrag(ev, 'application/x-spell');
            try {
              if (p && p.from_character_id && p.from_character_id !== c.id) { await API.post(`/api/characters/${p.from_character_id}/transfer`, { item_uid: p.item.uid, to_character_id: c.id }); toast(`${p.item.name} → ${c.name}`); }
              else if (p && !p.from_character_id) { const full = await API.get('/api/characters/' + c.id); full.sheet.inventory = [...(full.sheet.inventory || []), { ...p.item, uid: Modules.uid() }]; await API.patch('/api/characters/' + c.id, { sheet: full.sheet }); toast(`${p.item.name} → ${c.name}`); }
              else if (sp) { const full = await API.get('/api/characters/' + c.id); full.sheet.spells ||= { known: [], slots: {}, ability: 'int' }; if (!full.sheet.spells.known.some(x => x.name === sp.spell.name)) full.sheet.spells.known.push({ ...sp.spell, uid: Modules.uid() }); await API.patch('/api/characters/' + c.id, { sheet: full.sheet }); toast(`${sp.spell.name} → ${c.name}`); }
            } catch (e) { toast('Не удалось: ' + e.message, 4000); }
          });
          list.append(it);
        }
        if (!chars.length) list.append(el('p', { class: 'muted' }, 'Пока никого. Создайте персонажа или добавьте своего.'));
        const free = mine.filter(c => c.campaign_id !== cid);
        if (free.length) {
          list.append(el('h3', { style: 'margin-top:10px' }, 'Мои вне кампании'));
          for (const c of free) list.append(el('div', { class: 'item' }, el('span', { class: 'grow' }, c.name), el('button', { class: 'small', onclick: async () => { await API.patch('/api/characters/' + c.id, { campaign_id: cid }); refresh(); } }, '+ в кампанию')));
        }
      };
      w.append(el('button', { class: 'primary', style: 'width:100%;margin-bottom:8px', onclick: async () => { const n = await prompt2('Имя персонажа'); if (n) { const c = await API.post('/api/characters', { name: n, campaign_id: cid }); refresh(); openSheet(c.id); } } }, '+ Новый персонаж'),
        el('p', { class: 'muted', style: 'font-size:12px' }, 'Перетащите персонажа на стол — появится токен. Перетащите предмет с листа на персонажа — он будет передан.'), list);
      refresh(); panels.chars.refresh = refresh;
      return w;
    }
    // Лист персонажа поверх стола (iframe) с кнопкой «в отдельное окно»
    const sheetFrames = new Set();
    function openSheet(charId) {
      const iframe = el('iframe', { class: 'sheetframe', src: `/sheet/${charId}?embed=1` });
      sheetFrames.add(iframe);
      floatWindow('Лист персонажа', iframe, { popout: () => window.open('/sheet/' + charId, 'sheet_' + charId, 'width=1000,height=800'), x: 60 + Math.random() * 40, y: 60 + Math.random() * 40 });
    }

    // ---- ассеты ----
    function buildAssets() {
      const w = el('div');
      const kindSel = el('select', {}, ...[['token', 'Токены'], ['prop', 'Объекты'], ['map', 'Карты'], ['portrait', 'Портреты']].map(([k, v]) => el('option', { value: k }, v)));
      const gridEl = el('div', { class: 'asset-grid' });
      const drop = el('div', { class: 'dropzone' }, 'Перетащите изображения сюда или ', el('a', { href: '#', onclick: e => { e.preventDefault(); file.click(); } }, 'выберите файл'));
      const file = el('input', { type: 'file', accept: 'image/*', multiple: '', class: 'hidden' });
      async function uploadFiles(files) {
        for (const f of files) { const fd = new FormData(); fd.append('file', f); fd.append('name', f.name.replace(/\.[^.]+$/, '')); fd.append('kind', kindSel.value); fd.append('campaign_id', cid); const a = await API.upload('/api/assets', fd); toast(`${a.name}: ${(a.raw_size / 1024) | 0} КБ → ${(a.stored_size / 1024) | 0} КБ в базе`); }
        refresh();
      }
      file.addEventListener('change', () => uploadFiles(file.files));
      drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); }); drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); uploadFiles(e.dataTransfer.files); });
      async function refresh() {
        const list = await API.get(`/api/assets?campaign_id=${cid}&kind=${kindSel.value}`);
        gridEl.innerHTML = '';
        for (const a of list) {
          const d = el('div', { class: 'asset', draggable: 'true', title: a.name + (a.builtin ? ' (встроенный)' : '') }, el('span', {}, a.name));
          assetURL(a.id).then(u => d.prepend(el('img', { src: u })));
          d.addEventListener('dragstart', ev => { ev.dataTransfer.setData('application/x-asset', JSON.stringify(a)); ev.dataTransfer.effectAllowed = 'copy'; });
          d.addEventListener('dblclick', () => { const st = Table.state(); const c = { x: (st.w / 2 - st.cam.x) / st.cam.k, y: (st.h / 2 - st.cam.y) / st.cam.k }; const ev = new DragEvent('drop', { dataTransfer: new DataTransfer() }); ev.dataTransfer.setData('application/x-asset', JSON.stringify(a)); Object.defineProperty(ev, 'offsetX', { value: st.w / 2 }); Object.defineProperty(ev, 'offsetY', { value: st.h / 2 }); st.canvas.dispatchEvent(ev); });
          if (!a.builtin) d.append(el('span', { class: 'del', onclick: async e => { e.stopPropagation(); if (confirm('Удалить ассет?')) { await API.del('/api/assets/' + a.id); refresh(); } } }, icon('close')));
          gridEl.append(d);
        }
      }
      kindSel.addEventListener('change', refresh);
      w.append(kindSel, el('div', { style: 'height:8px' }), drop, file, el('p', { class: 'muted', style: 'font-size:12px' }, 'Перетащите на стол (или двойной клик — в центр). Картинки сжимаются и хранятся в БД в base64.'), gridEl);
      refresh(); panels.assets.refresh = refresh;
      return w;
    }

    // ---- инициатива ----
    function buildInitiative() {
      const w = el('div');
      initList = el('div');
      const render = () => {
        initList.innerHTML = '';
        initList.append(el('div', { class: 'row', style: 'margin-bottom:6px' }, el('b', {}, 'Раунд ', initState.round), isGM ? el('button', { class: 'small', style: 'flex:0', onclick: () => { initState.turn = (initState.turn + 1) % Math.max(1, initState.order.length); if (initState.turn === 0) initState.round++; sync(); } }, 'Следующий ход') : null, isGM ? el('button', { class: 'small', style: 'flex:0', onclick: () => { initState = { order: [], turn: 0, round: 1 }; sync(); } }, icon('close')) : null));
        initState.order.forEach((o, i) => {
          const r = el('div', { class: 'init-row' + (i === initState.turn ? ' current' : '') },
            isGM ? el('input', { type: 'number', value: o.init, onchange: e => { o.init = +e.target.value; initState.order.sort((a, b) => b.init - a.init); sync(); } }) : el('b', { style: 'text-align:center' }, o.init),
            el('span', {}, o.name), el('span', { class: 'muted' }, o.hp ? `${o.hp.cur}/${o.hp.max}` : ''),
            isGM ? el('button', { class: 'small', onclick: () => { initState.order.splice(i, 1); sync(); } }, icon('close')) : null);
          initList.append(r);
        });
      };
      const sync = () => { render(); if (isGM) ws.send({ type: 'initiative', state: initState }); };
      if (isGM) w.append(el('div', { class: 'row', style: 'margin-bottom:8px' },
        el('button', { class: 'small', onclick: () => { const sc = Table.getScene(); initState.order = sc.items.filter(i => i.layer === 'character' && !i.data.hidden).map(i => ({ id: i.id, name: i.data.name || '?', init: rollDice('d20').total + (i.data.monster ? mod(i.data.monster.abilities?.dex || 10) : 0), hp: i.data.hp })).sort((a, b) => b.init - a.init); initState.turn = 0; initState.round = 1; sync(); } }, 'Собрать со стола'),
        el('button', { class: 'small', onclick: async () => { const n = await prompt2('Имя'); if (!n) return; const v = +await prompt2('Инициатива', '', '10'); initState.order.push({ name: n, init: v }); initState.order.sort((a, b) => b.init - a.init); sync(); } }, '+ Вручную')));
      w.append(initList); render();
      panels.init.render = render;
      return w;
    }

    // ---- сцены (ГМ) ----
    function buildScenes() {
      const w = el('div');
      const list = el('div', { class: 'list' });
      const refresh = async () => {
        scenes = await API.get(`/api/campaigns/${cid}/scenes`); refreshSceneSel();
        list.innerHTML = '';
        for (const s of scenes) list.append(el('div', { class: 'item' + (s.id === currentSceneId ? ' active' : ''), onclick: () => loadScene(s.id) }, el('span', { class: 'grow' }, s.name, s.id === camp.active_scene_id ? ' (активная)' : ''),
          el('button', { class: 'small', title: 'Переименовать', onclick: async e => { e.stopPropagation(); const n = await prompt2('Название', '', s.name); if (n) { await API.patch(`/api/campaigns/${cid}/scenes/${s.id}`, { name: n }); refresh(); } } }, icon('edit')),
          el('button', { class: 'small', title: 'Дублировать', onclick: async e => { e.stopPropagation(); await API.post(`/api/campaigns/${cid}/scenes/${s.id}/duplicate`); refresh(); } }, icon('copy')),
          el('button', { class: 'small danger', onclick: async e => { e.stopPropagation(); if (confirm('Удалить сцену?')) { await API.del(`/api/campaigns/${cid}/scenes/${s.id}`); refresh(); } } }, icon('trash'))));
      };
      const gridBox = el('div', { class: 'card', style: 'margin-top:10px' });
      const renderGrid = () => {
        const sc = Table.getScene(); if (!sc) return; const g = sc.grid;
        gridBox.innerHTML = ''; gridBox.append(el('h3', {}, 'Сетка сцены'),
          el('div', { class: 'row' }, el('div', { class: 'field' }, el('label', {}, 'Тип сетки'), el('select', { onchange: e => { g.type = e.target.value; Table.sendScene({ grid: g }); } }, el('option', { value: 'square', selected: (g.type || 'square') === 'square' ? '' : null }, 'Квадраты'), el('option', { value: 'hex', selected: g.type === 'hex' ? '' : null }, 'Гексы'))),
            el('div', { class: 'field' }, el('label', {}, 'Размер клетки (px)'), el('input', { type: 'number', value: g.size, onchange: e => { g.size = +e.target.value; Table.sendScene({ grid: g }); } })),
            el('div', { class: 'field' }, el('label', {}, 'Масштаб клетки'), el('input', { value: g.scale || '5 фт', onchange: e => { g.scale = e.target.value; Table.state().gridScaleFt = parseInt(g.scale) || 5; Table.sendScene({ grid: g }); } }))),
          el('div', { class: 'field' }, el('label', {}, 'Цвет линий'), el('input', { type: 'color', value: (g.color || '#000000').slice(0, 7), style: 'height:32px;padding:2px', onchange: e => { g.color = e.target.value + '66'; Table.sendScene({ grid: g }); } })),
          el('label', {}, el('input', { type: 'checkbox', checked: g.visible ? '' : null, style: 'width:auto', onchange: e => { g.visible = e.target.checked; Table.sendScene({ grid: g }); } }), ' Показывать сетку'));
      };
      w.append(el('button', { class: 'primary', style: 'width:100%;margin-bottom:8px', onclick: async () => { const n = await prompt2('Название сцены'); if (n) { const s = await API.post(`/api/campaigns/${cid}/scenes`, { name: n }); await refresh(); loadScene(s.id); } } }, '+ Новая сцена'), list, gridBox);
      refresh(); panels.scenes.refresh = () => { refresh(); renderGrid(); };
      setTimeout(renderGrid, 300);
      return w;
    }

    // ---- настройки (ГМ) ----
    function buildSettings() {
      const w = el('div');
      const inv = el('div', { class: 'list' });
      const refreshInv = async () => {
        const list = await API.get(`/api/campaigns/${cid}/invites`);
        inv.innerHTML = '';
        for (const i of list) { const url = location.origin + i.url; inv.append(el('div', { class: 'item' }, el('span', { class: 'grow', title: url }, el('span', { class: 'badge ' + i.role }, i.role === 'gm' ? 'ГМ' : 'Игрок'), ' ', url), el('button', { class: 'small', onclick: () => { navigator.clipboard.writeText(url); toast('Ссылка скопирована'); } }, icon('copy')), el('button', { class: 'small danger', onclick: async () => { await API.del(`/api/campaigns/${cid}/invites/${i.code}`); refreshInv(); } }, icon('close')))); }
        if (!list.length) inv.append(el('p', { class: 'muted' }, 'Ссылок нет'));
      };
      const mem = el('div', { class: 'list' });
      const refreshMem = async () => {
        camp = await API.get('/api/campaigns/' + cid); mem.innerHTML = '';
        for (const m of camp.members) mem.append(el('div', { class: 'item' }, el('span', { class: 'grow' }, m.name, ' ', el('span', { class: 'muted' }, m.email || '')),
          el('select', { style: 'width:auto', onchange: async e => { await API.patch(`/api/campaigns/${cid}/members/${m.user_id}`, { role: e.target.value }); refreshMem(); } }, el('option', { value: 'player', selected: m.role === 'player' ? '' : null }, 'Игрок'), el('option', { value: 'gm', selected: m.role === 'gm' ? '' : null }, 'Мастер')),
          m.user_id !== camp.owner_id ? el('button', { class: 'small danger', onclick: async () => { if (confirm('Исключить?')) { await API.del(`/api/campaigns/${cid}/members/${m.user_id}`); refreshMem(); } } }, icon('close')) : null));
      };
      w.append(el('h3', {}, 'Ссылки-приглашения'), el('div', { class: 'row', style: 'margin-bottom:8px' },
        el('button', { class: 'small', onclick: async () => { await API.post(`/api/campaigns/${cid}/invites`, { role: 'player' }); refreshInv(); } }, '+ Для игроков'),
        el('button', { class: 'small', onclick: async () => { await API.post(`/api/campaigns/${cid}/invites`, { role: 'gm' }); refreshInv(); } }, '+ Для мастера')), inv,
        el('h3', { style: 'margin-top:14px' }, 'Участники'), mem,
        el('h3', { style: 'margin-top:14px' }, 'Наборы справочника'), Compendium.campaignPacksPanel(cid, isGM),
        el('h3', { style: 'margin-top:14px' }, 'Кампания'),
        el('button', { class: 'small', onclick: async () => { const n = await prompt2('Название', '', camp.name); if (n) { await API.patch('/api/campaigns/' + cid, { name: n, description: camp.description }); location.reload(); } } }, 'Переименовать'), ' ',
        el('button', { class: 'small danger', onclick: async () => { if (confirm('Удалить кампанию безвозвратно?')) { await API.del('/api/campaigns/' + cid); location.href = '/'; } } }, 'Удалить кампанию'));
      refreshInv(); refreshMem();
      return w;
    }

    // ---- обработка WS ----
    function handleWs(m) {
      switch (m.type) {
        case 'chat': addMsg(m); if (curPanel !== 'chat') tabs.querySelector('[data-k=chat]').style.color = 'var(--accent)'; break;
        case 'presence': presence.innerHTML = ''; m.users.forEach(u => presence.append(el('span', { class: u.role, title: u.name }, u.name.slice(0, 2).toUpperCase()))); break;
        case 'active_scene': camp.active_scene_id = m.scene_id; refreshSceneSel(); if (!isGM) loadScene(m.scene_id); break;
        case 'initiative': initState = m.state; panels.init.render?.(); if (curPanel !== 'init') tabs.querySelector('[data-k=init]').style.color = 'var(--accent)'; break;
        case 'character_update': panels.chars.refresh?.(); for (const f of sheetFrames) { if (!f.isConnected) { sheetFrames.delete(f); continue; } try { f.contentWindow.postMessage({ type: 'character_update', id: m.character?.id }, '*'); } catch { } } break;
        case 'packs_changed': paneEls.comp?.firstChild?.reload?.(); toast('Наборы кампании обновлены'); break;
        default: Table.onMessage(m);
      }
    }
    tabs.addEventListener('click', e => { if (e.target.dataset.k) e.target.style.color = ''; });
    // сообщения из iframe листа персонажа (броски в чат, открыть в отдельном окне)
    window.addEventListener('message', e => {
      const d = e.data; if (!d?.type) return;
      if (d.type === 'roll') ws.send({ type: 'roll', expr: d.expr, label: d.label, gm_only: !!d.gm_only });
      if (d.type === 'chat') ws.send({ type: 'chat', text: d.text });
      if (d.type === 'card') ws.send({ type: 'card', card: d.card });
      if (d.type === 'loot_drop') Table.dropLootAtCenter({ item: d.item }).then(() => toast(`${d.item.name} выложен на стол`)).catch(err => toast('Ошибка: ' + err.message));
    });

    connect();
    await loadScene(currentSceneId);
  }
})();
