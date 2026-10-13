// static/nodes/data/dice.js — узел «Кость» (data.dice).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { ABILITIES } = window.NodeRegistry;
  const STAT_KEYS = ['', ...ABILITIES, 'best', 'prof', 'atk', 'atk_str', 'atk_dex', 'spell', 'spell_mod', 'level', 'dc'];
  class DataDice extends GraphNode {
    static type = 'data.dice';
    static label = 'Кость';
    static group = 'Данные';
    static inputs = {};
    static outputs = { value: 'dice' };
    static defaults = { value: { count: 1, sides: 6, bonus: 0, stat: '' } };
    static validate(p) {
      const v = p.value;
      if (!v || typeof v !== 'object' || Array.isArray(v) || !Number.isInteger(v.count) || v.count < 0 || v.count > 100 || !Number.isInteger(v.sides) || v.sides < 1 || v.sides > 1000 || !Number.isInteger(v.bonus ?? 0) || Math.abs(v.bonus ?? 0) > 1000000 || !STAT_KEYS.includes(v.stat ?? '')) return 'Узел кости должен содержать количество и грани.';
      return '';
    }
  }
  register(DataDice);
})();
