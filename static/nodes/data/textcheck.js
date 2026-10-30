// static/nodes/data/textcheck.js — сравнение строк (data.textcheck): выход bool.
// Таблица операций одна с сервером: NodeRegistry.textCheckValue и text_check_value в src/mechanics_graph.rs.
(() => {
  const { GraphNode, register } = window.Nodes;
  const { TEXT_CHECK_OPS, textCheckValue } = window.NodeRegistry;
  class DataTextCheck extends GraphNode {
    static type = 'data.textcheck';
    static label = 'Сравнить строки';
    static description = 'Сравнение строк: содержит, начинается, заканчивается, равно или не равно.';
    static group = 'Данные';
    static inputs = { a: 'text', b: 'text' };
    static outputs = { value: 'bool' };
    // case=false — без учёта регистра (по умолчанию); true — регистр важен.
    static defaults = { op: 'contains', case: false };
    static isComputed = true;
    static validate(p) {
      if (!TEXT_CHECK_OPS.includes(p.op)) return 'Сравнение строк: допустимы contains, starts, ends, eq и ne.';
      return typeof p.case === 'boolean' ? '' : 'Сравнение строк: параметр case — true или false.';
    }
    static compute(p, get) { return textCheckValue(p.op, get('a'), get('b'), p.case); }
  }
  register(DataTextCheck);
})();
