// static/nodes/conditions/edition.js — условие «Если редакция» (condition.edition).
(() => {
  const { GraphNode, register } = window.Nodes;
  class ConditionEdition extends GraphNode {
    static type = 'condition.edition';
    static label = 'Если редакция';
    static group = 'Условия';
    static inputs = {};
    static outputs = { value: 'bool' };
    static defaults = { editions: ['2014'] };
    static validate(p) {
      if (!Array.isArray(p.editions) || !p.editions.length || p.editions.length > 2 || p.editions.some(x => typeof x !== 'string' || !['2014', '2024'].includes(x))) return 'Условие редакции: один или несколько допустимых SRD.';
      return '';
    }
  }
  register(ConditionEdition);
})();
