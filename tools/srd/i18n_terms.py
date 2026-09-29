# -*- coding: utf-8 -*-
"""Короткие термины базового набора: русский ⇄ английский. Всё, что нельзя надёжно взять из корпуса OmnisGM."""
import re

# --- заклинания -------------------------------------------------------------------------
CASTING_TIME = {  # английский (как в data_seed) -> русский
    '1 action': 'Действие', 'Action': 'Действие', '1 bonus action': 'Бонусное действие', 'Bonus Action': 'Бонусное действие',
    '1 reaction': 'Реакция', '1 minute': '1 минута', '10 minutes': '10 минут', '1 hour': '1 час', '8 hours': '8 часов',
    '12 hours': '12 часов', '24 hours': '24 часа',
    'Action (Overgrowth) or 8 hours (Enrichment)': 'Действие (Разрастание) или 8 часов (Обогащение)',
    'Bonus Action, which you take immediately after hitting a creature with a Melee weapon or an Unarmed Strike':
        'Бонусное действие, которое вы совершаете сразу после попадания по существу рукопашным оружием или безоружным ударом',
    'Bonus Action, which you take immediately after hitting a creature with a weapon':
        'Бонусное действие, которое вы совершаете сразу после попадания по существу оружием',
    'Bonus Action, which you take immediately after hitting a target with a Melee weapon or an Unarmed Strike':
        'Бонусное действие, которое вы совершаете сразу после попадания по цели рукопашным оружием или безоружным ударом',
    'Reaction, which you take in response to taking damage from a creature that you can see within 60 feet of yourself':
        'Реакция, которую вы совершаете в ответ на получение урона от существа, которое вы видите в пределах 60 футов от себя',
    'Reaction, which you take when you are hit by an attack roll or targeted by the Magic Missile spell':
        'Реакция, которую вы совершаете, когда по вам попадает бросок атаки или когда вы становитесь целью заклинания «Волшебная стрела»',
    'Reaction, which you take when you or a creature you can see within 60 feet of you falls':
        'Реакция, которую вы совершаете, когда вы или существо, которое вы видите в пределах 60 футов от себя, падаете',
    'Reaction, which you take when you see a creature within 60 feet of yourself casting a spell with Verbal, Somatic, or Material components':
        'Реакция, которую вы совершаете, когда видите, как существо в пределах 60 футов от вас накладывает заклинание с вербальными, соматическими или материальными компонентами',
}
RANGE = {
    'Self': 'На себя', 'Touch': 'Касание', 'Sight': 'Видимость', 'Special': 'Особая', 'Unlimited': 'Неограниченная',
    '5 feet': '5 футов', '10 feet': '10 футов', '15 feet': '15 футов', '30 feet': '30 футов', '60 feet': '60 футов', '90 feet': '90 футов',
    '100 feet': '100 футов', '120 feet': '120 футов', '150 feet': '150 футов', '300 feet': '300 футов', '500 feet': '500 футов',
    '1 mile': '1 миля', '500 miles': '500 миль',
}
DURATION = {
    'Instantaneous': 'Мгновенная', 'Special': 'Особая', 'Until dispelled': 'Пока не рассеяно', 'Until dispelled or triggered': 'Пока не рассеяно или не сработает',
    '1 round': '1 раунд', '1 minute': '1 минута', '10 minutes': '10 минут', '1 hour': '1 час', '8 hours': '8 часов', '24 hours': '24 часа',
    '1 day': '1 день', '7 days': '7 дней', '10 days': '10 дней', '30 days': '30 дней',
    'Concentration up to 10 minutes': 'Концентрация, до 10 минут',
}
_UNITS = {'round': ('раунда', 'раундов'), 'rounds': ('раунда', 'раундов'), 'minute': ('минуты', 'минут'), 'minutes': ('минуты', 'минут'),
          'hour': ('часа', 'часов'), 'hours': ('часа', 'часов'), 'day': ('дня', 'дней'), 'days': ('дня', 'дней')}


