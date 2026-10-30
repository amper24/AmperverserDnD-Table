// static/nodes/data/listjoin.js — склейка списка в строку (data.listjoin): выход text.
// Разделитель — параметр (по умолчанию «, », до 10 символов); без провода список пуст.
(() => {
  const { GraphNode, register } = window.Nodes;
  class DataListJoin extends GraphNode {
    static type = 'data.listjoin';
    static label = 'Склеить список';
    static description = 'Склейка списка в строку через разделитель: подпись, перечисление, текст.';
    static group = 'Данные';
    static inputs = { list: 'list' };
    static outputs = { value: 'text' };
    static defaults = { separator: ', ' };
    static isComputed = true;
    static validate(p) {
      if (p.separator === undefined) return '';
      return typeof p.separator === 'string' && p.separator.length <= 10 ? '' : 'Склейка: разделитель — строка до 10 символов.';
    }
    static compute(p, get) {
      const items = get('list');
      if (!Array.isArray(items)) return '';
      return items.map(item => typeof item === 'string' ? item : '').join(typeof p.separator === 'string' ? p.separator : ', ');
    }
  }
  register(DataListJoin);
})();
