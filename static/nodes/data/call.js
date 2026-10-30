// static/nodes/data/call.js — вызов группы-функции (data.call).
// Числовые аргументы a, b, c по порядку связываются с group.input, результат приводится
// к объявленному типу (number/text/bool/list). Вычисление группы — общий groupValue в
// mechanics-graph.js: он же проверяет рекурсию и глубину вызовов, сервер повторяет это
// в call_group_value (src/mechanics_graph.rs).
(() => {
  const { GraphNode, register } = window.Nodes;
  const FUNCTION_TYPES = ['number', 'text', 'bool', 'list'];
  // Приведение к типу функции: без значения — 0 / "" / false / []. Та же таблица на сервере.
  function coerce(type, value) {
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    if (type === 'text') return typeof value === 'string' ? value : '';
    if (type === 'bool') return typeof value === 'boolean' ? value : false;
    if (type === 'list') return Array.isArray(value) ? value : [];
    return undefined;
  }
  class DataCall extends GraphNode {
    static type = 'data.call';
    static label = 'Вызов группы';
    static description = 'Вызвать группу-функцию: числовые аргументы a, b, c и типизированный результат.';
    static group = 'Данные';
    static inputs = { a: 'number', b: 'number', c: 'number' };
    static outputs = { value: 'number' };
    static defaults = { group: '', result: 'number' };
    static isComputed = true;
    // Тип выхода зависит от параметра result, как у logic.op вход b зависит от операции.
    static ports(params = {}) {
      const result = FUNCTION_TYPES.includes(params.result) ? params.result : 'number';
      return { inputs: { a: 'number', b: 'number', c: 'number' }, outputs: { value: result } };
    }
    // Форма параметров проверяется здесь; существование группы, value-only, число входов,
    // совпадение типа результата и циклы проверяет граф (callError в mechanics-graph.js).
    static validate(p) {
      if (p.group !== undefined && (typeof p.group !== 'string' || p.group.length > 64)) return 'Вызов группы: ID группы — строка до 64 символов.';
      if (p.result !== undefined && !FUNCTION_TYPES.includes(p.result)) return 'Узел вызова: тип результата number, text, bool или list.';
      return '';
    }
    static compute(p, get, env) {
      const result = FUNCTION_TYPES.includes(p.result) ? p.result : 'number';
      const args = [get('a'), get('b'), get('c')];
      const value = env && typeof env.callGroup === 'function' ? env.callGroup(String(p.group || ''), args, result) : undefined;
      return coerce(result, value);
    }
  }
  register(DataCall);
})();
