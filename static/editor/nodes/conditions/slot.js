// static/nodes/conditions/slot.js — условие «Ячейки заклинаний» (condition.slot).
// Сравнивает остаток ячеек круга (sheet.spells.slots[level]: max − used) с числом;
// для круга Договора (level совпадает с pact_slots.level) берётся пул pact_slots.
// В редакторе и предпросмотре без листа — false.
(() => {
  const { GraphNode, register } = window.Nodes;
  const { SLOT_OPS } = window.NodeRegistry;
  class ConditionSlot extends GraphNode {
    static type = 'condition.slot';
    static label = 'Ячейки заклинаний';
    static description = 'Сравнить остаток ячеек выбранного круга с числом.';
    static group = 'Условия';
    static inputs = {};
    static outputs = { value: 'bool' };
    static defaults = { level: 1, op: 'gte', value: 1 };
    static isComputed = true;
    static validate(p) {
      if (!Number.isInteger(p.level) || p.level < 1 || p.level > 9) return 'Ячейки: круг от 1 до 9.';
      if (!SLOT_OPS.includes(p.op)) return 'Ячейки: операция gte или lt.';
      if (!Number.isInteger(p.value) || p.value < 0 || p.value > 20) return 'Ячейки: значение от 0 до 20.';
      return '';
    }
    static compute() { return false; }
  }
  register(ConditionSlot);
})();
