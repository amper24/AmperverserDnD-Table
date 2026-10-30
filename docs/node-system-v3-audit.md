# Ревизия нодовой системы v3

Дата: 2026-10-30. Проверка соответствия цели «маленькие ноды, условия, результаты,
переменные и ссылки, функции-группы, строки и списки, руки, заклинания, шаблоны, без
легаси» фактами из репозитория.

## Соответствие цели

| Требование | Факт | Подтверждение |
|---|---|---|
| Маленькие ортогональные блоки | 9 блоков действий: `program`, `roll`, `field`, `spend`, `slot`, `hands`, `grant_item`, `manual`, `setvar`; всего 46 типов (44 видимых + 2 внутренних узла групп) | `src/mechanics_graph.rs` (`NODE_TYPES`), 46 файлов `static/nodes/**`, `NodeRegistry.NODE_DEFS` |
| У каждого блока `enabled` и `condition` | У всех `action.*` (кроме `program`) входы `exec`, `enabled`, `condition`; `program` — `trigger`/`exec` | тесты `node-registry.test.cjs`, `node-sockets.test.cjs`; Rust `all_action_blocks_expose_enabled_and_condition` |
| `condition` в рантайме | `to_v1` кладёт `condition_src`, `execute` вычисляет узел с листом и результатами; `false`/`0` → блок пропускается | Rust `action_results_gate_the_next_action_in_the_runtime`, `condition_input_skips_block_and_keeps_flow` |
| Результаты действий | `sheet.action_results = {last, by_program}`: `total/hit/applied/spent/rolls/at`; ответ `execute` содержит `results` | `src/mechanics.rs`, docs `node-system-v3.md` |
| `data.result` | Источник `last` или id программы; поля `total/hit/applied/spent`; выход `value:number` | `static/nodes/data/result.js`, фикстура `tests/fixtures/mechanics-graph.json` |
| `data.sheet` | Путь поля листа (`hp.current`, `level`, `abilities.str`), нечисловое → 0 | `static/nodes/data/sheet.js`, Rust `data_sheet_reads_a_nested_sheet_field_and_defaults_to_zero` |
| Переменные и ссылки | `action.setvar`/`data.var` с областями action/sheet и именем `[a-z0-9_]{1,32}`; `data.ref` на числовой узел того же графа, циклические ссылки отклоняются | `static/nodes/actions/setvar.js`, `static/nodes/data/var.js`, `static/nodes/data/ref.js`; Rust `setvar_action_scope_is_visible_to_later_blocks_only`, `setvar_sheet_scope_persists_for_the_next_program` |
| Математика | `data.math` — add/sub/mul/div/min/max; `data.mathfun` — min/max/clamp/abs/round/floor/ceil/sign | `static/nodes/data/math.js`, `static/nodes/data/mathfun.js`; Rust `mathfun_value` |
| Примитивы данных | `data.number` (число), `data.dice` (кость/формула), `data.stat` (характеристика или навык), `data.boolean` (логическая константа), `dice.combine` (сложение костей) | `static/nodes/data/*.js`, `tests/node-registry.test.cjs` |
| Логика | Один `logic.op` с восемью операциями: and/or/not/xor/nand/nor/xnor/implies; у `not` вход `b` не используется | `static/nodes/logic/op.js`, `NodeRegistry.LOGIC_OPS`; Rust `LOGIC_OPS` сверяет `integrity.cjs` |
| Условия листа | Четыре узла `condition.status/item/hp/slot` читают лист в рантайме; без листа — false | `static/nodes/conditions/*`, Rust `STATUS_MODES`/`ITEM_MODES`/`HP_OPS`/`SLOT_OPS` |
| Строки и списки | Семь узлов: `data.text`, `data.textlen`, `data.textcheck`, `data.list`, `data.listget`, `data.listlen`, `data.listjoin`; таблицы операций одни на клиенте и сервере | `static/nodes/data/text*.js`, `static/nodes/data/list*.js`; Rust `TEXT_OPS`/`TEXT_CHECK_OPS` |
| Функции-группы | `data.call`: до трёх числовых аргументов `a/b/c`, типизированный результат number/text/bool/list; рекурсия и блоки действий внутри функции запрещены | `static/nodes/data/call.js`, `tests/graph-call.test.cjs`; Rust `call_group_value` |
| Руки | `action.hands` — add/remove/set, `count` 1–6; `extra_hands` 0–4, слоты `extra1..extra4`, при исчезновении руки предметы уходят в рюкзак | `static/nodes/actions/hands.js`, `src/mechanics.rs` (`hands`, `inventory::MAX_EXTRA_HANDS`), `tests/action-hands.test.cjs` |
| Палитра сокращена | `action.condition/adjust/passive` → `action.field`; `consume` → `spend`; `condition.compare` → `data.compare`; `require` удалён; `slot` — отдельный узел | grep по `static/src/tests/data_seed/tools` — старых типов нет (кроме CHANGELOG) |
| Данные мигрированы без обратной совместимости | 0 записей с v1 `programs`; все записи с механиками — графы | аудит-скрипт: v1 = 0 в `srd_2014/srd_2024/skills` |
| Поток «Начало → Конец» | у каждой программы ровно один `flow.end` на цепочку | 2014: 3625 программ / 3625 «Концов»; 2024: 3349/3349; `add_flow_ends.cjs --check` — обрывов нет |
| Заклинания | выбор круга, `action.slot`, upcast, концентрация, ритуал | 2014: 319 заклинаний, 295 `slot`, 32 upcast, 126 концентрация, 29 ритуальных; 2024: 339/312/37/132/29; Rust cast-тесты; `spell-cast.browser.cjs` PASS |
| Шаблоны | 46 шаблонов механик + 19 стартеров (16 вставляются в действие), все исполнimы | `tests/template-presets.test.cjs` (все шаблоны, все программы, все записи seed) |
| Документация | `docs/node-system-v3.md` — палитра, семантика, переменные, функции, строки/списки, руки, ограничения MVP, шаблоны; README обновлён | файлы в репозитории |

