// static/nodes/data/table.js — узел «Таблица по уровню» (data.table).
(() => {
  const { GraphNode, register } = window.Nodes;
  class DataTable extends GraphNode {
    static type = 'data.table';
    static label = 'Таблица по уровню';
    static group = 'Данные';
    static inputs = {};
    static outputs = { value: 'table' };
    static defaults = { value: { '1': 0 } };
    static validate(p) {
      if (!p.value || typeof p.value !== 'object' || Array.isArray(p.value)) return 'Табличный узел должен содержать JSON-объект.';
      return '';
    }
  }
  register(DataTable);
})();
