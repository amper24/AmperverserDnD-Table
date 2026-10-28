// static/nodes/rules/hit-die.js — правило «Кость хитов» (rule.hit_die).
(() => {
  const { GraphNode, register } = window.Nodes;
  class RuleHitDie extends GraphNode {
    static type = 'rule.hit_die';
    static label = 'Кость хитов';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool' };
    static outputs = { effect: 'effect' };
    static defaults = { value: 'd8' };
    static isRule = true;
    static validate(p) {
      if (p.value !== undefined && (typeof p.value !== 'string' || !/^d(?:6|8|10|12)$/.test(p.value))) return 'Кость хитов: d6, d8, d10 или d12.';
      return '';
    }
    static project(p, env) {
      const die = env.value('value');
      if (die) { env.sheet.hp.hit_dice = `1${die}`; env.emit('hit_die', { value: die }); }
    }
  }
  register(RuleHitDie);
})();
