// static/nodes/rules/equipment.js — правило «Снаряжение» (rule.equipment): фиксированный список предметов.
(() => {
  const { GraphNode, register } = window.Nodes;
  const { equipmentItemsValue } = window.NodeRegistry;
  class RuleEquipment extends GraphNode {
    static type = 'rule.equipment';
    static label = 'Снаряжение';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool' };
    static outputs = { effect: 'effect' };
    static defaults = { items: [{ name: 'Дорожная одежда', qty: 1 }] };
    static isRule = true;
    static validate(p) {
      if (!equipmentItemsValue(p.items)) return 'Снаряжение: список предметов с названием (до 120) и количеством (1–1000).';
      return '';
    }
    static project(p, env) {
      const items = env.normalizeEquipmentItems(env.get('items') ?? p.items);
      env.emit('equipment', { items });
    }
  }
  register(RuleEquipment);
})();
