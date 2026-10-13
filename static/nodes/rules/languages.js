// static/nodes/rules/languages.js — правило «Языки» (rule.languages).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { stringList } = window.NodeRegistry;
  class RuleLanguages extends GraphNode {
    static type = 'rule.languages';
    static label = 'Языки';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool', value: 'list' };
    static outputs = { effect: 'effect' };
    static defaults = { value: [] };
    static isRule = true;
    static validate(p) {
      if (p.value !== undefined && !stringList(p.value)) return 'Языки должны быть списком текстовых значений.';
      return '';
    }
    static project(p, env) {
      const langs = env.valuesOf(env.value('value')).map(String).filter(Boolean);
      env.sheet.languages.push(...langs); env.appendProficiency(env.sheet, 'Языки', langs); env.emit('languages', { values: langs });
    }
  }
  register(RuleLanguages);
})();
