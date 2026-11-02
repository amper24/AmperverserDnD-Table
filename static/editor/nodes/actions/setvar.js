// static/nodes/actions/setvar.js — узел «Записать переменную» (action.setvar).
// Значение приходит на вход value, имя и область задаются параметрами. Область action живёт
// до конца текущего выполнения, sheet сохраняет число в sheet.vars.
(() => {
  const { GraphNode, register, actionDefaults } = window.Nodes;
  const { VAR_SCOPES, varName } = window.NodeRegistry;
  class ActionSetVar extends GraphNode {
    static type = 'action.setvar';
    static label = 'Записать переменную';
    static description = 'Записать число в переменную действия или листа.';
    static group = 'Действия';
    static inputs = { exec: 'flow', enabled: 'bool', condition: 'bool', value: 'number' };
    static outputs = { exec: 'flow' };
    static defaults = actionDefaults('setvar');
    static isAction = true;
    // Имя — 1–32 символа [a-z0-9_], область — action или sheet (те же проверки на сервере).
    static validate(p) {
      if (!varName(p.name)) return 'Переменная: имя из латинских букв, цифр и «_» (1–32).';
      if (!VAR_SCOPES.includes(p.scope)) return 'Переменная: область action или sheet.';
      return '';
    }
  }
  register(ActionSetVar);
})();
