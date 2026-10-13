// static/nodes/actions/manual.js — узел «Ручное правило» действия (action.manual).
(() => {
  const { GraphNode, register, actionDefaults } = window.Nodes;
  class ActionManual extends GraphNode {
    static type = 'action.manual';
    static label = window.Mechanics.TYPES.manual?.[0] || 'manual';
    static group = 'Действия';
    static inputs = { exec: 'flow', enabled: 'bool' };
    static outputs = { exec: 'flow' };
    static defaults = actionDefaults('manual');
    static isAction = true;
  }
  register(ActionManual);
})();