## Числа

| Показатель | Значение |
|---|---|
| Типов узлов (клиент = сервер) | **46 / 46** (44 видимых + 2 внутренних) |
| Категорий палитры | 6 (Начало → Действия → Данные → Условия → Правила → Группы) |
| Записей SRD 2014 / 2024 | 1294 / 1205 |
| Из них с механиками | 981 / 986 |
| Программ (все с «Концом») | 3625 / 3349 |
| Заклинаний | 319 / 339 |
| Шаблонов / стартеров | **46 / 19** (было 40 / 13; 16 стартеров с `attach`) |
| JS-тестов | **493 pass** |
| Rust-тестов | **103 pass** |
| integrity | 0 ошибок, 12 исторических предупреждений |

## Отклонения и ограничения (осознанные)

1. **`flow.if` остаётся статическим**: значения `data.result`/`data.sheet`/`data.var` в нём
   дают 0, потому что ветвление компилируется до исполнения. Динамические условия работают
   на входах блоков (`condition`), а не на ветвлении. Поэтому «Запомнить бросок» ставит
   `data.compare` прямо на вход `condition` второго броска.
2. **Числовые аргументы функций**: `data.call` принимает только number `a`, `b`, `c` (до
   трёх) и приводит результат к объявленному типу; текст, список и bool как аргументы
   группы-функции не передаются.
3. **Строки и списки не попадают в план**: `data.text`/`data.list` и производные не
   создают блоков исполнения и не пишут в лист — только предпросмотр и рантайм-условия.
4. **`extra_hands` до 4**: узел `action.hands` принимает `count` 1–6, но запас
   дополнительных рук ограничен четырьмя; `set 3` — одна дополнительная рука, `add 3` —
   три, общее число рук не больше шести.
5. **`manual` — текстовое правило в палитре действий**: без него не выразить справочные
   механики SRD. Итоговая палитра: 9 блоков действий + поток.
6. **Ручные правила и динамические условия**: клиентский предпросмотр статический,
   поэтому manual-блок, скрытый в предпросмотре, но выполнимый на сервере, требует
   подтверждения. Это описано в docs; в текущих данных таких цепочек нет.
7. **`equipment.browser.cjs`** падает на `.roll-mode-menu` и на чистом HEAD — это
   предсуществующий дефект теста/среды, к v3 не относится.
8. **`data.result` читает результаты прошлых действий**: собственный итог текущего
   действия в середине цепочки недоступен (результаты пишутся после выполнения).
   Для «своего» итога используйте `action.roll` → `condition.hit`/`data.compare` по
   входу, либо предыдущее действие предмета.

## Что осталось (приоритеты)

1. Ветвление по результатам (`flow.if` с рантайм-условием) — если понадобится.
2. Передача текста/списка в аргументы группы-функции (сейчас только числа).
3. Показ истории результатов действий в карточке предмета (сейчас доступны в ответе
   каста и через `data.result`).
4. Починить `equipment.browser.cjs` (не связано с v3).
