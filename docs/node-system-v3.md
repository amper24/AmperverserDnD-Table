# Нодовая система v3

Цель: маленькие ортогональные блоки, условия у каждого блока, результаты действий,
доступные другим действиям, и понятная палитра без легаси. Обратной совместимости нет.

## Принципы

1. **Один блок — один глагол.** Блок либо вычисляет значение, либо меняет лист/предмет,
   либо управляет потоком. Составные узлы (adjust+condition+passive) сливаются в один
   `action.field` с параметром `kind`, как уже сделано для `rule.value/list/class`.
2. **Условие у каждого блока.** У всех блоков есть входы `enabled` (статическое условие:
   редакция/уровень/подкласс/выбор) и `condition` (динамическое bool-значение). Если
   условие ложно, блок пропускается, а поток идёт дальше по exec-выходу. Ветвление
   (`flow.if`) остаётся только для случаев, где нужны разные продолжения цепочки.
3. **Результаты принадлежат листу.** Выполнение действия пишет итог в лист:
   `sheet.action_results = { last: {...}, by_program: { "<program_id>": {...} } }`.
   Узел `data.result` читает последнее действие или конкретную программу; `data.sheet`
   читает поле листа. Так одно действие может «посмотреть», что дало другое действие на
   этом же листе, и использовать это в условиях и формулах.
4. **Поток статический, значения — в рантайме.** План блоков (`to_v1_with_context`)
   остаётся: поток и порядок блоков известны при компиляции. Для динамического условия
   в план кладётся `condition_src` — id узла-источника; сервер вычисляет его значение в
   рантайме той же функцией, что и при компиляции (`mechanics_graph::node_value`), но с
   контекстом `{"runtime": {"sheet": <лист>, "results": <action_results>}}`. `flow.if`
   по-прежнему выбирает ветвь статически (при неизвестном значении остаются обе ветви).
5. **Палитра закрытая.** Незнакомый тип узла — ошибка; алиасов нет.

## Палитра v3

Порядок категорий в меню — рабочий процесс: **Начало → Действия → Данные → Условия → Правила → Группы**.
У каждого типа есть короткое описание одной строкой (подсказка в меню и на карточке).
Заголовки карточек единообразны: `Действие · …`, `Данные · …`, `Условие · …`, `Правило · …`;
у настраиваемых узлов после названия идёт выбранный вид (`Действие · Бросок · Атака`).

