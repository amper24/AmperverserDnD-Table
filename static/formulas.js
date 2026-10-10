// ---------------------------------------------------------------------------
// formulas.js — безопасный вычислитель формул механик (без eval и без произвольного кода).
// Грамматика: целые числа, + − * /, скобки, функции min(a,b…) и max(a,b…), переменные @name или name.
// Деление целочисленное с округлением вниз (как в правилах D&D).
// Переменные описаны данными (реестр VARIABLES): модификатор характеристики или поле листа.
// Чтобы добавить новую переменную, достаточно строки в VARIABLES — код менять не нужно.
// Загружается до equipment.js и mechanics-graph.js. Даёт: window.Formulas.
// ---------------------------------------------------------------------------
(() => {
  const MAX_LENGTH = 200, MAX_DEPTH = 24;
  const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const FUNCTIONS = { min: { min: 1 }, max: { min: 1 } };

  // Реестр переменных (данные). ability — модификатор характеристики листа; sheet — числовое поле листа.
  const VARIABLES = {
    ...Object.fromEntries(ABILITY_KEYS.map(key => [key, { ability: key }])),
    prof: { sheet: 'proficiency_bonus' },
    level: { sheet: 'level' },
  };

  // Устаревшие значения листа (до данных-правил) → правило защиты без доспехов из набора class_rules (поле legacy_unarmored).
  // Используются только для чтения старых листов; новые записи задают правило в данных класса.
  function legacyUnarmored(slug) {
    for (const edition of ['2014', '2024']) {
      const rule = window.Presets?.classRules(edition, slug)?.legacy_unarmored;
      if (rule) return rule;
    }
    return null;
  }

  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const modOf = score => Math.floor((Number(score ?? 10) - 10) / 2);

  // Значения переменных для листа: модификатор характеристики или числовое поле листа.
  function sheetVars(sheet = {}) {
    const out = {};
    for (const [name, def] of Object.entries(VARIABLES)) {
      if (def.ability) out[name] = modOf(sheet.abilities?.[def.ability]);
      else if (def.sheet) out[name] = Number(sheet[def.sheet]) || 0;
    }
    return out;
  }

  // Разбор в дерево. Ошибка — исключение с понятным текстом; вычисления не выполняются.
  function tokenize(text) {
    const tokens = [];
    const re = /\s+|(\d+)|(@?[a-z_][a-z0-9_]*)|([+\-*/(),])/gi;
    let match, last = 0;
    while ((match = re.exec(text)) !== null) {
      if (match.index !== last) throw new Error(`Неизвестный символ «${text[last]}» в формуле.`);
      last = re.lastIndex;
      if (match[1] !== undefined) tokens.push({ t: 'num', v: Number(match[1]) });
      else if (match[2] !== undefined) tokens.push({ t: 'id', v: match[2].replace(/^@/, '').toLowerCase() });
      else if (match[3] !== undefined) tokens.push({ t: 'op', v: match[3] });
    }
    if (last !== text.length) throw new Error(`Неизвестный символ «${text[last]}» в формуле.`);
    return tokens;
  }

  // allowed — допустимые имена переменных (по умолчанию переменные листа; модули передают свой набор).
  function parse(text, allowed = VARIABLES) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Формула пустая.');
    if (text.length > MAX_LENGTH) throw new Error(`Формула длиннее ${MAX_LENGTH} символов.`);
    const tokens = tokenize(text);
    let pos = 0, depth = 0;
    const peek = () => tokens[pos];
    const take = () => tokens[pos++];
    const isOp = (token, v) => token && token.t === 'op' && token.v === v;
    function enter() { if (++depth > MAX_DEPTH) throw new Error('Формула слишком вложенная.'); }
    function leave() { depth--; }

    function expr() {
      let node = term();
      while (isOp(peek(), '+') || isOp(peek(), '-')) {
        const op = take().v; node = { op, a: node, b: term() };
      }
      return node;
    }
    function term() {
      let node = unary();
      while (isOp(peek(), '*') || isOp(peek(), '/')) {
        const op = take().v; node = { op, a: node, b: unary() };
      }
      return node;
    }
    function unary() {
      if (isOp(peek(), '-')) { take(); return { op: 'neg', a: unary() }; }
      return primary();
    }
    function primary() {
      enter();
      const token = take();
      let node;
      if (!token) throw new Error('Формула обрывается.');
      if (token.t === 'num') node = { num: token.v };
      else if (isOp(token, '(')) {
        node = expr();
        if (!isOp(take(), ')')) throw new Error('Не хватает закрывающей скобки.');
      } else if (token.t === 'id' && isOp(peek(), '(')) {
        const fn = token.v;
        if (!own(FUNCTIONS, fn)) throw new Error(`Неизвестная функция «${fn}».`);
        take();
        const args = [expr()];
        while (isOp(peek(), ',')) { take(); args.push(expr()); }
        if (!isOp(take(), ')')) throw new Error('Не хватает закрывающей скобки у функции.');
        if (args.length < FUNCTIONS[fn].min) throw new Error(`Функция «${fn}» требует аргументы.`);
        node = { fn, args };
      } else if (token.t === 'id') {
        if (!own(allowed, token.v)) throw new Error(`Неизвестная переменная «${token.v}».`);
        node = { name: token.v };
      } else throw new Error('Неверный фрагмент формулы.');
      leave();
      return node;
    }

    const tree = expr();
    if (pos !== tokens.length) throw new Error('Лишний фрагмент в конце формулы.');
    return tree;
  }

  function run(node, vars) {
    if ('num' in node) return node.num;
    if ('name' in node) {
      const value = own(vars, node.name) ? vars[node.name] : undefined;
      if (!Number.isFinite(value)) throw new Error(`Нет значения для «${node.name}».`);
      return value;
    }
    if (node.fn) {
      const values = node.args.map(arg => run(arg, vars));
      return node.fn === 'min' ? Math.min(...values) : Math.max(...values);
    }
    if (node.op === 'neg') return -run(node.a, vars);
    const a = run(node.a, vars), b = run(node.b, vars);
    if (node.op === '+') return a + b;
    if (node.op === '-') return a - b;
    if (node.op === '*') return a * b;
    if (b === 0) throw new Error('Деление на ноль.');
    return Math.floor(a / b);
  }

  // Возвращает '' для корректной формулы или текст ошибки (для редактора и сервера).
  function validate(text) {
    try { parse(text); return ''; } catch (error) { return error.message; }
  }

  // Вычисляет формулу; vars — объект «имя → число» (по умолчанию переменные листа).
  // Возвращает null при ошибке, если не передан throwOnError.
  function evaluate(text, vars, { throwOnError = false, allowed = VARIABLES } = {}) {
    try { return run(parse(text, allowed), vars); } catch (error) { if (throwOnError) throw error; return null; }
  }

  // Старый синтаксис предметов: «14 + dex max 2» → «14+min(dex,2)».
  function normalizeLegacy(text) {
    return String(text).toLowerCase().replace(/\s+/g, '').replace(/([a-z_]+)max(\d+)/g, 'min($1,$2)');
  }

  // Правило защиты без доспехов текущего листа: новое поле или старая строка.
  function unarmoredRule(sheet) {
    const value = sheet?.unarmored_defense;
    if (value && typeof value === 'object' && typeof value.formula === 'string') return value;
    if (typeof value === 'string' && legacyUnarmored(value)) return legacyUnarmored(value);
    return null;
  }

  const API = { VARIABLES, FUNCTIONS, legacyUnarmored, modOf, sheetVars, validate, evaluate, normalizeLegacy, unarmoredRule, parse };
  window.Formulas = API;
})();
