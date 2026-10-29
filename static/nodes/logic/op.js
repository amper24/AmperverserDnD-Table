// static/nodes/logic/op.js — узел «Логика» (logic.op): И / ИЛИ / НЕ.
(() => {
  const { GraphNode, register } = window.Nodes;
  const { LOGIC_OPS } = window.NodeRegistry;
  class LogicOp extends GraphNode {
    static type = 'logic.op';
    static label = 'Логика';
    static description = 'Логика: И, ИЛИ, НЕ для булевых значений.';
    static group = 'Логика';
    static inputs = { a: 'bool', b: 'bool' };
    static outputs = { value: 'bool' };
    static defaults = { op: 'and' };
    static isComputed = true;
    static validate(p) {
      if (p.op !== undefined && !LOGIC_OPS.includes(p.op)) return 'Логический узел: операция И, ИЛИ или НЕ.';
      return '';
    }
    static compute(p, get) {
      const a = get('a');
      if (p.op === 'not') return typeof a === 'boolean' ? !a : undefined;
      const b = get('b');
      if (p.op === 'or') { if (a === true || b === true) return true; return a === false && b === false ? false : undefined; }
      if (a === false || b === false) return false;
      return a === true && b === true ? true : undefined;
    }
  }
  register(LogicOp);
})();
