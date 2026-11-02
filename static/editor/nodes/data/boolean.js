// static/nodes/data/boolean.js — логическая константа (data.boolean).
(() => {
  const { GraphNode, register } = window.Nodes;
  class DataBoolean extends GraphNode {
    static type = 'data.boolean';
    static label = 'Логическая константа';
    static description = 'Логическая константа true или false.';
    static group = 'Данные';
    static outputs = { value: 'bool' };
    static defaults = { value: true };
    static isComputed = true;
    static validate(p) { return typeof p.value === 'boolean' ? '' : 'Константа: значение true или false.'; }
    static compute(p) { return typeof p.value === 'boolean' ? p.value : undefined; }
  }
  register(DataBoolean);
})();