// static/nodes/logic/op.js — узел «Логика» (logic.op): И / ИЛИ / НЕ / исключающее ИЛИ / И-НЕ / ИЛИ-НЕ /
// равнозначность / импликация. НЕ использует только вход «a»; остальные операции — «a» и «b».
// Таблица истинности совпадает с сервером (src/mechanics_graph.rs, graph_output_value).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { LOGIC_OPS } = window.NodeRegistry;
  class LogicOp extends GraphNode {
    static type = 'logic.op';
    static label = 'Логика';
    static description = 'Логика: И, ИЛИ, НЕ, исключающее ИЛИ, И-НЕ, ИЛИ-НЕ, равнозначность, импликация.';
    static group = 'Логика';
    static inputs = { a: 'bool', b: 'bool' };
    static outputs = { value: 'bool' };
    static defaults = { op: 'and' };
    static isComputed = true;
    // Порты зависят от операции: у «НЕ» вход «b» не нужен, и лишний провод к нему не появится.
    static ports(p) {
      return (p || {}).op === 'not' ? { inputs: { a: 'bool' }, outputs: { value: 'bool' } } : { inputs: { a: 'bool', b: 'bool' }, outputs: { value: 'bool' } };
    }
    static validate(p) {
      if (p.op !== undefined && !LOGIC_OPS.includes(p.op)) {
        return `Логический узел: операция ${LOGIC_OPS.join(', ')}.`;
      }
      return '';
    }
    // Таблица истинности: неизвестный вход делает результат неизвестным, кроме случаев,
    // где значение операции определено уже одним входом (И с ложью, ИЛИ с истиной, И-НЕ, ИЛИ-НЕ, импликация).
    static compute(p, get) {
      const a = get('a');
      switch (p.op) {
        case 'not': return typeof a === 'boolean' ? !a : undefined;
        case 'xor': { const b = get('b'); return typeof a === 'boolean' && typeof b === 'boolean' ? a !== b : undefined; }
        case 'xnor': { const b = get('b'); return typeof a === 'boolean' && typeof b === 'boolean' ? a === b : undefined; }
        case 'or': { const b = get('b'); if (a === true || b === true) return true; return a === false && b === false ? false : undefined; }
        case 'nor': { const b = get('b'); if (a === true || b === true) return false; return a === false && b === false ? true : undefined; }
        case 'implies': { const b = get('b'); if (a === false || b === true) return true; return a === true && b === false ? false : undefined; }
        case 'nand': { const b = get('b'); if (a === false || b === false) return true; return a === true && b === true ? false : undefined; }
        default: { const b = get('b'); if (a === false || b === false) return false; return a === true && b === true ? true : undefined; }
      }
    }
  }
  register(LogicOp);
})();