| Тип | Назначение | Входы → выходы | Параметры |
|---|---|---|---|
| `action.program` | Начало действия и его кнопка | — → `exec` (flow) | `program_id`, `name`, `trigger` = use/passive, `style`, `feature_name`, `group`, `roll_only` |
| `flow.if` | Ветвление потока по bool | `exec` (flow), `condition` (bool) → `then`/`else` (flow) | нет |
| `flow.end` | Конец действия | `exec` (flow) → — | нет |
| `action.roll` | Бросок: атака, урон, лечение, временные хиты, свободный | `exec`, `enabled` (bool), `condition` (bool), `dice` (dice) → `exec` | `kind` = roll/attack/damage/heal/temp_hp, `dice`, `dc`, `name`, `target`/`apply` (лечение, временные хиты), `damage_type`, `upcast` = `{ count, sides }` |
| `action.field` | Изменение листа: состояние, показатель, формула | `exec`, `enabled`, `condition` → `exec` | `kind` = status/value/formula; status: `condition`, `operation` add/remove/concentration; value: `field`, `amount`; formula: `field`, `value` |
| `action.spend` | Расход ресурса предмета или умения | `exec`, `enabled`, `condition` → `exec` | `resource` = quantity/charges/uses, `source` = self/item/tag, `amount`, `trigger` = use/attack, `item_uid`, `tag` |
| `action.slot` | Расход ячейки заклинания | `exec`, `enabled`, `condition` → `exec` | `level` = 0 (круг выбирается при касте) / 1–9, `amount` |
| `action.grant_item` | Выдача предмета владельцу листа | `exec`, `enabled`, `condition` → `exec` | `amount`, `item`, `target` |
| `action.manual` | Правило для мастера | `exec`, `enabled`, `condition` → `exec` | `text` |
| `data.number` | Числовая константа | — → `value` (number) | `value` |
| `data.dice` | Кость или формула | — → `value` (dice) | `value` = `{ count, sides, bonus, stat }` |
| `data.stat` | Характеристика или навык | — → `value` (dice) | `id`, `mode` = bonus/score |
| `data.math` | Арифметика | `a`, `b` (number) → `value` (number) | `op` = add/sub/mul/div/min/max |
| `data.compare` | Сравнение чисел | `a`, `b` (number) → `value` (bool) | `op` = `>=`, `<=`, `>`, `<`, `=`, `!=` |
| `dice.combine` | Сложение двух костей | `a`, `b` (dice) → `value` (dice) | нет |
| `logic.op` | Логика И / ИЛИ / НЕ | `a`, `b` (bool) → `value` (bool) | `op` = and/or/not |
| `data.boolean` | Логическая константа | — → `value` (bool) | `value` = true/false |
| `data.result` | Результат последнего действия или программы | — → `value` (number) | `source` = last/ID программы, `field` = total/hit/applied/spent |
| `data.sheet` | Числовое поле листа | — → `value` (number) | `field` — путь вида `hp.current`, `level`, `abilities.str` |
| `data.cast` | Круг текущего каста | — → `value` (number) | `field` = level/base/extra |
| `condition.context` | Условие редакции, уровня, подкласса, выбора | — → `value` (bool) | `kind` = edition/level/subclass/choice; edition: `editions`; level: `min`, `max`; subclass/choice: `id`, `value` |
| `condition.hit` | Попадание предыдущей атаки | — → `value` (bool) | нет |
| `rule.value` | Правило-значение | `enabled` (bool), `amount` (number) → `effect` | `kind` = ability/speed/hp/hit_die/asi/armor_formula + `ability`, `amount`, `value`, `formula`, `table` |
| `rule.list` | Правило-список | `enabled`, `amount` (number) → `effect` | `kind` = languages/proficiencies/skill_proficiency/saving_throws/skills/spell_list/feature/class_features/equipment/equipment_choice + поля вида |
| `rule.class` | Правило класса | `enabled` (bool) → `effect` | `kind` = class_progression/class_rules/spell_slots/spellcasting, `table`, `ability` |
| `rule.manual` | Ручное правило пассивной программы | `enabled` (bool) → `effect` | `text` |
| `group.instance` | Вызов повторно используемой группы | порты группы → порты группы | `group_id` |
| `group.input` | Вход группы (внутренний) | — → `value` (тип сокета) | `socket_id` |
| `group.output` | Выход группы (внутренний) | `value` (тип сокета) → — | `socket_id` |

Отдельных узлов изменения состояния, показателя и параметра при создании больше нет — их
заменяет один `action.field` с параметром `kind`; расход предметных ресурсов — `action.spend`,
ячейка заклинания — отдельный `action.slot`; сравнение чисел переехало в `data.compare`.
`data.boolean` остаётся как константа.

### action.roll

Бросок с видом `kind` (roll / attack / damage / heal / temp_hp), кубиками, DC и
режимом преимущества. Лечение и временные хиты применяются сразу; урон — это бросок,
результат которого применяет ДМ (или `action.field` по его решению).

`upcast` = `{ count, sides }` — сколько костей добавляется к урону или лечению за
каждый круг ячейки выше базового. Сервер дописывает `+(extra*count)d<sides>` к формуле
только у блоков damage/heal; у атаки и свободного броска параметр не действует.

### action.field

