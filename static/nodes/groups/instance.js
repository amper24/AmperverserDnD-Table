// static/nodes/groups/instance.js — узел «Группа» (group.instance): вызов группы повторного использования.
(() => {
  const { GraphNode, register } = window.Nodes;
  class GroupInstance extends GraphNode {
    static type = 'group.instance';
    static label = 'Группа';
    static group = 'Группы';
    static inputs = {};
    static outputs = {};
    static defaults = { group_id: '' };
  }
  register(GroupInstance);
})();
