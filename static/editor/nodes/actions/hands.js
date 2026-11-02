// static/nodes/actions/hands.js — узел «Руки» (action.hands).
// Меняет число рук листа: extra_hands — дополнительные руки после main/off (0..4, слоты extra1..extra4).
// add/remove — на сколько дополнительных рук, set — общее число рук (2 = main+off, 3 = одна дополнительная).
// В плане — блок hands с теми же полями (src/mechanics.rs); предметы с исчезнувших extraN уходят в рюкзак.
(() => {
  const { GraphNode, register, actionDefaults } = window.Nodes;
  class ActionHands extends GraphNode {
    static type = 'action.hands';
    static label = 'Руки';
    static description = 'Добавляет, убирает или задаёт число рук: main, off и дополнительные.';
    static group = 'Действия';
    static inputs = { exec: 'flow', enabled: 'bool', condition: 'bool' };
    static outputs = { exec: 'flow' };
    static defaults = actionDefaults('hands');
    static isAction = true;
    // Контракт блока hands (src/mechanics.rs): операция и число рук 1–6.
    // set считает общее число рук, поэтому extra_hands = count − 2 (2 — обычные main+off).
    static validate(p) {
      if (!['add', 'remove', 'set'].includes(p.operation)) return 'Руки: операция add, remove или set.';
      if (!Number.isInteger(p.count) || p.count < 1 || p.count > 6) return 'Руки: целое число от 1 до 6.';
      return '';
    }
  }
  register(ActionHands);
})();
