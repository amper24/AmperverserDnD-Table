// static/nodes/actions/passive.js — узел «Параметр при создании» (action.passive).
(() => {
  const { GraphNode, register, actionDefaults } = window.Nodes;
  class ActionPassive extends GraphNode {
    static type = 'action.passive';
    static label = window.Mechanics.TYPES.passive?.[0] || 'passive';
    static group = 'Действия';
    static inputs = { exec: 'flow', enabled: 'bool' };
    static outputs = { exec: 'flow' };
    static defaults = actionDefaults('passive');
    static isAction = true;
  }
  register(ActionPassive);
})();
