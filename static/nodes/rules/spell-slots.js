// static/nodes/rules/spell-slots.js — правило «Ячейки заклинаний» (rule.spell_slots).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { tableValue } = window.NodeRegistry;
  class RuleSpellSlots extends GraphNode {
    static type = 'rule.spell_slots';
    static label = 'Ячейки заклинаний';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool', table: 'table' };
    static outputs = { effect: 'effect' };
    static defaults = { table: { levels: { '1': { slots: [2, 0, 0, 0, 0, 0, 0, 0, 0] } } } };
    static isRule = true;
    static validate(p) {
      if (p.table !== undefined && !tableValue(p.table)) return 'Табличное правило должно содержать ограниченный JSON-объект.';
      return '';
    }
    static project(p, env) {
      const table = env.get('table') ?? p.table;
      if (table && typeof table === 'object') { env.sheet.spell_progression.slots = env.clone(table); env.emit('spell_slots', { table }); }
    }
  }
  register(RuleSpellSlots);
})();
