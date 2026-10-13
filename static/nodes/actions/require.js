// static/nodes/actions/require.js — узел «Проверка условия» (action.require).
(() => {
  const { GraphNode, register, actionDefaults } = window.Nodes;
  class ActionRequire extends GraphNode {
    static type = 'action.require';
    static label = window.Mechanics.TYPES.require?.[0] || 'require';
    static group = 'Действия';
    static inputs = { exec: 'flow', enabled: 'bool' };
    static outputs = { exec: 'flow' };
    static defaults = actionDefaults('require');
    static isAction = true;
  }
  register(ActionRequire);
})();
