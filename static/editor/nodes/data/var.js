// static/nodes/data/var.js — узел «Переменная» (data.var).
// Читает число из переменной действия или листа; без состояния выполнения — 0.
(() => {
  const { GraphNode, register } = window.Nodes;
  const { VAR_SCOPES, varName } = window.NodeRegistry;
  class DataVar extends GraphNode {
    static type = 'data.var';
    static label = 'Переменная';
    static description = 'Прочитать число из переменной действия или листа.';
    static group = 'Данные';
    static inputs = {};
    static outputs = { value: 'number' };
    static defaults = { name: 'value', scope: 'action' };
    static isComputed = true;
    // Имя и область — те же закрытые проверки, что у action.setvar.
    static validate(p) {
      if (!varName(p.name)) return 'Переменная: имя из латинских букв, цифр и «_» (1–32).';
      if (!VAR_SCOPES.includes(p.scope)) return 'Переменная: область action или sheet.';
      return '';
    }
    // В редакторе и предпросмотре состояния выполнения нет: переменная равна 0.
    static compute() { return 0; }
  }
  register(DataVar);
})();
