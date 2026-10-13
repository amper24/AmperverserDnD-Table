// static/nodes/rules/speed.js — правило «Скорость» (rule.speed).
(() => {
  const { GraphNode, register } = window.Nodes;
  class RuleSpeed extends GraphNode {
    static type = 'rule.speed';
    static label = 'Скорость';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool', value: 'number' };
    static outputs = { effect: 'effect' };
    static defaults = { value: 30 };
    static isRule = true;
    static validate(p) {
      if (p.value !== undefined && (!Number.isInteger(p.value) || p.value < 0 || p.value > 1000)) return 'Скорость должна быть целым числом от 0 до 1000.';
      return '';
    }
    static project(p, env) {
      const v = Number(env.value('value'));
      if (Number.isFinite(v)) { env.sheet.speed = v; env.emit('speed', { value: v }); }
    }
  }
  register(RuleSpeed);
})();
