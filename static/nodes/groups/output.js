// static/nodes/groups/output.js — внутренний узел «Выход группы» (group.output).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { idText } = window.NodeRegistry;
  class GroupOutput extends GraphNode {
    static type = 'group.output';
    static label = 'Выход группы';
    static description = 'Выход группы: отдаёт значение в интерфейс.';
    static group = 'Группы';
    static inputs = { value: 'text' };
    static outputs = {};
    static defaults = { socket_id: '' };
    static validate(p) {
      if (!idText(p.socket_id, 64)) return 'Узел границы группы должен ссылаться на сокет интерфейса.';
      return '';
    }
  }
  register(GroupOutput);
})();
