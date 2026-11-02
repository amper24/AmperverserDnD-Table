// ---------------------------------------------------------------------------
// nav.js — единая навигация страниц: пункты меню, активный раздел, шапка.
//
// Даёт: Nav (APP_NAME, ITEMS, normalizePath, activeKey, build, items, tableHref,
//       header, menu).
// Зависимости: common.js (el, icon, Theme, API, go, LS) и nav.css; подключается
// после common.js на всех страницах. Роутинг не подменяет: пункты — обычные
// <a href>, поэтому SPA (app.js), лист, участники и профиль переходят как раньше.
// ---------------------------------------------------------------------------
(function () {
  const APP_NAME = 'Edge Tablet';
  // Пункты меню. key — стабильный идентификатор (data-nav, aria-current),
  // brand — «Главная» рисуется логотипом. href «Стола» вычисляет tableHref().
  const ITEMS = [
    { key: 'home', label: 'Главная', href: '/', icon: 'd20', brand: true },
    { key: 'campaigns', label: 'Кампании', href: '/campaigns', icon: 'scroll' },
    { key: 'characters', label: 'Персонажи', href: '/characters', icon: 'sheet' },
    { key: 'compendium', label: 'Справочник', href: '/compendium', icon: 'book' },
    { key: 'table', label: 'Стол', href: '/campaigns', icon: 'map' },
    { key: 'profile', label: 'Профиль', href: '/profile', icon: 'user' },
  ];
  // Путь без query/hash и хвостовых слэшей: '/profile/?x' → '/profile'.
  function normalizePath(pathname) {
    let p = String(pathname === undefined || pathname === null ? '/' : pathname);
    const tail = p.search(/[?#]/);
    if (tail >= 0) p = p.slice(0, tail);
    if (p.length > 1) p = p.replace(/\/+$/, '');
    return p || '/';
  }
  // Активный раздел по адресу: /profile → Профиль, /table/… → Стол,
  // /c/… → Кампании, /sheet/… и /character/… → Персонажи, /compendium → Справочник.
  function activeKey(pathname) {
    const p = normalizePath(pathname);
    if (p === '/') return 'home';
    if (p === '/profile') return 'profile';
    if (p === '/table' || p.startsWith('/table/')) return 'table';
    if (p.startsWith('/c/')) return 'campaigns';
    if (p === '/characters' || p.startsWith('/characters/')) return 'characters';
    if (p.startsWith('/sheet/') || p.startsWith('/character/')) return 'characters';
    if (p === '/compendium' || p.startsWith('/compendium/')) return 'compendium';
    // Библиотека ресурсов и наборы — тот же раздел «Справочник».
    if (p === '/library' || p.startsWith('/library/') || p === '/packs' || p.startsWith('/packs/')) return 'compendium';
    if (p === '/campaigns' || p.startsWith('/campaigns/')) return 'campaigns';
    return '';
  }
  // Чистая сборка пунктов: копии links + active у совпавшего раздела.
  function build(links, pathname) {
    const active = activeKey(pathname);
    return (links || []).map(link => Object.assign({}, link, { active: link.key === active }));
  }
  // «Стол» ведёт на стол кампании: из /table/:cid или /c/:cid — эта же кампания,
  // иначе последняя открытая (et-last-campaign), иначе список кампаний.
  function tableHref(pathname) {
    const p = normalizePath(pathname);
    const own = /^\/(?:table|c)\/([\w-]+)/.exec(p);
    if (own) return '/c/' + own[1];
    let last = null;
    try { last = window.LS ? window.LS.getItem('et-last-campaign') : null; } catch (e) { last = null; }
    return last ? '/c/' + last : '/campaigns';
  }
  // Пункты с готовыми href: единственное место, где «Стол» получает адрес.
  function items(pathname) {
    const p = normalizePath(pathname);
    return build(ITEMS.map(item => (item.key === 'table' ? Object.assign({}, item, { href: tableHref(p) }) : item)), p);
  }
  // ---------- DOM: шапка и компактное меню ----------
  let seq = 0;
  function linkNode(item) {
    return el('a', {
      href: item.href, class: 'edge-nav-link', 'data-nav': item.key,
      'aria-current': item.active ? 'page' : null,
      'aria-label': item.label, title: item.label,
    }, icon(item.icon, 16), el('span', { class: 'edge-nav-label' }, item.label));
  }
  function brandNode(list, opts) {
    const home = list.find(item => item.brand) || list[0] || { active: false };
    return el('a', {
      href: (home.href || '/'), class: 'brand edge-brand', 'data-nav': home.key || 'home',
      'aria-current': home.active ? 'page' : null,
      'aria-label': 'Главная — ' + (opts.brand || APP_NAME),
      title: 'Главная — ' + (opts.brand || APP_NAME),
    }, opts.brand || APP_NAME);
  }
  function logoutButton() {
    return el('button', {
      class: 'small edge-logout', type: 'button', title: 'Выйти из аккаунта', 'aria-label': 'Выйти из аккаунта',
      onclick: async () => { try { await API.post('/api/auth/logout'); } catch (e) { /* сессия уже закрыта */ } go('/'); },
    }, icon('logout', 14), el('span', { class: 'edge-logout-label' }, 'Выйти'));
  }
  function userbox(opts) {
    if (!opts.me) {
      return el('span', { class: 'userbox edge-guest' },
        el('a', { href: '/login', class: 'btn small' }, 'Войти'),
        opts.canRegister === false ? null : el('a', { href: '/register', class: 'btn small primary' }, 'Регистрация'));
    }
    return el('span', { class: 'userbox' },
      el('a', { href: '/profile', class: 'userlink', title: 'Профиль' }, opts.me.name || 'Профиль'),
      opts.logout === false ? null : logoutButton());
  }
  // Один общий обработчик: Esc и клик вне закрывают открытые панели меню.
  let globalsBound = false;
  function closeAll() {
    document.querySelectorAll('.edge-nav.is-open, .edge-nav-panel.is-open').forEach(panel => {
      const hadFocus = panel.contains(document.activeElement);
      panel.classList.remove('is-open');
      const btn = panel.id ? document.querySelector('[aria-controls="' + panel.id + '"]') : null;
      if (btn) btn.setAttribute('aria-expanded', 'false');
      if (hadFocus && btn) btn.focus({ preventScroll: true });
    });
  }
  function bindGlobals() {
    if (globalsBound) return;
    globalsBound = true;
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(); });
    document.addEventListener('pointerdown', e => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      const insideNav = target.closest('.edge-topbar .edge-nav, .edge-nav-menu');
      if (!insideNav) closeAll();
    });
  }
  function toggle(button, panel) {
    bindGlobals();
    const open = !panel.classList.contains('is-open');
    closeAll();
    panel.classList.toggle('is-open', open);
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      const first = panel.querySelector('a');
      if (first) first.focus({ preventScroll: true });
    }
  }
  /// Полная шапка страницы: логотип (Главная), пункты, меню на узком экране,
  /// админка (root), тема, пользователь и «Выйти».
  function header(opts) {
    const o = opts || {};
    const path = o.current || (typeof location !== 'undefined' ? location.pathname : '/');
    let list = items(path);
    // Явное перекрытие активного пункта (например, «Админ») — для страниц вне карты.
    if (o.active) list = list.map(item => Object.assign({}, item, { active: item.key === o.active }));
    const id = 'edge-nav-menu-' + (++seq);
    const panel = el('nav', { class: 'mainnav edge-nav', id, 'aria-label': 'Основная навигация' },
      ...list.filter(item => !item.brand).map(linkNode));
    const toggleBtn = el('button', {
      class: 'edge-nav-toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': id,
      title: 'Меню разделов', 'aria-label': 'Меню разделов', onclick: () => toggle(toggleBtn, panel),
    }, icon('menu', 18));
    const admin = o.admin
      ? el('a', { href: '/admin', class: 'edge-nav-admin root' + (o.active === 'admin' ? ' active' : ''), title: 'Админ-панель' }, 'Админ')
      : null;
    return el('header', { class: 'topbar edge-topbar' },
      brandNode(list, o), panel, toggleBtn, admin, el('span', { class: 'spacer' }),
      o.theme === false ? null : Theme.button(), userbox(o));
  }
  /// Компактное меню для плотных панелей (полноэкранный стол): кнопка + список.
  function menu(opts) {
    const o = opts || {};
    const path = o.current || (typeof location !== 'undefined' ? location.pathname : '/');
    const list = items(path);
    const id = 'edge-nav-panel-' + (++seq);
    const panel = el('nav', { class: 'edge-nav edge-nav-panel', id, 'aria-label': 'Разделы' },
      ...list.filter(item => !item.brand).map(linkNode));
    const btn = el('button', {
      class: 'small edge-nav-menu-btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': id,
      title: 'Разделы', 'aria-label': 'Разделы', onclick: () => toggle(btn, panel),
    }, icon('menu', 15), el('span', { class: 'edge-nav-menu-label' }, 'Разделы'));
    return el('span', { class: 'edge-nav-menu' }, btn, panel);
  }
  window.Nav = { APP_NAME, ITEMS, normalizePath, activeKey, build, tableHref, items, header, menu, closeAll };
})();
