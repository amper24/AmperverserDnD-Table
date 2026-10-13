// static/nodes/rules/class-rules.js — правило «Правила класса» (rule.class_rules).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { tableValue } = window.NodeRegistry;
  class RuleClassRules extends GraphNode {
    static type = 'rule.class_rules';
    static label = 'Правила класса';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool', table: 'table' };
    static outputs = { effect: 'effect' };
    static defaults = { table: { caster: { level: '' }, multiclass: { requirements: [] } } };
    static isRule = true;
    static validate(p) {
      if (p.table !== undefined && !tableValue(p.table)) return 'Табличное правило должно содержать ограниченный JSON-объект.';
      return '';
    }
    static project(p, env) {
      const table = env.get('table') ?? p.table;
      if (table && typeof table === 'object') { env.sheet.class_rules = env.clone(table); env.emit('class_rules', { table }); }
    }
  }
  register(RuleClassRules);
})();
