// static/nodes/rules/hp-bonus.js — правило «Бонус хитов» (rule.hp_bonus).
(() => {
  const { GraphNode, register } = window.Nodes;
  class RuleHpBonus extends GraphNode {
    static type = 'rule.hp_bonus';
    static label = 'Бонус хитов';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool', amount: 'number' };
    static outputs = { effect: 'effect' };
    static defaults = { amount: 1 };
    static isRule = true;
    static validate(p) {
      if (p.amount !== undefined && (!Number.isInteger(p.amount) || Math.abs(p.amount) > 1000)) return 'Бонус хитов: целое от −1000 до 1000.';
      return '';
    }
    static project(p, env) {
      const amount = Number(env.get('amount') ?? p.amount) || 0;
      env.sheet.hp.max += amount; env.sheet.hp.current += amount; env.emit('hp_bonus', { amount });
    }
  }
  register(RuleHpBonus);
})();
