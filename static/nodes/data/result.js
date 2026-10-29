// static/nodes/data/result.js — узел «Результат действия» (data.result).
// Читает итог последнего действия или конкретной программы из листа (action_results).
// Значение вычисляет сервер в рантайме; в редакторе и предпросмотре без результатов — 0.
(() => {
  const { GraphNode, register } = window.Nodes;
  class DataResult extends GraphNode {
    static type = 'data.result';
    static label = 'Результат действия';
    static group = 'Данные';
    static inputs = {};
    static outputs = { value: 'number' };
    static defaults = { source: 'last', field: 'total' };
    static isComputed = true;
    // Источник — «последнее действие» или программа этого графа (проверяет сервер), поле — из закрытого списка.
    static validate(p) {
      const source = String(p.source || '');
      if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(source)) return 'Результат: выберите последнее действие или программу этого графа.';
      if (!['total', 'hit', 'applied', 'spent'].includes(p.field)) return 'Результат действия: поле total, hit, applied или spent.';
      return '';
    }
    // Без состояния выполнения результата ещё нет: 0, чтобы предпросмотр строил числа и не падал.
    static compute() { return 0; }
  }
  register(DataResult);
})();
