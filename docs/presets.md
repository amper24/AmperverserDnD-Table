# Наборы данных (presets)

Стартовые графы редактора механик, основы создания предметов и заклинаний, таблицы развития классов и ячейки
мультикласса — **данные, а не код**. Реестр `static/presets.js` (`window.Presets`) читает их как JSON.

## Где лежат

| Файл | Вид набора | Что внутри |
|---|---|---|
| `static/presets/index.json` | — | список встроенных наборов (`{"sets": ["graph-starters.json", ...]}`) |
| `static/presets/graph-starters.json` | `graph_starter` | готовые графы для пустого редактора |
| `static/presets/item-presets.json` | `item_preset` | основы «Что создаём?» для предмета |
| `static/presets/spell-presets.json` | `spell_preset` | основы «Что создаём?» для заклинания |
| `static/presets/class-progression-2014.json`, `…-2024.json` | `class_progression` | таблица развития каждого класса (ключ — slug) |
| `static/presets/multiclass-slots-2014.json`, `…-2024.json` | `multiclass_slots` | общие ячейки заклинателей по уровню (элемент `multiclass`) |
| `static/presets/class-rules-2014.json`, `…-2024.json` | `class_rules` | правила класса (ключ — slug): `ru`, `color`, `caster`, `multiclass`, `weapon_mastery` (2024), `legacy_unarmored` |

Таблицы развития генерирует `tools/srd/build_progression.py` (из OmnisGM-Rules, CC BY 4.0).

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
  - `graph_starter`: `name`, `nodes` (`{key, type, params, x, y}`), `links` (`[из, сокет, в, сокет]`), необязательные `hint`, `attach`;
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

У записей классов SRD таблица также записана в узел `rule.class_progression` (`tools/srd/add_class_progression_nodes.cjs`).
Мастер уровней берёт таблицу в порядке: данные записи → узел графа → набор `class_progression`.
Правила класса (`class_rules`) тоже записаны в узел `rule.class_rules` той же записи (без полей `ru`, `color`, `legacy_unarmored`). Порядок чтения: блок `data.caster` (старые записи) → узел графа → набор `class_rules`.
Набор нужен записям без узла: старым снимкам и базам, где правка сохранена (`seed.rs` не перезаписывает изменённые строки).
