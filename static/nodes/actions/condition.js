// static/nodes/actions/condition.js — узел «Состояние» (action.condition).
(() => {
  const { GraphNode, register, actionDefaults } = window.Nodes;
  class ActionCondition extends GraphNode {
    static type = 'action.condition';
    static label = window.Mechanics.TYPES.condition?.[0] || 'condition';
    static group = 'Действия';
    static inputs = { exec: 'flow', enabled: 'bool' };
    static outputs = { exec: 'flow' };
    static defaults = actionDefaults('condition');
    static isAction = true;
  }
  register(ActionCondition);
})();
