// static/nodes/actions/field.js — узел «Изменить поле» (action.field): вид задаёт kind.
// status — наложить/снять состояние, value — изменить показатель, formula — параметр при создании.
// В план действия попадает только блок выбранного вида (blockParams); старых отдельных узлов нет.
(() => {
  const { GraphNode, register, actionDefaults } = window.Nodes;
  const { FIELD_KINDS, FIELD_VALUE_FIELDS, FIELD_FORMULA_FIELDS } = window.NodeRegistry;
  class ActionField extends GraphNode {
    static type = 'action.field';
    static label = 'Изменить поле';
    static description = 'Изменение листа: состояние, показатель или параметр при создании.';
    static group = 'Действия';
    static inputs = { exec: 'flow', enabled: 'bool', condition: 'bool' };
    static outputs = { exec: 'flow' };
    static defaults = actionDefaults('field');
    static isAction = true;
    // Проекция узла в блок плана: вид выбирает блок (status → condition, value → adjust, formula → passive),
    // а лишние для этого вида параметры в блок не попадают (в узле они сохраняются).
    static blockParams(params) {
      const p = { ...params };
      delete p.kind;
      if (params?.kind === 'status') { delete p.field; delete p.amount; delete p.value; }
      else if (params?.kind === 'value') { delete p.condition; delete p.operation; delete p.value; }
      else if (params?.kind === 'formula') { delete p.condition; delete p.operation; delete p.amount; }
      return p;
    }
    static validate(p) {
      if (!FIELD_KINDS.includes(p.kind)) return 'Изменить поле: вид status, value или formula.';
      if (p.kind === 'status') {
        if (typeof p.condition !== 'string' || !p.condition.trim() || p.condition.length > 200) return 'Состояние: название до 200 символов.';
        if (!['add', 'remove'].includes(p.operation)) return 'Состояние: операция add или remove.';
      }
      if (p.kind === 'value') {
        if (!Object.hasOwn(FIELD_VALUE_FIELDS, String(p.field))) return 'Недоступный показатель.';
        if (!Number.isInteger(p.amount) || p.amount < -10000 || p.amount > 10000) return 'Показатель: целое от −10000 до 10000.';
      }
      if (p.kind === 'formula') {
        if (!Object.hasOwn(FIELD_FORMULA_FIELDS, String(p.field))) return 'Параметр доступен только в пассивной программе.';
        if (p.value === undefined || JSON.stringify(p.value).length > 100000) return 'Значение параметра: ограниченное JSON-значение.';
      }
      return '';
    }
  }
  register(ActionField);
})();
