// ---------------------------------------------------------------------------
// sheet-vars.js — переменные листа (sheet.vars) для панели «Переменные…».
// Даёт: window.SheetVars — чистые проверки и нормализация без DOM:
// validName, nameError, parseValue, normalize, entries, upsert, remove.
// Зависимости: нет; подключается в sheet.html перед sheet.js.
// Имя и область совпадают с NodeRegistry.varName и проверками сервера.
// ---------------------------------------------------------------------------
(() => {
  // Имя переменной: 1–32 символа [a-z0-9_] — ровно как varName в node-registry.js
  // и как проверяет сервер в src/mechanics_graph.rs.
  const NAME = /^[a-z0-9_]{1,32}$/;
  const MAX_NAME = 32;
  const NAME_ERROR = 'Имя — 1–32 символа: латинские строчные буквы, цифры и «_».';
  const VALUE_ERROR = 'Значение — конечное число.';
  const validName = value => typeof value === 'string' && NAME.test(value);
  // Подсказка для формы добавления. Пустое имя и недопустимые символы получают
  // один текст: обе причины чинятся одинаково; занятое имя — отдельный текст.
  const nameError = (value, taken = []) => {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!validName(name)) return NAME_ERROR;
    if (Array.isArray(taken) && taken.includes(name)) return 'Такая переменная уже есть.';
    return '';
  };
  // Число из поля ввода: конечное, с запятой как десятичным разделителем
  // (русская раскладка) и пробелами по краям. Пустое/NaN/Infinity — null.
  const parseValue = value => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const text = value.trim().replace(',', '.');
    if (!text) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  };
  // sheet.vars — объект «имя → число». Мусор (массив, null, строки, NaN,
  // недопустимые имена) отбрасывается, числовые строки становятся числами.
  // Новый объект: вызывающий сам решает, записывать ли его в лист.
  function normalize(vars) {
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return {};
    // Object.fromEntries, а не out[name] = …: имя «__proto__» допустимо regex,
    // а обычное присваивание вызвало бы сеттер прототипа вместо своей пары.
    const pairs = [];
    for (const [name, value] of Object.entries(vars)) {
      if (!validName(name)) continue;
      const number = parseValue(value);
      if (number !== null) pairs.push([name, number]);
    }
    return Object.fromEntries(pairs);
  }
  // Пары в стабильном алфавитном порядке: Object.keys сортирует имена из одних
  // цифр иначе, чем остальные, а таблице нужен один порядок для любых имён.
  const entries = vars => Object.entries(normalize(vars)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // Добавить или заменить значение. Исходный объект не меняется; недопустимое
  // имя или значение возвращают нормализованную копию без изменений.
  function upsert(vars, name, value) {
    const out = normalize(vars);
    const number = parseValue(value);
    if (!validName(name) || number === null) return out;
    // Вычисляемое свойство в литерале тоже создаёт свою пару для «__proto__».
    return { ...out, [name]: number };
  }
  function remove(vars, name) {
    const out = normalize(vars);
    delete out[name];
    return out;
  }
  window.SheetVars = Object.freeze({ MAX_NAME, NAME_ERROR, VALUE_ERROR, validName, nameError, parseValue, normalize, entries, upsert, remove });
})();