def duration_ru(s):
    """'Up to 8 hours' -> 'до 8 часов'; 'Concentration, up to 1 minute' -> 'Концентрация, до 1 минуты'."""
    if s in DURATION: return DURATION[s]
    m = re.match(r'^(Concentration,? )?(?:up to|Up to) (\d+) (\w+)$', s)
    if m and m.group(3) in _UNITS:
        n = int(m.group(2)); one, many = _UNITS[m.group(3)]
        return ('Концентрация, ' if m.group(1) else '') + f'до {n} {one if n == 1 else many}'
    return None


SCHOOL = {'Ограждение': 'Abjuration', 'Вызов': 'Conjuration', 'Прорицание': 'Divination', 'Очарование': 'Enchantment', 'Воплощение': 'Evocation',
          'Иллюзия': 'Illusion', 'Некромантия': 'Necromancy', 'Преобразование': 'Transmutation'}
CLASS = {'Варвар': 'Barbarian', 'Бард': 'Bard', 'Жрец': 'Cleric', 'Друид': 'Druid', 'Воин': 'Fighter', 'Монах': 'Monk', 'Паладин': 'Paladin',
         'Следопыт': 'Ranger', 'Плут': 'Rogue', 'Чародей': 'Sorcerer', 'Колдун': 'Warlock', 'Волшебник': 'Wizard'}
SPELL_ACTION_LABEL = {'Атака заклинанием': 'Spell attack', 'Спасбросок': 'Saving throw', 'Лечение': 'Healing', 'Урон': 'Damage'}
ABIL_EN = {'СИЛ': 'STR', 'ЛОВ': 'DEX', 'ТЕЛ': 'CON', 'ИНТ': 'INT', 'МДР': 'WIS', 'ХАР': 'CHA'}
ABIL_EN3 = {'СИЛ': 'Str', 'ЛОВ': 'Dex', 'ТЕЛ': 'Con', 'ИНТ': 'Int', 'МДР': 'Wis', 'ХАР': 'Cha'}
SKILL_EN = {'Акробатика': 'Acrobatics', 'Уход за животными': 'Animal Handling', 'Магия': 'Arcana', 'Атлетика': 'Athletics', 'Обман': 'Deception',
            'История': 'History', 'Проницательность': 'Insight', 'Запугивание': 'Intimidation', 'Расследование': 'Investigation', 'Медицина': 'Medicine',
            'Природа': 'Nature', 'Восприятие': 'Perception', 'Выступление': 'Performance', 'Убеждение': 'Persuasion', 'Религия': 'Religion',
            'Анализ': 'Investigation', 'Ловкость рук': 'Sleight of Hand', 'Скрытность': 'Stealth', 'Выживание': 'Survival'}
CONDITION_EN = {'Ослеплённый': 'Blinded', 'Очарованный': 'Charmed', 'Оглохший': 'Deafened', 'Истощение': 'Exhaustion', 'Испуганный': 'Frightened',
                'Схваченный': 'Grappled', 'Недееспособный': 'Incapacitated', 'Невидимый': 'Invisible', 'Парализованный': 'Paralyzed',
                'Окаменевший': 'Petrified', 'Отравленный': 'Poisoned', 'Сбитый с ног': 'Prone', 'Опутанный': 'Restrained', 'Ошеломлённый': 'Stunned',
                'Бессознательный': 'Unconscious'}
DAMAGE_EN = {'кислота': 'acid', 'дробящий': 'bludgeoning', 'холод': 'cold', 'огонь': 'fire', 'силовое поле': 'force', 'электричество': 'lightning',
             'некротический': 'necrotic', 'колющий': 'piercing', 'яд': 'poison', 'психический': 'psychic', 'излучение': 'radiant', 'рубящий': 'slashing',
             'звук': 'thunder'}
DAMAGE_RU = {v: k for k, v in DAMAGE_EN.items()}

