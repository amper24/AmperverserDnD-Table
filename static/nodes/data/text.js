// static/nodes/data/text.js — строковый узел «Текст» (data.text).
// Операции одной таблицей с сервером: NodeRegistry.textValue и text_value в src/mechanics_graph.rs.
(() => {
  const { GraphNode, register } = window.Nodes;
  const { TEXT_OPS, textValue } = window.NodeRegistry;
  class DataText extends GraphNode {
    static type = 'data.text';
    static label = 'Текст';
    static description = 'Строка из двух значений: склеить, верхний или нижний регистр, обрезать пробелы.';
    static group = 'Данные';
    // a обязателен; b читает только concat — у остальных операций лишний вход не используется.
    static inputs = { a: 'text', b: 'text' };
    static outputs = { value: 'text' };
    static defaults = { op: 'concat' };
    static isComputed = true;
    static validate(p) { return TEXT_OPS.includes(p.op) ? '' : 'Текст: допустимы concat, upper, lower и trim.'; }
    static compute(p, get) { return textValue(p.op, get('a'), get('b')); }
  }
  register(DataText);
})();
