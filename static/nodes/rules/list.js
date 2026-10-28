// static/nodes/rules/list.js — универсальное правило-список (rule.list + kind).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { ABILITIES, RULE_LIST_KINDS, stringList, tableValue, equipmentItemsValue, equipmentChoiceValue } = window.NodeRegistry;
  // Название навыка → ключ листа (как в static/common.js SKILLS); что не узнали, остаётся как есть.
  const skillKey = name => {
    const value = String(name || '').trim();
    const hit = (window.SKILLS || []).find(([key, label]) => label === value || key === value);
    return hit ? hit[0] : value;
  };
  class RuleList extends GraphNode {
    static type = 'rule.list';
    static label = 'Список';
    static group = 'Правила персонажа';
    static inputs = { enabled: 'bool', amount: 'number' };
    static outputs = { effect: 'effect' };
    static defaults = { kind: 'languages', value: [] };
    static isRule = true;
    static validate(p) {
      const kind = p.kind;
      if (!Object.hasOwn(RULE_LIST_KINDS, kind)) return 'Список: неизвестный вид.';
      if (kind === 'languages' && p.value !== undefined && !stringList(p.value)) return 'Языки должны быть списком текстовых значений.';
      if (kind === 'proficiencies' && ((p.value !== undefined && !stringList(p.value)) || (p.label !== undefined && (typeof p.label !== 'string' || p.label.length > 120)))) return 'Владения должны быть списком и иметь короткую метку.';
      if (kind === 'skill_proficiency' && p.value !== undefined && (!stringList(p.value) || p.value.length > 18)) return 'Владение навыком: список названий (до 18).';
      if (kind === 'skills' && (!(typeof p.id === 'string' && p.id.length > 0 && p.id.length <= 100) || !Number.isInteger(p.count) || p.count < 0 || p.count > 18 || !stringList(p.options) || p.options.length > 18)) return 'Выбор навыков: ID, список до 18 и количество от 0 до 18.';
      if (kind === 'spell_list' && (!['known', 'prepared', 'book'].includes(p.mode) || (p.ability !== undefined && !ABILITIES.includes(p.ability)) || !stringList(p.spells))) return 'Список заклинаний: режим, список и характеристика должны быть допустимы.';
      if (kind === 'feature' && (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 120 || (p.text !== undefined && (typeof p.text !== 'string' || p.text.length > 4000)))) return 'Умение: название до 120 и текст до 4000 символов.';
      if (kind === 'class_features' && p.table !== undefined && !tableValue(p.table)) return 'Табличное правило должно содержать ограниченный JSON-объект.';
      if (kind === 'equipment' && !equipmentItemsValue(p.items)) return 'Снаряжение: список предметов с названием (до 120) и количеством (1–1000).';
      if (kind === 'equipment_choice' && !equipmentChoiceValue(p)) return 'Выбор снаряжения: ID, название и варианты со списком предметов.';
      return '';
    }
    static project(p, env) {
      switch (p.kind) {
        case 'languages': {
          const langs = env.valuesOf(env.value('value')).map(String).filter(Boolean);
          env.sheet.languages.push(...langs); env.appendProficiency(env.sheet, 'Языки', langs); env.emit('languages', { values: langs });
          break;
        }
        case 'proficiencies': {
          const profs = env.valuesOf(env.value('value')).map(String).filter(Boolean);
          env.appendProficiency(env.sheet, p.label || 'Владения', profs); env.emit('proficiencies', { label: p.label || 'Владения', values: profs });
          break;
        }
        case 'skill_proficiency': {
          // Значения — названия из справочника (категория «Навыки») или ключи; в лист попадают ключи.
          const skills = env.valuesOf(env.value('value')).map(String).filter(Boolean).map(skillKey);
          env.sheet.skills.push(...skills); env.emit('skill_proficiency', { values: skills });
          break;
        }
        case 'skills': {
          const id = String(p.id || ''), options = env.valuesOf(env.get('options') ?? p.options), count = Number(env.get('count') ?? p.count) || 0;
          const selected = env.valuesOf(env.context.choices?.[id]).slice(0, Math.max(0, count)).map(String).map(skillKey);
          env.sheet.skill_choices.push({ id, count, options: options.map(String), selected: [...selected] });
          env.sheet.skills.push(...selected); env.emit('skills', { id, count, options: options.map(String), selected: [...selected] });
          break;
        }
        case 'spell_list': {
          const spells = env.valuesOf(env.get('spells') ?? p.spells);
          env.sheet.spell_rules.push({ mode: p.mode, ability: p.ability || '', spells: env.clone(spells) }); env.emit('spell_list', { mode: p.mode, ability: p.ability || '', spells });
          break;
        }
        case 'feature': {
          const feature = { name: p.name, text: p.text || '', source: env.context.source || '', mechanic_node_id: env.context.featureNodeId || '' };
          env.sheet.features.push(feature); env.emit('feature', { feature });
          break;
        }
        case 'class_features': {
          const table = env.get('table') ?? p.table;
          if (table && typeof table === 'object') { env.sheet.class_features = env.clone(table); env.emit('class_features', { table }); }
          break;
        }
        case 'equipment': {
          const items = env.normalizeEquipmentItems(env.get('items') ?? p.items);
          env.emit('equipment', { items });
          break;
        }
        case 'equipment_choice': {
          const choice = { id: String(p.id || '').slice(0, 100), title: String(p.title || 'Выберите снаряжение').slice(0, 120), options: env.normalizeEquipmentOptions(p.options) };
          env.emit('equipment_choice', choice);
          break;
        }
      }
    }
  }
  register(RuleList);
})();