Изменение листа или состояния: `kind` = status / value / formula. `status` — имя
состояния в параметре `condition` и операция add/remove; операция `concentration`
оставляет `condition` пустым — сервер сам подставляет «Концентрация: <имя заклинания>»
и заменяет прежнюю запись. `value` — поле листа `field` и целое `amount`; `formula` —
пассивный параметр при создании (`field`, `value`, например формула защиты без доспехов).
Урон, лечение и временные хиты — это броски `action.roll`, а не `action.field`.

### action.spend

Расход ресурса: `resource` = quantity / charges / uses, источник `source` =
self / item / tag, `amount` и момент `trigger` = use / attack.

### action.slot

Расход ячейки заклинания. `level` = 0 — круг выбран при касте (сервер берёт его из
операции и контекста каста), 1–9 — фиксированный круг. `amount` — сколько ячеек
списать. В план блока исполнения узел компилируется в `consume` с `resource: "slot"`
и `slot_level`. При ритуале (круг каста 0) блок пропускается: ячейка не тратится.

### data.result / data.sheet / data.cast

`data.result` — выход `value: number`, входов нет. Параметры:
`source` = `last` (последнее выполненное действие) или `program_id` программы этого
графа; `field` = `total` | `hit` | `applied` | `spent`. `hit` отдаётся числом 0/1.
Значение берётся из `sheet.action_results` (см. ниже); без состояния выполнения
(редактор, предпросмотр) — `0`.

`data.sheet` — выход `value: number`, входов нет. Параметр `field` — непустой путь по
ключевым полям листа из `[a-z0-9_.]` (`hp.current`, `level`, `abilities.str`).
Отсутствующее или нечисловое поле — `0`; без листа (предпросмотр) — тоже `0`.

`data.cast` — выход `value: number`, входов нет. Параметр `field` = `level` (круг
выбранной ячейки) | `base` (базовый круг заклинания) | `extra` (круги выше базового).
Читается из контекста каста; без каста (редактор, предпросмотр) — `0`.
Все три узла используются в условиях (`data.compare`) и формулах.

### Результаты выполнения

После успешного действия сервер пишет в лист:

```json
{
  "action_results": {
    "last": { "total": 12, "hit": true, "applied": 0, "spent": 1, "rolls": 2, "at": 1760000000 },
    "by_program": {
      "<program_id>": { "total": 12, "hit": true, "applied": 0, "spent": 1, "rolls": 2, "at": 1760000000 }
    }
  }
}
```

- `total` — итог последнего броска действия (0, если бросков не было);
- `hit` — попадание атаки: `true`/`false`, `null` без броска атаки (в `data.result` — 0/1);
- `applied` — сумма эффектов `heal`/`temp_hp`/`damage`; урон приходит броском и на лист
  не применяется (его применяет ДМ), поэтому на практике это лечение и временные хиты;
- `spent` — сумма израсходованных ресурсов;
- `rolls` — число бросков действия; `at` — unix-секунды выполнения.
- `last` перезаписывается каждым успешным действием, `by_program` хранит итог каждой
  программы и не теряет ранее записанные программы.
- Ошибка на любом шаге по-прежнему откатывает лист целиком: результаты пишутся только
  после выполнения всей цепочки. Ответ `execute` содержит этот же объект в поле `results`.

Условие блока считается в рантайме: если ко входу `condition` подведён провод, в блок
плана попадает `condition_src`, и сервер вычисляет узел-источник по текущему листу и
результатам. `false` или `0` пропускает блок, поток идёт дальше по `exec`; неизвестный
узел — ошибка выполнения (лист не меняется). В редакторе предпросмотр остаётся
статическим: `data.result`/`data.sheet` без состояния дают `0`, поэтому блок с таким
условием в предпросмотре может быть скрыт.

## Заклинания

Каст — программа `action.program` → `action.slot` → броски и правила. `action.slot.level = 0`
означает «круг выбирает игрок»: клиент перед кастом показывает круги от базового до 9-го,
в которых есть свободные ячейки, и отправляет `slot_level` в операции `program`. Сервер
проверяет `base ≤ chosen ≤ 9`, списывает ячейку нужного круга (обычную, иначе ячейку
Договора) и кладёт `{ level, base, extra }` в контекст выполнения:

