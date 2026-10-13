#!/usr/bin/env python3
"""Записи навыков справочника (data_seed/skills.json): 18 навыков SRD с русским и английским
слоем и графом механики.

    python3 tools/srd/build_skills.py            # пересобрать data_seed/skills.json
    python3 tools/srd/build_skills.py --check    # только проверить, что файл актуален

Ключи и характеристики должны совпадать со списком клиента (SKILLS в static/common.js)
и списком сервера (SKILL_IDS в src/mechanics_graph.rs) — это проверяет tools/srd/integrity.cjs.

У каждой записи свой граф: узел `rule.skill_proficiency` раздаёт владение этим навыком,
поэтому запись работает как и остальные объекты справочника — её можно перетащить в
редактор расы или класса и на лист персонажа, и владение придёт из графа.
"""
import argparse
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "data_seed" / "skills.json"

# ключ, название, характеристика, английское название, русское описание, английское описание
SKILLS = [
    ('acrobatics', 'Акробатика', 'dex', 'Acrobatics',
     'Удержать равновесие на краю или на скользкой поверхности, выполнить акробатический трюк, вырваться из захвата или уйти от опрокидывания.',
     'Stay on your feet in tricky situations: balance on a ledge, perform an acrobatic stunt, escape a grapple or avoid being knocked prone.'),
    ('animal', 'Уход за животными', 'wis', 'Animal Handling',
     'Успокоить животное, понять его намерения, удержаться в седле при резком манёвре или заставить ездовое животное преодолеть препятствие.',
     'Calm a domesticated animal, intuit its intent, keep your seat when a mount rears or force a mount to cross a frightening obstacle.'),
    ('arcana', 'Магия', 'int', 'Arcana',
     'Знания о магии: школы и традиции, магические предметы и символы, существа из иных планов, правила работы заклинаний.',
     'Recall lore about spells, magic items, eldritch symbols, magical traditions, the planes of existence and the creatures that dwell there.'),
    ('athletics', 'Атлетика', 'str', 'Athletics',
     'Лазание, плавание, прыжки, захват и удержание противника, трудные физические усилия.',
     'Climb, swim, jump, grapple or shove a creature: any hard physical effort that tests raw strength and endurance.'),
    ('deception', 'Обман', 'cha', 'Deception',
     'Скрыть правду, выдать ложь за истину, незаметно подсунуть фальшивку или отвести глаза стражнику.',
     'Hide the truth, pass off a lie as fact, palm a forged document or talk your way past a guard who should know better.'),
    ('history', 'История', 'int', 'History',
     'Легенды, войны и колонии, древние цивилизации, давно забытые династии и события прошлого.',
     'Recall lore about historical events, legendary people, ancient kingdoms, past disputes, wars and lost colonies.'),
    ('insight', 'Проницательность', 'wis', 'Insight',
     'Понять истинные намерения собеседника, заметить ложь, уловить настроение или прочитать язык тела.',
     'Determine the true intentions of a creature: spot a lie, predict its next move or read a telling mood and body language.'),
    ('intimidation', 'Запугивание', 'cha', 'Intimidation',
     'Угрозами или давлением заставить существо сделать то, что вам нужно, или выбить из него правду.',
     'Force a creature to do what you want through overt threats, hostile actions or physical intimidation.'),
    ('investigation', 'Расследование', 'int', 'Investigation',
     'Найти скрытую улику, воссоздать картину случившегося по косвенным признакам, расшифровать чужие записи.',
     'Look around for clues, deduce what happened from indirect evidence, or puzzle out a trap, a lock or hidden writing.'),
    ('medicine', 'Медицина', 'wis', 'Medicine',
     'Стабилизировать умирающего, поставить диагноз, определить причину смерти или действие яда.',
     'Diagnose an illness, stabilise a dying companion, or identify the poison, disease or wound that afflicts a creature.'),
    ('nature', 'Природа', 'int', 'Nature',
     'Знания о растениях и животных, погоде и природных циклах, ландшафте и его опасностях.',
     'Recall lore about terrain, plants and animals, weather, seasons and natural cycles — and the dangers they hide.'),
    ('perception', 'Восприятие', 'wis', 'Perception',
     'Заметить существо или предмет, услышать звук за дверью, почувствовать засаду — или понять, что кто-то крадётся.',
     'Spot, hear or otherwise detect the presence of something: notice a hidden creature, eavesdrop on a conversation or sense an ambush.'),
    ('performance', 'Выступление', 'cha', 'Performance',
     'Сыграть, спеть, станцевать, прочесть стихи или удержать внимание толпы.',
     'Act, tell a joke, play an instrument, dance or sing: hold the attention of an audience and move it as you intend.'),
    ('persuasion', 'Убеждение', 'cha', 'Persuasion',
     'Уговорить собеседника дипломатией, сочувствием или здравым доводом — заставить его захотеть помочь.',
     'Win someone over with tact, social grace or good nature: make a creature want to do what you ask.'),
    ('religion', 'Религия', 'int', 'Religion',
     'Знания о богах и их служителях, ритуалах и священных символах, культы и запретные обряды.',
     'Recall lore about deities, rites and prayers, religious hierarchies, holy symbols and the practices of secret cults.'),
    ('sleight', 'Ловкость рук', 'dex', 'Sleight of Hand',
     'Незаметно украсть, спрятать предмет в рукаве, сжульничать в игре или подсунуть что-то на глазах у всех.',
     'Pick a pocket, plant something on someone, conceal an object on your person or cheat at a game unnoticed.'),
    ('stealth', 'Скрытность', 'dex', 'Stealth',
     'Спрятаться, пройти незамеченным, подобраться к врагу или вовсе не оставить следа.',
     'Conceal yourself, move silently, sneak up on a creature or escape notice and leave no trail behind.'),
    ('survival', 'Выживание', 'wis', 'Survival',
     'Идти по следу, выследить дичь, найти дорогу, предсказать погоду или найти пропитание и укрытие.',
     'Follow tracks, hunt game, guide a group through wasteland, predict the weather or find food and shelter for everyone.'),
]

ORIGIN = 'skill-graph-v2'


def graph(name):
    """Граф записи навыка: владение этим навыком (узел rule.skill_proficiency)."""
    return {
        'origin': ORIGIN,
        'version': 2,
        'graph': {
            'nodes': [{
                'id': 'skill_proficiency',
                'type': 'rule.skill_proficiency',
                'params': {'value': [name]},
                'position': {'x': 40, 'y': 40},
            }],
            'links': [],
            'frames': [],
            'groups': [],
        },
    }


def entries():
    out = []
    for key, name, ability, name_en, desc, desc_en in SKILLS:
        out.append({
            'category': 'skill',
            'slug': key,
            'name': name,
            'data': {
                'key': key,
                'ability': ability,
                'name_en': name_en,
                'desc': desc,
                'mechanics': graph(name),
                'i18n': {'en': {'name': name_en, 'desc': desc_en}},
            },
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='проверить, что файл не отличается от сборки')
    args = ap.parse_args()
    text = json.dumps(entries(), ensure_ascii=False, indent=1) + '\n'
    current = OUT.read_text(encoding='utf-8') if OUT.exists() else ''
    if args.check:
        if current != text:
            raise SystemExit(f'{OUT.relative_to(ROOT)} устарел: запустите python3 tools/srd/build_skills.py')
        print(f'{OUT.relative_to(ROOT)} актуален ({len(SKILLS)} навыков)')
        return
    OUT.write_text(text, encoding='utf-8')
    print(f'{OUT.relative_to(ROOT)}: {len(SKILLS)} навыков')


if __name__ == '__main__':
    main()
