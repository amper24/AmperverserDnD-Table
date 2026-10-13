// static/nodes/data/stat.js — узел «Характеристика / навык» (data.stat).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { isStatId, STAT_MODES, statDice } = window.NodeRegistry;
  class DataStat extends GraphNode {
    static type = 'data.stat';
    static label = 'Характеристика / навык';
    static group = 'Данные';
    static inputs = {};
    static outputs = { value: 'dice' };
    static defaults = { id: 'str', mode: 'bonus' };
    static isComputed = true;
    static validate(p) {
      if (!isStatId(p.id) || !STAT_MODES.includes(p.mode)) return 'Выберите характеристику или навык и режим: бонус или значение.';
      return '';
    }
    static compute(p) { return statDice(p); }
  }
  register(DataStat);
})();
