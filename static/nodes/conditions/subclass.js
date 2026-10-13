// static/nodes/conditions/subclass.js — условие «Если подкласс» (condition.subclass).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { idText } = window.NodeRegistry;
  class ConditionSubclass extends GraphNode {
    static type = 'condition.subclass';
    static label = 'Если подкласс';
    static group = 'Условия';
    static inputs = {};
    static outputs = { value: 'bool' };
    static defaults = { id: '' };
    static validate(p) {
      if (!idText(p.id, 100)) return 'Укажите ID подкласса в условии.';
      return '';
    }
  }
  register(ConditionSubclass);
})();
