// static/nodes/actions/grant-item.js — узел «Выдать предмет» (action.grant_item).
(() => {
  const { GraphNode, register, actionDefaults } = window.Nodes;
  class ActionGrantItem extends GraphNode {
    static type = 'action.grant_item';
    static label = window.Mechanics.TYPES.grant_item?.[0] || 'grant_item';
    static group = 'Действия';
    static inputs = { exec: 'flow', enabled: 'bool', condition: 'bool' };
    static outputs = { exec: 'flow' };
    static defaults = actionDefaults('grant_item');
    static isAction = true;
  }
  register(ActionGrantItem);
})();
