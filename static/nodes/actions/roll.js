// static/nodes/actions/roll.js — узел «Бросок» (action.roll): вид задаёт kind.
(() => {
  const { GraphNode, register, actionDefaults } = window.Nodes;
  class ActionRoll extends GraphNode {
    static type = 'action.roll';
    static label = 'Бросок';
    static description = 'Бросок: атака, урон, лечение, временные хиты или свободный бросок.';
    static group = 'Действия';
    static inputs = { exec: 'flow', enabled: 'bool', condition: 'bool', dice: 'dice' };
    static outputs = { exec: 'flow' };
    static defaults = { ...actionDefaults('roll'), kind: 'roll' };
    static isAction = true;
    // Вид броска уходит в поле kind блока плана, а не остаётся параметром-дублем.
    static blockParams(params) {
      const p = { ...params };
      delete p.kind;
      return p;
    }
    // Повышение круга: число костей за каждый круг выше базового (только урон и лечение).
    static validate(p) {
      if (p.upcast === undefined) return '';
      if (!p.upcast || typeof p.upcast !== 'object') return 'Повышение круга: объект с количеством и гранями.';
      if (!Number.isInteger(p.upcast.count) || p.upcast.count < 0 || p.upcast.count > 100) return 'Повышение круга: количество костей 0–100.';
      if (!Number.isInteger(p.upcast.sides) || p.upcast.sides < 1 || p.upcast.sides > 1000) return 'Повышение круга: грани 1–1000.';
      return '';
    }
  }
  register(ActionRoll);
})();
