// static/nodes/actions/roll.js — узел «Бросок» (action.roll): вид задаёт kind.
(() => {
  const { GraphNode, register, actionDefaults } = window.Nodes;
  class ActionRoll extends GraphNode {
    static type = 'action.roll';
    static label = 'Бросок';
    static description = 'Бросок: атака, урон, лечение, временные хиты или свободный бросок.';
    static group = 'Действия';
    static inputs = { exec: 'flow', enabled: 'bool', condition: 'bool', dice: 'dice' };
    static outputs = { exec: 'flow' };
    static defaults = { ...actionDefaults('roll'), kind: 'roll' };
    static isAction = true;
    // Вид броска уходит в поле kind блока плана, а не остаётся параметром-дублем.
    static blockParams(params) {
      const p = { ...params };
      delete p.kind;
      return p;
    }
  }
  register(ActionRoll);
})();
