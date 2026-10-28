// static/nodes/rules/class-features.js — правило «Умения класса» (rule.class_features): таблица умений по уровням.
(() => {
  const { GraphNode, register } = window.Nodes;
  const { tableValue } = window.NodeRegistry;
  class RuleClassFeatures extends GraphNode {
    static type = 'rule.class_features';
    static label = 'Умения класса';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool' };
    static outputs = { effect: 'effect' };
    static defaults = { table: { levels: { '1': [{ name: 'Новое умение', text: '' }] } } };
    static isRule = true;
    static validate(p) {
      if (p.table !== undefined && !tableValue(p.table)) return 'Табличное правило должно содержать ограниченный JSON-объект.';
      return '';
    }
    static project(p, env) {
      const table = env.get('table') ?? p.table;
      if (table && typeof table === 'object') { env.sheet.class_features = env.clone(table); env.emit('class_features', { table }); }
    }
  }
  register(RuleClassFeatures);
})();
