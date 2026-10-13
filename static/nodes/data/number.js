// static/nodes/data/number.js — узел «Число» (data.number).
(() => {
  const { GraphNode, register } = window.Nodes;
  class DataNumber extends GraphNode {
    static type = 'data.number';
    static label = 'Число';
    static group = 'Данные';
    static inputs = {};
    static outputs = { value: 'number' };
    static defaults = { value: 1 };
    static validate(p) {
      if (!Number.isFinite(p.value)) return 'Числовой узел должен содержать конечное число.';
      return '';
    }
  }
  register(DataNumber);
})();
