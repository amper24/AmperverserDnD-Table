// static/nodes/data/mathfun.js — узел «Математика» (data.mathfun).
// Функции одного числа и диапазона. Таблица одна с сервером: NodeRegistry.mathfunValue
// и src/mechanics_graph.rs mathfun_value.
(() => {
  const { GraphNode, register } = window.Nodes;
  const { MATHFUN_OPS, mathfunValue } = window.NodeRegistry;
  class DataMathFun extends GraphNode {
    static type = 'data.mathfun';
    static label = 'Математика';
    static description = 'Функции чисел: минимум, максимум, clamp, модуль, округление, знак.';
    static group = 'Данные';
    // a обязателен; b нужен min/max, b и c — clamp; у остальных операций лишние входы не читаются.
    static inputs = { a: 'number', b: 'number', c: 'number' };
    static outputs = { value: 'number' };
    static defaults = { op: 'abs' };
    static isComputed = true;
    static validate(p) { return MATHFUN_OPS.includes(p.op) ? '' : 'Математика: допустимы min, max, clamp, abs, round, floor, ceil и sign.'; }
    static compute(p, get) { return mathfunValue(p.op, get('a'), get('b'), get('c')); }
  }
  register(DataMathFun);
})();
