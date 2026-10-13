// static/nodes/data/ability.js — узел «Характеристика» (data.ability).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { ABILITIES } = window.NodeRegistry;
  class DataAbility extends GraphNode {
    static type = 'data.ability';
    static label = 'Характеристика';
    static group = 'Данные';
    static inputs = {};
    static outputs = { value: 'ability' };
    static defaults = { value: 'str' };
    static validate(p) {
      if (!ABILITIES.includes(p.value)) return 'Выберите характеристику из закрытого списка.';
      return '';
    }
  }
  register(DataAbility);
})();
