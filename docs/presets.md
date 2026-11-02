# Наборы данных (presets)

Стартовые графы редактора механик, основы создания предметов и заклинаний, таблицы развития классов и ячейки
мультикласса — **данные, а не код**. Реестр `static/presets.js` (`window.Presets`) читает их как JSON.

## Где лежат

| Файл | Вид набора | Что внутри |
|---|---|---|
| `static/presets/index.json` | — | список встроенных наборов (`{"sets": ["graph-starters.json", ...]}`) |
| `static/presets/graph-starters.json` | `graph_starter` | 19 готовых графов для пустого редактора (16 с `attach: true` вставляются в действие) |
| — (пользовательский слой) | `graph_group` | группы нод, сохранённые из редактора графа (вход/выход, узлы, связи) |
| `static/presets/mechanic-templates.json` | `mechanic_templates` | 46 шаблонов механик для библиотеки предмета/заклинания/умения (группы `table.group`: Бой 13, Лечение 7, Предметы 4, Умения и эффекты 10, Персонаж 12) |
| `static/presets/mechanic-starters.json` | `mechanic_starters` | 3 полных графа создания персонажа: раса, класс, предыстория |
| `static/presets/item-presets.json` | `item_preset` | 6 основ «Что создаём?» для предмета |
| `static/presets/spell-presets.json` | `spell_preset` | 5 основ «Что создаём?» для заклинания |
| `static/presets/class-progression-2014.json`, `…-2024.json` | `class_progression` | таблица развития каждого класса (ключ — slug), по 12 классов на редакцию |
| `static/presets/multiclass-slots-2014.json`, `…-2024.json` | `multiclass_slots` | общие ячейки заклинателей по уровню (элемент `multiclass`) |
| `static/presets/class-rules-2014.json`, `…-2024.json` | `class_rules` | правила класса (ключ — slug): `ru`, `color`, `caster`, `multiclass`, `weapon_mastery` (2024), `legacy_unarmored` |
| `static/presets/race-rules-2014.json`, `…-2024.json` | `race_rules` | варианты выбора расы (навыки, инструменты, языки, хит-кость): 6 и 11 элементов |
| `static/presets/feat-rules-2014.json`, `…-2024.json` | `feat_rules` | правила черт по названию `name_en`: `groups` (`style` — боевой стиль, `asi` — служебная «Увеличение характеристик», `epic` — эпический дар), `ability_increase` (`amount`, `max`, `abilities`), `requires` (`level`, `feature_contains`, `ability`) |
| `static/presets/feature-rules-2014.json`, `…-2024.json` | `feature_rules` | правила умений классов и подклассов: 14 и 13 элементов |
| `static/presets/equipment-text-rules.json` | `equipment_text_rules` | разбор текста стартового снаряжения (27 правил) |
| `static/presets/equipment-pick-rules.json` | `equipment_pick_rules` | выбор предмета при разборе снаряжения (28 правил) |
| `static/presets/conditions.json` | `conditions` | 16 состояний: подписи, тексты и порядок |
| `static/presets/spell-schools.json` | `spell_schools` | 8 школ заклинаний |
| `static/presets/languages.json` | `languages` | 17 языков справочника |
| `static/presets/enemy-types.json` | `enemy_types` | 14 типов врагов для монстров |
| `static/presets/block-defaults.json` | `block_defaults` | 12 умолчаний блоков (например, кость броска по умолчанию) |

Таблицы развития генерирует `tools/srd/build_progression.py` (из OmnisGM-Rules, CC BY 4.0).
Все эти файлы перечислены в `index.json` и грузятся реестром `Presets`; тест `tests/presets.test.cjs`
ловит набор, забытый в `index.json`.

## Формат набора

```json
{
  "kind": "graph_starter",
  "id": "user.my-sets",
  "name": "Мои варианты",
  "items": [ { "id": "my-level-speed", "name": "Скорость с 3 уровня", "hint": "…", "nodes": [...], "links": [...] } ]
}
```

