// static/nodes/data/ref.js — узел «Ссылка на узел» (data.ref).
// Числовое значение другого узла этого же графа (в группе — её собственных узлов).
// Существование цели, запрет себя и циклов проверяет граф (verifyRef в mechanics-graph.js
// и src/mechanics_graph.rs); форма выбирает узел из текущего графа.
(() => {
  const { GraphNode, register } = window.Nodes;
  class DataRef extends GraphNode {
    static type = 'data.ref';
    static label = 'Ссылка на узел';
    static description = 'Прочитать число другого узла графа.';
    static group = 'Данные';
    static inputs = {};
    static outputs = { value: 'number' };
    static defaults = { node: '' };
    static isComputed = true;
    // Цель выбирается в форме из текущего графа; здесь проверяется только форма ID.
    static validate(p) {
      if (p.node !== undefined && (typeof p.node !== 'string' || p.node.length > 100)) return 'Ссылка: ID узла — строка до 100 символов.';
      return '';
    }
    // Резервное значение: графовые движки разворачивают ссылку до вызова compute.
    static compute() { return 0; }
  }
  register(DataRef);
})();
