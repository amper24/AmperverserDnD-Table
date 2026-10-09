# Эталон node-rules (разбитый на файлы)

Раньше это был один файл `docs/node-rules-baseline.json` (2.8 МБ). Теперь эталон
лежит каталогом, где каждая запись рас/классов SRD и каждый уровень — отдельный
маленький JSON-файл (самый большой ~34 КБ).

```
meta.json                       метаданные снимка + порядок записей (поле entries)
<редакция>/<races|classes>/<slug>/
    entry.json                  slug, name, parent, choices, edition, kind, levels
    level-01.json, level-03.json, ... {"level": N, "sheet": {...}}
```

Содержимое эквивалентно прежнему монолитному файлу; при изменении формата
он собирается обратно скриптом.

## Работа с эталоном

```bash
# разбить монолит (если он снова понадобится) на каталог
python3 tools/node_rules_baseline.py split --src docs/node-rules-baseline.json --dst docs/node-rules-baseline

# собрать один JSON (например, для сравнения или экспорта)
python3 tools/node_rules_baseline.py merge --src docs/node-rules-baseline --dst /tmp/node-rules-baseline.json

# проверить, что каталог собирается в те же данные, что и эталон
python3 tools/node_rules_baseline.py check --src docs/node-rules-baseline.json --dst docs/node-rules-baseline
```

Эталон замороженный: не правьте файлы уровней, чтобы «подогнать» код под них —
расхождения исправляются в таблицах/графах (см. `../node-rules-inventory.md`).
