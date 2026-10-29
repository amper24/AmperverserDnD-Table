// static/nodes/data/combine.js — узел «Сложить кости» (dice.combine).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { diceTerm } = window.NodeRegistry;
  class DiceCombine extends GraphNode {
    static type = 'dice.combine';
    static label = 'Сложить кости';
    static description = 'Сложить две кости в одну формулу.';
    static group = 'Данные';
    static inputs = { a: 'dice', b: 'dice' };
    static outputs = { value: 'dice' };
    static defaults = {};
    static isComputed = true;
    static compute(p, get) {
      const a = get('a'), b = get('b');
      return a && b ? { count: 0, sides: 6, bonus: 0, stat: '', advanced: `${diceTerm(a)}+${diceTerm(b)}` } : undefined;
    }
  }
  register(DiceCombine);
})();
