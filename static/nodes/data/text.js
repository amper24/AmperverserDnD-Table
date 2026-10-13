// static/nodes/data/text.js — узел «Текст» (data.text).
(() => {
  const { GraphNode, register } = window.Nodes;
  class DataText extends GraphNode {
    static type = 'data.text';
    static label = 'Текст';
    static group = 'Данные';
    static inputs = {};
    static outputs = { value: 'text' };
    static defaults = { value: '' };
    static validate(p) {
      if (typeof p.value !== 'string' || p.value.length > 4000) return 'Текстовый узел: до 4000 символов.';
      return '';
    }
  }
  register(DataText);
})();
