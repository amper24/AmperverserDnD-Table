// static/nodes/actions/adjust.js — узел «Изменить показатель» (action.adjust).
(() => {
  const { GraphNode, register, actionDefaults } = window.Nodes;
  class ActionAdjust extends GraphNode {
    static type = 'action.adjust';
    static label = window.Mechanics.TYPES.adjust?.[0] || 'adjust';
    static group = 'Действия';
    static inputs = { exec: 'flow', enabled: 'bool' };
    static outputs = { exec: 'flow' };
    static defaults = actionDefaults('adjust');
    static isAction = true;
  }
  register(ActionAdjust);
})();
