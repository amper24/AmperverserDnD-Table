#!/usr/bin/env python3
"""Чистка графов механик в data_seed/ от узлов старого формата.

Расы, классы и предыстории теперь самодостаточны: их правила живут в узлах rule.*
(в наборах правил остаётся только то, чему узла пока нет). Скрипт приводит данные
к этому виду и идемпотентен — повторный запуск ничего не меняет.

Что делает:

1. Навыки на графах. У рас `action.field {kind: 'formula', field: 'skills'}` превращается в узел
   `rule.list` (kind: skill_proficiency), у предысторий `data.skills` — в такой же узел, у классов
   `data.skills {choose, from}` — в узел `rule.list` (kind: skills, id `classSkills`). Выбор навыка
   у рас из набора race_rules (`choices` вида `skills`) становится узлом `rule.list` (kind: skills)
   с тем же ключом выбора (`raceSkills`), чтобы мастер создания продолжал спрашивать.
2. Заклинания и владения рас из набора race_rules переезжают в запись: `cantrips` →
   `data.cantrips`, `choices` вида `spell` → `data.spell_choices`, выбор характеристики
   (`raceSpellAbility`) → `data.spell_ability_choice`, `weapons` → узел
   `rule.list` (kind: proficiencies, label «Оружие»), `hp_bonus` → `rule.value` (kind: hp), `always_prepared` →
   `rule.list` (kind: spell_list) с режимом `prepared`. Эти ключи убираются из набора правил.
3. Лишние узлы. `action.field` (kind: formula) с полем, которое уже закрыто узлом rule.*, удаляется
   вместе с опустевшей программой-обёрткой «Параметры при создании»: у рас это скорость,
   языки, бонусы характеристик и навыки, у классов — кость хитов, спасброски,
   заклинательная характеристика, навыки, доспехи и оружие. Пассивные блоки без узла-
   эквивалента (`unarmored_defense` у варвара и монаха) остаются.
4. Стандартные иконки приложения (`window.ICONS`): записи получают `data.icon`, если
   своего нет — раса по английскому имени, класс и предыстория по категории, навык — `target`.

Запуск:
    python3 tools/srd/clean_legacy_graph_nodes.py          # почистить
    python3 tools/srd/clean_legacy_graph_nodes.py --check  # проверить (код 1, если не почищено)
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SEED_PATHS = {"2014": ROOT / "data_seed" / "srd_2014.json", "2024": ROOT / "data_seed" / "srd_2024.json"}
SKILLS_PATH = ROOT / "data_seed" / "skills.json"
PRESETS = ROOT / "static" / "presets"
EDITIONS = ("2014", "2024")

# Стандартные иконки приложения (static/common.js).
RACE_ICONS = {
    "dwarf": "helm", "elf": "leaf", "half-elf": "halfleaf", "tiefling": "horns", "dragonborn": "dragon",
    "gnome": "cog", "human": "user", "halfling": "leaf", "half-orc": "horns", "orc": "horns", "goliath": "chest",
}
CATEGORY_ICONS = {"class": "shield", "background": "book", "skill": "target"}

# Поля action.field (kind: formula), закрытые узлами rule.*: у рас и у классов.
RACE_COVERED_FIELDS = ("speed", "languages")
CLASS_COVERED_FIELDS = ("hit_die", "saves", "spellcasting", "skills", "armor", "weapons")


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def dump(path: Path, data) -> None:
    """Формат файла как у его генератора: сиды SRD — компактно одной строкой, навыки — как build_skills.py."""
    if path in SEED_PATHS.values():
        path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    else:
        path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


# Английские названия для слоя i18n.en: их вид проверяет tests/i18n.test.cjs (в английском виде
# русского текста быть не должно). Навыки берём из data_seed/skills.json, предметы и заклинания —
# из самих сидов, немногочисленные заголовки и подсказки выбора — таблицей ниже.
TITLES_EN = {
    "Заговор высшего эльфа": "High Elf Cantrip",
    "Заклинательная характеристика родословной": "Lineage Spellcasting Ability",
    "Заклинательная характеристика": "Spellcasting Ability",
    "Навыки расы": "Racial skill",
    "Навыки класса": "Class skill",
    "Параметры при создании": "Character creation parameters",
}
HINTS_EN = {
    "Выберите один заговор из списка волшебника; Интеллект — заклинательная характеристика.":
        "Choose one cantrip from the wizard spell list; Intelligence is your spellcasting ability for it.",
    "Выберите характеристику, указанную в особенности расы.": "Choose the ability noted in the lineage trait.",
    "Острые чувства · эльф": "Keen Senses",
    "Умелость · человек": "Skillful",
    "Универсальность навыков · полуэльф": "Skill Versatility",
}


def name_maps(records, skills):
    """Русское название → английское: для навыков, предметов, заклинаний и всего остального."""
    table = {}
    for entry in records:
        en = (entry.get("data", {}).get("i18n", {}).get("en") or {}).get("name")
        if en and entry.get("name"):
            table.setdefault(entry["name"], en)
    for entry in skills:
        en = (entry.get("data", {}).get("i18n", {}).get("en") or {}).get("name")
        if en and entry.get("name"):
            table.setdefault(entry["name"], en)
    return table


def en_names(names, table):
    return [table.get(str(x), str(x)) for x in names]


def en_ci(value, table):
    """Английское название без учёта регистра: в фильтрах классы записаны строчными буквами."""
    want = str(value).lower()
    for ru, en in table.items():
        if ru.lower() == want:
            return en
    return str(value)


def add_en_nodes(entry, overlay):
    """Дописывает английскую версию новых узлов в data.i18n.en.mechanics.graph.nodes (слияние по id)."""
    if not overlay:
        return
    en = entry["data"].setdefault("i18n", {}).setdefault("en", {})
    mech = en.setdefault("mechanics", {}).setdefault("graph", {})
    nodes = mech.setdefault("nodes", [])
    by_id = {n.get("id"): n for n in nodes}
    for node in overlay:
        target = by_id.get(node["id"])
        if target is None:
            nodes.append(node)
            by_id[node["id"]] = node
        else:
            target.setdefault("params", {}).update(node.get("params") or {})


def add_en_fields(entry, fields):
    """Английские версии новых полей данных: ключ с «!» заменяет значение целиком (см. src/i18n.rs).

    Значения пересчитываются из данных записи, а не дописываются: иначе повторный запуск
    оставил бы английский слой с прежней (например, ещё русской) версией поля.
    """
    if not fields:
        return
    en = entry["data"].setdefault("i18n", {}).setdefault("en", {})
    for key, value in fields.items():
        en[key + "!"] = value


def same(a, b) -> bool:
    return json.dumps(a, ensure_ascii=False, sort_keys=True) == json.dumps(b, ensure_ascii=False, sort_keys=True)


def graph_of(data: dict) -> dict:
    """Граф механик записи (формат v2 — у сидов он уже такой)."""
    mech = data.get("mechanics") or {}
    graph = (mech.get("graph") or {}) if mech.get("version") == 2 else {}
    graph.setdefault("nodes", [])
    graph.setdefault("links", [])
    graph.setdefault("frames", [])
    graph.setdefault("groups", [])
    return graph


def nodes_of(graph: dict, kind: str) -> list:
    return [n for n in graph["nodes"] if n.get("type") == kind]


def value_nodes(graph: dict, kind: str) -> list:
    """Узлы универсального правила-значения выбранного вида (rule.value + params.kind)."""
    return [n for n in nodes_of(graph, "rule.value") if (n.get("params") or {}).get("kind") == kind]


def list_nodes(graph: dict, kind: str) -> list:
    """Узлы универсального правила-списка выбранного вида (rule.list + params.kind)."""
    return [n for n in nodes_of(graph, "rule.list") if (n.get("params") or {}).get("kind") == kind]


def formula_nodes(graph: dict) -> list:
    """Блоки-формулы создания (action.field, kind: formula) — бывшие пассивные блоки."""
    return [n for n in nodes_of(graph, "action.field") if (n.get("params") or {}).get("kind") == "formula"]


def add_node(graph: dict, node: dict) -> None:
    node.setdefault("position", {"x": 40, "y": 40 + (len(graph["nodes"]) % 12) * 60})
    graph["nodes"].append(node)


def drop_node(graph: dict, node_id: str) -> None:
    graph["nodes"] = [n for n in graph["nodes"] if n.get("id") != node_id]
    graph["links"] = [l for l in graph["links"]
                      if (l.get("from") or {}).get("node") != node_id and (l.get("to") or {}).get("node") != node_id]


def fix_passive_chain(graph: dict):
    """Собирает программу «Параметры при создании» заново после удаления пассивных блоков.

    Пассивные блоки в графе выстроены цепочкой (`программа → блок → блок → …`). Когда часть
    блоков удаляется (их поля закрыты узлами rule.*), цепочка рвётся и `Mechanics.toLegacy`
    теряет оставшиеся блоки (так у варвара и монаха пропадала «Защита без доспехов»). Здесь
    программа связывается напрямую с каждым оставшимся блоком.
    """
    passives = formula_nodes(graph)
    programs = [n for n in nodes_of(graph, "action.program") if n.get("params", {}).get("trigger") == "passive"]
    if not passives:
        for program in programs:
            drop_node(graph, program["id"])
        return None
    program = programs[0] if programs else None
    created = None
    if program is None:
        taken = {str(p.get("params", {}).get("program_id")) for p in nodes_of(graph, "action.program")}
        program_id = next(f"p{i}" for i in range(1, 100) if f"p{i}" not in taken)
        program = {"id": f"program-{program_id}", "type": "action.program",
                   "params": {"program_id": program_id, "name": "Параметры при создании", "trigger": "passive"}}
        add_node(graph, program)
        # Английский слой для воссозданной программы: в английском виде русского текста быть не должно.
        created = {"id": program["id"], "params": {"name": "Character creation parameters"}}
    for extra in programs[1:]:
        drop_node(graph, extra["id"])
    ids = {n["id"] for n in passives}
    graph["links"] = [l for l in graph["links"]
                      if not ((l.get("from") or {}).get("node") in ids and (l.get("to") or {}).get("node") in ids)]
    # Повторные связи (и оставшиеся от прежних запусков) убираем: у блока должна быть одна связь от программы.
    seen, links = set(), []
    for link in graph["links"]:
        key = ((link.get("from") or {}).get("node"), (link.get("from") or {}).get("socket"),
               (link.get("to") or {}).get("node"), (link.get("to") or {}).get("socket"))
        if key in seen:
            continue
        seen.add(key)
        links.append(link)
    graph["links"] = links
    linked = {(l.get("to") or {}).get("node") for l in links}
    for node in passives:
        if node["id"] not in linked:
            graph["links"].append({"from": {"node": program["id"], "socket": "exec"}, "to": {"node": node["id"], "socket": "exec"}})
    if created:
        return created
    # Оверлей английского слоя пишем и для уже существующей программы: он мог быть потерян
    # при прежней чистке (узел создавался заново, а перевод — нет).
    name = str(program.get("params", {}).get("name") or "")
    name_en = TITLES_EN.get(name)
    return {"id": program["id"], "params": {"name": name_en}} if name_en else None


def drop_empty_programs(graph: dict) -> None:
    """Программа-обёртка «Параметры при создании» без блоков: узел-программа без связей."""
    linked = set()
    for link in graph["links"]:
        linked.add((link.get("from") or {}).get("node"))
        linked.add((link.get("to") or {}).get("node"))
    for node in list(graph["nodes"]):
        if node.get("type") == "action.program" and node.get("params", {}).get("trigger") == "passive" and node["id"] not in linked:
            drop_node(graph, node["id"])


def skill_names(values) -> list:
    """Названия навыков из значения пассивного блока или поля data.skills."""
    if isinstance(values, dict):
        values = values.get("from") or []
    if not isinstance(values, list):
        return []
    return [str(v).strip() for v in values if isinstance(v, str) and str(v).strip()]


def merge_race(entry: dict, table: dict | None, is_root: bool, names: dict) -> None:
    d = entry["data"]
    graph = graph_of(d)
    overlay, overlay_fields = [], {}

    # 1. Навыки расы: пассивный блок → узел владения навыком.
    if not list_nodes(graph, "skill_proficiency"):
        fixed = []
        for node in formula_nodes(graph):
            if node.get("params", {}).get("field") == "skills":
                fixed += skill_names(node["params"].get("value"))
        if fixed:
            fixed = list(dict.fromkeys(fixed))
            add_node(graph, {"id": "race_skills_fixed", "type": "rule.list", "params": {"kind": "skill_proficiency", "value": fixed}})
            overlay.append({"id": "race_skills_fixed", "params": {"kind": "skill_proficiency", "value": en_names(fixed, names)}})

    # 2. Языки: узел rule.list (kind: languages) (у рас 2024 языков нет — выбора стандартных языков в данных тоже нет).
    if not list_nodes(graph, "languages"):
        langs = [x.strip() for x in (d.get("languages") or []) if isinstance(x, str) and x.strip() and len(x.strip()) <= 40]
        if langs:
            add_node(graph, {"id": "race_languages", "type": "rule.list", "params": {"kind": "languages", "value": langs}})
            overlay.append({"id": "race_languages", "params": {"kind": "languages", "value": en_names(langs, names)}})

    choices = [c for c in ((table or {}).get("choices") or []) if isinstance(c, dict)]

    # 3. Выбор навыка игроком: набор правил → узел rule.list (kind: skills) с тем же ключом выбора.
    skill_choices = [c for c in choices if c.get("kind") == "skills" and c.get("key")] if table else []
    if is_root and skill_choices and not list_nodes(graph, "skills"):
        choice = skill_choices[0]
        title = str(choice.get("title") or "Навыки расы")
        add_node(graph, {"id": "race_skills_choice", "type": "rule.list",
                         "params": {"kind": "skills", "id": str(choice["key"]), "count": int(choice.get("count") or 0),
                                    "options": [], "title": title}})
        overlay.append({"id": "race_skills_choice", "params": {"kind": "skills", "title": HINTS_EN.get(title, title)}})

    # 4. Заклинания расы: набор правил → поля записи (их мастер создания читает первыми).
    cantrips = []
    for item in (table or {}).get("cantrips") or []:
        if isinstance(item, dict) and item.get("name"):
            cantrips.append({"name": str(item["name"]), "level": 0, "ability": str(item.get("ability") or "")})
        elif isinstance(item, str) and item.strip():
            cantrips.append({"name": item.strip(), "level": 0, "ability": ""})
    if cantrips and "cantrips" not in d:
        d["cantrips"] = cantrips

    spell_choices = []
    for c in choices:
        if c.get("kind") != "spell" or not c.get("key"):
            continue
        spell_choices.append({"key": str(c["key"]), "kind": "spell", "title": str(c.get("title") or ""),
                              "hint": str(c.get("hint") or ""), "ability": str(c.get("ability") or "int"),
                              "filter": {"level": int((c.get("filter") or {}).get("level") or 0),
                                         "classes": [str(x).lower() for x in ((c.get("filter") or {}).get("classes") or [])]}})
    if spell_choices and "spell_choices" not in d:
        d["spell_choices"] = spell_choices

    ability = next((c for c in choices if c.get("key") == "raceSpellAbility" and c.get("kind") == "options"), None)
    if ability and "spell_ability_choice" not in d:
        chosen = {"enabled": True, "options": [str(o.get("value")) for o in ability.get("options") or [] if o.get("value")],
                  "title": str(ability.get("title") or "Заклинательная характеристика"), "hint": str(ability.get("hint") or "")}
        d["spell_ability_choice"] = chosen

    # 4b. Английский слой для полей заклинаний: считается из итоговых данных записи, поэтому
    # повторный запуск чинит слой, даже если поля уже переехали раньше.
    if d.get("cantrips"):
        overlay_fields["cantrips"] = [{"name": names.get(c["name"], c["name"]), "level": c.get("level", 0),
                                       "ability": c.get("ability", "")} for c in d["cantrips"]]
    if d.get("spell_choices"):
        overlay_fields["spell_choices"] = [{**c, "title": TITLES_EN.get(c["title"], c["title"]),
                                           "hint": HINTS_EN.get(c["hint"], c["hint"]),
                                           # Классы в фильтре — строчными буквами, как их сравнивает мастер создания.
                                           "filter": {**c.get("filter", {}), "classes": list(dict.fromkeys(
                                               en_ci(x, names).lower() for x in (c.get("filter") or {}).get("classes") or []))}}
                                          for c in d["spell_choices"]]
    if d.get("spell_ability_choice"):
        ability_choice = d["spell_ability_choice"]
        overlay_fields["spell_ability_choice"] = {**ability_choice,
                                                  "title": TITLES_EN.get(ability_choice.get("title"), ability_choice.get("title")),
                                                  "hint": HINTS_EN.get(ability_choice.get("hint"), ability_choice.get("hint"))}

    # 5. Владения оружием, бонус хитов и всегда подготовленные заклинания → узлы.
    weapons = [str(x).strip() for x in (table or {}).get("weapons") or [] if str(x).strip()]
    if weapons and not any((n.get("params") or {}).get("label") == "Оружие" for n in list_nodes(graph, "proficiencies")):
        add_node(graph, {"id": "race_weapons", "type": "rule.list", "params": {"kind": "proficiencies", "label": "Оружие", "value": weapons}})
        overlay.append({"id": "race_weapons", "params": {"kind": "proficiencies", "label": "Weapons", "value": en_names(weapons, names)}})
    if (table or {}).get("hp_bonus") and not value_nodes(graph, "hp"):
        add_node(graph, {"id": "race_hp_bonus", "type": "rule.value", "params": {"kind": "hp", "amount": int(table["hp_bonus"])}})
    prepared = [str(x).strip() for x in (table or {}).get("always_prepared") or [] if str(x).strip()]
    if prepared and not list_nodes(graph, "spell_list"):
        add_node(graph, {"id": "race_prepared", "type": "rule.list", "params": {"kind": "spell_list", "mode": "prepared", "spells": prepared}})
        overlay.append({"id": "race_prepared", "params": {"kind": "spell_list", "spells": en_names(prepared, names)}})

    # 6. Чистка лишних пассивных блоков: их поля закрыты узлами rule.*.
    covered = set(RACE_COVERED_FIELDS)
    covered.update(f"asi.{n['params'].get('ability')}" for n in value_nodes(graph, "ability"))
    if list_nodes(graph, "skill_proficiency"):
        covered.add("skills")
    for node in list(formula_nodes(graph)):
        if str(node.get("params", {}).get("field")) in covered:
            drop_node(graph, node["id"])
    wrapper = fix_passive_chain(graph)
    drop_empty_programs(graph)
    prune_en_overlay(entry)
    add_en_nodes(entry, overlay + ([wrapper] if wrapper else []))
    add_en_fields(entry, overlay_fields)


def merge_class(entry: dict, names: dict) -> None:
    d = entry["data"]
    graph = graph_of(d)
    # Выбор навыков класса: поле data.skills → узел rule.list (kind: skills) (поле остаётся источником для мастера создания).
    if not list_nodes(graph, "skills") and isinstance(d.get("skills"), dict):
        from_names = [str(x).strip() for x in d["skills"].get("from") or [] if str(x).strip()]
        count = int(d["skills"].get("choose") or 0)
        if from_names or count:
            add_node(graph, {"id": "class_skills", "type": "rule.list",
                             "params": {"kind": "skills", "id": "classSkills", "count": count, "options": from_names,
                                        "title": "Навыки класса"}})
            add_en_nodes(entry, [{"id": "class_skills", "params": {"kind": "skills", "options": en_names(from_names, names), "title": "Class skill"}}])
    for node in list(formula_nodes(graph)):
        if str(node.get("params", {}).get("field")) in CLASS_COVERED_FIELDS:
            drop_node(graph, node["id"])
    wrapper = fix_passive_chain(graph)
    drop_empty_programs(graph)
    prune_en_overlay(entry)
    if wrapper:
        add_en_nodes(entry, [wrapper])


def merge_background(entry: dict, table: dict) -> None:
    d = entry["data"]
    graph = graph_of(d)
    if not list_nodes(graph, "skill_proficiency"):
        fixed = skill_names(d.get("skills"))
        if fixed:
            add_node(graph, {"id": "bg_skills", "type": "rule.list", "params": {"kind": "skill_proficiency", "value": fixed}})
            add_en_nodes(entry, [{"id": "bg_skills", "params": {"kind": "skill_proficiency", "value": en_names(fixed, table)}}])
    has_skill_node = bool(list_nodes(graph, "skill_proficiency"))
    for node in list(formula_nodes(graph)):
        if has_skill_node and str(node.get("params", {}).get("field")) == "skills":
            drop_node(graph, node["id"])
    wrapper = fix_passive_chain(graph)
    drop_empty_programs(graph)
    prune_en_overlay(entry)
    if wrapper:
        add_en_nodes(entry, [wrapper])


def prune_en_overlay(entry: dict) -> None:
    """Убирает из английского слоя узлы, которых больше нет в графе записи.

    Слияние слоя идёт по id и дописывает незнакомые узлы: если этого не сделать, удалённые
    пассивные блоки вернулись бы в английском виде (и снова стали бы «лишними узлами»).
    """
    d = entry.get("data") or {}
    en = (d.get("i18n") or {}).get("en") or {}
    nodes = ((en.get("mechanics") or {}).get("graph") or {}).get("nodes")
    if not isinstance(nodes, list) or not nodes:
        return
    alive = {n.get("id") for n in ((d.get("mechanics") or {}).get("graph") or {}).get("nodes", [])}
    en["mechanics"]["graph"]["nodes"] = [n for n in nodes if n.get("id") in alive]


def set_icons(records) -> None:
    for entry in records:
        d = entry.get("data") or {}
        if d.get("icon"):
            continue
        if entry.get("category") == "race":
            en = str((d.get("i18n", {}).get("en") or {}).get("name") or "").lower()
            for key, icon in RACE_ICONS.items():
                if key in en:
                    d["icon"] = icon
                    break
        elif entry.get("category") in CATEGORY_ICONS:
            d["icon"] = CATEGORY_ICONS[entry["category"]]


def plan_edition(edition: str):
    """Новые данные редакции: (путь к сиду, записи, путь к набору, набор)."""
    seed_path = SEED_PATHS[edition]
    records = load(seed_path)
    preset_path = PRESETS / f"race-rules-{edition}.json"
    presets = load(preset_path)
    items = presets.get("items") if isinstance(presets, dict) and "items" in presets else presets
    tables = {str(item["table"].get("name_en", "")).lower(): item["table"] for item in items if isinstance(item.get("table"), dict)}

    names = name_maps(records, load(SKILLS_PATH))
    for entry in records:
        category = entry.get("category")
        if category == "race":
            en = str((entry["data"].get("i18n", {}).get("en") or {}).get("name") or "").lower()
            is_root = not entry["data"].get("parent") and not entry["data"].get("subrace")
            merge_race(entry, tables.get(en), is_root, names)
        elif category == "class":
            merge_class(entry, names)
        elif category == "background":
            merge_background(entry, names)
    set_icons(records)

    # Набор правил: убираем переехавшее в записи.
    for item in items:
        table = item["table"]
        for key in ("cantrips", "weapons", "hp_bonus", "always_prepared"):
            table.pop(key, None)
        choices = [c for c in (table.get("choices") or []) if isinstance(c, dict)]
        if choices:
            kept = [c for c in choices if c.get("kind") not in ("spell", "skills") and c.get("key") != "raceSpellAbility"]
            if kept:
                table["choices"] = kept
            else:
                table.pop("choices", None)
    return seed_path, records, preset_path, presets


def plan_skills():
    skills = load(SKILLS_PATH)
    set_icons(skills)
    return SKILLS_PATH, skills


def main() -> int:
    parser = argparse.ArgumentParser(description="Чистка графов механик в data_seed/ (расы, классы, предыстории)")
    parser.add_argument("--check", action="store_true", help="ничего не писать: код 1, если данные не почищены")
    args = parser.parse_args()

    dirty, written = [], []
    for edition in EDITIONS:
        seed_path, records, preset_path, presets = plan_edition(edition)
        if not same(load(seed_path), records):
            dirty.append(seed_path)
            if not args.check:
                dump(seed_path, records)
                written.append(seed_path)
        if not same(load(preset_path), presets):
            dirty.append(preset_path)
            if not args.check:
                dump(preset_path, presets)
                written.append(preset_path)
    skills_path, skills = plan_skills()
    if not same(load(skills_path), skills):
        dirty.append(skills_path)
        if not args.check:
            dump(skills_path, skills)
            written.append(skills_path)

    if args.check:
        if dirty:
            for path in dirty:
                print(f"{path.relative_to(ROOT)}: данные не почищены — запустите python3 tools/srd/clean_legacy_graph_nodes.py", file=sys.stderr)
            return 1
        print("данные почищены: в графах рас и классов нет лишних узлов")
        return 0
    if written:
        for path in written:
            print(f"обновлён {path.relative_to(ROOT)}")
    else:
        print("данные уже почищены")
    return 0


if __name__ == "__main__":
    sys.exit(main())
