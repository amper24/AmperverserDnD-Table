// static/nodes/rules/saving-throws.js — правило «Спасброски» (rule.saving_throws).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { ABILITIES } = window.NodeRegistry;
  class RuleSavingThrows extends GraphNode {
    static type = 'rule.saving_throws';
    static label = 'Спасброски';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool', value: 'list' };
    static outputs = { effect: 'effect' };
    static defaults = { value: [] };
    static isRule = true;
    static validate(p) {
      if (p.value !== undefined && (!Array.isArray(p.value) || p.value.length > 6 || p.value.some(v => !ABILITIES.includes(v)))) return 'Спасброски должны быть списком характеристик.';
      return '';
    }
    static project(p, env) {
      const saves = env.valuesOf(env.value('value')).filter(x => ABILITIES.includes(x));
      env.sheet.saving_throws = [...new Set([...env.sheet.saving_throws, ...saves])]; env.emit('saving_throws', { values: saves });
    }
  }
  register(RuleSavingThrows);
})();
