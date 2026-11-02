# Архив: удалённые артефакты и исторические инструменты

Здесь собрано то, что больше не участвует в работе, но упоминается в CHANGELOG, аудитах и
старых инструкциях. Если вы ищете файл, которого нет в репозитории, — скорее всего, он в
этом списке. Все удаления уже произошли; ничего из перечисленного не нужно «восстанавливать»
для сборки или тестов.

## Удалено (механизм отменён)

| Что | Когда и почему удалено | Чем заменено |
|---|---|---|
| `data_seed/previous_shipped.json` | Снимки прежних поставок больше не нужны: базовый справочник — часть сборки, а не набор миграций по хешам (коммит «Чистка: базовый справочник — часть сборки, без миграций по хешам») | При старте `src/store/seed.rs` считает отпечаток вшитых файлов и заменяет базовые записи целиком; правки пользователя не трогаются |
| `data_seed/legacy_hashes.json` | То же: хеши прежних версий строк больше не хранятся | Отпечаток файлов в `seed.rs` |
| `tools/srd/previous_shipped.py` | Строил снимки для `previous_shipped.json` | — |
| `tools/srd/verify_migration.py` | Проверял маршрут обновления по снимкам (`--prev-json-dir`, `--prev`) | `node tools/srd/integrity.cjs` проверяет сами данные и паритет клиент/сервер |
| `tools/srd/graph_convert.cjs` | Конвертер блоков v1 → граф v2; совместимость со старой схемой удалена | Генераторы сразу пишут `version: 2`; `src/store/seed.rs` и редактор принимают только v2 |
| `tools/srd/migrate_spells_071.cjs` | Разовая пересборка заклинаний 0.7.1 | Текущая сборка `tools/srd/build_srd.py` |
| `static/class-progression.js` | Таблицы развития переехали в данные | `static/presets/class-progression-2014.json` / `…-2024.json`, узел `rule.class` (kind `class_progression`), чтение — `ClassRules`/`Mechanics.classProgression`; отсутствие файла зафиксировано в `tests/presets.test.cjs` |

Исторические записи в `CHANGELOG.md` и `docs/srd-audit-report.md` ссылаются на эти файлы —
это нормально: они описывают состояние на момент версии. Актуальные инструкции — в
`README.md`, `docs/mechanics.md` и `docs/db.md`.

## Осталось, но это разовые миграции (не генераторы)

Эти скрипты лежат в `tools/srd/` для воспроизводимости прошлых шагов. Они **не входят** в
регулярные проверки, и запускать их на текущих данных не нужно.

| Скрипт | Что делал | Проверка |
|---|---|---|
| `add_class_progression_nodes.cjs` | Перенёс таблицы развития классов в узлы `rule.class` | пишет всегда (нет `--check`); данные уже собраны — 12/12 классов |
| `add_class_rule_nodes.cjs` | Перенёс базовые правила классов в узлы `rule.class` | пишет всегда; 12/12 классов |
| `add_race_background_nodes.cjs` | Перенёс правила рас и предысторий в узлы | пишет всегда; 14/14 и 37/37 записей |
| `add_missing_damage_rolls.cjs` | Добавлял узлы `action.roll` (урон) по тексту описания | пишет всегда; на текущих данных расходится со сборкой — **не запускать** |
| `add_flow_ends.cjs` | Достраивал «Конец» в программы | **есть** `--check`/`--dry-run`, идемпотентен: 2 608 графов без обрывов |
| `fix_*.py` (`fix_class_features`, `fix_en_damage_types`, `fix_monster_defenses`, `fix_skill_names`, `fix_spell_saves`, `fix_thunder_terms`) | Разовые правки данных SRD (термины, спасброски, защиты) | не генераторы; результат уже в `data_seed/` |
| `audit_rolls.py`, `compare_upstream.py` | Отчёты: где в тексте есть броски / сверка с дампом SRD | только читают данные |
| `i18n_*.py`, `localize.py`, `ru_names.py`, `mechanics.py` | Сборка локализации и механик | `localize.py` вызывается `build_srd.py` |

Проверки, которые действительно нужно гонять (и их текущий результат):

```bash
node tools/srd/integrity.cjs                     # 0 ошибок, 12 исторических предупреждений
node tools/srd/mechanics_summary.cjs --check     # сводка совпадает с данными
node tools/srd/add_flow_ends.cjs --check         # программ без «Конца» нет
python3 tools/srd/build_skills.py --check        # 18 навыков актуальны
python3 tools/srd/build_feats.py --check         # черты и ссылки актуальны
python3 tools/srd/clean_legacy_graph_nodes.py --check  # лишних узлов в графах нет
```

## Не архив

Не путать с устаревшим:

- `docs/mechanics-migration.json` — **живая** сводка, её пересобирает
  `node tools/srd/mechanics_summary.cjs`, свежесть проверяет `--check`;
- `docs/node-rules-baseline/` — действующий эталон проекций для
  `tests/node-rules-baseline.test.cjs` и `tools/node_rules_baseline.py`;
- `tools/srd/ru_spells.json` — словарь названий заклинаний, нужен `build_srd.py`;
- `data_seed/feats_2014.json`, `data_seed/feats_2024.json` — актуальные наборы черт.