# --- монстры ------------------------------------------------------------------------------
SIZE_EN = {'Крошечный': 'Tiny', 'Маленький': 'Small', 'Средний': 'Medium', 'Большой': 'Large', 'Огромный': 'Huge', 'Громадный': 'Gargantuan'}
SIZE_RU = {'Medium or small': 'Средний или Маленький'}
MTYPE_EN = {'аберрация': 'aberration', 'зверь': 'beast', 'небожитель': 'celestial', 'конструкт': 'construct', 'дракон': 'dragon', 'элементаль': 'elemental',
            'фея': 'fey', 'исчадие': 'fiend', 'великан': 'giant', 'гуманоид': 'humanoid', 'чудовище': 'monstrosity', 'слизь': 'ooze', 'растение': 'plant',
            'нежить': 'undead', 'рой крошечных зверей': 'swarm of Tiny beasts'}
MSUB_RU = {'any race': 'любая раса', 'dwarf': 'дварф', 'elf': 'эльф', 'gnoll': 'гнолл', 'gnome': 'гном', 'goblinoid': 'гоблиноид', 'grimlock': 'гримлок',
           'human': 'человек', 'kobold': 'кобольд', 'lizardfolk': 'людоящер', 'merfolk': 'мерфолк', 'orc': 'орк', 'sahuagin': 'сахуагин',
           'demon': 'демон', 'devil': 'дьявол', 'shapechanger': 'оборотень', 'titan': 'титан'}
MSUB_EN = {v: k for k, v in MSUB_RU.items()}
MTYPE_FULL_RU = {'swarm of tiny beasts': 'рой крошечных зверей', 'swarm of tiny undead': 'рой крошечной нежити'}
ALIGN_EN = {'без мировоззрения': 'unaligned', 'законно-добрый': 'lawful good', 'законно-злой': 'lawful evil', 'законно-нейтральный': 'lawful neutral',
            'любое': 'any alignment', 'любое злое': 'any evil alignment', 'любое недоброе': 'any non-good alignment', 'любое незаконное': 'any non-lawful alignment',
            'любое хаотичное': 'any chaotic alignment', 'нейтрально-добрый': 'neutral good', 'нейтрально-злой': 'neutral evil', 'нейтральный': 'neutral',
            'хаотично-добрый': 'chaotic good', 'хаотично-злой': 'chaotic evil', 'хаотично-нейтральный': 'chaotic neutral'}
ALIGN_RU = {'neutral good (50%) or neutral evil (50%)': 'нейтрально-добрый (50%) или нейтрально-злой (50%)'}
SPEED_EN = {'полёт': 'fly', 'плавание': 'swim', 'лазание': 'climb', 'копание': 'burrow'}
SENSE_EN = {'слепое зрение': 'blindsight', 'тёмное зрение': 'darkvision', 'истинное зрение': 'truesight', 'чувство вибрации': 'tremorsense',
            'пассивное Восприятие': 'passive Perception'}
LANG_RU = {'Common': 'Общий', 'Dwarvish': 'Дварфийский', 'Elvish': 'Эльфийский', 'Giant': 'Великаний', 'Gnomish': 'Гномий', 'Goblin': 'Гоблинский',
           'Halfling': 'Полуросличий', 'Orc': 'Орочий', 'Abyssal': 'Абиссальный', 'Celestial': 'Небесный', 'Draconic': 'Драконий',
           'Deep Speech': 'Глубинная речь', 'Infernal': 'Инфернальный', 'Primordial': 'Первичный', 'Sylvan': 'Сильван', 'Undercommon': 'Подземный',
           'Auran': 'Ауран', 'Aquan': 'Акван', 'Ignan': 'Игнан', 'Terran': 'Терран', 'Gnoll': 'Гнолльский', 'Druidic': 'Друидический',
           "Thieves' cant": 'Воровской жаргон', 'Sphinx': 'Сфинкса', 'Telepathy': 'Телепатия', 'Dwarvish, Giant': 'Дварфийский, Великаний'}

