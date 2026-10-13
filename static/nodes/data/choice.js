// static/nodes/data/choice.js — узел «Выбор» (data.choice).
(() => {
  const { GraphNode, register } = window.Nodes;
  class DataChoice extends GraphNode {
    static type = 'data.choice';
    static label = 'Выбор';
    static group = 'Данные';
    static inputs = {};
    static outputs = { value: 'choice' };
    static defaults = { value: { id: '', count: 1, options: [] } };
    static validate(p) {
      if (!p.value || typeof p.value !== 'object' || Array.isArray(p.value)) return 'Узел выбора должен содержать JSON-объект.';
      return '';
    }
  }
  register(DataChoice);
})();
