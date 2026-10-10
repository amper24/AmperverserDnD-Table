// ---------------------------------------------------------------------------
// presets.js — реестр наборов данных: стартовые графы, основы предметов и заклинаний,
// таблицы развития классов и ячейки мультикласса. Код здесь не содержит ни одного набора:
// все наборы — JSON.
//
// Встроенные наборы: static/presets/index.json перечисляет файлы наборов. Свой набор
// добавляется в файл и в список index.json, либо импортируется в браузер (см. importUser).
//
// Формат набора:
//   { "kind": "graph_starter" | "item_preset" | "spell_preset" | "class_progression" | "multiclass_slots",
//     "id": "уникальный id набора", "name": "название", "edition": "2014" | "2024" (нужно для классов),
//     "items": [ { "id": "...", ...поля вида } ] }
// Поля элемента зависят от вида (см. KINDS). Один и тот же id элемента в двух наборах одного вида:
// побеждает набор, загруженный позже (пользовательский набор перекрывает встроенный).
//
// Диалог наборов: Presets.openManager() (кнопка «Наборы данных…» в редакторе механик).
// Потребители: mechanics-graph.js (graph_starter), modules.js (item_preset, spell_preset),
// levelup.js и character-builder.js (class_progression, multiclass_slots).
// ---------------------------------------------------------------------------
(function () {
  // Вид набора: какие поля обязательны у элементов. Новый вид нужен только там, где появляется новый потребитель.
  const KINDS = {
    graph_starter: { fields: ['name', 'nodes'], optional: ['hint', 'attach', 'links'] },
    item_preset: { fields: ['name', 'fields'], optional: ['hint'] },
    spell_preset: { fields: ['name', 'fields'], optional: ['hint'] },
    class_progression: { fields: ['table'], needsEdition: true },
    multiclass_slots: { fields: ['table'], needsEdition: true },
    class_rules: { fields: ['table'], needsEdition: true },
    race_rules: { fields: ['table'], needsEdition: true },
    feat_rules: { fields: ['table'], needsEdition: true },
    feature_rules: { fields: ['table'], needsEdition: true },
    // Словари правил: каждый элемент — table с полями, которые читают потребители (см. docs/presets.md).
    conditions: { fields: ['table'] },
    spell_schools: { fields: ['table'] },
    languages: { fields: ['table'] },
    enemy_types: { fields: ['table'] },
    // Библиотека механик: шаблоны блоков и стартовые программы создания (описание в docs/presets.md).
    mechanic_templates: { fields: ['table'] },
    mechanic_starters: { fields: ['table'] },
  };
  const STORE_KEY = 'et-presets-user';
  const MANIFEST = 'index.json';
  const EDITIONS = ['2014', '2024'];

  const state = { builtin: [], user: [], loaded: false };
  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  // Не даём падать необработанному отклонению, если загрузка не удалась: её видит только тот, кто ждёт ready.
  ready.catch(() => {});

  const isObj = x => x && typeof x === 'object' && !Array.isArray(x);

  // Проверка набора. Возвращает строку с ошибкой или '' (набор корректен).
  function problemOf(set) {
    if (!isObj(set)) return 'набор должен быть объектом';
    const kind = KINDS[set.kind];
    if (!kind) return `неизвестный вид набора «${set.kind}»`;
    if (typeof set.id !== 'string' || !set.id.trim()) return 'нужен id набора';
    if (typeof set.name !== 'string' || !set.name.trim()) return `набор «${set.id}»: нужно название`;
    if (kind.needsEdition && !EDITIONS.includes(String(set.edition))) return `набор «${set.id}»: укажите редакцию 2014 или 2024`;
    if (!Array.isArray(set.items)) return `набор «${set.id}»: items должен быть массивом`;
    const seen = new Set();
    for (const item of set.items) {
      if (!isObj(item) || typeof item.id !== 'string' || !item.id.trim()) return `набор «${set.id}»: у элемента нет id`;
      if (seen.has(item.id)) return `набор «${set.id}»: повтор элемента «${item.id}»`;
      seen.add(item.id);
      for (const f of kind.fields) if (item[f] === undefined) return `набор «${set.id}», элемент «${item.id}»: нет поля «${f}»`;
      if (set.kind === 'graph_starter') {
        if (!Array.isArray(item.nodes)) return `стартовый граф «${item.id}»: nodes должен быть массивом`;
        const keys = new Set(item.nodes.map(n => n?.key));
        for (const l of item.links || []) {
          if (!Array.isArray(l) || l.length !== 4) return `стартовый граф «${item.id}»: связь — четыре значения [из, сокет, в, сокет]`;
          if (!keys.has(l[0]) || !keys.has(l[2])) return `стартовый граф «${item.id}»: связь ссылается на неизвестный узел`;
        }
      }
    }
    return '';
  }
  // Проверка набора с исключением — для импорта и загрузки.
  function checkSet(set) { const p = problemOf(set); if (p) throw new Error(p); return set; }

  function readUser() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter(s => !problemOf(s)) : [];
    } catch { return []; }
  }
  function saveUser() {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(state.user));
  }

  // Загрузка встроенных наборов. read(file) — функция, отдающая JSON по имени файла из static/presets/.
  async function load(read = defaultRead) {
    try {
      const index = await read(MANIFEST);
      if (!Array.isArray(index?.sets)) throw new Error('index.json: нужен массив sets');
      const builtin = [];
      for (const file of index.sets) builtin.push(checkSet(await read(file)));
      const ids = new Set();
      for (const s of builtin) { if (ids.has(s.id)) throw new Error(`повтор набора «${s.id}»`); ids.add(s.id); }
      state.builtin = builtin;
      state.user = readUser();
      state.loaded = true;
      resolveReady(api);
      changed();
    } catch (e) {
      rejectReady(e);
      throw e;
    }
    return api;
  }
  function defaultRead(file) {
    return fetch('/static/presets/' + file, { cache: 'no-cache' }).then(r => {
      if (!r.ok) throw new Error(`не загружен ${file}: ${r.status}`);
      return r.json();
    });
  }

  function sets() { return [...state.builtin, ...state.user]; }
  // Все элементы вида. Для наборов с редакцией: пока edition не задана, отдаём элементы всех редакций.
  function items(kind, edition) {
    const byId = new Map();
    for (const s of sets()) {
      if (s.kind !== kind) continue;
      if (edition && s.edition && String(s.edition) !== String(edition)) continue;
      for (const item of s.items) byId.set(item.id, item); // позже загруженный перекрывает
    }
    return [...byId.values()];
  }
  function item(kind, id, edition) { return items(kind, edition).find(i => i.id === id) || null; }

  // Правила класса по редакции и slug (кастеры, мультикласс, мастерства, цвет) — вид class_rules.
  function classRules(edition, slug) { return item('class_rules', slug, edition)?.table || null; }
  // Таблица развития класса по редакции и slug (ключ — slug класса, как у ClassRules.slugOf).
  function classProgression(edition, slug) {
    const t = item('class_progression', slug, edition);
    return t ? t.table : null;
  }
  // Ячейки мультикласса заклинателей для редакции (таблица «multiclass»).
  function multiclassSlots(edition) {
    const t = item('multiclass_slots', 'multiclass', edition);
    return t ? t.table : null;
  }

  // Список, который сохраняет ссылку: модули читают его при загрузке скрипта, а наборы приходят позже.
  // Список заполняется сразу и после каждой загрузки/изменения наборов. pick — что положить, filter — что оставить.
  const liveLists = [];
  function liveList(kind, pick = i => i.table?.ru ?? i.id, filter = () => true) {
    const list = [];
    const fill = () => { list.length = 0; for (const i of items(kind)) if (filter(i)) list.push(pick(i)); };
    fill();
    liveLists.push(fill);
    return list;
  }
  function refreshLive() { for (const fill of liveLists) fill(); }

  function userSets() { return state.user.slice(); }
  // Импорт пользовательских наборов из JSON-текста: один набор или массив наборов.
  // id набора не должен совпадать со встроенным; повторный импорт того же id заменяет пользовательский набор.
  function importUser(text) {
    const parsed = typeof text === 'string' ? JSON.parse(text) : text;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (!list.length) throw new Error('В файле нет наборов');
    for (const s of list) {
      checkSet(s);
      if (state.builtin.some(b => b.id === s.id)) throw new Error(`id «${s.id}» занят встроенным набором`);
    }
    for (const s of list) state.user = state.user.filter(u => u.id !== s.id).concat([JSON.parse(JSON.stringify(s))]);
    saveUser();
    changed();
    return list.map(s => s.id);
  }
  function removeUser(id) {
    state.user = state.user.filter(u => u.id !== id);
    saveUser();
    changed();
  }
  // Открытые редакторы перерисовывают списки наборов по событию presets:changed.
  function changed() {
    refreshLive();
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent('presets:changed'));
  }

  // Диалог «Наборы данных»: список наборов, импорт своего JSON (файлом или текстом), удаление своих наборов.
  // Нужны window.el и window.modal из common.js; без них диалог недоступен.
  function openManager() {
    const { el, modal, toast } = window;
    const text = el('textarea', { rows: 8, placeholder: '{ "kind": "graph_starter", "id": "...", "name": "...", "items": [ ... ] }', style: 'width:100%;font-family:monospace' });
    const list = el('div', { class: 'preset-sets' });
    const kindLabel = { graph_starter: 'стартовые графы', item_preset: 'основы предметов', spell_preset: 'основы заклинаний', class_progression: 'таблицы развития', multiclass_slots: 'ячейки мультикласса' };
    const row = (set, own) => el('div', { class: 'preset-set-row', 'data-set': set.id },
      el('b', {}, set.name), ' ', el('span', { class: 'muted small' }, `${kindLabel[set.kind] || set.kind} · ${set.items.length} эл. · ${own ? 'ваш набор' : 'встроенный'}`),
      own ? el('button', { class: 'small danger', onclick: () => { removeUser(set.id); renderList(); } }, 'Удалить') : null);
    function renderList() {
      list.replaceChildren(...state.builtin.map(s => row(s, false)), ...state.user.map(s => row(s, true)));
    }
    renderList();
    const file = el('input', { type: 'file', accept: '.json,application/json', onchange: async e => { const f = e.target.files?.[0]; if (f) text.value = await f.text(); } });
    const content = el('div', {},
      el('p', { class: 'muted small' }, 'Набор — JSON. Встроенные наборы только читаются; свой набор хранится в этом браузере и подключается сразу.'),
      list, el('h3', {}, 'Импорт'), file, text);
    return modal('Наборы данных', content, [{ label: 'Импортировать', cls: 'primary', fn: () => {
      try {
        const ids = importUser(text.value);
        toast?.(`Импортировано: ${ids.join(', ')}`);
        return true;
      } catch (err) { toast?.('Не импортировано: ' + err.message); return false; }
    } }], { wide: true });
  }

  const api = {
    KINDS: Object.keys(KINDS),
    ready,
    load, sets, items, item, classProgression, multiclassSlots, classRules, liveList,
    userSets, importUser, removeUser, problemOf, openManager,
    get loaded() { return state.loaded; },
  };

  // В браузере наборы загружаются сразу; в тестах (vm без fetch) загрузку запускает сам тест.
  if (typeof window !== 'undefined') {
    window.Presets = api;
    if (typeof fetch === 'function' && typeof location !== 'undefined' && !window.PRESETS_MANUAL) load().catch(e => console.error('Наборы данных не загружены:', e.message));
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
