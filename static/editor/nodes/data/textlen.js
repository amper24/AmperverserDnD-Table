// static/nodes/data/textlen.js — длина строки (data.textlen).
// Символы Unicode (кодовые точки): таблица та же, что text_value/text_length в src/mechanics_graph.rs.
(() => {
  const { GraphNode, register } = window.Nodes;
  const { textLength } = window.NodeRegistry;
  class DataTextLen extends GraphNode {
    static type = 'data.textlen';
    static label = 'Длина строки';
    static description = 'Сколько символов в строке (Unicode): длина текста для сравнений и условий.';
    static group = 'Данные';
    static inputs = { a: 'text' };
    static outputs = { value: 'number' };
    static defaults = {};
    static isComputed = true;
    // Без провода вход читается пустой строкой: длина 0.
    static compute(p, get) { return textLength(get('a')); }
  }
  register(DataTextLen);
})();
