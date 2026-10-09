// ---------------------------------------------------------------------------
// node-menu.js — всплывающее меню редактора механик (ПКМ): поиск по узлам, категории, появление у курсора.
// Данные берутся из NodeRegistry (static/node-registry.js); здесь только отрисовка и закрытие.
// Даёт: window.NodeMenu.
// ---------------------------------------------------------------------------
window.NodeMenu = (() => {
  // Секции меню добавления узла из реестра, с фильтром по запросу.
  function addSections(query = '') {
    return window.NodeRegistry.catalog(query).map(section => ({
      title: section.title,
      items: section.items.map(item => ({ label: item.label, hint: item.type, run: () => ({ type: item.type }) })),
    }));
  }

  // Открывает меню внутри container (position: relative). sections — массив или функция(запрос).
  // onPick(result) получает то, что вернул run() пункта. Возвращает { close }.
  function open({ container, x, y, sections, searchable = false, placeholder = 'Поиск узла…', onPick, onClose }) {
    const menu = document.createElement('div');
    menu.className = 'node-menu';
    menu.setAttribute('role', 'menu');
    menu.style.left = `${Math.max(0, x)}px`;
    menu.style.top = `${Math.max(0, y)}px`;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', keys, true);
      menu.remove();
      onClose?.();
    };
    const outside = event => { if (!menu.contains(event.target)) close(); };
    const keys = event => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    const list = document.createElement('div');
    list.className = 'node-menu-list';
    const render = query => {
      const current = typeof sections === 'function' ? sections(query) : sections;
      list.replaceChildren();
      let first = null;
      for (const section of current) {
        if (!section.items.length) continue;
        const head = document.createElement('div');
        head.className = 'node-menu-title';
        head.textContent = section.title || '';
        list.append(head);
        for (const item of section.items) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'node-menu-item';
          button.setAttribute('role', 'menuitem');
          button.textContent = item.label;
          if (item.hint) { const hint = document.createElement('small'); hint.textContent = item.hint; button.append(hint); }
          button.addEventListener('click', () => { const result = item.run(); close(); onPick?.(result); });
          list.append(button);
          first ||= { item, button };
        }
      }
      if (!list.children.length) { const empty = document.createElement('p'); empty.className = 'node-menu-empty'; empty.textContent = 'Ничего не найдено'; list.append(empty); }
      menu._first = first;
    };
    if (searchable) {
      const input = document.createElement('input');
      input.type = 'search';
      input.className = 'node-menu-search';
      input.placeholder = placeholder;
      input.setAttribute('aria-label', placeholder);
      input.addEventListener('input', () => render(input.value));
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && menu._first) { event.preventDefault(); const result = menu._first.item.run(); close(); onPick?.(result); }
      });
      menu.append(input);
      menu._input = input;
    }
    menu.append(list);
    container.append(menu);
    render('');
    menu._input?.focus();
    // Регистрация на следующем тике, чтобы текущее нажатие ПКМ не закрыло меню сразу.
    setTimeout(() => {
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', keys, true);
    }, 0);
    return { close, element: menu };
  }

  return { addSections, open };
})();
