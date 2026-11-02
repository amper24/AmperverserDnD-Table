// static/nodes/conditions/status.js — условие «Есть состояние» (condition.status).
// Читает список состояний листа (sheet.conditions) в рантайме: есть ли состояние с таким названием.
// В редакторе и предпросмотре без листа — false (значение неизвестно).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { STATUS_MODES } = window.NodeRegistry;
  class ConditionStatus extends GraphNode {
    static type = 'condition.status';
    static label = 'Есть состояние';
    static description = 'Наложено ли на лист состояние с таким названием.';
    static group = 'Условия';
    static inputs = {};
    static outputs = { value: 'bool' };
    static defaults = { name: 'Отравленный', mode: 'present' };
    static isComputed = true;
    static validate(p) {
      const name = typeof p.name === 'string' ? p.name.trim() : '';
      if (!name || name.length > 120) return 'Состояние: название от 1 до 120 символов.';
      if (!STATUS_MODES.includes(p.mode)) return 'Состояние: режим present или absent.';
      return '';
    }
    // Без листа (редактор, предпросмотр) значение неизвестно, поэтому показываем false.
    static compute() { return false; }
  }
  register(ConditionStatus);
})();
