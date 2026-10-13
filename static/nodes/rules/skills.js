// static/nodes/rules/skills.js — правило «Выбор навыков» (rule.skills).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { idText, stringList } = window.NodeRegistry;
  // Выбранное в лист попадает ключом: игрок мог выбрать навык названием (как в справочнике).
  const skillKey = name => {
    const value = String(name || '').trim();
    const hit = (window.SKILLS || []).find(([key, label]) => label === value || key === value);
    return hit ? hit[0] : value;
  };
  class RuleSkills extends GraphNode {
    static type = 'rule.skills';
    static label = 'Выбор навыков';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool', options: 'list', count: 'number' };
    static outputs = { effect: 'effect' };
    static defaults = { id: '', count: 1, options: [] };
    static isRule = true;
    static validate(p) {
      if (!idText(p.id, 100) || !Number.isInteger(p.count) || p.count < 0 || p.count > 18 || !stringList(p.options) || p.options.length > 18) return 'Выбор навыков: ID, список до 18 и количество от 0 до 18.';
      return '';
    }
    static project(p, env) {
      const id = String(p.id || ''), options = env.valuesOf(env.get('options') ?? p.options), count = Number(env.get('count') ?? p.count) || 0;
      const selected = env.valuesOf(env.context.choices?.[id]).slice(0, Math.max(0, count)).map(String).map(skillKey);
      env.sheet.skill_choices.push({ id, count, options: options.map(String), selected: [...selected] });
      env.sheet.skills.push(...selected); env.emit('skills', { id, count, options: options.map(String), selected: [...selected] });
    }
  }
  register(RuleSkills);
})();
