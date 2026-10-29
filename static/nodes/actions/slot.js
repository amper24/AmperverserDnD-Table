// static/nodes/actions/slot.js — узел «Расход ячейки» (action.slot).
// Отдельный глагол заклинания: списывает ячейку выбранного при касте круга (level 0)
// или фиксированного круга (1–9). В плане — блок consume с resource=slot.
(() => {
  const { GraphNode, register, actionDefaults } = window.Nodes;
  class ActionSlot extends GraphNode {
    static type = 'action.slot';
    static label = 'Расход ячейки';
    static description = 'Списывает ячейку заклинания выбранного или фиксированного круга.';
    static group = 'Действия';
    static inputs = { exec: 'flow', enabled: 'bool', condition: 'bool' };
    static outputs = { exec: 'flow' };
    static defaults = actionDefaults('slot');
    static isAction = true;
    // Контракт блока consume: level 0 означает «круг, выбранный при касте», 1–9 — свой круг.
    static blockParams(params) {
      const p = { ...params };
      const level = Number.isInteger(p.level) ? p.level : 0;
      delete p.level;
      p.resource = 'slot';
      p.source = 'self';
      p.trigger = 'use';
      p.slot_level = level;
      if (!Number.isInteger(p.amount)) p.amount = 1;
      return p;
    }
    static validate(p) {
      if (!Number.isInteger(p.level) || p.level < 0 || p.level > 9) return 'Круг ячейки: целое от 0 до 9 (0 — круг каста).';
      if (!Number.isInteger(p.amount) || p.amount < 1 || p.amount > 10000) return 'Количество ячеек: целое от 1 до 10000.';
      return '';
    }
  }
  register(ActionSlot);
})();
