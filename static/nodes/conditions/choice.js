// static/nodes/conditions/choice.js — условие «Если выбран вариант» (condition.choice).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { idText } = window.NodeRegistry;
  class ConditionChoice extends GraphNode {
    static type = 'condition.choice';
    static label = 'Если выбран вариант';
    static group = 'Условия';
    static inputs = {};
    static outputs = { value: 'bool' };
    static defaults = { id: '', value: '' };
    static validate(p) {
      if (!idText(p.id, 100) || !Object.hasOwn(p, 'value')) return 'Укажите ID группы и сравниваемый выбор.';
      return '';
    }
  }
  register(ConditionChoice);
})();
