// static/nodes/flow/if.js — узел «Если» (flow.if): ветвление потока по условию.
(() => {
  const { GraphNode, register } = window.Nodes;
  class FlowIf extends GraphNode {
    static type = 'flow.if';
    static label = 'Если';
    static description = 'Ветвление: продолжает поток по «да» или «нет».';
    static group = 'Поток';
    static inputs = { exec: 'flow', condition: 'bool' };
    static outputs = { then: 'flow', else: 'flow' };
    static defaults = {};
    static validate(p) {
      if (Object.keys(p).length > 8) return 'Условный узел содержит лишние параметры.';
      return '';
    }
  }
  register(FlowIf);
})();
