// static/nodes/conditions/hit.js — условие «Попадание атаки» (condition.hit).
(() => {
  const { GraphNode, register } = window.Nodes;
  class ConditionHit extends GraphNode {
    static type = 'condition.hit';
    static label = 'Попадание атаки';
    static group = 'Условия';
    static inputs = {};
    static outputs = { value: 'bool' };
    static defaults = {};
  }
  register(ConditionHit);
})();