- `kind` — один из видов таблицы выше; `id` набора уникален; `name` обязательно.
- `edition` (`"2014"` / `"2024"`) обязательна для `class_progression`, `multiclass_slots` и `class_rules`; у остальных видов не нужна.
- У каждого элемента обязательны `id` (уникален внутри набора) и поля вида:
  - `graph_starter`: `name`, `nodes` (`{key, type, params, x, y}`), `links` (`[из, сокет, в, сокет]`), необязательные `hint`, `attach`, `style` (стиль кнопки: `attack`, `damage`, … — ставится узлу «Начало», если там стиль по умолчанию);
  - `item_preset` / `spell_preset`: `name`, `fields` (значения полей формы), необязательный `hint`;
  - `class_progression` / `multiclass_slots` / `class_rules`: `table`.
- Проверка (`Presets.problemOf`) отбрасывает неверный набор и называет причину: нет поля, повтор id, связь на неизвестный узел, нет редакции.

Повтор `id` элемента в двух наборах одного вида: побеждает набор, загруженный позже. Пользовательский набор
перекрывает встроенный элемент с тем же id, но не набор с тем же `id` (импорт такой набор отклоняет).

## Свой набор

1. **В браузере.** Редактор механик → кнопка «Наборы данных…» → файл `.json` или текст набора → «Импортировать».
   Набор хранится в `localStorage` этого браузера (ключ `et-presets-user`), виден во всех редакторах сразу,
   удаляется кнопкой в том же диалоге. Встроенные наборы удалить нельзя.
2. **В репозитории.** Положите файл в `static/presets/`, добавьте его имя в `index.json`. Тесты проверят, что все
   JSON-наборы подключены (`tests/presets.test.cjs`).

Новые виды наборов требуют кода: нужен потребитель вида (как `graphStarters()` в `mechanics-graph.js`).

## Загрузка

Страницы ждут `Presets.ready` перед первым рендером (`app.js`, `sheet.js`). Если загрузка не удалась, интерфейс
работает с пустыми наборами, ошибка идёт в консоль. Тесты в node загружают наборы с диска через
`tools/presets/node-loader.cjs`; браузерные тесты читают `/static/presets/*` через `page.route`.

## Связь с узлом прогрессии

У записей классов SRD таблица также записана в узел `rule.class` (kind `class_progression`) (`tools/srd/add_class_progression_nodes.cjs`).
Мастер уровней берёт таблицу в порядке: данные записи → узел графа → набор `class_progression`.
Правила класса (`class_rules`) тоже записаны в узел `rule.class` (kind `class_rules`) той же записи (без полей `ru`, `color`, `legacy_unarmored`). Порядок чтения: блок `data.caster` (старые записи) → узел графа → набор `class_rules`.
Набор нужен записям без узла: пользовательским записям, homebrew и наборам, где узел ещё не создан. Базовая часть справочника при смене вшитых файлов заменяется целиком (`src/seed.rs`), поэтому у записей SRD узел всегда есть; набор остаётся запасным путём для чтения старых и чужих данных.

## Выборы класса (`class_rules` → `choices`)

Выбор, который игрок делает при создании персонажа (боевой стиль, орден, избранный враг, инструменты), записывается в поле `table.choices` записи класса в наборе `class_rules`. Ключ выбора (`key`) совпадает с ключом в черновике (`draft.ruleChoices`). Виды:

- `options` — один вариант из `options[]` (`value`, `name`, `text`, `feature_text`). Поля:
  - `feature_name` — название особенности: на листе появится `«feature_name: name»` (если не задано — `value`);
  - `feature_text` с подстановкой `{value}` и `{ключ подполя}`;
  - `sub_fields` — поля ввода для варианта (например, два вида гуманоидов), все обязательны и различаются;
  - `proficiencies` + `grant` — владения, которые получает лист;
  - `extra_cantrips` — бонусные заговоры (учитываются при расчёте заклинаний).
- `items` — несколько предметов из каталога: `count`, `filter.category` (категория предмета), `grant` (раздел владений).
- `language` — язык из списка (`exclude` — что не предлагать), `control: 'select'`, `grant`.
- `feat` — черта из каталога; `filter.group` — группа из набора `feat_rules` (например, `style`).

Общие поля: `title`, `hint`, `problem` (текст, если выбор не сделан), `optional` (необязательный выбор), `requires` (выбор показывается и применяется только если выбран указанный ключ).

Проверки и панели мастера читают эти же записи (`B.classChoices`, `B.classChoiceProblem`), поэтому пользовательский набор класса с выбором работает без правок кода.
