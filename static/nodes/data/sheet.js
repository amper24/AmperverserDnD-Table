// static/nodes/data/sheet.js — узел «Поле листа» (data.sheet).
// Читает числовое поле листа (hp.current, level, abilities.str) в рантайме;
// в редакторе и предпросмотре без листа — 0.
(() => {
  const { GraphNode, register } = window.Nodes;
  class DataSheet extends GraphNode {
    static type = 'data.sheet';
    static label = 'Поле листа';
    static group = 'Данные';
    static inputs = {};
    static outputs = { value: 'number' };
    static defaults = { field: 'hp.current' };
    static isComputed = true;
    // Путь по вложенным ключам листа: непустой, из строчных латинских букв, цифр, «_» и «.».
    static validate(p) {
      const field = String(p.field || '');
      if (field.length > 100 || !/^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(field)) return 'Поле листа: непустой путь из латинских букв, цифр, «_» и «.» (например hp.current).';
      return '';
    }
    // Без листа значение неизвестно; предпросмотр показывает 0.
    static compute() { return 0; }
  }
  register(DataSheet);
})();
