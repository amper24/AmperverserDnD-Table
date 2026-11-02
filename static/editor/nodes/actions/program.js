// static/nodes/actions/program.js — узел «Начало действия» (action.program).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { idText } = window.NodeRegistry;
  class ActionProgram extends GraphNode {
    static type = 'action.program';
    static label = 'Начало действия';
    static description = 'Начало действия: точка входа программы и её кнопка.';
    static group = 'Действия';
    static inputs = {};
    static outputs = { exec: 'flow' };
    static defaults = { program_id: '', name: 'Новое действие', trigger: 'use', style: 'default' };
    static isAction = true;
    static validate(p) {
      if (p.style !== undefined && !window.BUTTON_STYLES?.[p.style]) return 'Неизвестный стиль кнопки.';
      if (!idText(p.program_id, 100) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 120 || !['use', 'passive'].includes(p.trigger)) return 'Программе нужны ID, название и допустимый триггер.';
      return '';
    }
  }
  register(ActionProgram);
})();
