// static/nodes/rules/class-progression.js — правило «Прогрессия класса» (rule.class_progression).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { tableValue } = window.NodeRegistry;
  class RuleClassProgression extends GraphNode {
    static type = 'rule.class_progression';
    static label = 'Прогрессия класса';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool', table: 'table' };
    static outputs = { effect: 'effect' };
    static defaults = { table: { columns: [], levels: { '1': { pb: 2 } } } };
    static isRule = true;
    static validate(p) {
      if (p.table !== undefined && !tableValue(p.table)) return 'Табличное правило должно содержать ограниченный JSON-объект.';
      return '';
    }
    static project(p, env) {
      const table = env.get('table') ?? p.table;
      if (table && typeof table === 'object') { env.sheet.class_progression = env.clone(table); env.emit('class_progression', { table }); }
    }
  }
  register(RuleClassProgression);
})();
