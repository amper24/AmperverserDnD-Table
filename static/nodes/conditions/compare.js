// static/nodes/conditions/compare.js — условие «Сравнить числа» (condition.compare).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { COMPARE_OPS } = window.NodeRegistry;
  class ConditionCompare extends GraphNode {
    static type = 'condition.compare';
    static label = 'Сравнить числа';
    static group = 'Условия';
    static inputs = { a: 'number', b: 'number' };
    static outputs = { value: 'bool' };
    static defaults = { op: '>=' };
    static isComputed = true;
    static validate(p) {
      if (!Object.hasOwn(COMPARE_OPS, p.op)) return 'Сравнение: допустимы >=, <=, >, <, = и !=.';
      return '';
    }
    static compute(p, get) {
      const a = get('a'), b = get('b');
      return typeof a === 'number' && typeof b === 'number' && COMPARE_OPS[p.op] ? COMPARE_OPS[p.op](a, b) : undefined;
    }
  }
  register(ConditionCompare);
})();
