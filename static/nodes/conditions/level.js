// static/nodes/conditions/level.js — условие «Если уровень» (condition.level).
(() => {
  const { GraphNode, register } = window.Nodes;
  class ConditionLevel extends GraphNode {
    static type = 'condition.level';
    static label = 'Если уровень';
    static group = 'Условия';
    static inputs = {};
    static outputs = { value: 'bool' };
    static defaults = { min: 1, max: 20 };
    static validate(p) {
      if (!Number.isInteger(p.min) || !Number.isInteger(p.max) || p.min < 1 || p.max > 20 || p.min > p.max) return 'Условие уровня: диапазон 1–20.';
      return '';
    }
  }
  register(ConditionLevel);
})();
