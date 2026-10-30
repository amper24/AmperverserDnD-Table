// static/nodes/data/list.js — литерал списка строк (data.list).
// Значение — параметр items: у узла нет входов, поэтому список доступен без состояния выполнения
// (как на сервере: graph_output_value берёт items и не читает провода).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { stringList, listItems } = window.NodeRegistry;
  class DataList extends GraphNode {
    static type = 'data.list';
    static label = 'Список';
    static description = 'Литерал списка строк: до 100 значений по 200 символов для склейки и поиска.';
    static group = 'Данные';
    static inputs = {};
    static outputs = { value: 'list' };
    static defaults = { items: [] };
    static isComputed = true;
    static validate(p) { return stringList(p.items) ? '' : 'Список: items — массив до 100 строк по 200 символов.'; }
    static compute(p) { return listItems(p.items); }
  }
  register(DataList);
})();
