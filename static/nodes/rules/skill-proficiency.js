// static/nodes/rules/skill-proficiency.js — правило «Владение навыком» (rule.skill_proficiency).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { stringList } = window.NodeRegistry;
  // Название навыка → ключ листа (как в static/common.js SKILLS); что не узнали, остаётся как есть.
  const skillKey = name => {
    const value = String(name || '').trim();
    const hit = (window.SKILLS || []).find(([key, label]) => label === value || key === value);
    return hit ? hit[0] : value;
  };
  class RuleSkillProficiency extends GraphNode {
    static type = 'rule.skill_proficiency';
    static label = 'Владение навыком';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool', value: 'list' };
    static outputs = { effect: 'effect' };
    static defaults = { value: [] };
    static isRule = true;
    static validate(p) {
      if (p.value !== undefined && (!stringList(p.value) || p.value.length > 18)) return 'Владение навыком: список названий (до 18).';
      return '';
    }
    static project(p, env) {
      // Значения — названия из справочника (категория «Навыки») или ключи; в лист попадают ключи.
      const skills = env.valuesOf(env.value('value')).map(String).filter(Boolean).map(skillKey);
      env.sheet.skills.push(...skills); env.emit('skill_proficiency', { values: skills });
    }
  }
  register(RuleSkillProficiency);
})();
