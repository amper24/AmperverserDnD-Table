// ---------------------------------------------------------------------------
// lobby.js — страницы вне стола: лендинг и панель пользователя, разделы
// (кампании, персонажи, справочник, библиотека, наборы), вход по приглашению,
// профиль, администрирование, приватность и диагностика входа.
// Даёт: window.Lobby.create(ctx) → { renderLanding, renderHome, renderDiag,
//       renderPrivacy, renderProfile, renderAdmin, renderJoin, renderSection };
//       window.Lobby.inviteTarget(info) → { id, name, role } (разбор ответа /api/join/:code).
// Зависимости: common.js, asset-kinds.js, packs.js; в index.html — до app.js.
// ---------------------------------------------------------------------------
// Модуль не держит собственного состояния: точку входа static/app.js он получает
// контекстом (контейнер #app, шапка, текущий пользователь) и возвращает рендереры,
// поэтому маршрутизация и проверка входа остаются в одном месте.

// Приглашение: ответ GET /api/join/:code — { campaign: { id, name, description }, role },
// поэтому идентификатор кампании лежит во вложенном объекте. Плоские
// campaign_id/campaign_name поддержаны как совместимость со старыми сборками
// клиента. Разбор — отдельной функцией: по ней кнопка «Присоединиться» ведёт сразу
// на стол кампании (/c/:id), а не на /c/undefined с окном «Нет доступа».
function inviteTarget(info) {
  const src = info || {};
  const camp = src.campaign || {};
  return {
    id: String(camp.id || src.campaign_id || '').trim(),
    name: camp.name || src.campaign_name || 'Кампания',
    role: src.role || camp.role || 'player',
  };
}

