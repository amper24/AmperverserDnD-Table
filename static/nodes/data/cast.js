// static/nodes/data/cast.js — узел «Круг каста» (data.cast).
// Читает круг выбранной ячейки, базовый круг заклинания и число лишних кругов.
// Значение вычисляет сервер в рантайме; в редакторе и предпросмотре без каста — 0.
(() => {
  const { GraphNode, register } = window.Nodes;
  class DataCast extends GraphNode {
    static type = 'data.cast';
    static label = 'Круг каста';
    static description = 'Круг выбранной ячейки, базовый круг заклинания и число лишних кругов.';
    static group = 'Данные';
    static inputs = {};
    static outputs = { value: 'number' };
    static defaults = { field: 'level' };
    static isComputed = true;
    static validate(p) {
      if (!['level', 'base', 'extra'].includes(p.field)) return 'Круг каста: поле level, base или extra.';
      return '';
    }
    // Без состояния выполнения каста ещё нет: 0, чтобы предпросмотр строил числа и не падал.
    static compute() { return 0; }
  }
  register(DataCast);
})();
