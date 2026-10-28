// static/nodes/rules/class.js — универсальное правило-класс (rule.class + kind).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { ABILITIES, RULE_CLASS_KINDS, tableValue } = window.NodeRegistry;
  class RuleClass extends GraphNode {
    static type = 'rule.class';
    static label = 'Класс';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool' };
    static outputs = { effect: 'effect' };
    static defaults = { kind: 'class_progression', table: { columns: [], levels: { '1': {} } } };
    static isRule = true;
    static validate(p) {
      const kind = p.kind;
      if (!Object.hasOwn(RULE_CLASS_KINDS, kind)) return 'Класс: неизвестный вид.';
      if ((kind === 'class_progression' || kind === 'class_rules' || kind === 'spell_slots') && p.table !== undefined && !tableValue(p.table)) return 'Табличное правило должно содержать ограниченный JSON-объект.';
      if (kind === 'spellcasting' && !ABILITIES.includes(p.ability)) return 'Выберите заклинательную характеристику из закрытого списка.';
      return '';
    }
    static project(p, env) {
      switch (p.kind) {
        case 'class_progression': {
          const table = env.get('table') ?? p.table;
          if (table && typeof table === 'object') { env.sheet.class_progression = env.clone(table); env.emit('class_progression', { table }); }
          break;
        }
        case 'class_rules': {
          const table = env.get('table') ?? p.table;
          if (table && typeof table === 'object') { env.sheet.class_rules = env.clone(table); env.emit('class_rules', { table }); }
          break;
        }
        case 'spell_slots': {
          const table = env.get('table') ?? p.table;
          if (table && typeof table === 'object') { env.sheet.spell_progression.slots = env.clone(table); env.emit('spell_slots', { table }); }
          break;
        }
        case 'spellcasting':
          env.sheet.spellcasting = p.ability; env.emit('spellcasting', { ability: p.ability });
          break;
      }
    }
  }
  register(RuleClass);
})();
