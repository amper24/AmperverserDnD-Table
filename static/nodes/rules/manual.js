// static/nodes/rules/manual.js — правило «Ручное правило» (rule.manual).
(() => {
  const { GraphNode, register } = window.Nodes;
  class RuleManual extends GraphNode {
    static type = 'rule.manual';
    static label = 'Ручное правило';
    static description = 'Ручное правило пассивной программы.';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool' };
    static outputs = { effect: 'effect' };
    static defaults = { text: 'Опишите правило, которое применяется вручную.' };
    static isRule = true;
    static validate(p) {
      if (typeof p.text !== 'string' || p.text.length > 4000) return 'Ручное правило: до 4000 символов.';
      return '';
    }
    static project(p, env) {
      const text = String(env.get('text') ?? p.text ?? '');
      env.sheet.manual_rules.push(text); env.emit('manual', { text });
    }
  }
  register(RuleManual);
})();
