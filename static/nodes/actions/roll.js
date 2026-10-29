// static/nodes/actions/roll.js — узел «Бросок» (action.roll): вид задаёт roll_kind.
(() => {
  const { GraphNode, register, actionDefaults } = window.Nodes;
  class ActionRoll extends GraphNode {
    static type = 'action.roll';
    static label = 'Бросок';
    static group = 'Действия';
    static inputs = { exec: 'flow', enabled: 'bool', condition: 'bool', dice: 'dice' };
    static outputs = { exec: 'flow' };
    static defaults = { ...actionDefaults('roll'), roll_kind: 'roll' };
    static isAction = true;
  }
  register(ActionRoll);
})();
