// static/nodes/conditions/hp.js — условие «Хиты» (condition.hp).
// Сравнивает текущие хиты листа (или процент от максимума при percent: true) с числом.
// В редакторе и предпросмотре без листа — false.
(() => {
  const { GraphNode, register } = window.Nodes;
  const { HP_OPS } = window.NodeRegistry;
  class ConditionHp extends GraphNode {
    static type = 'condition.hp';
    static label = 'Хиты';
    static description = 'Сравнить текущие хиты или их процент от максимума с числом.';
    static group = 'Условия';
    static inputs = {};
    static outputs = { value: 'bool' };
    static defaults = { op: 'lt', value: 50, percent: false };
    static isComputed = true;
    static validate(p) {
      if (!HP_OPS.includes(p.op)) return 'Хиты: операция lt, le, gt или ge.';
      const limit = p.percent === true ? 100 : 1_000_000;
      if (!Number.isInteger(p.value) || p.value < 0 || p.value > limit) {
        return p.percent === true ? 'Хиты: процент от 0 до 100.' : 'Хиты: целое число от 0 до 1000000.';
      }
      return '';
    }
    static compute() { return false; }
  }
  register(ConditionHp);
})();
