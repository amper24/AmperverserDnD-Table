// static/nodes/rules/feature.js — правило «Умение» (rule.feature).
(() => {
  const { GraphNode, register } = window.Nodes;
  class RuleFeature extends GraphNode {
    static type = 'rule.feature';
    static label = 'Умение';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool' };
    static outputs = { effect: 'effect' };
    static defaults = { name: 'Новое умение', text: '', feature_name: '' };
    static isRule = true;
    static validate(p) {
      if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 120 || (p.text !== undefined && (typeof p.text !== 'string' || p.text.length > 4000))) return 'Умение: название до 120 и текст до 4000 символов.';
      return '';
    }
    static project(p, env) {
      const feature = { name: p.name, text: p.text || '', source: env.context.source || '', mechanic_node_id: env.context.featureNodeId || '' };
      env.sheet.features.push(feature); env.emit('feature', { feature });
    }
  }
  register(RuleFeature);
})();
