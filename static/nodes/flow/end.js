// static/nodes/flow/end.js — узел «Конец» (flow.end): принимает поток действия.
(() => {
  const { GraphNode, register } = window.Nodes;
  class FlowEnd extends GraphNode {
    static type = 'flow.end';
    static label = 'Конец';
    static group = 'Поток';
    static inputs = { exec: 'flow' };
    static outputs = {};
    static defaults = {};
  }
  register(FlowEnd);
})();
