// static/nodes/conditions/item.js — условие «Есть предмет» (condition.item).
// Ищет предмет по имени в снаряжении листа (sheet.inventory); режим equipped дополнительно
// требует флаг equipped. В редакторе и предпросмотре без листа — false.
(() => {
  const { GraphNode, register } = window.Nodes;
  const { ITEM_MODES } = window.NodeRegistry;
  class ConditionItem extends GraphNode {
    static type = 'condition.item';
    static label = 'Есть предмет';
    static description = 'Есть ли предмет в снаряжении листа — в сумке или надетым.';
    static group = 'Условия';
    static inputs = {};
    static outputs = { value: 'bool' };
    static defaults = { name: 'Кинжал', mode: 'owned' };
    static isComputed = true;
    static validate(p) {
      const name = typeof p.name === 'string' ? p.name.trim() : '';
      if (!name || name.length > 120) return 'Предмет: название от 1 до 120 символов.';
      if (!ITEM_MODES.includes(p.mode)) return 'Предмет: режим owned или equipped.';
      return '';
    }
    static compute() { return false; }
  }
  register(ConditionItem);
})();