window.Lobby = {
  inviteTarget,
  create({ app, me, topbar, avatarEl, lobbyLibrary, APP_NAME, PW_MIN, CAN_REGISTER, SECTION_CARDS }) {
    // ================= Главная: лендинг (гость) =================
    function sectionCards() { return el('div', { class: 'sections' }, ...SECTION_CARDS.map(([href, t, d]) => el('a', { href: me ? href : '/login?next=' + encodeURIComponent(href), class: 'card section-card' }, el('b', {}, t), el('p', {}, d), el('span', { class: 'go' }, icon('arrow'))))); }
    function renderLanding() {
      app.innerHTML = ''; document.title = APP_NAME + ' — виртуальный стол для D&D';
      app.append(el('div', { class: 'home' }, topbar(),
        el('section', { class: 'hero' }, el('div', { class: 'hero-text' },
          el('h1', {}, APP_NAME), el('p', { class: 'lead' }, 'Виртуальный стол для D&D: карты, токены, туман войны, кубики в чате, листы персонажей с перетаскиваемыми предметами и заклинаниями, справочник на русском и свои наборы правил.'),
          el('div', { class: 'hero-cta' }, CAN_REGISTER ? el('a', { href: '/register', class: 'btn primary big' }, 'Создать аккаунт') : null, el('a', { href: '/login', class: `btn big${CAN_REGISTER ? '' : ' primary'}` }, 'Войти')))),
        el('section', { class: 'wrap' }, el('h2', {}, 'Разделы'), sectionCards()),
        el('section', { class: 'wrap' }, el('h2', {}, 'Как начать'), el('ol', { class: 'steps' },
          el('li', {}, el('b', {}, 'Зарегистрируйтесь'), ' — почта, пароль и код подтверждения из письма.'), el('li', {}, el('b', {}, 'Создайте кампанию'), ' и отправьте игрокам ссылку-приглашение.'),
          el('li', {}, el('b', {}, 'Загрузите карту'), ' перетаскиванием, добавьте токены и персонажей.'), el('li', {}, el('b', {}, 'Играйте'), ' — кубики, туман, инициатива, листы и предметы синхронизируются мгновенно.'))),
        el('footer', { class: 'home-foot' }, APP_NAME, ' · самостоятельный хостинг: ', el('code', {}, 'cargo run --release'), ' · Docker · Pterodactyl', el('br'), el('a', { href: '/privacy' }, 'Конфиденциальность и cookie'), el('button', { class: 'link', onclick: () => Consent.settings() }, 'Настройки cookie'))));
    }
    // ================= Главная: панель пользователя =================
    // Состав: приветствие, быстрые действия, «Мои кампании» (карточки с ролью,
    // числом участников, последней сценой и переходами) и «Мои персонажи»
    // (имя, раса/класс/уровень, кампания, «Лист»). Данные — существующие API
    // (/api/campaigns, /api/characters, детали кампании и её сцены); грузятся
    // параллельно (Promise.all), пока показываются скелетоны, ошибки — с «Повторить».
    const HOME_LIMIT = 6;
    // Склонение счётчиков — общий помощник (static/common.js, window.pluralRu).
    const plural = window.pluralRu;
    const roleLabel = role => (role === 'gm' ? 'мастер' : 'игрок');
    async function renderHome() {
      app.innerHTML = ''; document.title = APP_NAME;
      const page = el('div', { class: 'page home-page' });
      app.append(topbar(), page);

      // ---------- быстрые действия ----------
      const run = fn => { fn().catch(e => toast(e.message || 'Ошибка', 4000)); };
      const newCampaign = async () => {
        const name = await prompt2('Название кампании', 'Затерянные рудники');
        if (!name) return;
        const c = await API.post('/api/campaigns', { name });
        go('/c/' + c.id);
      };
      const newCharacter = async () => {
        const draft = await newCharacterDialog();
        if (!draft) return;
        const c = await API.post('/api/characters', draft);
        window.open(withTok('/sheet/' + c.id), '_blank');
        reloadPage();
      };
      const quick = (label, ico, cls, fn) => el('button', {
        class: cls, type: 'button', onclick: () => run(fn),
      }, icon(ico, 16), ' ', label);

      page.append(el('div', { class: 'home-head' },
        el('div', { class: 'grow' }, el('h1', {}, 'Добро пожаловать, ' + me.name),
          el('p', { class: 'muted' }, 'Кампании, персонажи и быстрый старт — всё с главной страницы.')),
        el('div', { class: 'home-quick' },
          quick('Новая кампания', 'plus', 'primary', newCampaign),
          quick('Новый персонаж', 'user', '', newCharacter))));

      // ---------- секции и их состояния ----------
      const campsBox = el('div', { class: 'home-cards', 'data-sec': 'campaigns' });
      const charsBox = el('div', { class: 'home-cards', 'data-sec': 'characters' });
      page.append(
        el('section', { class: 'home-sec' },
          el('div', { class: 'home-sec-head' }, el('h2', {}, 'Мои кампании'), el('a', { class: 'btn small', href: '/campaigns' }, 'Все кампании')), campsBox),
        el('section', { class: 'home-sec' },
          el('div', { class: 'home-sec-head' }, el('h2', {}, 'Мои персонажи'), el('a', { class: 'btn small', href: '/characters' }, 'Все персонажи')), charsBox),
        el('section', { class: 'home-sec' }, el('h2', {}, 'Разделы'), sectionCards()));

      function skeletonCards(count) {
        return Array.from({ length: count }, () => el('div', { class: 'card home-card home-skeleton', 'aria-hidden': 'true' },
          el('span', { class: 'sk sk-title' }), el('span', { class: 'sk sk-line' }), el('span', { class: 'sk sk-line short' }), el('span', { class: 'sk sk-actions' })));
      }
      function busy(box, count) {
        box.setAttribute('aria-busy', 'true');
        box.replaceChildren(...skeletonCards(count));
      }
      function done(box, nodes) {
        box.removeAttribute('aria-busy');
        box.replaceChildren(...nodes);
      }
      function errorCard(message, retry) {
        return el('div', { class: 'card home-empty home-error', role: 'alert' },
          el('h3', {}, 'Не удалось загрузить'),
          el('p', { class: 'muted' }, message || 'Ошибка сети'),
          el('div', { class: 'home-empty-actions' }, el('button', { type: 'button', onclick: () => run(load) }, 'Повторить')));
      }
      function emptyCard(title, text, actions) {
        return el('div', { class: 'card home-empty' },
          el('h3', {}, title), el('p', { class: 'muted' }, text), el('div', { class: 'home-empty-actions' }, ...actions));
      }
      function campaignCard(c, info) {
        const members = info.members;
        const scene = info.scene;
        const meta = el('div', { class: 'home-card-meta' },
          el('span', { title: 'Участники кампании' }, icon('users', 14), ' ',
            members === null ? 'Участники —' : `${members} ${plural(members, 'участник', 'участника', 'участников')}`),
          el('span', { title: 'Сцена, на которой идёт игра' }, icon('map', 14), ' ', scene ? 'Сцена: ' + scene : 'Сцена не выбрана'));
        return el('article', { class: 'card home-card', 'data-campaign': c.id },
          el('div', { class: 'home-card-head' },
            el('h3', { class: 'home-card-title', title: c.name }, c.name),
            el('span', { class: 'badge ' + (c.role || 'player') }, roleLabel(c.role))),
          el('p', { class: 'muted small home-card-desc' }, c.description || 'Без описания'),
          meta,
          el('div', { class: 'home-card-actions' },
            el('a', { class: 'btn small primary', href: '/c/' + c.id, title: 'Открыть стол кампании' }, 'Открыть'),
            el('a', { class: 'btn small', href: '/c/' + c.id, target: '_blank', rel: 'noopener', title: 'Открыть стол в новой вкладке' }, icon('map', 14), ' На стол'),
            el('a', { class: 'btn small', href: '/table/' + c.id, title: 'Настройки компании: участники, права и наборы правил' }, icon('users', 14), ' Настройки компании')));
      }
      function characterCard(c, campaignsById) {
        const s = c.sheet || {};
        const camp = c.campaign_id ? (campaignsById.get(c.campaign_id) || null) : null;
        const kind = [s.race, s.class, s.subclass].filter(Boolean).join(' · ');
        const level = Number(s.level) > 0 ? s.level : null;
        return el('article', { class: 'card home-card', 'data-character': c.id },
          el('div', { class: 'home-card-head' },
            el('h3', { class: 'home-card-title', title: c.name }, c.name),
            el('span', { class: 'badge' }, level ? level + ' ур.' : 'без уровня')),
          el('p', { class: 'muted small home-card-desc' }, kind || 'Класс и раса не выбраны'),
          el('div', { class: 'home-card-meta' },
            el('span', { title: 'Кампания персонажа' }, icon('shield', 14), ' ',
              camp ? 'Кампания: ' + camp.name : (c.campaign_id ? 'Кампания недоступна' : 'Вне кампании'))),
          el('div', { class: 'home-card-actions' },
            el('a', { class: 'btn small primary', href: '/sheet/' + c.id, target: '_blank', rel: 'noopener', title: 'Открыть лист персонажа' }, icon('sheet', 14), ' Лист')));
      }

      // ---------- загрузка ----------
      async function load() {
        busy(campsBox, 3); busy(charsBox, 3);
        // Список кампаний и персонажей — параллельно; детали показываем позже, тоже пачкой.
        const [campsRes, charsRes] = await Promise.allSettled([API.get('/api/campaigns'), API.get('/api/characters')]);
        const camps = campsRes.status === 'fulfilled' && Array.isArray(campsRes.value) ? campsRes.value : null;
        const chars = charsRes.status === 'fulfilled' && Array.isArray(charsRes.value) ? charsRes.value : null;
        const shown = (camps || []).slice(0, HOME_LIMIT);
        // Участники и сцены: только для показанных карточек, запросы параллельны.
        const details = await Promise.all(shown.map(c => Promise.all([
          API.get('/api/campaigns/' + c.id).catch(() => null),
          API.get('/api/campaigns/' + c.id + '/scenes').catch(() => null),
        ])));
        const byId = new Map((camps || []).map(c => [c.id, c]));

        if (!camps) done(campsBox, [errorCard(campsRes.reason?.message, load)]);
        else if (!camps.length) done(campsBox, [emptyCard('Пока нет кампаний',
          'Создайте кампанию и отправьте игрокам ссылку-приглашение — присоединиться можно по ней.',
          [el('button', { class: 'primary', type: 'button', onclick: () => run(newCampaign) }, icon('plus', 16), ' Создать кампанию')])]);
        else {
          const cards = shown.map((c, i) => {
            const [detail, scenes] = details[i] || [];
            const list = Array.isArray(scenes) ? scenes : [];
            const activeId = c.active_scene_id || detail?.active_scene_id || null;
            const scene = (activeId && list.find(s => s.id === activeId)) || list[list.length - 1] || null;
            return campaignCard(c, { members: Array.isArray(detail?.members) ? detail.members.length : null, scene: scene?.name || '' });
          });
          if (camps.length > shown.length) cards.push(el('a', { class: 'btn small home-more', href: '/campaigns' }, `Ещё кампаний: ${camps.length - shown.length}`));
          done(campsBox, cards);
        }

        if (!chars) done(charsBox, [errorCard(charsRes.reason?.message, load)]);
        else if (!chars.length) done(charsBox, [emptyCard('Пока нет персонажей',
          'Создайте персонажа — мастер из восьми шагов проведёт по правилам; лист и портрет появятся здесь.',
          [el('button', { class: 'primary', type: 'button', onclick: () => run(newCharacter) }, icon('plus', 16), ' Создать персонажа')])]);
        else {
          const cards = chars.slice(0, HOME_LIMIT).map(c => characterCard(c, byId));
          if (chars.length > HOME_LIMIT) cards.push(el('a', { class: 'btn small home-more', href: '/characters' }, `Ещё персонажей: ${chars.length - HOME_LIMIT}`));
          done(charsBox, cards);
        }
      }
      await load();
    }

    // ================= Диагностика входа =================
    async function renderDiag() {
      app.innerHTML = ''; document.title = 'Диагностика — ' + APP_NAME;
      const page = el('div', { class: 'page legal' }); app.append(topbar(), page);
      const rows = [];
      const add = (k, v, ok) => rows.push(el('tr', {}, el('td', {}, k), el('td', { style: ok === false ? 'color:var(--danger)' : ok ? 'color:var(--ok)' : '' }, String(v))));
      let inFrame = false; try { inFrame = window.top !== window.self; } catch { inFrame = true; }
      add('Во фрейме', inFrame ? 'да' : 'нет');
      add('Origin страницы', location.origin, location.origin !== 'null');
      let ls = 'доступен'; try { localStorage.setItem('__d', '1'); localStorage.removeItem('__d'); } catch (e) { ls = 'НЕДОСТУПЕН: ' + e.name; }
      add('localStorage', ls, ls === 'доступен');
      let ck = 'доступен'; try { document.cookie = '__d=1; SameSite=Lax'; ck = document.cookie.includes('__d=1') ? 'доступен (JS-cookie записался)' : 'JS-cookie не записался'; document.cookie = '__d=; Max-Age=0'; } catch (e) { ck = 'НЕДОСТУПЕН: ' + e.name; }
      add('document.cookie', ck, ck.startsWith('доступен'));
      add('Хранилище приложения', LS.persistent ? 'постоянное' : 'только память (сессия не переживёт перезагрузку страницы)', LS.persistent);
      add('Токен dnd_token', LS.getItem('dnd_token') ? 'есть' : 'нет');
      let hasSA = 'нет API'; try { if (document.hasStorageAccess) hasSA = (await document.hasStorageAccess()) ? 'есть' : 'нет'; } catch (e) { hasSA = e.name; }
      add('Storage Access (cookie во фрейме)', hasSA);
      let meRes; try { const r = await fetch('/api/auth/me', { credentials: 'same-origin' }); meRes = r.status + (r.ok ? ' — cookie сессии работает' : ' — cookie не отправляется'); } catch (e) { meRes = 'ошибка ' + e.message; }
      add('/api/auth/me только по cookie', meRes, meRes.startsWith('200'));
      let meTok; try { const r = await fetch('/api/auth/me', { headers: LS.getItem('dnd_token') ? { Authorization: 'Bearer ' + LS.getItem('dnd_token') } : {} }); meTok = r.status + (r.ok ? ' — вход по токену работает' : ' — токена нет или он недействителен'); } catch (e) { meTok = 'ошибка ' + e.message; }
      add('/api/auth/me по токену', meTok, meTok.startsWith('200'));
      add('Браузер', navigator.userAgent);
      page.append(el('h1', {}, 'Диагностика входа'), el('p', { class: 'muted' }, 'Эта страница показывает, что именно блокирует ваш браузер в текущем окне. Скопируйте таблицу, если вход не работает.'),
        el('div', { class: 'table-scroll' }, el('table', {}, ...rows)),
        el('p', { class: 'diag-actions', style: 'margin-top:14px' }, el('a', { href: '/login', class: 'btn primary' }, 'Перейти ко входу'), ' ', el('a', { href: location.origin !== 'null' ? location.href.replace('/diag', '/') : '/', target: '_blank', class: 'btn' }, 'Открыть в новой вкладке')));
    }

    // ================= Политика конфиденциальности и cookie =================
    function renderPrivacy() {
      app.innerHTML = ''; document.title = 'Конфиденциальность и cookie — ' + APP_NAME;
      const page = el('div', { class: 'page legal' });
      app.append(topbar(), page);
      const tr = (...c) => el('tr', {}, ...c.map(x => el('td', {}, x)));
      page.append(el('h1', {}, 'Конфиденциальность и cookie'),
        el('p', { class: 'muted' }, APP_NAME + ' — самостоятельно размещаемый виртуальный стол. Все данные хранятся в базе того сервера, на котором запущено приложение; сторонним сервисам ничего не передаётся.'),
        el('h2', {}, 'Какие данные хранятся'),
        el('ul', {}, el('li', {}, 'Аккаунт: почта, имя, хэш пароля (argon2), аватар, дата регистрации, флаг администратора.'),
          el('li', {}, 'Игровые данные: кампании, сцены, персонажи, справочник и наборы, чат, загруженные изображения (сжатые, в базе).'),
          el('li', {}, 'Технические: токены сессий (30 дней), одноразовые коды подтверждения почты (15 минут).')),
        el('h2', {}, 'Cookie и хранилище браузера'),
        el('table', {}, el('tr', {}, el('th', {}, 'Имя'), el('th', {}, 'Тип'), el('th', {}, 'Назначение'), el('th', {}, 'Срок')),
          tr('dnd_session', 'cookie, обязательный', 'Сессия входа (HttpOnly, SameSite=Lax).', '30 дней'),
          tr('dnd_session_x', 'cookie, обязательный', 'Та же сессия для работы во встроенном фрейме (SameSite=None; Secure; Partitioned).', '30 дней'),
          tr('dnd_token', 'localStorage, обязательный', 'Копия токена сессии для запросов и WebSocket, когда браузер не принимает cookie во фрейме.', 'до выхода'),
          tr('et-consent', 'cookie + localStorage, обязательный', 'Ваш выбор по cookie.', '1 год'),
          tr('et-theme', 'localStorage, функциональный', 'Светлая/тёмная тема.', 'бессрочно'),
          tr('et-edition', 'localStorage, функциональный', 'Выбранная редакция правил (2014/2024) для справочника и новых персонажей.', 'бессрочно'),
          tr('et-lang', 'localStorage, функциональный', 'Выбранный язык справочника и наборов (русский/английский).', 'бессрочно'),
          tr('sheet_tab_*', 'localStorage, функциональный', 'Последняя открытая вкладка листа персонажа.', 'бессрочно'),
          tr('dicetray_min', 'localStorage, функциональный', 'Свёрнута ли панель кубиков на столе.', 'бессрочно'),
          tr('et-last-campaign', 'localStorage, функциональный', 'Последняя открытая кампания: на её стол ведёт пункт «Стол» в шапке.', 'бессрочно'),
          tr('dice-settings', 'localStorage, функциональный', 'Цвет кубиков и аудитория бросков; физика анимации работает автоматически.', 'бессрочно')),
        el('p', { class: 'muted small' }, 'Аналитических, рекламных и сторонних cookie нет. Функциональные ключи сохраняются только после вашего согласия; без него они живут до закрытия страницы.'),
        el('div', { class: 'row', style: 'margin:10px 0 20px' }, el('button', { class: 'small', onclick: () => Consent.settings() }, 'Настройки cookie')),
        el('h2', {}, 'Ваши права'),
        el('ul', {}, el('li', {}, 'Изменить имя, аватар и пароль — на странице ', el('a', { href: '/profile' }, 'профиля'), '.'),
          el('li', {}, 'Завершить сессию — кнопка «Выйти»; смена пароля завершает сессии на других устройствах.'),
          el('li', {}, 'Удалить аккаунт и все данные — обратитесь к администратору сервера (команда ', el('code', {}, 'dnd-table users delete <email>'), ').')),
        el('h2', {}, 'Почта'),
        el('p', {}, 'Адрес почты используется только для подтверждения регистрации и восстановления пароля. Рассылок нет.'),
        el('p', { class: 'muted small' }, 'Владелец конкретного сервера может дополнить эту страницу своими контактами и юридическими реквизитами (файл static/app.js, функция renderPrivacy).'));
    }

    async function renderProfile() {
      app.innerHTML = ''; document.title = 'Профиль — ' + APP_NAME;
      const page = el('div', { class: 'page narrow' });
      app.append(topbar('profile'), page);
      const msg = el('div', { class: 'auth-err' });
      const okmsg = (t) => { msg.style.color = 'var(--ok)'; msg.textContent = t; setTimeout(() => { msg.textContent = ''; msg.style.color = ''; }, 2500); };
      const fail = (e) => { msg.style.color = ''; msg.textContent = e.message; };
      // аватар
      const av = avatarEl(me, 96);
      const file = el('input', { type: 'file', accept: 'image/*', class: 'hidden' });
      file.addEventListener('change', async () => {
        const f = file.files[0]; if (!f) return;
        try {
          const fd = new FormData(); fd.append('file', f); fd.append('kind', AssetKinds.forUsage('avatar')); fd.append('name', 'Аватар ' + me.name);
          const a = await API.upload('/api/assets', fd);
          await API.patch('/api/auth/me', { avatar_asset_id: a.id });
          me.avatar_asset_id = a.id; window.ME = me; okmsg('Аватар обновлён'); reloadPage();
        } catch (e) { fail(e); }
      });
      const avBox = el('div', { class: 'card row', style: 'align-items:center;gap:16px' }, av,
        el('div', { style: 'flex:1' }, el('b', {}, 'Аватар'), el('p', { class: 'muted small', style: 'margin:4px 0 8px' }, 'Показывается в шапке, списке участников кампании и чате. Сжимается до 1024 px и хранится в базе.'),
          el('div', { class: 'row' }, el('button', { class: 'small', onclick: () => file.click() }, 'Загрузить'), me.avatar_asset_id ? el('button', { class: 'small', onclick: async () => { try { await API.patch('/api/auth/me', { avatar_asset_id: null }); reloadPage(); } catch (e) { fail(e); } } }, 'Убрать') : null), file));
      // данные
      const name = el('input', { value: me.name, maxlength: 64 });
      const dataBox = el('div', { class: 'card' }, el('h2', {}, 'Данные аккаунта'),
        el('div', { class: 'field' }, el('label', {}, 'Имя (видят другие игроки)'), name),
        el('div', { class: 'field' }, el('label', {}, 'Почта'), el('input', { value: me.email, disabled: '' })),
        el('div', { class: 'muted small', style: 'margin-bottom:10px' }, 'Аккаунт создан ' + new Date(me.created_at).toLocaleDateString(), me.is_root ? ' · права root' : ''),
        el('button', { class: 'primary', onclick: async e => { try { e.target.disabled = true; await API.patch('/api/auth/me', { name: name.value }); okmsg('Сохранено'); me.name = name.value.trim(); document.querySelector('.userlink > span:last-child').textContent = me.name; } catch (err) { fail(err); } finally { e.target.disabled = false; } } }, 'Сохранить'));
      // пароль
      const oldPw = el('input', { type: 'password', autocomplete: 'current-password' }), pw1 = el('input', { type: 'password', autocomplete: 'new-password', placeholder: `минимум ${PW_MIN} символов` }), pw2 = el('input', { type: 'password', autocomplete: 'new-password' });
      const pwBox = el('div', { class: 'card' }, el('h2', {}, 'Смена пароля'),
        el('div', { class: 'field' }, el('label', {}, 'Текущий пароль'), oldPw), el('div', { class: 'field' }, el('label', {}, 'Новый пароль'), pw1), el('div', { class: 'field' }, el('label', {}, 'Повторите новый пароль'), pw2),
        el('p', { class: 'muted small' }, 'После смены пароля все остальные устройства будут разлогинены. Если пароль забыт — «Забыли пароль?» на странице входа.'),
        el('button', { class: 'primary', onclick: async e => { try { if (pw1.value !== pw2.value) throw new Error('Пароли не совпадают'); e.target.disabled = true; await API.post('/api/auth/change-password', { old_password: oldPw.value, password: pw1.value }); oldPw.value = pw1.value = pw2.value = ''; okmsg('Пароль изменён'); } catch (err) { fail(err); } finally { e.target.disabled = false; } } }, 'Сменить пароль'));
      const sessBox = el('div', { class: 'card' }, el('h2', {}, 'Сессия'), el('div', { class: 'row' },
        el('button', { onclick: async () => { await API.post('/api/auth/logout'); go('/'); } }, 'Выйти'),
        el('span', { class: 'muted small' }, 'Вход по паролю выполняется на странице ', el('a', { href: '/login' }, '/login'), '.')));
      const cookieBox = el('div', { class: 'card' }, el('h2', {}, 'Cookie и данные'), el('p', { class: 'muted small' }, 'Обязательные cookie сессии — всегда; функциональные (тема, вкладки) — по вашему выбору. ', el('a', { href: '/privacy' }, 'Политика конфиденциальности')), el('button', { class: 'small', onclick: () => Consent.settings() }, 'Настройки cookie'));
      page.append(el('h1', {}, 'Профиль'), msg, avBox, dataBox, pwBox, cookieBox, sessBox);
    }

    // ================= Администрирование (root) =================
    async function renderAdmin() {
      app.innerHTML = ''; document.title = 'Администрирование — ' + APP_NAME;
      const page = el('div', { class: 'page' });
      app.append(topbar('admin'), page);
      if (!me.is_root) { page.append(el('h1', {}, 'Нет доступа'), el('p', { class: 'muted' }, 'Нужны права root. Выдать их можно из консоли: ', el('code', {}, 'dnd-table users make-root ' + me.email))); return; }
      const stats = await API.get('/api/admin/stats');
      const statRow = el('div', { class: 'stats' }, ...[['Пользователи', stats.users], ['Кампании', stats.campaigns], ['Персонажи', stats.characters], ['Ассеты', stats.assets + ' (встр. ' + stats.assets_builtin + ')'], ['Базовый справочник', stats.compendium_base], ['Наборы', stats.packs]]
        .map(([k, v]) => el('div', { class: 'card stat' }, el('div', { class: 'muted small' }, k), el('b', {}, v))));
      // Пересоздание справочника: из текущего источника (кэш / локальная папка / встроенный seed)…
      const reseedBtn = el('button', { style: 'flex:0;white-space:nowrap', onclick: async e => {
        if (!confirm('Удалить все базовые записи справочника и залить их заново из текущего источника? Ваши правки базовых записей будут потеряны.')) return;
        const b = e.target; b.disabled = true;
        try { const r = await API.post('/api/admin/reseed'); toast('Справочник пересоздан: ' + r.entries + ' записей'); } catch (err) { toast('Ошибка: ' + err.message, 5000); } finally { b.disabled = false; }
      } }, 'Пересоздать базовый справочник');
      // …и переподгрузка данных из Git: единственное место, где кэш обновляется в режиме sdr.update: once.
      const syncBtn = el('button', { style: 'flex:0;white-space:nowrap', onclick: async e => {
        if (!confirm('Забрать свежие данные справочника из Git (папка data_seed) и залить их заново? Правки базовых записей будут потеряны.')) return;
        const b = e.target, label = b.textContent; b.disabled = true; b.textContent = 'Загрузка…';
        try { const r = await API.post('/api/admin/sdr'); toast('Данные из Git загружены: ' + r.entries + ' записей'); } catch (err) { toast('Ошибка: ' + err.message, 5000); } finally { b.disabled = false; b.textContent = label; }
      } }, 'Обновить из Git');
      page.append(el('div', { class: 'row', style: 'margin-bottom:14px' }, el('h1', { style: 'flex:1' }, 'Администрирование'), reseedBtn, syncBtn), statRow);
      page.append(el('p', { class: 'muted small' }, 'Как root вы можете редактировать и удалять записи базового справочника и любых наборов прямо в разделе «Справочник», а в «Библиотеке ресурсов» — загружать встроенные ассеты и удалять любые. «Обновить из Git» забирает свежую папку ', el('code', {}, 'data_seed'), ' из репозитория ', el('code', {}, 'sdr.git_url'), ' и заливает справочник заново — при ', el('code', {}, 'sdr.update: once'), ' это единственный способ обновить данные без перезапуска и пересборки.'));
      // пользователи
      const tbl = el('table', { class: 'tbl' });
      const tableWrap = el('div', { class: 'table-scroll admin-table-scroll' }, tbl);
      const box = el('div', { class: 'card', style: 'margin-top:16px' }, el('div', { class: 'row' }, el('h2', { style: 'flex:1;margin:0' }, 'Пользователи'),
        el('button', { class: 'primary small', style: 'flex:0', onclick: async () => {
          const email = el('input', { type: 'email', placeholder: 'email' }), pw = el('input', { type: 'password', placeholder: 'пароль (8+)' }), name = el('input', { placeholder: 'имя' }), root = el('input', { type: 'checkbox', style: 'width:auto' });
          const ok = await modal('Новый пользователь', el('div', {}, el('div', { class: 'field' }, el('label', {}, 'Почта'), email), el('div', { class: 'field' }, el('label', {}, 'Пароль'), pw), el('div', { class: 'field' }, el('label', {}, 'Имя'), name), el('label', {}, root, ' root')), [{ label: 'Создать', cls: 'primary', fn: () => ({ email: email.value, password: pw.value, name: name.value, is_root: root.checked }) }]);
          if (!ok) return; try { await API.post('/api/admin/users', ok); toast('Создан'); refresh(); } catch (e) { toast('Ошибка: ' + e.message, 4000); }
        } }, 'Создать')), tableWrap);
      page.append(box);
      async function refresh() {
        const users = await API.get('/api/admin/users');
        tbl.innerHTML = '';
        tbl.append(el('tr', {}, ...['Почта', 'Имя', 'Root', 'Подтв.', 'Создан', ''].map(h => el('th', {}, h))));
        for (const u of users) {
          const rootCb = el('input', { type: 'checkbox', style: 'width:auto', checked: u.is_root ? '' : null, onchange: async e => { try { await API.patch('/api/admin/users/' + u.id, { is_root: e.target.checked }); if (u.id === me.id && !e.target.checked) reloadPage(); } catch (err) { toast(err.message, 4000); e.target.checked = !e.target.checked; } } });
          tbl.append(el('tr', {}, el('td', {}, u.email, u.id === me.id ? el('span', { class: 'badge', style: 'margin-left:6px' }, 'вы') : null), el('td', {}, u.name), el('td', {}, rootCb), el('td', {}, u.verified ? 'да' : 'нет'), el('td', { class: 'muted small' }, u.created_at.slice(0, 10)),
            el('td', { style: 'text-align:right;white-space:nowrap' },
              el('button', { class: 'small', title: 'Сменить пароль', onclick: async () => { const p = await prompt2('Новый пароль для ' + u.email); if (p) { try { await API.patch('/api/admin/users/' + u.id, { password: p }); toast('Пароль обновлён'); } catch (e) { toast(e.message, 4000); } } } }, icon('lock')), ' ',
              el('button', { class: 'small', title: 'Переименовать', onclick: async () => { const n = await prompt2('Имя', '', u.name); if (n) { await API.patch('/api/admin/users/' + u.id, { name: n }); refresh(); } } }, icon('edit')), ' ',
              u.id !== me.id ? el('button', { class: 'small danger', title: 'Удалить', onclick: async () => { if (confirm('Удалить ' + u.email + ' вместе с его кампаниями и персонажами?')) { await API.del('/api/admin/users/' + u.id); refresh(); } } }, icon('trash')) : null)));
        }
      }
      refresh();
    }

    // ================= Присоединение =================
    // Вход по ссылке-приглашению: показываем кампанию и роль, по кнопке — POST
    // /api/join/:code и сразу переход на стол (/c/:id). Идентификатор берём из
    // ответа POST, иначе из приглашения (inviteTarget): раньше страница читала
    // несуществующее info.campaign_id и уводила на /c/undefined — «Нет доступа»,
    // хотя участником пользователь уже стал.
    async function renderJoin(codeStr) {
      app.innerHTML = '';
      try {
        const target = inviteTarget(await API.get('/api/join/' + codeStr));
        const err = el('div', { class: 'auth-err' });
        const btn = el('button', { class: 'primary wide' }, 'Присоединиться');
        btn.addEventListener('click', async () => {
          if (btn.disabled) return;
          btn.disabled = true; btn.textContent = 'Присоединяемся…'; err.textContent = '';
          try {
            const res = (await API.post('/api/join/' + codeStr)) || {};
            const cid = String(res.campaign_id || target.id || '').trim();
            if (!cid) throw new Error('Приглашение без кампании — откройте ссылку заново');
            go('/c/' + cid);
          } catch (e) {
            // Остаёмся на странице приглашения: роль уже выдана или ссылка исчерпана.
            btn.disabled = false; btn.textContent = 'Присоединиться';
            err.textContent = e.message || 'Не удалось присоединиться';
          }
        });
        app.append(el('div', { class: 'center' }, el('div', { class: 'card auth' }, el('h2', {}, 'Приглашение'),
          el('p', {}, 'Кампания ', el('b', {}, target.name), ' · роль: ', target.role === 'gm' ? 'мастер' : 'игрок'),
          btn, err, el('p', {}, el('a', { href: '/' }, 'На главную')))));
      } catch (e) { app.append(el('div', { class: 'center' }, el('div', { class: 'card auth' }, el('h2', {}, 'Ошибка'), el('p', {}, e.message), el('a', { href: '/' }, 'На главную')))); }
    }

    // ================= Разделы =================
    async function renderSection(k) {
      app.innerHTML = '';
      const page = el('div', { class: 'page' });
      app.append(topbar(), page);
      const views = { camps: lobbyCampaigns, chars: lobbyCharacters, comp: () => el('div', { class: 'fill' }, Compendium.widget({})), library: lobbyLibrary, packs: () => Packs.page() };
      const titles = { camps: 'Кампании', chars: 'Персонажи', comp: 'Справочник', library: 'Библиотека ресурсов', packs: 'Наборы' };
      document.title = titles[k] + ' — ' + APP_NAME;
      const r = await views[k]();
      page.append(r);
    }
    async function lobbyCampaigns() {
      const wrap = el('div');
      const list = await API.get('/api/campaigns');
      wrap.append(el('div', { class: 'row', style: 'margin-bottom:14px' }, el('h1', { style: 'flex:1' }, 'Кампании'),
        el('button', { class: 'primary', style: 'flex:0;white-space:nowrap', onclick: async () => { const n = await prompt2('Название кампании', 'Затерянные рудники'); if (n) { const c = await API.post('/api/campaigns', { name: n }); go('/c/' + c.id); } } }, 'Новая кампания'),
        el('button', { style: 'flex:0;white-space:nowrap', onclick: async () => { const c = await prompt2('Ссылка-приглашение', 'например, https://…/join/abc123'); if (c) go('/join/' + String(c).trim().split('/').filter(Boolean).pop()); } }, 'Присоединиться по ссылке')));
      const g = el('div', { class: 'grid' });
      if (!list.length) g.append(el('p', { class: 'muted' }, 'Пока нет кампаний. Создайте свою или присоединитесь по ссылке-приглашению.'));
      for (const c of list) g.append(el('div', { class: 'card camp-card', onclick: () => go('/c/' + c.id) }, el('div', { class: 'row' }, el('h2', { style: 'flex:1;margin:0' }, c.name), el('span', { class: 'badge ' + c.role }, c.role === 'gm' ? 'мастер' : 'игрок')), el('p', { class: 'muted' }, c.description || 'Без описания'), el('div', { class: 'muted small' }, `${c.members_count || c.members?.length || ''} участников`.replace(/^ /, ''))));
      wrap.append(g);
      return wrap;
    }
    async function lobbyCharacters() {
      const wrap = el('div');
      const list = await API.get('/api/characters');
      wrap.append(el('div', { class: 'row', style: 'margin-bottom:14px' }, el('h1', { style: 'flex:1' }, 'Персонажи'),
        el('button', { class: 'primary', style: 'flex:0;white-space:nowrap', onclick: async () => { const r = await newCharacterDialog(); if (r) { const c = await API.post('/api/characters', r); window.open(withTok('/sheet/' + c.id), '_blank'); reloadPage(); } } }, 'Новый персонаж'),
        el('button', { style: 'flex:0;white-space:nowrap', onclick: () => LSS.importDialog({ onDone: c => { window.open(withTok('/sheet/' + c.id), '_blank'); reloadPage(); } }) }, icon('upload'), ' Импорт из Long Story Short')));
      const g = el('div', { class: 'grid' });
      if (!list.length) g.append(el('p', { class: 'muted' }, 'Персонажей пока нет.'));
      for (const c of list) g.append(charCard(c, () => reloadPage()));
      wrap.append(g);
      return wrap;
    }
    function charCard(c, onChange) {
      const s = c.sheet || {};
      const img = el('div', { class: 'portrait', style: 'width:56px;height:56px;flex:0 0 56px' }, icon('user', 28));
      if (c.portrait_asset_id) assetURL(c.portrait_asset_id).then(u => { img.innerHTML = ''; img.append(el('img', { src: u })); });
      return el('div', { class: 'card camp-card', onclick: () => window.open(withTok('/sheet/' + c.id), '_blank') }, el('div', { class: 'row' }, img, el('div', { style: 'flex:1' }, el('b', {}, c.name), el('div', { class: 'muted' }, [s.race, s.class, s.level && s.level + ' ур.'].filter(Boolean).join(' · ') || 'Новый персонаж'), el('div', { class: 'muted small' }, c.campaign_name ? 'Кампания: ' + c.campaign_name : 'Вне кампании')),
        el('button', { class: 'small danger', style: 'flex:0', onclick: async e => { e.stopPropagation(); if (confirm('Удалить персонажа?')) { await API.del('/api/characters/' + c.id); onChange(); } } }, icon('trash'))));
    }
    // Библиотека ресурсов: все изображения пользователя (карты, токены, портреты, объекты) + встроенные
    return { renderLanding, renderHome, renderDiag, renderPrivacy, renderProfile, renderAdmin, renderJoin, renderSection };
  },
};
