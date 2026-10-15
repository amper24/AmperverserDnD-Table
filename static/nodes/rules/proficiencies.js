// static/nodes/rules/proficiencies.js — правило «Владения» (rule.proficiencies).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { stringList } = window.NodeRegistry;
  class RuleProficiencies extends GraphNode {
    static type = 'rule.proficiencies';
    static label = 'Владения';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool' };
    static outputs = { effect: 'effect' };
    static defaults = { kind: 'general', value: [] };
    static isRule = true;
    static validate(p) {
      if ((p.value !== undefined && !stringList(p.value)) || (p.kind !== undefined && (typeof p.kind !== 'string' || p.kind.length > 120))) return 'Владения должны быть списком и иметь короткий тип.';
      return '';
    }
    static project(p, env) {
      const profs = env.valuesOf(env.value('value')).map(String).filter(Boolean);
      env.appendProficiency(env.sheet, p.kind || 'Владения', profs); env.emit('proficiencies', { label: p.kind || 'Владения', values: profs });
    }
  }
  register(RuleProficiencies);
})();
