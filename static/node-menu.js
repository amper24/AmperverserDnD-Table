// ---------------------------------------------------------------------------
// node-menu.js — всплывающее меню редактора механик (ПКМ): поиск по узлам, категории, появление у курсора.
// Категории раскрываются вариантами при наведении (или клике, стрелке вправо); пункт с полем children — подменю,
// вложенность любая. Подпанели лежат внутри меню, а не в списке (список прокручивается и обрезал бы их).
// Без запроса в режиме categories верхний уровень — категории, в поиске — плоский список с заголовками категорий.
// Данные берутся из NodeRegistry (static/node-registry.js); здесь только отрисовка и закрытие.
// Даёт: window.NodeMenu.
// ---------------------------------------------------------------------------
window.NodeMenu = (() => {
  // Секции меню добавления узла из реестра, с фильтром по запросу (плоский вид для поиска).
  function addSections(query = '') {
    return window.NodeRegistry.catalog(query).map(section => ({
      title: section.title,
      items: section.items.map(item => ({ label: item.label, hint: item.type, run: () => ({ type: item.type }) })),
    }));
  }

  // Категории реестра с вариантами-узлами для вложенного меню: категория → узел.
  function catalogCategories() {
    return window.NodeRegistry.catalog('').map(section => ({
      label: section.title,
      children: section.items.map(item => ({ label: item.label, hint: item.type, run: () => ({ type: item.type }) })),
    }));
  }

  // Открывает меню внутри container (position: relative). sections — массив или функция(запрос).
  // Пункт: { label, hint?, run? } или { label, children: [...] } (подменю). onPick(result) получает то, что вернул run().
  // categories: true — без запроса верхний уровень раскрывается подменю (категории → варианты).
  // Возвращает { close, element }.
  function open({ container, x, y, sections, searchable = false, categories = false, placeholder = 'Поиск узла…', onPick, onClose }) {
    const menu = document.createElement('div');
    menu.className = 'node-menu';
    menu.setAttribute('role', 'menu');
    menu.style.left = `${Math.max(0, x)}px`;
    menu.style.top = `${Math.max(0, y)}px`;
    let closed = false;
    let panels = [];       // подпанели текущей отрисовки: { el, depth, button }
    let pendingClose = null;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(pendingClose);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', keys, true);
      menu.remove();
      onClose?.();
    };
    const outside = event => { if (!menu.contains(event.target)) close(); };
    const keys = event => { if (event.key === 'Escape') { event.preventDefault(); close(); } };

    // Закрывает подпанели глубины depth и глубже.
    const closeFrom = depth => {
      for (const p of panels) if (p.depth >= depth && !p.el.hidden) { p.el.hidden = true; p.button.setAttribute('aria-expanded', 'false'); }
    };
    const scheduleClose = depth => {
      clearTimeout(pendingClose);
      pendingClose = setTimeout(() => closeFrom(depth), 180);
    };
    // Ставит подпанель рядом с кнопкой: справа, а если не влезает — слева; по высоте внутри холста.
    const place = (button, panel) => {
      const mr = menu.getBoundingClientRect(), br = button.getBoundingClientRect();
      const cr = (container.getBoundingClientRect?.() || { left: 0, top: 0, right: container.clientWidth || 0, bottom: container.clientHeight || 0 });
      panel.hidden = false;
      const pw = panel.offsetWidth, ph = panel.offsetHeight;
      let left = br.right - mr.left + 4;
      if (br.right + 4 + pw > cr.right) left = br.left - mr.left - pw - 4;
      let top = br.top - mr.top - 6;
      if (br.top + ph > cr.bottom) top = Math.max(0, cr.bottom - mr.top - ph - 4);
      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(top)}px`;
    };
    // Элемент меню: пункт или категория с подпанелью (depth — глубина, на которой она лежит).
    const entry = (item, depth) => {
      if (!item.children) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'node-menu-item';
        button.setAttribute('role', 'menuitem');
        button.textContent = item.label;
        if (item.hint) { const hint = document.createElement('small'); hint.textContent = item.hint; button.append(hint); }
        button.addEventListener('click', () => { const result = item.run?.(); close(); onPick?.(result); });
        return { el: button, first: { item, button } };
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'node-menu-item node-menu-cat';
      if (depth === 0 && categories) button.classList.add('node-menu-title');
      button.setAttribute('role', 'menuitem');
      button.setAttribute('aria-haspopup', 'menu');
      button.setAttribute('aria-expanded', 'false');
      const label = document.createElement('span');
      label.textContent = item.label;
      const arrow = document.createElement('span');
      arrow.className = 'node-menu-arrow'; // стрелка рисуется в CSS, текст категории остаётся чистым
      button.append(label, arrow);
      const panel = document.createElement('div');
      panel.className = 'node-menu-sub';
      panel.setAttribute('role', 'menu');
      panel.hidden = true;
      for (const child of item.children) panel.append(entry(child, depth + 1).el);
      menu.append(panel);
      panels.push({ el: panel, depth, button });
      const show = () => {
        clearTimeout(pendingClose);
        closeFrom(depth);
        place(button, panel);
        button.setAttribute('aria-expanded', 'true');
      };
      button.addEventListener('mouseenter', show);
      button.addEventListener('mouseleave', () => scheduleClose(depth));
      panel.addEventListener('mouseenter', () => clearTimeout(pendingClose));
      panel.addEventListener('mouseleave', () => scheduleClose(depth));
      button.addEventListener('click', e => { e.stopPropagation(); show(); });
      button.addEventListener('keydown', e => {
        if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); show(); panel.querySelector('.node-menu-item')?.focus(); }
      });
      panel.addEventListener('keydown', e => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); closeFrom(depth); button.focus(); }
      });
      return { el: button, first: null };
    };

    const list = document.createElement('div');
    list.className = 'node-menu-list';
    const render = query => {
      const current = typeof sections === 'function' ? sections(query) : sections;
      list.replaceChildren();
      for (const p of panels) p.el.remove();
      panels = [];
      let first = null;
      const searching = Boolean(String(query || '').trim()) && searchable;
      if (categories && !searching) {
        // Верхний уровень — категории; варианты появляются при наведении.
        for (const section of current) {
          if (!section.items.length) continue;
          const { el } = entry({ label: section.title, children: section.items }, 0);
          list.append(el);
        }
      } else {
        for (const section of current) {
          if (!section.items.length) continue;
          const head = document.createElement('div');
          head.className = 'node-menu-title';
          head.textContent = section.title || '';
          list.append(head);
          for (const item of section.items) {
            const built = entry(item, 0);
            list.append(built.el);
            first ||= built.first;
          }
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
        if (event.key === 'Enter' && menu._first) { event.preventDefault(); const result = menu._first.item.run?.(); close(); onPick?.(result); }
      });
      menu.append(input);
      menu._input = input;
    }
    menu.append(list);
    container.append(menu);
    render('');
    // Меню не должно выходить за холст (он обрезает содержимое): сдвигаем внутрь у правого и нижнего края.
    const fit = () => {
      const maxX = Math.max(0, (container.clientWidth || 0) - menu.offsetWidth - 4), maxY = Math.max(0, (container.clientHeight || 0) - menu.offsetHeight - 4);
      if (container.clientWidth) menu.style.left = `${Math.min(Math.max(0, x), maxX)}px`;
      if (container.clientHeight) menu.style.top = `${Math.min(Math.max(0, y), maxY)}px`;
    };
    fit();
    menu._input?.focus();
    // Регистрация на следующем тике, чтобы текущее нажатие ПКМ не закрыло меню сразу.
    setTimeout(() => {
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', keys, true);
    }, 0);
    return { close, element: menu };
  }

  return { addSections, catalogCategories, open };
})();
