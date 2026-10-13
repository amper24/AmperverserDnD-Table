// static/nodes/rules/armor-formula.js — правило «Защита без доспехов» (rule.armor_formula).
(() => {
  const { GraphNode, register } = window.Nodes;
  class RuleArmorFormula extends GraphNode {
    static type = 'rule.armor_formula';
    static label = 'Защита без доспехов';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool', formula: 'text' };
    static outputs = { effect: 'effect' };
    static defaults = { formula: '10 + @dex + @con', name: 'Защита без доспехов', no_shield: false };
    static isRule = true;
    static validate(p) {
      const formulaError = typeof p.formula === 'string' && p.formula.length <= 100 ? window.Formulas.validate(p.formula) : 'Формула защиты: строка до 100 символов.';
      if (formulaError) return `Формула защиты без доспехов: ${formulaError}`;
      if (p.name !== undefined && (typeof p.name !== 'string' || p.name.length > 120)) return 'Название защиты без доспехов: строка до 120 символов.';
      if (p.no_shield !== undefined && typeof p.no_shield !== 'boolean') return 'Запрет щита: логическое значение.';
      return '';
    }
    static project(p, env) {
      const rule = { formula: String(env.get('formula') ?? p.formula ?? ''), name: String(p.name || 'Защита без доспехов').slice(0, 120), no_shield: Boolean(p.no_shield) };
      env.sheet.unarmored_defense = env.clone(rule); env.emit('unarmored_defense', rule);
    }
  }
  register(RuleArmorFormula);
})();