# --- предметы -----------------------------------------------------------------------------
# (ключ — старое значение category; для 2024 — по имени) -> (русский, английский)
GEAR_CAT = {
    'Standard Gear': ('Снаряжение', 'Adventuring Gear'), 'Ammunition': ('Боеприпасы', 'Ammunition'),
    'Holy Symbols': ('Священные символы', 'Holy Symbols'), 'Arcane Foci': ('Магические фокусы', 'Arcane Foci'),
    'Druidic Foci': ('Друидические фокусы', 'Druidic Foci'), 'Kits': ('Комплекты', 'Kits'),
    'Equipment Packs': ('Наборы снаряжения', 'Equipment Packs'), "Artisan's Tools": ('Инструменты ремесленника', "Artisan's Tools"),
    'Gaming Sets': ('Игровые наборы', 'Gaming Sets'), 'Musical Instrument': ('Музыкальные инструменты', 'Musical Instruments'),
    'Other Tools': ('Другие инструменты', 'Other Tools'), 'Mounts and Other Animals': ('Ездовые животные', 'Mounts and Other Animals'),
    'Tack, Harness, and Drawn Vehicles': ('Упряжь и повозки', 'Tack, Harness, and Drawn Vehicles'),
    'Waterborne Vehicles': ('Водный транспорт', 'Waterborne Vehicles'),
}
MAGIC_CAT = {
    'Wondrous Items': ('Чудесные предметы', 'Wondrous Items'), 'Potion': ('Зелья', 'Potions'), 'Potions': ('Зелья', 'Potions'),
    'Ring': ('Кольца', 'Rings'), 'Rings': ('Кольца', 'Rings'), 'Weapon': ('Оружие', 'Weapons'), 'Weapons': ('Оружие', 'Weapons'),
    'Armor': ('Доспехи', 'Armor'), 'Wand': ('Волшебные палочки', 'Wands'), 'Wands': ('Волшебные палочки', 'Wands'),
    'Staff': ('Посохи', 'Staffs'), 'Staffs': ('Посохи', 'Staffs'), 'Rod': ('Жезлы', 'Rods'), 'Scroll': ('Свитки', 'Scrolls'),
    'Ammunition': ('Боеприпасы', 'Ammunition'),
}
# SRD 5.2: раздел «Инструменты» и «Снаряжение для приключений» (06_Equipment.md)
ARTISAN = {"Alchemist's Supplies", "Brewer's Supplies", "Calligrapher's Supplies", "Carpenter's Tools", "Cartographer's Tools", "Cobbler's Tools",
           "Cook's Utensils", "Glassblower's Tools", "Jeweler's Tools", "Leatherworker's Tools", "Mason's Tools", "Painter's Supplies",
           "Potter's Tools", "Smith's Tools", "Tinker's Tools", "Weaver's Tools", "Woodcarver's Tools"}
OTHER_TOOLS = {'Disguise Kit', 'Forgery Kit', 'Herbalism Kit', "Navigator's Tools", "Poisoner's Kit", "Thieves' Tools"}
GAMING = {'Dice', 'Dice Set', 'Dragonchess', 'Playing Cards', 'Playing Card Set', 'Three-Dragon Ante'}
MUSIC = {'Bagpipes', 'Drum', 'Dulcimer', 'Flute', 'Horn', 'Lute', 'Lyre', 'Pan flute', 'Shawm', 'Viol'}
PACKS = {"Burglar's Pack", "Diplomat's Pack", "Dungeoneer's Pack", "Entertainer's Pack", "Explorer's Pack", "Priest's Pack", "Scholar's Pack"}
ARCANE = {'Crystal', 'Orb', 'Rod', 'Staff', 'Wand'}
DRUIDIC = {'Sprig of mistletoe', 'Totem', 'Wooden staff', 'Yew wand'}
HOLY = {'Amulet', 'Emblem', 'Reliquary'}
KITS = {"Climber's Kit", "Healer's Kit", 'Mess Kit'}
RARITY_EN = {'Обычный': 'Common', 'Необычный': 'Uncommon', 'Редкий': 'Rare', 'Очень редкий': 'Very Rare', 'Легендарный': 'Legendary',
             'Артефакт': 'Artifact', 'Разная': 'Varies'}
