// ---------------------------------------------------------------------------
// presets-data.js — только данные: стартовые графы редактора механик и пресеты создания
// записей (предмет, заклинание). Код здесь не живёт: логика читает window.PRESET_DATA
// (mechanics-graph.js → graphStarters, modules.js → itemPresets / spellPresets).
// Чтобы добавить вариант, достаточно строки в нужном массиве.
//
// Формат стартового графа: nodes — { key, type, params, x, y } (x, y — относительно угла холста; params — только отличия от
// значений по умолчанию реестра узлов, block_id действий создаётся при вставке);
// links — [fromKey, fromSocket, toKey, toSocket]; attach: true — первый узел подключается
// к выходу «exec» программы «Использовать» (если у графа её нет, узел остаётся без входа).
// ---------------------------------------------------------------------------
window.PRESET_DATA = {
  graphStarters: [
    { id: 'speed-level', name: 'Скорость с уровня', hint: 'Скорость 35 фт, если уровень персонажа от 5 до 20',
      nodes: [{ key: 'lvl', type: 'condition.level', params: { min: 5, max: 20 }, x: 0, y: 0 }, { key: 'spd', type: 'rule.speed', params: { value: 35 }, x: 260, y: 0 }],
      links: [['lvl', 'value', 'spd', 'enabled']] },
    { id: 'hp-bonus', name: 'Бонус к хитам', hint: '+2 к максимуму хитов, всегда',
      nodes: [{ key: 'amt', type: 'data.number', params: { value: 2 }, x: 0, y: 0 }, { key: 'hp', type: 'rule.hp_bonus', params: { amount: 2 }, x: 260, y: 0 }],
      links: [['amt', 'value', 'hp', 'amount']] },
    { id: 'hp-bonus-level', name: 'Хиты с 3 уровня', hint: '+1 к хитам, начиная с 3 уровня персонажа',
      nodes: [{ key: 'lvl', type: 'condition.level', params: { min: 3, max: 20 }, x: 0, y: 0 }, { key: 'amt', type: 'data.number', params: { value: 1 }, x: 0, y: 120 }, { key: 'hp', type: 'rule.hp_bonus', params: { amount: 1 }, x: 260, y: 60 }],
      links: [['lvl', 'value', 'hp', 'enabled'], ['amt', 'value', 'hp', 'amount']] },
    { id: 'attack-hit-damage', name: 'Атака → попадание → урон', hint: 'Бросок атаки; урон только при попадании (ветка «Если» по условию «Попадание атаки»)', attach: true,
      nodes: [
        { key: 'atk', type: 'action.attack', params: { dc: 12 }, x: 0, y: 0 },
        { key: 'hit', type: 'condition.hit', params: {}, x: 260, y: 120 },
        { key: 'if', type: 'flow.if', params: {}, x: 260, y: 0 },
        { key: 'dmg', type: 'action.damage', params: { dice: { count: 1, sides: 8, bonus: 0, stat: '' } }, x: 520, y: 0 },
      ],
      links: [['atk', 'exec', 'if', 'exec'], ['hit', 'value', 'if', 'condition'], ['if', 'then', 'dmg', 'exec']] },
    { id: 'damage-only', name: 'Урон', hint: 'Самостоятельное действие: урон без броска, всегда', attach: true,
      nodes: [{ key: 'dmg', type: 'action.damage', params: { dice: { count: 2, sides: 6, bonus: 0, stat: '' } }, x: 0, y: 0 }],
      links: [] },
  ],
  itemPresets: [
    { id: 'weapon', name: 'Оружие', hint: 'Клинок, лук или посох: урон и тип атаки', fields: { type: 'weapon', name: 'Оружие' } },
    { id: 'armor', name: 'Доспех или щит', hint: 'Защита и класс доспеха', fields: { type: 'armor', name: 'Доспех' } },
    { id: 'consumable', name: 'Зелье или свиток', hint: 'Одноразовый эффект, расходуется при использовании', fields: { type: 'consumable', name: 'Зелье' } },
    { id: 'magic', name: 'Магический предмет', hint: 'Требует настройки, часто с зарядами', fields: { type: 'magic', name: 'Магический предмет', attunement: true } },
    { id: 'gear', name: 'Снаряжение', hint: 'Обычная вещь без механики: верёвка, факел, инструмент', fields: { type: 'gear', name: 'Снаряжение' } },
    { id: 'blank', name: 'С нуля', hint: 'Пустая форма, все поля по умолчанию', fields: {} },
  ],
  spellPresets: [
    { id: 'cantrip', name: 'Заговор', hint: 'Не тратит ячейки, работает на любом уровне', fields: { level: 0, cast_cost: 'free', name: 'Заговор' } },
    { id: 'spell1', name: 'Заклинание 1 круга', hint: 'Тратит ячейку своего круга или выше', fields: { level: 1, name: 'Заклинание' } },
    { id: 'spell3', name: 'Заклинание 3 круга', hint: 'Для средних по силе эффектов', fields: { level: 3, name: 'Заклинание' } },
    { id: 'ritual', name: 'Ритуал', hint: 'Можно сотворить без ячейки за дополнительное время', fields: { level: 1, ritual: true, name: 'Ритуал' } },
    { id: 'blank', name: 'С нуля', hint: 'Пустая форма, все поля по умолчанию', fields: {} },
  ],
};
