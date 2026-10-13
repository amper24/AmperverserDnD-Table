// static/nodes/rules/equipment-choice.js — правило «Выбор снаряжения» (rule.equipment_choice).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { equipmentChoiceValue } = window.NodeRegistry;
  class RuleEquipmentChoice extends GraphNode {
    static type = 'rule.equipment_choice';
    static label = 'Выбор снаряжения';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool' };
    static outputs = { effect: 'effect' };
    static defaults = { id: 'gear', title: 'Выберите снаряжение', options: [{ name: 'Вариант А', items: [{ name: 'Дорожная одежда', qty: 1 }], gold: 0 }] };
    static isRule = true;
    static validate(p) {
      if (!equipmentChoiceValue(p)) return 'Выбор снаряжения: ID, название и варианты со списком предметов.';
      return '';
    }
    static project(p, env) {
      const choice = { id: String(p.id || '').slice(0, 100), title: String(p.title || 'Выберите снаряжение').slice(0, 120), options: env.normalizeEquipmentOptions(p.options) };
      env.emit('equipment_choice', choice);
    }
  }
  register(RuleEquipmentChoice);
})();