- `extra = chosen - base`; у `action.roll` (damage/heal) с `upcast` к формуле добавляется
  `extra*count` костей `sides` — например, «Огненный шар» 3-го круга ячейкой 5-го бросает
  `8d6+2d6`;
- `data.cast` читает `level` / `base` / `extra` (без каста — 0);
- ритуал: `slot_level = 0` при `base > 0` разрешён только заклинанию со свойством «Ритуал»;
  блок `action.slot` пропускается, в ответе эффект «Ритуал: 10 минут, ячейка не тратится»;
- концентрация: после успешного каста сервер заменяет состояние «Концентрация: …» именем
  заклинания (прежняя запись удаляется, чужие состояния остаются);
- `action.field` status с `operation: concentration` — явный узел того же поведения для
  редактора; `condition` у него пустой, имя подставляет сервер.

Контекст каста живёт только на время выполнения (`sheet.cast` ставится перед блоками и
удаляется до нормализации), в листе сохраняются лишь ячейки, состояния и `action_results`.
Шаблон «Ячейка → лечение» использует `action.slot` с `level: 1`; SRD-заклинания —
`action.slot` с `level: 0`, `upcast` по тексту `higher_level` и узел концентрации.

## Шаблоны

Готовые шаблоны лежат в двух наборах и собираются только из узлов v3:

- `static/presets/mechanic-templates.json` — полные графы (`action.program` → блоки → `flow.end`)
  для библиотеки `Mechanics.templates(category)`;
- `static/presets/graph-starters.json` — тела цепочек с `attach: true` для диалога «Шаблоны действий»:
  вставка в пустое действие ставит цепочку между существующими «Началом» и «Концом».

Новые шаблоны (появились вместе с унификацией палитры):

| Шаблон | Цепочка |
|---|---|
| Атака и урон по результату | `action.roll` (attack) → `condition.hit` → `flow.if` → `action.roll` (damage) в ветке «да» |
| Лечение при ранении | `data.sheet` (hp.current, hp.max) + `data.math` → `data.compare` (`<`) → `action.roll` (heal) с условием |
| Спасбросок против СЛ | `action.roll` (roll с `dc`) → `data.result` (total) → `data.compare` с СЛ → `flow.if` → урон при провале |
| Многоатака: два удара | два `action.roll` (attack) подряд |
| Заряды посоха | `action.spend` (charges) → `action.roll` (damage) |
| Кара: дополнительный урон | attack → `flow.if` (hit) → основной damage → дополнительный damage в той же ветке |
| Аура: усиление по уровню | `condition.context` (level) → `action.field` (value: speed) с условием |
| Скрытая атака | `condition.context` (level ≥ 3) → `action.roll` (damage 3d6) с условием |

Все шаблоны проходят `Mechanics.validate`/`Mechanics.problems`, каждый граф содержит `flow.end`,
а вставляемые варианты проверяются на отсутствие висячих exec-выходов после attach
(`tests/template-presets.test.cjs`).

## Этапы

1. Палитра v3: слияние узлов, условия `enabled`/`condition` у блоков, миграция данных —
   сделано.
2. Состояние выполнения: `data.result`, `data.sheet`, `action_results` в листе и
   `condition_src` в плане (условие блока считается в рантайме; поток остаётся
   статическим) — сделано.
3. Заклинания: отдельный узел `action.slot`, выбор круга, upcast, концентрация, ритуал,
   `data.cast`; SRD-заклинания пересобраны (295/312 с ячейкой, 126/132 с концентрацией,
   29/29 ритуальных, 32/37 с upcast) — сделано.
4. Шаблоны: 40 автоматических механик (включая 8 новых), единая палитра с описаниями и
   подсказками — сделано; редактор продолжает упрощаться (пустые состояния, примеры).
