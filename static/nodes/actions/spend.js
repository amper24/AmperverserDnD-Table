// static/nodes/actions/spend.js — узел «Расход ресурса» (action.spend).
// Количество, заряды, ячейка или использование; в плане — блок consume с теми же параметрами.
(() => {
  const { GraphNode, register, actionDefaults } = window.Nodes;
  class ActionSpend extends GraphNode {
    static type = 'action.spend';
    static label = 'Расход ресурса';
    static group = 'Действия';
    static inputs = { exec: 'flow', enabled: 'bool', condition: 'bool' };
    static outputs = { exec: 'flow' };
    static defaults = actionDefaults('spend');
    static isAction = true;
    // Контракт блока consume (src/mechanics.rs): вид ресурса, источник, количество и момент расхода.
    static validate(p) {
      if (!['quantity', 'charges', 'slot', 'uses'].includes(p.resource)) return 'Расход: ресурс quantity, charges, slot или uses.';
      if (!['self', 'item', 'tag'].includes(p.source)) return 'Расход: источник self, item или tag.';
      if (!['use', 'attack'].includes(p.trigger)) return 'Расход: момент use или attack.';
      if (!Number.isInteger(p.amount) || p.amount < 1 || p.amount > 10000) return 'Количество расхода: целое от 1 до 10000.';
      if (p.source === 'item' && !String(p.item_uid || '').trim()) return 'Не задан источник расхода.';
      if (p.source === 'tag' && !String(p.tag || '').trim()) return 'Не задан источник расхода.';
      if (p.resource === 'slot' && (!Number.isInteger(p.slot_level) || p.slot_level < 1 || p.slot_level > 9)) return 'Круг ячейки: целое от 1 до 9.';
      return '';
    }
  }
  register(ActionSpend);
})();
