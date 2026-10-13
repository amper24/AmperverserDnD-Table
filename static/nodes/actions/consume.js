// static/nodes/actions/consume.js — узел «Расход ресурса» (action.consume).
(() => {
  const { GraphNode, register, actionDefaults } = window.Nodes;
  class ActionConsume extends GraphNode {
    static type = 'action.consume';
    static label = window.Mechanics.TYPES.consume?.[0] || 'consume';
    static group = 'Действия';
    static inputs = { exec: 'flow', enabled: 'bool' };
    static outputs = { exec: 'flow' };
    static defaults = actionDefaults('consume');
    static isAction = true;
  }
  register(ActionConsume);
})();