RARITY_RU = {'Rare (+1), Very Rare (+2), or Legendary (+3)': 'Редкий (+1), очень редкий (+2) или легендарный (+3)', 'Rare (+2)': 'Редкий (+2)',
             'Rare (Silver or Brass), Very Rare (Bronze), or Legendary (Iron)': 'Редкий (серебряный или латунный), очень редкий (бронзовый) или легендарный (железный)',
             'Rarity Varies': 'Разная', 'Uncommon (+1)': 'Необычный (+1)', 'Uncommon (+1), Rare (+2), or Very Rare (+3)': 'Необычный (+1), редкий (+2) или очень редкий (+3)',
             'Very Rare (+3)': 'Очень редкий (+3)'}
PROP_EN = {'Боеприпас': 'Ammunition', 'Двуручное': 'Two-Handed', 'Досягаемость': 'Reach', 'Лёгкое': 'Light', 'Метательное': 'Thrown', 'Монашеское': 'Monk',
           'Особое': 'Special', 'Перезарядка': 'Loading', 'Тяжёлое': 'Heavy', 'Универсальное': 'Versatile', 'Фехтовальное': 'Finesse'}
WEAPON_CAT_EN = {'Простое рукопашное': 'Simple Melee', 'Простое дальнобойное': 'Simple Ranged', 'Воинское рукопашное': 'Martial Melee',
                 'Воинское дальнобойное': 'Martial Ranged', 'Лёгкий доспех': 'Light Armor', 'Средний доспех': 'Medium Armor', 'Тяжёлый доспех': 'Heavy Armor',
                 'Щит': 'Shield'}
# дальность броска метательного оружия: в исходных данных ошибка «(5/None)»
THROWN_FIX = {'Trident': '20/60', 'Dagger': '20/60', 'Handaxe': '20/60', 'Javelin': '30/120', 'Light hammer': '20/60', 'Light Hammer': '20/60', 'Spear': '20/60'}
COST_EN = {'мм': 'cp', 'см': 'sp', 'зм': 'gp', 'эм': 'ep', 'пм': 'pp'}

ITEM_TYPE_LABEL = {}  # подписи типов выводит интерфейс

# --- размеры/типы рас и прочее ---------------------------------------------------------
RACE_SIZE_EN = SIZE_EN

LANGS_FULL = {}   # готовые переводы редких строк «языки» — см. i18n_manual.py


def dmg_list_ru(v):
    """'bludgeoning, piercing, and slashing from nonmagical weapons' -> русская строка (по словарю типов урона)."""
    m = re.match(r"^(.*?)(?: from (nonmagical (?:weapons|attacks))(?: that aren't (silvered|adamantine))?)?$", v)
    if not m: return None
    head, src, cond = m.groups()
    parts = [p.strip() for p in re.split(r',\s*(?:and\s+)?|\s+and\s+', head) if p.strip()]
    if not parts or any(p not in DAMAGE_RU for p in parts): return None
    words = [DAMAGE_RU[p] for p in parts]
    if not src: return ', '.join(words)
    s = (', '.join(words[:-1]) + ' и ' + words[-1] if len(words) > 1 else words[0]) + ' урон от '
    s += 'немагического оружия' if 'weapons' in src else 'немагических атак'
    if cond: s += ', не ' + {'silvered': 'посеребрённого', 'adamantine': 'адамантинового'}[cond]
    return s

MASTERY_RU = {'Cleave': 'Рассечение', 'Graze': 'Скольжение', 'Nick': 'Порез', 'Push': 'Толчок', 'Sap': 'Оглушение', 'Slow': 'Замедление',
              'Topple': 'Опрокидывание', 'Vex': 'Досаждение'}
CLASS_RU = {v: k for k, v in CLASS.items()}
ABILITY_FULL_EN = {'Сила': 'Strength', 'Ловкость': 'Dexterity', 'Телосложение': 'Constitution', 'Интеллект': 'Intelligence', 'Мудрость': 'Wisdom',
                   'Харизма': 'Charisma'}

# ячейки таблиц: (шаблон, замена) для значений, которых нет в корпусе как отдельных строк
CELL_WORDS = [
    (r'd(\d+)', r'к\1'), (r'Ace of (\w+)', None),
]
CELL_WORDS = [(a, b) for a, b in CELL_WORDS if b]
