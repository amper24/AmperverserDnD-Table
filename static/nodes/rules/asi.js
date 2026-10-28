// static/nodes/rules/asi.js — правило «Улучшение характеристик» (rule.asi).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { tableValue } = window.NodeRegistry;
  class RuleAsi extends GraphNode {
    static type = 'rule.asi';
    static label = 'Улучшение характеристик';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool' };
    static outputs = { effect: 'effect' };
    static defaults = { table: { levels: { '4': { amount: 2 } } } };
    static isRule = true;
    static validate(p) {
      if (p.table !== undefined && !tableValue(p.table)) return 'Табличное правило должно содержать ограниченный JSON-объект.';
      return '';
    }
    static project(p, env) {
      const table = env.get('table') ?? p.table;
      if (table && typeof table === 'object') { env.sheet.asi_rules.push(env.clone(table)); env.emit('asi', { table }); }
    }
  }
  register(RuleAsi);
})();
