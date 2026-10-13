// static/nodes/rules/ability-bonus.js — правило «Бонус характеристики» (rule.ability_bonus).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { ABILITIES } = window.NodeRegistry;
  class RuleAbilityBonus extends GraphNode {
    static type = 'rule.ability_bonus';
    static label = 'Бонус характеристики';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool', amount: 'number' };
    static outputs = { effect: 'effect' };
    static defaults = { ability: 'str', amount: 1 };
    static isRule = true;
    static validate(p) {
      if (!ABILITIES.includes(p.ability) || (p.amount !== undefined && (!Number.isFinite(p.amount) || Math.abs(p.amount) > 1000))) return 'Бонус характеристики требует существующий ключ характеристики и конечную величину.';
      return '';
    }
    static project(p, env) {
      const ability = p.ability, amount = Number(env.value('amount')) || 0;
      if (ABILITIES.includes(ability)) { env.sheet.abilities[ability] = (Number(env.sheet.abilities[ability]) || 10) + amount; env.emit('ability_bonus', { ability, amount }); }
    }
  }
  register(RuleAbilityBonus);
})();
