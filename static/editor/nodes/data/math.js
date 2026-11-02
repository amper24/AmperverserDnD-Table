// static/nodes/data/math.js — арифметика над числами (data.math).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { MATH_OPS } = window.NodeRegistry;
  class DataMath extends GraphNode {
    static type = 'data.math';
    static label = 'Вычислить';
    static description = 'Арифметика: сложить, вычесть, умножить, разделить, минимум, максимум.';
    static group = 'Данные';
    static inputs = { a: 'number', b: 'number' };
    static outputs = { value: 'number' };
    static defaults = { op: 'add' };
    static isComputed = true;
    static validate(p) { return MATH_OPS.includes(p.op) ? '' : 'Вычисление: допустимы add, sub, mul, div, min и max.'; }
    static compute(p, get) {
      const a = get('a'), b = get('b');
      if (typeof a !== 'number' || typeof b !== 'number') return undefined;
      if (p.op === 'add') return a + b;
      if (p.op === 'sub') return a - b;
      if (p.op === 'mul') return a * b;
      if (p.op === 'div') return b === 0 ? undefined : a / b;
      if (p.op === 'min') return Math.min(a, b);
      if (p.op === 'max') return Math.max(a, b);
      return undefined;
    }
  }
  register(DataMath);
})();