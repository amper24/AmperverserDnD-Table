// static/nodes/data/listlen.js — длина списка (data.listlen): выход number.
// Без провода список пуст: длина 0 (как list_len в src/mechanics_graph.rs).
(() => {
  const { GraphNode, register } = window.Nodes;
  class DataListLen extends GraphNode {
    static type = 'data.listlen';
    static label = 'Длина списка';
    static description = 'Сколько элементов в списке: число для сравнений и условий блока.';
    static group = 'Данные';
    static inputs = { list: 'list' };
    static outputs = { value: 'number' };
    static defaults = {};
    static isComputed = true;
    static compute(p, get) { const items = get('list'); return Array.isArray(items) ? items.length : 0; }
  }
  register(DataListLen);
})();
