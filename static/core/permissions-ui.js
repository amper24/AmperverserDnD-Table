// ---------------------------------------------------------------------------
// permissions-ui.js — интерфейс системы прав кампании: роли и права на слои.
//
// Где живёт: страница участников (/table/<кампания>), раздел «Права».
// Один модуль на всю страницу: рисует список ролей, диалог создания/правки
// и матрицу «слой × роль» с тремя переключателями (читать / изменять / создавать).
//
// Источник правды — сервер (src/domain/access.rs + src/api/campaigns.rs):
//   GET    /api/campaigns/:cid/roles               — роли кампании;
//   POST   /api/campaigns/:cid/roles               — новая роль;
//   PATCH  /api/campaigns/:cid/roles/:rid          — имя, описание, возможности;
//   DELETE /api/campaigns/:cid/roles/:rid          — удалить (участники → «Игрок»);
//   GET    /api/campaigns/:cid/layer-permissions   — права ролей на слои;
//   PATCH  /api/campaigns/:cid/layer-permissions   — одна клетка матрицы.
// Всё это требует возможности table.manage_roles; без неё раздел не показывается.
//
// Даёт: window.Permissions = { GROUPS, PRESETS, LAYERS, allCaps, label, hint,
//   summary, presetCaps, mount }.
// Зависимости: common.js (el, icon, modal, toast, API), access.js, asset-kinds.js.
// ---------------------------------------------------------------------------
window.Permissions = (function () {
  const A = window.Access;

  // Возможности — по смыслу, а не по алфавиту: подпись и подсказка человеческим языком.
  // Список целиком сверяется с Access.ALL в tests/permissions-ui.test.cjs — новая
  // возможность в src/domain/access.rs обязана появиться и здесь.
  const GROUPS = [
    {
      key: 'campaign', title: 'Кампания', hint: 'Видимость кампании, участники, приглашения',
      caps: [
        { id: 'campaign.read', label: 'Видеть кампанию', hint: 'Список кампаний, участники, чат, эта страница' },
        { id: 'campaign.manage_members', label: 'Управлять участниками', hint: 'Менять роль участника и исключать из кампании' },
        { id: 'campaign.invite', label: 'Приглашения', hint: 'Создавать, смотреть и удалять ссылки-приглашения' },
        { id: 'campaign.manage_characters', label: 'Переносить персонажей', hint: 'Чужие листы: перенос в другую кампанию и отвязка' },
      ],
    },
    {
      key: 'characters', title: 'Листы персонажей', hint: 'Свои и чужие листы',
      caps: [
        { id: 'character.read_own', label: 'Свои листы', hint: 'Открывать листы своих персонажей' },
        { id: 'character.read_shared', label: 'Расшаренные листы', hint: 'Читать чужие листы, если владелец включил «поделиться»' },
        { id: 'character.edit_own', label: 'Править свои листы', hint: 'Создавать и менять своих персонажей' },
        { id: 'character.edit_any', label: 'Править любые листы', hint: 'Мастер: открывать и править любой лист кампании' },
      ],
    },
    {
      key: 'table', title: 'Стол', hint: 'Сцены, токены, туман войны',
      caps: [
        { id: 'table.read', label: 'Видеть стол', hint: 'Сцена, токены, чат стола, подключение к столу' },
        { id: 'table.place_character', label: 'Ставить своего персонажа', hint: 'Токен своего персонажа на стол' },
        { id: 'table.place_any_character', label: 'Ставить любого персонажа', hint: 'Любой персонаж, NPC и монстр на стол' },
        { id: 'table.move_own_token', label: 'Двигать свои токены', hint: 'Свои токены: двигать, удалять, подбирать лут' },
        { id: 'table.move_any_token', label: 'Двигать любые токены', hint: 'Любые элементы сцены, раскладка слоёв' },
        { id: 'table.manage_scene', label: 'Сцены и сетка', hint: 'Создавать сцены, менять сетку, слои и активную карту' },
        { id: 'table.manage_fog', label: 'Туман войны', hint: 'Открывать и закрывать клетки тумана' },
        { id: 'table.manage_members_tokens', label: 'Токены участников', hint: 'Назначать владельца любого токена и скрывать его от игроков' },
      ],
    },
    {
      key: 'rules', title: 'Права', hint: 'Роли и права на слои',
      caps: [
        { id: 'table.manage_roles', label: 'Роли и права', hint: 'Создавать роли, выдавать возможности и настраивать эту страницу' },
        { id: 'table.manage_layers', label: 'Слои стола', hint: 'Создавать и удалять слои сцены' },
      ],
    },
  ];

  // Быстрые наборы в диалоге роли: чаще всего нужен «как игрок» или «только смотреть».
  const PRESETS = [
    { id: 'player', label: 'Игрок', hint: 'Системный набор игрока', caps: () => A.PLAYER },
    { id: 'readonly', label: 'Только чтение', hint: 'Видеть кампанию, листы и стол, ничего не менять', caps: () => ['campaign.read', 'character.read_own', 'character.read_shared', 'table.read'] },
    { id: 'gm', label: 'Всё', hint: 'Все возможности, как у мастера', caps: () => A.ALL },
    { id: 'none', label: 'Ничего', hint: 'Снять все галочки', caps: () => [] },
  ];

  // Слои стола: порядок — от самого нужного (персонажи) к карте; подписи — как в интерфейсе стола.
  const LAYER_NAMES = {
    character: 'Персонажи', prop: 'Предметы и объекты', mount: 'Спутники', attachment: 'Вложения',
    drawing: 'Рисунки', text: 'Надписи', note: 'Заметки', map: 'Карта',
  };
  const LAYER_ORDER = ['character', 'prop', 'mount', 'attachment', 'drawing', 'text', 'note', 'map'];
  const LAYERS = LAYER_ORDER.map(id => ({ id, label: LAYER_NAMES[id] }));

  const CAP_BY_ID = new Map();
  for (const group of GROUPS) for (const cap of group.caps) CAP_BY_ID.set(cap.id, { ...cap, group });

  /// Все возможности в порядке групп — тот же набор, что Access.ALL.
  function allCaps() { return GROUPS.flatMap(group => group.caps.map(cap => cap.id)); }
  /// Подпись возможности (для чипов и подсказок).
  function label(cap) { return CAP_BY_ID.get(cap)?.label || cap; }
  /// Подсказка «что именно разрешает».
  function hint(cap) { return CAP_BY_ID.get(cap)?.hint || ''; }
  /// Группы, в которых у роли есть хотя бы одна возможность: [{ title, count, labels }].
  function groupsOf(caps) {
    const list = Array.isArray(caps) ? caps : [];
    return GROUPS
      .map(group => {
        const got = group.caps.filter(cap => list.includes(cap.id));
        return { key: group.key, title: group.title, count: got.length, labels: got.map(cap => cap.label) };
      })
      .filter(group => group.count > 0);
  }
  /// Короткая сводка набора возможностей: «все возможности», «7 из 18», «без доступа».
  function summary(caps) {
    const list = Array.isArray(caps) ? caps : [];
    const total = allCaps().length;
    if (!list.length) return 'без доступа';
    if (list.length >= total) return 'все возможности';
    return list.length + ' из ' + total;
  }
  /// Набор возможностей из пресета (по id).
  function presetCaps(id) {
    const preset = PRESETS.find(item => item.id === id);
    return preset ? Array.from(preset.caps()) : [];
  }

  const plural = (n, one, few, many) => {
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  };

  // -------------------------------------------------------------------------
  // Матрица «слой × роль»
  // -------------------------------------------------------------------------
  const CELL_FLAGS = [
    { key: 'read', letter: 'Ч', title: 'Читать слой' },
    { key: 'write', letter: 'З', title: 'Изменять элементы слоя' },
    { key: 'create', letter: 'С', title: 'Создавать элементы слоя' },
  ];

  /// Права роли на слой из ответа сервера; по умолчанию — как в DEFAULT_PLAYER_LAYER_PERMS
  /// (src/domain/access.rs): читать можно всё, менять и создавать — всё, кроме карты.
  function permOf(perms, roleId, layerId) {
    const row = perms.find(p => (p.role_id === roleId || p.role_name === roleId) && p.layer_id === layerId);
    if (!row) return { read: true, write: layerId !== 'map', create: layerId !== 'map' };
    return { read: !!row.can_read, write: !!row.can_write, create: !!row.can_create };
  }

  /// Согласованность флагов: изменять/создавать нельзя без чтения, чтение без них — можно.
  function normalizePerm(next) {
    if (next.write || next.create) next.read = true;
    if (!next.read) { next.write = false; next.create = false; }
    return next;
  }

  // -------------------------------------------------------------------------
  // Раздел «Права»: список ролей + диалог роли + матрица слоёв
  // -------------------------------------------------------------------------
  /// Нарисовать раздел в контейнере. Возвращает { reload, roles } — роли нужны
  /// странице, чтобы предложить их в списке «роль участника».
  async function mount(container, opts) {
    const cid = opts.cid;
    const members = () => opts.members ? opts.members() : [];
    const onChanged = opts.onChanged || (() => {});
    const state = { roles: [], perms: [], loading: true, error: '', loaded: false };

    const countEl = el('span', { class: 'muted small' });
    const newBtn = el('button', { class: 'small primary', style: 'flex:0;white-space:nowrap', title: 'Создать роль с набором возможностей', onclick: () => roleDialog(null) }, icon('plus'), ' Новая роль');
    const rolesBox = el('div', { class: 'role-grid' });
    const matrixBox = el('div', { class: 'perms-matrix-box' });
    const statusEl = el('div', { class: 'muted small', style: 'margin-top:8px' });

    container.append(
      el('div', { class: 'row', style: 'align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap' },
        el('b', { style: 'flex:1' }, 'Роли'), countEl, newBtn),
      rolesBox,
      el('div', { class: 'row', style: 'align-items:center;gap:8px;margin:16px 0 4px;flex-wrap:wrap' },
        el('b', { style: 'flex:1' }, 'Права на слои'),
        el('span', { class: 'muted small' }, 'Ч — читать, З — изменять, С — создавать')),
      el('p', { class: 'muted small', style: 'margin:0 0 6px' },
        'Одна строка — один слой стола, один столбец — своя роль. Изменения сохраняются сразу; «Мастер» всегда имеет полный доступ, а права по умолчанию — как у «Игрока» (всё видно, менять можно всё, кроме карты).'),
      matrixBox,
      statusEl);

    /// Загрузить роли и права на слои с сервера и перерисовать.
    async function reload() {
      state.loading = true;
      state.error = '';
      try {
        const [roles, perms] = await Promise.all([
          API.get(`/api/campaigns/${cid}/roles`).then(r => r || []),
          API.get(`/api/campaigns/${cid}/layer-permissions`).then(r => r || []),
        ]);
        state.roles = roles;
        state.perms = perms;
        state.loaded = true;
        A.setLayerPerms(cid, perms);
      } catch (e) {
        state.error = e.message || 'не удалось загрузить роли';
      }
      state.loading = false;
      render();
      onChanged();
    }

    function render() {
      rolesBox.innerHTML = '';
      matrixBox.innerHTML = '';
      statusEl.textContent = '';
      newBtn.classList.toggle('hidden', !state.loaded);
      if (state.loading) {
        countEl.textContent = '';
        rolesBox.append(el('div', { class: 'muted small' }, 'Загрузка ролей…'));
        matrixBox.append(el('div', { class: 'muted small' }, 'Загрузка прав на слои…'));
        return;
      }
      if (state.error) {
        countEl.textContent = '';
        rolesBox.append(el('div', { class: 'row', style: 'gap:8px;align-items:center;flex-wrap:wrap' },
          el('span', { class: 'muted' }, 'Не удалось загрузить роли: ' + state.error),
          el('button', { class: 'small', style: 'flex:0', onclick: reload }, 'Повторить')));
        matrixBox.classList.add('hidden');
        return;
      }
      matrixBox.classList.remove('hidden');
      const custom = state.roles.filter(role => !role.is_system);
      countEl.textContent = custom.length
        ? custom.length + ' ' + plural(custom.length, 'своя роль', 'свои роли', 'своих ролей')
        : 'своих ролей пока нет';
      rolesBox.append(...systemCards());
      for (const role of custom) rolesBox.append(roleCard(role));
      if (!custom.length) {
        rolesBox.append(el('div', { class: 'role-empty' },
          el('span', { class: 'muted small' }, 'Своих ролей пока нет. Создайте роль — например «Смотритель карты» с правом двигать карту, но без доступа к листам.'),
          el('button', { class: 'small primary', style: 'flex:0;white-space:nowrap', onclick: () => roleDialog(null) }, icon('plus'), ' Создать первую роль')));
      }
      matrixBox.append(matrix(custom));
    }

    /// Системные роли — только для справки: их набор задан сервером.
    function systemCards() {
      return [
        ['Мастер', 'Все возможности и все слои. Владельца кампании нельзя разжаловать.', 'gm'],
        ['Игрок', 'Базовый набор: свои листы, расшаренные листы, свои токены. Слои — по матрице ниже.', 'player'],
      ].map(([name, text, cls]) => el('div', { class: 'role-card system' },
        el('div', { class: 'row', style: 'align-items:center;gap:8px' },
          el('b', { style: 'flex:1' }, name), el('span', { class: 'badge ' + cls, style: 'flex:0;white-space:nowrap' }, 'системная')),
        el('div', { class: 'muted small', style: 'margin-top:4px' }, text)));
    }

    function roleCard(role) {
      const caps = role.capabilities || [];
      const inRole = members().filter(m => m.role === role.name).length;
      const chips = groupsOf(caps).map(group =>
        el('span', { class: 'chip', title: group.labels.join(', ') }, group.title + ' · ' + group.count));
      return el('div', { class: 'role-card', 'data-role': role.id },
        el('div', { class: 'row', style: 'align-items:center;gap:8px' },
          el('b', { style: 'flex:1' }, role.name),
          el('span', { class: 'muted small', style: 'flex:0;white-space:nowrap', title: 'Возможности роли' }, summary(caps))),
        el('div', { class: 'muted small', style: 'margin:2px 0 6px' }, role.description || 'Без описания'),
        el('div', { class: 'row', style: 'flex-wrap:wrap;gap:2px' }, chips.length ? chips : el('span', { class: 'muted small' }, 'Возможностей нет — роль ничего не разрешает')),
        el('div', { class: 'row', style: 'align-items:center;gap:6px;margin-top:8px' },
          el('span', { class: 'muted small', style: 'flex:1' }, inRole ? inRole + ' ' + plural(inRole, 'участник', 'участника', 'участников') : 'нет участников'),
          el('button', { class: 'small', style: 'flex:0;white-space:nowrap', title: 'Изменить название, описание и возможности', onclick: () => roleDialog(role) }, icon('edit'), ' Изменить'),
          el('button', { class: 'small danger', style: 'flex:0;white-space:nowrap', title: 'Удалить роль: её участники станут игроками', onclick: () => removeRole(role) }, icon('trash'), ' Удалить')));
    }

    function matrix(custom) {
      if (!custom.length) return el('p', { class: 'muted small' }, 'Матрица появится, когда будет хотя бы одна своя роль.');
      const table = el('table', { class: 'tbl perms-matrix' });
      const thead = el('thead', {}, el('tr', {},
        el('th', { style: 'min-width:150px' }, 'Слой'),
        ...custom.map(role => el('th', { style: 'text-align:center' }, role.name))));
      table.append(thead);
      for (const layer of LAYERS) {
        const tr = el('tr', {}, el('td', {}, layer.label, el('span', { class: 'muted small' }, ' · ' + layer.id)));
        for (const role of custom) {
          const cell = el('td', { class: 'perms-cell', style: 'text-align:center;white-space:nowrap', 'data-role': role.id, 'data-layer': layer.id });
          const cur = normalizePerm(permOf(state.perms, role.id, layer.id));
          for (const flag of CELL_FLAGS) {
            cell.append(el('button', {
              class: 'perm-toggle' + (cur[flag.key] ? ' on' : ''),
              title: flag.title, 'aria-pressed': cur[flag.key] ? 'true' : 'false',
              'data-flag': flag.key,
              onclick: e => toggleFlag(role, layer.id, flag.key, cell, e.currentTarget),
            }, flag.letter));
          }
          tr.append(cell);
        }
        table.append(tr);
      }
      return table;
    }

    /// Клик по «Ч/З/С»: меняем состояние сразу, сохраняем в фоне, ошибку показываем и откатываем.
    async function toggleFlag(role, layerId, flagKey, cell, button) {
      if (cell.dataset.busy) return;
      const before = normalizePerm(permOf(state.perms, role.id, layerId));
      // Выключили «Ч» — вместе с ним гаснут «З» и «С»: изменять то, чего не видишь, нельзя.
      const next = { ...before, [flagKey]: !before[flagKey] };
      if (flagKey === 'read' && !next.read) { next.write = false; next.create = false; }
      normalizePerm(next);
      applyPerm(role.id, layerId, next);
      paintCell(cell, next);
      cell.dataset.busy = '1';
      cell.classList.add('saving');
      try {
        await API.patch(`/api/campaigns/${cid}/layer-permissions`, {
          role_id: role.id, layer_id: layerId,
          can_read: next.read, can_write: next.write, can_create: next.create,
        });
        A.setLayerPerms(cid, state.perms);
        statusEl.textContent = 'Сохранено: ' + role.name + ' · ' + (LAYER_NAMES[layerId] || layerId);
        setTimeout(() => { if (statusEl.textContent.startsWith('Сохранено')) statusEl.textContent = ''; }, 2500);
      } catch (e) {
        applyPerm(role.id, layerId, before);
        paintCell(cell, before);
        toast('Не удалось сохранить права: ' + e.message, 5000);
      } finally {
        delete cell.dataset.busy;
        cell.classList.remove('saving');
      }
    }

    /// Записать права роли на слой в локальное состояние (его и отдаёт Access).
    function applyPerm(roleId, layerId, perm) {
      const row = state.perms.find(p => (p.role_id === roleId || p.role_name === roleId) && p.layer_id === layerId);
      const role = state.roles.find(r => r.id === roleId);
      if (row) {
        row.can_read = perm.read; row.can_write = perm.write; row.can_create = perm.create;
        if (!row.role_name && role) row.role_name = role.name;
      } else {
        state.perms.push({
          role_id: roleId, role_name: role?.name || '', layer_id: layerId,
          can_read: perm.read, can_write: perm.write, can_create: perm.create,
        });
      }
    }

    function paintCell(cell, perm) {
      for (const flag of CELL_FLAGS) {
        const button = cell.querySelector('[data-flag="' + flag.key + '"]');
        if (!button) continue;
        button.classList.toggle('on', !!perm[flag.key]);
        button.setAttribute('aria-pressed', perm[flag.key] ? 'true' : 'false');
      }
    }

    // ---------------------- диалог роли ----------------------
    async function roleDialog(role) {
      const isNew = !role;
      const name = el('input', { value: role?.name || '', placeholder: 'Например: Смотритель карты', maxlength: 64 });
      const description = el('input', { value: role?.description || '', placeholder: 'Коротко: что роль делает', maxlength: 200 });
      let chosen = new Set(role?.capabilities || A.PLAYER);
      const boxes = new Map();
      const capsLabel = el('span', { class: 'muted small' });
      const refreshCaps = () => { capsLabel.textContent = summary(Array.from(chosen)); };
      const groupBlocks = GROUPS.map(group => el('div', { class: 'perm-group' },
        el('div', { class: 'perm-group-head' }, el('b', {}, group.title), el('span', { class: 'muted small' }, group.hint)),
        ...group.caps.map(cap => {
          const box = el('input', {
            type: 'checkbox', style: 'width:auto',
            onchange: e => { if (e.target.checked) chosen.add(cap.id); else chosen.delete(cap.id); refreshCaps(); },
          });
          box.checked = chosen.has(cap.id);
          boxes.set(cap.id, box);
          return el('label', { class: 'perm-cap', title: cap.hint }, box,
            el('span', { class: 'perm-cap-label' }, cap.label),
            el('span', { class: 'muted small perm-cap-hint' }, cap.hint));
        })));
      const setCaps = list => {
        chosen = new Set(list);
        for (const [id, box] of boxes) box.checked = chosen.has(id);
        refreshCaps();
      };
      refreshCaps();
      const presets = el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
        ...PRESETS.map(preset => el('button', {
          class: 'small', style: 'flex:0;white-space:nowrap', title: preset.hint, onclick: () => setCaps(preset.caps()),
        }, preset.label)));
      const body = el('div', {},
        el('div', { class: 'field' }, el('label', {}, 'Название'), name),
        el('div', { class: 'field' }, el('label', {}, 'Описание'), description),
        el('div', { class: 'field' }, el('div', { class: 'row', style: 'align-items:center;gap:8px;margin-bottom:4px' },
          el('label', { style: 'margin:0;flex:1' }, 'Возможности'), capsLabel), presets),
        el('div', { class: 'perm-groups' }, ...groupBlocks));
      const result = await modal(isNew ? 'Новая роль' : 'Роль «' + role.name + '»', body, [{
        label: isNew ? 'Создать роль' : 'Сохранить', cls: 'primary',
        fn: () => {
          const value = name.value.trim();
          if (!value) { toast('Введите название роли'); return false; }
          return { name: value, description: description.value.trim(), capabilities: allCaps().filter(cap => chosen.has(cap)) };
        },
      }], { wide: true });
      if (!result) return;
      try {
        if (isNew) await API.post(`/api/campaigns/${cid}/roles`, result);
        else await API.patch(`/api/campaigns/${cid}/roles/${role.id}`, result);
        toast(isNew ? 'Роль создана' : 'Роль сохранена');
        await reload();
      } catch (e) {
        toast('Не удалось сохранить роль: ' + e.message, 5000);
      }
    }

    async function removeRole(role) {
      const inRole = members().filter(m => m.role === role.name).length;
      const tail = inRole ? '\nЕё участники (' + inRole + ') станут игроками.' : '';
      if (!confirm('Удалить роль «' + role.name + '»?' + tail)) return;
      try {
        await API.del(`/api/campaigns/${cid}/roles/${role.id}`);
        toast('Роль удалена');
        opts.onRemoved && opts.onRemoved(role);
        await reload();
      } catch (e) {
        toast('Не удалось удалить роль: ' + e.message, 5000);
      }
    }

    await reload();
    return { reload, get roles() { return state.roles; } };
  }

  return { GROUPS, PRESETS, LAYERS, LAYER_NAMES, allCaps, label, hint, groupsOf, summary, presetCaps, mount };
})();
