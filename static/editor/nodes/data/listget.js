// static/nodes/data/listget.js — элемент списка по индексу (data.listget): выход text.
// Индекс с нуля; вне диапазона и без провода — пустая строка (как list_get в src/mechanics_graph.rs).
(() => {
  const { GraphNode, register } = window.Nodes;
  class DataListGet extends GraphNode {
    static type = 'data.listget';
    static label = 'Элемент списка';
    static description = 'Строка списка по номеру: индекс с нуля, вне диапазона — пустая строка.';
    static group = 'Данные';
    static inputs = { list: 'list', index: 'number' };
    static outputs = { value: 'text' };
    static defaults = {};
    static isComputed = true;
    static compute(p, get) {
      const items = get('list'), index = get('index');
      if (!Array.isArray(items) || typeof index !== 'number' || !Number.isFinite(index)) return '';
      const position = Math.trunc(index);
      return position >= 0 && position < items.length ? String(items[position] ?? '') : '';
    }
  }
  register(DataListGet);
})();
