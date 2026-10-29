// static/nodes/conditions/context.js — универсальное условие контекста (condition.context + kind).
(() => {
  const { GraphNode, register } = window.Nodes;
  const { CONTEXT_KINDS, idText } = window.NodeRegistry;
  const EDITIONS = ['2014', '2024'];
  class ConditionContext extends GraphNode {
    static type = 'condition.context';
    static label = 'Условие';
    static description = 'Условие редакции, уровня, подкласса или выбранного варианта.';
    static group = 'Условия';
    static inputs = {};
    static outputs = { value: 'bool' };
    static defaults = { kind: 'level', min: 1, max: 20 };
    static isComputed = true;
    static validate(p) {
      const kind = p.kind;
      if (!Object.hasOwn(CONTEXT_KINDS, kind)) return 'Условие: неизвестный вид.';
      if (kind === 'edition' && (!Array.isArray(p.editions) || !p.editions.length || p.editions.length > 2 || p.editions.some(x => typeof x !== 'string' || !EDITIONS.includes(x)))) return 'Условие редакции: один или несколько допустимых SRD.';
      if (kind === 'level' && (!Number.isInteger(p.min) || !Number.isInteger(p.max) || p.min < 1 || p.max > 20 || p.min > p.max)) return 'Условие уровня: диапазон 1–20.';
      if (kind === 'subclass' && !idText(p.id, 100)) return 'Укажите ID подкласса в условии.';
      if (kind === 'choice' && (!idText(p.id, 100) || !Object.hasOwn(p, 'value'))) return 'Укажите ID группы и сравниваемый выбор.';
      return '';
    }
    // Значение по контексту листа (редакция/уровень/подкласс/выборы); undefined — контекста нет.
    static evaluate(p, context = {}) {
      switch (p.kind) {
        case 'edition': {
          const edition = context.edition === undefined ? undefined : String(context.edition);
          return edition === undefined ? undefined : (p.editions || []).map(String).includes(edition);
        }
        case 'level': {
          const level = context.level === undefined ? undefined : Number(context.level);
          return Number.isFinite(level) ? level >= p.min && level <= p.max : undefined;
        }
        case 'subclass':
          return context.subclass === undefined ? undefined : String(context.subclass) === String(p.id);
        case 'choice':
          if (!context.choices) return undefined;
          return JSON.stringify(context.choices[p.id]) === JSON.stringify(p.value);
        default:
          return undefined;
      }
    }
  }
  register(ConditionContext);
})();
