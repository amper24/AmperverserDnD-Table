// static/nodes/rules/spell-list.js — правило «Список заклинаний» (rule.spell_list).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { ABILITIES, stringList } = window.NodeRegistry;
  class RuleSpellList extends GraphNode {
    static type = 'rule.spell_list';
    static label = 'Список заклинаний';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool', spells: 'list' };
    static outputs = { effect: 'effect' };
    static defaults = { mode: 'known', ability: 'int', spells: [] };
    static isRule = true;
    static validate(p) {
      if (!['known', 'prepared', 'book'].includes(p.mode) || (p.ability !== undefined && !ABILITIES.includes(p.ability)) || !stringList(p.spells)) return 'Список заклинаний: режим, список и характеристика должны быть допустимы.';
      return '';
    }
    static project(p, env) {
      const spells = env.valuesOf(env.get('spells') ?? p.spells);
      env.sheet.spell_rules.push({ mode: p.mode, ability: p.ability || '', spells: env.clone(spells) }); env.emit('spell_list', { mode: p.mode, ability: p.ability || '', spells });
    }
  }
  register(RuleSpellList);
})();
