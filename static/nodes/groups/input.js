// static/nodes/groups/input.js — внутренний узел «Вход группы» (group.input).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { idText } = window.NodeRegistry;
  class GroupInput extends GraphNode {
    static type = 'group.input';
    static label = 'Вход группы';
    static description = 'Вход группы: принимает значение из интерфейса.';
    static group = 'Группы';
    static inputs = {};
    static outputs = { value: 'text' };
    static defaults = { socket_id: '' };
    static validate(p) {
      if (!idText(p.socket_id, 64)) return 'Узел границы группы должен ссылаться на сокет интерфейса.';
      return '';
    }
  }
  register(GroupInput);
})();
