// static/nodes/rules/value.js — универсальное правило-значение (rule.value + kind).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { ABILITIES, RULE_VALUE_KINDS, tableValue } = window.NodeRegistry;
  const safeFormula = formula => typeof formula === 'string' && formula.length > 0 && formula.length <= 100 && /^[A-Za-z0-9+\-*@_(), .\t\r\n]+$/.test(formula);
  class RuleValue extends GraphNode {
    static type = 'rule.value';
    static label = 'Правило';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool', amount: 'number' };
    static outputs = { effect: 'effect' };
    static defaults = { kind: 'speed', amount: 30 };
    static isRule = true;
    static validate(p) {
      const kind = p.kind;
      if (!Object.hasOwn(RULE_VALUE_KINDS, kind)) return 'Правило: выберите вид из списка.';
      if (kind === 'ability' && (!ABILITIES.includes(p.ability) || (p.amount !== undefined && (!Number.isFinite(p.amount) || Math.abs(p.amount) > 1000)))) return 'Бонус характеристики требует существующий ключ характеристики и конечную величину.';
      if (kind === 'speed' && p.amount !== undefined && (!Number.isInteger(p.amount) || p.amount < 0 || p.amount > 1000)) return 'Скорость должна быть целым числом от 0 до 1000.';
      if (kind === 'hp' && p.amount !== undefined && (!Number.isInteger(p.amount) || Math.abs(p.amount) > 1000)) return 'Бонус хитов: целое от −1000 до 1000.';
      if (kind === 'hit_die' && p.value !== undefined && !/^d(?:6|8|10|12)$/.test(p.value)) return 'Кость хитов: d6, d8, d10 или d12.';
      if (kind === 'asi' && p.table !== undefined && !tableValue(p.table)) return 'Табличное правило должно содержать ограниченный JSON-объект.';
      if (kind === 'armor_formula' && !safeFormula(p.formula)) return 'Формула защиты без доспехов содержит только числа, характеристики, min/max и арифметические символы.';
      return '';
    }
    static project(p, env) {
      const amount = Number(env.value('amount') ?? p.amount) || 0;
      switch (p.kind) {
        case 'ability': { const ability = p.ability; if (ABILITIES.includes(ability)) { env.sheet.abilities[ability] = (Number(env.sheet.abilities[ability]) || 10) + amount; env.emit('ability_bonus', { ability, amount }); } break; }
        case 'speed': { const v = Number(env.value('amount') ?? p.amount); if (Number.isFinite(v)) { env.sheet.speed = v; env.emit('speed', { value: v }); } break; }
        case 'hp': { env.sheet.hp.max += amount; env.sheet.hp.current += amount; env.emit('hp_bonus', { amount }); break; }
        case 'hit_die': { const die = p.value; if (die) { env.sheet.hp.hit_dice = `1${die}`; env.emit('hit_die', { value: die }); } break; }
        case 'asi': { const table = env.get('table') ?? p.table; if (table && typeof table === 'object') { env.sheet.asi_rules.push(env.clone(table)); env.emit('asi', { table }); } break; }
        case 'armor_formula': { const rule = { formula: String(p.formula ?? ''), name: String(p.name || 'Защита без доспехов').slice(0, 120), no_shield: Boolean(p.no_shield) }; env.sheet.unarmored_defense = env.clone(rule); env.emit('unarmored_defense', rule); break; }
      }
    }
  }
  register(RuleValue);
})();