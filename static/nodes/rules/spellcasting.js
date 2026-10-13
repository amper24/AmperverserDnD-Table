// static/nodes/rules/spellcasting.js — правило «Заклинательная характеристика» (rule.spellcasting).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { ABILITIES } = window.NodeRegistry;
  class RuleSpellcasting extends GraphNode {
    static type = 'rule.spellcasting';
    static label = 'Заклинательная характеристика';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool' };
    static outputs = { effect: 'effect' };
    static defaults = { ability: 'int' };
    static isRule = true;
    static validate(p) {
      if (!ABILITIES.includes(p.ability)) return 'Выберите заклинательную характеристику из закрытого списка.';
      return '';
    }
    static project(p, env) {
      env.sheet.spellcasting = p.ability; env.emit('spellcasting', { ability: p.ability });
    }
  }
  register(RuleSpellcasting);
})();
