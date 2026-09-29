# -*- coding: utf-8 -*-
"""Ручные переводы остатка, которого нет в корпусе OmnisGM (другая редакция текста в data_seed, служебные строки сборки).

TEXT  — точные соответствия «английская строка → русская».
RULES — шаблоны для семейств однотипных строк (варианты предметов, «Вы знаете заклинание …»); функция получает
        match и контекст (ctx.spell_names / ctx.item_names) и возвращает русскую строку или None.
"""
import re

TEXT = {
    # содержимое наборов снаряжения (5e-bits)
    "A small box for alms, typically found in a priest's pack.": 'Небольшой ящик для подаяний. Обычно входит в набор священника.',
    "A block of incense, typically found in a priest's pack.": 'Брусок благовоний. Обычно входит в набор священника.',
    "A censer, typically found in a priest's pack.": 'Кадило. Обычно входит в набор священника.',
    "A small bag of sand, typically found in a scholar's pack.": 'Маленький мешочек с песком. Обычно входит в набор учёного.',
    "A small knife, typically found in a scholar's pack.": 'Небольшой нож. Обычно входит в набор учёного.',
    "A 10-foot length of string, typically found in a burglar's pack.": 'Бечёвка длиной 10 футов. Обычно входит в набор взломщика.',
    "Religious clothing, typically found in a priest's pack.": 'Религиозное облачение. Обычно входит в набор священника.',
    'A Glass Bottle holds up to 11/2 pints.': 'Стеклянная бутылка вмещает до 1½ пинты.',
    'Essential for wizards, a spellbook is a leather-bound tome with 100 blank vellum pages suitable for recording spells.':
        'Необходимая волшебникам книга заклинаний — фолиант в кожаном переплёте, содержащий 100 чистых пергаментных страниц, пригодных для записи заклинаний.',
    # варианты магических предметов
    'Weapon (Any Ammunition)': 'Оружие (любые боеприпасы)', 'Weapon (Rare)': 'Оружие (редкое)', 'Armor (Shield)': 'Доспех (щит)',
    'Rare (Silver)': 'Редкий (серебряный)', 'Rare (Brass)': 'Редкий (латунный)', 'Very Rare (Bronze)': 'Очень редкий (бронзовый)',
    'Legendary (Iron)': 'Легендарный (железный)',
    'This ammunition is typically found or sold in quantities of ten or twenty pieces. Ten pieces of this ammunition are equivalent in value to a potion of the same rarity.':
        'Такие боеприпасы обычно находят или продают по десять или двадцать штук. Десять штук таких боеприпасов по стоимости равны зелью той же редкости.',
    "You have a bonus to attack rolls and damage rolls made with this magic weapon. The bonus is determined by the weapon's rarity.":
        'Вы получаете бонус к броскам атаки и урона, сделанным этим магическим оружием. Бонус определяется редкостью оружия.',
    "While holding this Shield, you have a bonus to Armor Class determined by the Shield's rarity, in addition to the Shield's normal bonus to AC.":
        'Пока вы держите этот щит, вы получаете бонус к Классу Доспеха, определяемый редкостью щита, в дополнение к обычному бонусу щита к КД.',
    "While holding this wand, you gain a bonus to spell attack rolls determined by the wand's rarity. In addition, you ignore Half Cover when making a spell attack roll.":
        'Пока вы держите эту палочку, вы получаете бонус к броскам атаки заклинаниями, определяемый редкостью палочки. Кроме того, вы игнорируете укрытие на половину, когда совершаете бросок атаки заклинанием.',
    'While holding this wand, you gain a +1 bonus to spell attack rolls. In addition, you ignore half cover when making a spell attack.':
        'Пока вы держите эту палочку, вы получаете бонус +1 к броскам атаки заклинаниями. Кроме того, вы игнорируете укрытие на половину при атаке заклинанием.',
    'This ordinary bag, made from gray cloth, appears empty. Reaching inside the bag, however, reveals the presence of a small, fuzzy object. The bag weighs 1/2 pound.':
        'Этот обычный мешок из серой ткани кажется пустым. Однако, если сунуть в него руку, можно нащупать небольшой пушистый предмет. Мешок весит 1/2 фунта.',
    'This ordinary bag, made from rust cloth, appears empty. Reaching inside the bag, however, reveals the presence of a small, fuzzy object. The bag weighs 1/2 pound.':
        'Этот обычный мешок из рыжей ткани кажется пустым. Однако, если сунуть в него руку, можно нащупать небольшой пушистый предмет. Мешок весит 1/2 фунта.',
    'This ordinary bag, made from tan cloth, appears empty. Reaching inside the bag, however, reveals the presence of a small, fuzzy object. The bag weighs 1/2 pound.':
        'Этот обычный мешок из бурой ткани кажется пустым. Однако, если сунуть в него руку, можно нащупать небольшой пушистый предмет. Мешок весит 1/2 фунта.',
    "You can use an action to pull the fuzzy object from the bag and throw it up to 20 feet. When the object lands, it transforms into a creature you determine by rolling a d8 and consulting the table that corresponds to the bag's color. The creature vanishes at the next dawn or when it is reduced to 0 Hit Points.":
        'Вы можете действием вытащить пушистый предмет из мешка и бросить его на расстояние до 20 футов. Приземлившись, предмет превращается в существо, которое вы определяете броском к8 по таблице, соответствующей цвету мешка. Существо исчезает на следующем рассвете или когда его хиты опускаются до 0.',
    'Gray Bag:': 'Серый мешок:', 'Rust Bag:': 'Рыжий мешок:', 'Tan Bag:': 'Бурый мешок:',
    'Scroll, common': 'Свиток, обычный', 'Scroll, uncommon': 'Свиток, необычный', 'Scroll, rare': 'Свиток, редкий',
    'Scroll, very rare': 'Свиток, очень редкий', 'Scroll, legendary': 'Свиток, легендарный',
    'High Elf Cantrip': 'Заговор высшего эльфа', 'High Elf: Cantrip Versatility': 'Высший эльф: гибкость заговоров',
    'Wood Elf: Movement Speed Increase': 'Лесной эльф: увеличение скорости',
    'Your Movement Speed increases to 35 feet.': 'Ваша Скорость увеличивается до 35 футов.',
    # материальные компоненты 2024 (сломанная запятая в исходнике)
    'the powder of a crushed black, pearl worth 500+ GP': 'порошок из измельчённой чёрной жемчужины стоимостью 500+ зм',
    'incense worth 25+ GP, which the, spell consumes': 'благовония стоимостью 25+ зм, которые заклинание потребляет',
}

_RAR = {'common': 'обычн', 'uncommon': 'необычн', 'rare': 'редк', 'very rare': 'очень редк', 'legendary': 'легендарн'}
_ORD = {'1st': '1-го', '2nd': '2-го', '3rd': '3-го', '4th': '4-го', '5th': '5-го', '6th': '6-го', '7th': '7-го', '8th': '8-го', '9th': '9-го'}
_GEN = {'Weapon': ('Оружие', 'ое'), 'Armor': ('Доспех', 'ый'), 'Scroll': ('Свиток', 'ый'), 'Wand': ('Палочка', 'ая'), 'Rod': ('Жезл', 'ый'),
        'Staff': ('Посох', 'ый'), 'Ring': ('Кольцо', 'ое'), 'Potion': ('Зелье', 'ое')}
_INNER = {'any ammunition': 'любые боеприпасы', 'light, medium, or heavy': 'лёгкий, средний или тяжёлый'}


def _dice(s):
    return re.sub(r'(\d*)d(\d+)', lambda m: (m.group(1) or '') + 'к' + m.group(2), s)


def _rule_rarity_line(m, ctx):
    kind, inner, rar = m.group(1), m.group(2), m.group(3).lower()
    if kind not in _GEN or rar not in _RAR: return None
    word, end = _GEN[kind]
    r = _RAR[rar] + ('ое' if end == 'ое' else 'ая' if end == 'ая' else 'ый')
    if rar == 'very rare': r = 'очень ' + _RAR['rare'] + ('ое' if end == 'ое' else 'ая' if end == 'ая' else 'ый')
    inn = _INNER.get(inner.lower()) if inner else None
    if inner and not inn: return None
    return word + (' (%s)' % inn if inn else '') + ', ' + r


def _spell(ctx, n):
    return ctx.spell_names.get(n, n)


RULES = [
    (re.compile(r'^(Weapon|Armor) \(([^()]+)\), (common|uncommon|rare|very rare|legendary)$'), _rule_rarity_line),
    (re.compile(r'^You have a \+(\d) bonus to attack and damage rolls made with this piece of magic ammunition\. Once it hits a target, the ammunition is no longer magical\.$'),
     lambda m, c: 'Вы получаете бонус +%s к броскам атаки и урона, сделанным этим магическим боеприпасом. Попав по цели, боеприпас перестаёт быть магическим.' % m.group(1)),
    (re.compile(r'^You have a \+(\d) bonus to attack rolls and damage rolls made with this piece of magic ammunition\. The bonus is determined by the rarity of the ammunition\. Once it hits a target, the ammunition is no longer magical\.$'),
     lambda m, c: 'Вы получаете бонус +%s к броскам атаки и урона, сделанным этим магическим боеприпасом. Бонус определяется редкостью боеприпаса. Попав по цели, боеприпас перестаёт быть магическим.' % m.group(1)),
    (re.compile(r'^You have a \+(\d) bonus to (?:AC|Armor Class) while wearing this armor\.$'),
     lambda m, c: 'Пока вы носите этот доспех, вы получаете бонус +%s к КД.' % m.group(1)),
    (re.compile(r'^You have a \+(\d) bonus to (?:attack and damage rolls|attack rolls and damage rolls) made with this magic weapon\.$'),
     lambda m, c: 'Вы получаете бонус +%s к броскам атаки и урона, сделанным этим магическим оружием.' % m.group(1)),
    (re.compile(r"^While holding this Shield, you have a \+(\d) bonus to Armor Class, in addition to the Shield's normal bonus to AC\.$"),
     lambda m, c: 'Пока вы держите этот щит, вы получаете бонус +%s к Классу Доспеха в дополнение к обычному бонусу щита к КД.' % m.group(1)),
    (re.compile(r'^While holding this wand, you gain a \+(\d) bonus to spell attack rolls\. In addition, you ignore Half Cover when making a spell attack roll\.$'),
     lambda m, c: 'Пока вы держите эту палочку, вы получаете бонус +%s к броскам атаки заклинаниями. Кроме того, вы игнорируете укрытие на половину, когда совершаете бросок атаки заклинанием.' % m.group(1)),
    (re.compile(r"^While wearing this belt, your Strength score changes to (?:a )?(\d+)\. If your Strength is already equal to or greater than the belt's score, the item has no Effect on you\.$"),
     lambda m, c: 'Пока вы носите этот пояс, ваша Сила становится равной %s. Если ваша Сила уже не меньше значения пояса, предмет на вас не действует.' % m.group(1)),
    (re.compile(r'^This carpet is (\d+) feet by (\d+) feet and has a flying speed of (\d+) feet\. It can carry up to (\d+) pounds, but its flying speed becomes (\d+) feet while carrying over (\d+) pounds\.$'),
     lambda m, c: 'Этот ковёр имеет размер %s на %s футов и скорость полёта %s футов. Он выдерживает до %s фунтов, но при грузе свыше %s фунтов его скорость полёта снижается до %s футов.' % (m.group(1), m.group(2), m.group(3), m.group(4), m.group(6), m.group(5))),
    (re.compile(r'^You can use an action to blow this horn\. In response, (\d+d4 \+ \d+) warrior spirits from the Valhalla appear within 60 feet of you\. They use the statistics of a berserker\. They return to Valhalla after 1 hour or when they drop to 0 hit points\. Once you use the horn, it can\'t be used again until 7 days have passed\.$'),
     lambda m, c: 'Вы можете действием протрубить в этот рог. В ответ в пределах 60 футов от вас появляются %s духов-воинов из Валгаллы. Они используют характеристики берсерка. Они возвращаются в Валгаллу через 1 час или когда их хиты опускаются до 0. Использовав рог, вы не сможете применить его снова, пока не пройдут 7 дней.' % _dice(m.group(1))),
    (re.compile(r'^To create a golem, you must spend (\d+) days, working without interruption with the manual at hand and resting no more than 8 hours per day\. You must also pay ([\d,]+) gp to purchase supplies\.$'),
     lambda m, c: 'Чтобы создать голема, вы должны потратить %s дней, работая без перерыва с руководством под рукой и отдыхая не более 8 часов в день. Вы также должны заплатить %s зм на покупку материалов.' % (m.group(1), m.group(2).replace(',', ' '))),
    (re.compile(r'^When you drink this potion, your Strength score changes to (\d+) for 1 hour\. The potion has no effect on you if your Strength is equal to or greater than that score\.$'),
     lambda m, c: 'Когда вы выпиваете это зелье, ваша Сила становится равной %s на 1 час. Зелье на вас не действует, если ваша Сила не меньше этого значения.' % m.group(1)),
    (re.compile(r"^You regain (\d+d4 \+ \d+) hit points when you drink this potion\. The potion's red liquid glimmers when agitated\.$"),
     lambda m, c: 'Вы восстанавливаете %s хитов, когда выпиваете это зелье. Красная жидкость зелья мерцает, если её взболтать.' % _dice(m.group(1))),
    (re.compile(r"^This scroll contains an? (\d(?:st|nd|rd|th)) level spell\. The spell's saving throw is (\d+) and the attack bonus is \+(\d+)\.$"),
     lambda m, c: 'Этот свиток содержит заклинание %s уровня. СЛ спасброска заклинания равна %s, бонус атаки — +%s.' % (_ORD[m.group(1)], m.group(2), m.group(3))),
    (re.compile(r"^This scroll contains a cantrip\. The spell's saving throw is (\d+) and the attack bonus is \+(\d+)\.$"),
     lambda m, c: 'Этот свиток содержит заговор. СЛ спасброска заклинания равна %s, бонус атаки — +%s.' % (m.group(1), m.group(2))),
    (re.compile(r'^You (?:know|learn) the (spell|cantrip) (.+?)\.$'),
     lambda m, c: 'Вы %s %s «%s».' % ('знаете' if 'know' in m.group(0)[:12] else 'изучаете', 'заклинание' if m.group(1) == 'spell' else 'заговор', _spell(c, m.group(2)))),
]



TEXT.update({
    # --- 2014: монстры ---
    "Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 3 (1d4 + 2) piercing damage. If the target is a creature, it must succeed on a DC 10 Constitution saving throw or contract a disease. Until the disease is cured, the target can't regain hit points except by magical means, and the target's hit point maximum decreases by 3 (1d6) every 24 hours. If the target's hit point maximum drops to 0 as a result of this disease, the target dies.":
        'Рукопашная атака оружием: +4 к попаданию, досягаемость 5 фт., одна цель. Попадание: 3 (1d4 + 2) колющего урона. Если цель — существо, она должна преуспеть в спасброске Телосложения со СЛ 10, иначе заразится болезнью. Пока болезнь не излечена, цель не может восстанавливать хиты иначе как магией, а максимум хитов цели уменьшается на 3 (1d6) каждые 24 часа. Если максимум хитов цели опускается до 0 из-за этой болезни, цель умирает.',
    "While charmed by the harpy, a target is incapacitated and ignores the songs of other harpies. If the charmed target is more than 5 ft. away from the harpy, the must move on its turn toward the harpy by the most direct route. It doesn't avoid opportunity attacks, but before moving into damaging terrain, such as lava or a pit, and whenever it takes damage from a source other than the harpy, a target can repeat the saving throw. A creature can also repeat the saving throw at the end of each of its turns. If a creature's saving throw is successful, the effect ends on it.":
        'Пока цель очарована гарпией, она недееспособна и не обращает внимания на песни других гарпий. Если очарованная цель находится дальше 5 фт. от гарпии, она должна в свой ход двигаться к гарпии по кратчайшему пути. Она не избегает провоцированных атак, но перед движением в опасную местность (лава, яма) и всякий раз, когда она получает урон от источника, кроме гарпии, цель может повторить спасбросок. Существо также может повторять спасбросок в конце каждого своего хода. Если спасбросок существа успешен, эффект на нём оканчивается.',
    "The lamia's innate spellcasting ability is Charisma (spell save DC 13). It can innately cast the following spells, requiring no material components. At will: disguise self (any humanoid form), major image 3/day each: charm person, mirror image, scrying, suggestion 1/day: geas":
        'Врождённая базовая характеристика ламии для заклинаний — Харизма (СЛ спасброска от заклинаний 13). Она может накладывать следующие заклинания врождённо, не нуждаясь в материальных компонентах. Неограниченно: маскировка (любая гуманоидная форма), большая иллюзия. 3/день каждое: очарование личности, зеркальное отражение, наблюдение, внушение. 1/день: обет.',
    "A night hag carries two very rare magic items that she must craft for herself If either object is lost, the night hag will go to great lengths to retrieve it, as creating a new tool takes time and effort.":
        'Ночная карга носит при себе два очень редких магических предмета, которые она должна изготовить сама. Если любой из них потерян, ночная карга сделает всё возможное, чтобы вернуть его, ведь создание нового предмета требует времени и усилий.',
    "Heartstone: This lustrous black gem allows a night hag to become ethereal while it is in her possession. The touch of a heartstone also cures any disease. Crafting a heartstone takes 30 days.":
        'Камень сердца: этот блестящий чёрный самоцвет позволяет ночной карге становиться эфирной, пока он находится у неё. Прикосновение камня сердца также излечивает любую болезнь. Изготовление камня сердца занимает 30 дней.',
    "Soul Bag: When an evil humanoid dies as a result of a night hag's Nightmare Haunting, the hag catches the soul in this black sack made of stitched flesh. A soul bag can hold only one evil soul at a time, and only the night hag who crafted the bag can catch a soul with it. Crafting a soul bag takes 7 days and a humanoid sacrifice (whose flesh is used to make the bag).":
        'Мешок душ: когда злой гуманоид умирает в результате Кошмарного наваждения ночной карги, карга ловит душу в этот чёрный мешок, сшитый из плоти. Мешок душ может вмещать только одну злую душу за раз, и поймать в него душу может только та ночная карга, что его изготовила. Изготовление мешка душ занимает 7 дней и требует человеческого жертвоприношения (из плоти жертвы делают мешок).',
    "While in dim light or darkness, the shadow can take the Hide action as a bonus action. Its stealth bonus is also improved to +6.":
        'Находясь в тусклом свете или во тьме, тень может совершать действие Засада бонусным действием. Её бонус Скрытности также повышается до +6.',
    "Ranged Weapon Attack: +13 to hit, range 150/600 ft., one target. Hit: 15 (2d8 + 6) piercing damage plus 27 (6d8) radiant damage. If the target is a creature that has 190 hit points or fewer, it must succeed on a DC 15 Constitution saving throw or die.":
        'Дальнобойная атака оружием: +13 к попаданию, дистанция 150/600 фт., одна цель. Попадание: 15 (2d8 + 6) колющего урона плюс 27 (6d8) урона излучением. Если у цели-существа 190 хитов или меньше, она должна преуспеть в спасброске Телосложения со СЛ 15, иначе умрёт.',
    "The fiend kisses a creature charmed by it or a willing creature. The target must make a DC 15 Constitution saving throw against this magic, taking 32 (5d10 + 5) psychic damage on a failed save, or half as much damage on a successful one. The target's hit point maximum is reduced by an amount equal to the damage taken. This reduction lasts until the target finishes a long rest. The target dies if this effect reduces its hit point maximum to 0.":
        'Исчадие целует очарованное им существо или согласное существо. Цель должна совершить спасбросок Телосложения со СЛ 15 против этой магии, получая 32 (5d10 + 5) психического урона при провале или половину этого урона при успехе. Максимум хитов цели уменьшается на величину полученного урона. Это уменьшение длится, пока цель не завершит продолжительный отдых. Цель умирает, если этот эффект уменьшает её максимум хитов до 0.',
    'Claw (Bite in Beast Form)': 'Коготь (укус в облике зверя)',
    # --- 2014: классы ---
    "- When you make a melee weapon Attack using Strength, you gain a +2 bonus to the damage roll. This bonus increases as you level.":
        '- Когда вы совершаете рукопашную атаку оружием, используя Силу, вы получаете бонус +2 к броску урона. Этот бонус растёт с уровнем.',
    "Once you have raged the maximum number of times for your barbarian level, you must finish a Long Rest before you can rage again. You may rage 2 times at 1st level, 3 at 3rd, 4 at 6th, 5 at 12th, and 6 at 17th.":
        'Когда вы впали в ярость максимальное для вашего уровня варвара число раз, вы должны завершить продолжительный отдых, прежде чем сможете впасть в ярость снова. Вы можете впадать в ярость 2 раза на 1-м уровне, 3 — на 3-м, 4 — на 6-м, 5 — на 12-м и 6 — на 17-м.',
    "Choose one domain related to your deity, such as Knowledge, Life, Light, Nature, Tempest, Trickery, or War. Only the Life domain is detailed in the Open Game Licensed SRD. Additional Domains are described in the official rulebooks or products from other publishers.":
        'Выберите одну область, связанную с вашим божеством, например Знание, Жизнь, Свет, Природа, Буря, Обман или Война. В открытом SRD подробно описана только область Жизни. Дополнительные области описаны в официальных книгах правил или в продуктах других издателей.',
    "Starting at 2nd level, when you hit a creature with a melee weapon attack, you can expend one spell slot to deal radiant damage to the target, in addition to the weapon's damage. The extra damage is 2d8 for a 1st-level spell slot, plus 1d8 for each spell level higher than 1st, to a maximum of 5d8. The damage increases by 1d8 if the target is an undead or a fiend.":
        'Начиная со 2-го уровня, когда вы попадаете по существу рукопашной атакой оружием, вы можете потратить одну ячейку заклинания, чтобы нанести цели урон излучением в дополнение к урону оружия. Дополнительный урон равен 2d8 для ячейки 1-го уровня плюс 1d8 за каждый уровень ячейки выше 1-го, максимум 5d8. Урон увеличивается на 1d8, если цель — нежить или исчадие.',
    "You can transform one magic weapon into your pact weapon by performing a special ritual while you hold the weapon. You perform the ritual over the course of 1 hour, which can be done during a short rest. You can then dismiss the weapon, shunting it into an extradimensional space, and it appears whenever you create your pact weapon thereafter. You can't affect an artifact or a sentient weapon in this way. The weapon ceases being your pact weapon if you die, if you perform the 1-hour ritual on a different weapon, or if you use a 1-hour ritual to break your bond to it. The weapon appears at your feet if it is in the extradimensional space when the bond breaks.":
        'Вы можете превратить одно магическое оружие в своё оружие договора, проведя особый ритуал, пока держите это оружие. Ритуал длится 1 час и может проводиться во время короткого отдыха. Затем вы можете отпустить оружие, отправив его во внепространственное пространство, и оно появляется всякий раз, когда вы создаёте своё оружие договора. Таким образом нельзя подчинить артефакт или разумное оружие. Оружие перестаёт быть вашим оружием договора, если вы умираете, если вы проводите часовой ритуал над другим оружием или если вы используете часовой ритуал, чтобы разорвать связь с ним. Если в момент разрыва связи оружие находится во внепространственном пространстве, оно появляется у ваших ног.',
    "Your familiar is more cunning than a typical familiar. Its default form can be a reflection of your patron, with imps and quasits tied to the Fiend.":
        'Ваш фамильяр хитрее обычного. Его обычная форма может отражать вашего покровителя: имп и квазит связаны с Исчадием.',
    "If you lose your Book of Shadows, you can perform a 1-hour ceremony to receive a replacement from your patron. This ceremony can be performed during a short or long rest, and it destroys the previous book. The book turns to ash when you die.":
        'Если вы потеряете свою Книгу теней, вы можете провести часовую церемонию, чтобы получить замену от своего покровителя. Церемонию можно провести во время короткого или продолжительного отдыха, и она уничтожает прежнюю книгу. Книга обращается в пепел, когда вы умираете.',
    # названия умений с двоеточием и хвостом
    'Circle of the Land': 'Круг Земли', 'Arctic': 'Арктика', 'Coast': 'Побережье', 'Desert': 'Пустыня', 'Forest': 'Лес', 'Grassland': 'Луга',
    'Mountain': 'Горы', 'Swamp': 'Болото',
    'Flexible Casting: Converting Spell Slot': 'Гибкое колдовство: превращение ячейки заклинания',
    'Fighting Style: Two-Weapon Fighting': 'Боевой стиль: бой двумя оружиями',
    'Defensive Tactics: Multiattack Defense': 'Защитная тактика: защита от мультиатаки',
    'Simple Weapons': 'Простое оружие', 'Simple Weapons, Martial Weapons': 'Простое оружие, воинское оружие',
    'Light Armor, Medium Armor, Shields': 'Лёгкие доспехи, средние доспехи, щиты', 'Light Armor': 'Лёгкие доспехи', 'Light Armor, Medium Armor': 'Лёгкие доспехи, средние доспехи',
    'Light Armor, Medium Armor, Heavy Armor, Shields': 'Лёгкие доспехи, средние доспехи, тяжёлые доспехи, щиты',
    'Medium Armor, Shields': 'Средние доспехи, щиты', 'Shields': 'Щиты', 'None': 'Нет',
    'Table: Creating Spell Slots': 'Таблица: создание ячеек заклинаний',
    'Path feature': 'Умение пути',
})

_WERE = {'werebear': ('Медведь-оборотень', 'медведя-оборотня', 'медведя'), 'wereboar': ('Кабан-оборотень', 'кабана-оборотня', 'кабана'),
         'wererat': ('Крыса-оборотень', 'крысы-оборотня', 'крысы'), 'weretiger': ('Тигр-оборотень', 'тигра-оборотня', 'тигра'),
         'werewolf': ('Волк-оборотень', 'волка-оборотня', 'волка')}
_DMG_GEN = {'Piercing': 'Колющего', 'Slashing': 'Рубящего', 'Bludgeoning': 'Дробящего', 'Necrotic': 'Некротического', 'Radiant': 'Излучением'}


def _atk_simple(m, ctx):
    kind, bonus, reach, rest = m.groups()
    k = {'Melee': 'Рукопашная атака', 'Ranged': 'Дальнобойная атака', 'Melee or Ranged': 'Рукопашная или дальнобойная атака'}[kind]
    reach = re.sub(r'reach (\d+) ft\.?', r'досягаемость \1 футов', reach)
    reach = re.sub(r'range (\d+)/(\d+) ft\.?', r'дистанция \1/\2 футов', reach).replace(' or ', ' или ')
    return '%s: %s, %s. Попадание: %s' % (k, bonus, reach, rest)


def _were_curse(m, ctx):
    bonus, reach, dmg, dtype, dc, form = m.groups()
    nom, gen, _ = _WERE[form.lower()]
    return ('Рукопашная атака: %s, досягаемость %s футов. Попадание: %s %s урона. Если цель — Гуманоид, она подвергается следующему эффекту. '
            'Спасбросок Телосложения: СЛ %s. Провал: Цель проклята. Если проклятая цель опускается до 0 хитов, она вместо этого становится существом «%s» под контролем Мастера и имеет 10 хитов. '
            'Успех: Цель обладает иммунитетом к проклятию этого %s на 24 часа.') % (bonus, reach, dmg, _DMG_GEN[dtype], dc, nom, gen)


def _lang_were(m, ctx):
    return 'Общий (не может говорить в облике %s)' % {'bear': 'медведя', 'boar': 'кабана', 'rat': 'крысы', 'tiger': 'тигра', 'wolf': 'волка'}[m.group(1)]


def _parry(m, ctx):
    who, n = m.group(1), m.group(2)
    return ('Триггер: по %s попадает бросок рукопашной атаки, пока он держит оружие. Ответ: %s добавляет %s к своему КД против этой атаки, '
            'из-за чего атака может промахнуться.') % (_WHO.get(who, who), _WHO_NOM.get(who, who).capitalize(), n)


_WHO = {'bandit': 'бандиту', 'erinyes': 'эриниии', 'gladiator': 'гладиатору', 'knight': 'рыцарю', 'marilith': 'мариличи', 'noble': 'дворянину', 'warrior': 'воину'}
_WHO_NOM = {'bandit': 'бандит', 'erinyes': 'эриния', 'gladiator': 'гладиатор', 'knight': 'рыцарь', 'marilith': 'марилит', 'noble': 'дворянин', 'warrior': 'воин'}
_WHO['erinyes'] = 'эринии'
_WHO['marilith'] = 'марилит'

RULES += [
    (re.compile(r'^(Melee or Ranged|Melee|Ranged) Attack Roll: ([+-]\d+), ((?:reach|range)[^H]*?ft)\.? Hit: (\d+ \([^)]+\) (?:Piercing|Slashing|Bludgeoning) damage\.)$'),
     lambda m, c: _atk_simple(m, c).replace(' damage.', ' урона.').replace('Piercing', 'Колющего').replace('Slashing', 'Рубящего').replace('Bludgeoning', 'Дробящего')),
    (re.compile(r"^Melee Attack Roll: (\+\d+), reach (\d+) ft\. Hit: (\d+ \([^)]+\)) (Piercing) damage\. If the target is a Humanoid, it is subjected to the following effect\. Constitution Saving Throw: DC (\d+)\. Failure: The target is cursed\. If the cursed target drops to 0 Hit Points, it instead becomes a (Werebear|Wereboar|Wererat|Weretiger|Werewolf) under the GM’s control and has 10 Hit Points\. Success: The target is immune to this \w+’s curse for 24 hours\.$"),
     _were_curse),
    (re.compile(r"^Common \(can[’']t speak in (\w+) form\)$"), _lang_were),
    (re.compile(r'^Trigger: The (\w+) is hit by a melee attack roll while holding a weapon\. Response: The \w+ adds (\d+) to its AC against that attack, possibly causing it to miss\.$'), _parry),
]

TEXT_LAST = {k: TEXT.pop(k) for k in ['Arctic', 'Coast', 'Desert', 'Forest', 'Grassland', 'Mountain', 'Swamp', 'Shields', 'None', 'Simple Weapons', 'Light Armor', 'Path feature', 'Circle of the Land'] if k in TEXT}


# --- 2024: монстры (в корпусе md 5.2 у монстров нет раздела «Реакции», часть умений вариантов не сопоставилась) ---
TEXT.update({
    "Trigger: The bandit is hit by a melee attack roll while holding a weapon. Response: The bandit adds 2 to its AC against that attack, possibly causing it to miss.":
        'Триггер: по бандиту попадает бросок рукопашной атаки, пока он держит оружие. Ответ: бандит добавляет 2 к своему КД против этой атаки, из-за чего атака может промахнуться.',
    "Trigger: While the pudding is Large or Medium and has 10+ Hit Points, it becomes Bloodied or is subjected to Lightning or Slashing damage. Response: The pudding splits into two new Black Puddings. Each new pudding is one size smaller than the original pudding and acts on its Initiative. The original pudding’s Hit Points are divided evenly between the new puddings (round down).":
        'Триггер: пока пудинг Большой или Средний и имеет 10+ хитов, он становится Ослабленным или подвергается урону электричеством или рубящему урону. Ответ: пудинг делится на два новых Чёрных пудинга. Каждый новый пудинг на один размер меньше исходного и действует в его инициативу. Хиты исходного пудинга делятся поровну между новыми пудингами (с округлением вниз).',
    "Trigger: A creature the devil can see starts its turn within 30 feet of the devil and can see the devil. Response—Wisdom Saving Throw: DC 15, the triggering creature. Failure: The target has the Frightened condition until the end of its turn. Success: The target is immune to this devil’s Unnerving Gaze for 24 hours.":
        'Триггер: существо, которое дьявол видит, начинает свой ход в пределах 30 футов от дьявола и видит его. Ответ — Спасбросок Мудрости: СЛ 15, существо-триггер. Провал: цель получает состояние Испуганный до конца своего хода. Успех: цель получает иммунитет к Пугающему взгляду этого дьявола на 24 часа.',
    "Trigger: A creature or a source of Bright Light moves within 30 feet of the shrieker. Response: The shrieker emits a shriek audible within 300 feet of itself for 1 minute or until the shrieker dies.":
        'Триггер: существо или источник яркого света перемещается в пределах 30 футов от визгуна. Ответ: визгун издаёт вопль, слышимый в пределах 300 футов от него, в течение 1 минуты или пока визгун не умрёт.',
    "The mouther babbles incoherently while it doesn’t have the Incapacitated condition. Wisdom Saving Throw: DC 10, any creature that starts its turn within 20 feet of the mouther while it is babbling. Failure: The target rolls 1d8 to determine what it does during the current turn: 1–4. The target does nothing. 5–6. The target takes no action or Bonus Action and uses all its movement to move in a random direction. 7–8. The target makes a melee attack against a randomly determined creature within its reach or does nothing if it can’t make such an attack.":
        'Бормотун несвязно бормочет, пока не имеет состояния Недееспособный. Спасбросок Мудрости: СЛ 10, любое существо, начинающее ход в пределах 20 футов от бормотуна, пока тот бормочет. Провал: цель бросает 1d8, чтобы определить, что она делает в течение текущего хода: 1–4. Цель ничего не делает. 5–6. Цель не совершает действий и бонусных действий и тратит всё движение, чтобы двигаться в случайном направлении. 7–8. Цель совершает рукопашную атаку по случайно выбранному существу в пределах своей досягаемости или ничего не делает, если не может совершить такую атаку.',
    "Trigger: A creature the goblin can see makes an attack roll against it. Response: The goblin chooses a Small or Medium ally within 5 feet of itself. The goblin and that ally swap places, and the ally becomes the target of the attack instead.":
        'Триггер: существо, которое гоблин видит, совершает по нему бросок атаки. Ответ: гоблин выбирает Маленького или Среднего союзника в пределах 5 футов от себя. Гоблин и этот союзник меняются местами, и целью атаки становится союзник.',
    "While within 30 feet of at least two hag allies, the hag can cast one of the following spells, requiring no Material components, using the spell’s normal casting time, and using Intelligence as the spellcasting ability (spell save DC 11): Augury, Find Familiar, Identify, Locate Object, Scrying, or Unseen Servant. The hag must finish a Long Rest before using this trait to cast that spell again.":
        'Находясь в пределах 30 футов как минимум от двух союзниц-карг, карга может сотворить одно из следующих заклинаний, не нуждаясь в материальных компонентах, с обычным временем сотворения и используя Интеллект как базовую характеристику (СЛ спасброска от заклинаний 11): гадание, поиск фамильяра, опознание, поиск предмета, наблюдение или невидимый слуга. Карга должна завершить долгий отдых, прежде чем снова использовать эту особенность для сотворения того же заклинания.',
    "While within 30 feet of at least two hag allies, the hag can cast one of the following spells, requiring no Material components, using the spell’s normal casting time, and using Intelligence as the spellcasting ability (spell save DC 14): Augury, Find Familiar, Identify, Locate Object, Scrying, or Unseen Servant. The hag must finish a Long Rest before using this trait to cast that spell again.":
        'Находясь в пределах 30 футов как минимум от двух союзниц-карг, карга может сотворить одно из следующих заклинаний, не нуждаясь в материальных компонентах, с обычным временем сотворения и используя Интеллект как базовую характеристику (СЛ спасброска от заклинаний 14): гадание, поиск фамильяра, опознание, поиск предмета, наблюдение или невидимый слуга. Карга должна завершить долгий отдых, прежде чем снова использовать эту особенность для сотворения того же заклинания.',
    "Trigger: The mummy is hit by an attack roll. Response: The mummy adds 2 to its AC against the attack, possibly causing the attack to miss, and the mummy teleports up to 60 feet to an unoccupied space it can see. Each creature of its choice that it can see within 5 feet of its destination space has the Blinded condition until the end of the mummy’s next turn.":
        'Триггер: по мумии попадает бросок атаки. Ответ: мумия добавляет 2 к своему КД против этой атаки, из-за чего атака может промахнуться, и телепортируется до 60 футов в свободное пространство, которое видит. Каждое существо по её выбору, которое она видит в пределах 5 футов от места назначения, получает состояние Ослеплённый до конца следующего хода мумии.',
    "Trigger: Another creature the nalfeshnee can see ends its move within 120 feet of the nalfeshnee. Response: The nalfeshnee uses Teleport, but its destination space must be within 10 feet of the triggering creature.":
        'Триггер: другое существо, которое налфешни видит, заканчивает своё перемещение в пределах 120 футов от налфешни. Ответ: налфешни использует Телепортацию, но место назначения должно находиться в пределах 10 футов от существа-триггера.',
    "Trigger: While the jelly is Large or Medium and has 10+ Hit Points, it becomes Bloodied or is subjected to Lightning or Slashing damage. Response: The jelly splits into two new Ochre Jellies. Each new jelly is one size smaller than the original jelly and acts on its Initiative. The original jelly’s Hit Points are divided evenly between the new jellies (round down).":
        'Триггер: пока желе Большое или Среднее и имеет 10+ хитов, оно становится Ослабленным или подвергается урону электричеством или рубящему урону. Ответ: желе делится на два новых Охряных желе. Каждое новое желе на один размер меньше исходного и действует в его инициативу. Хиты исходного желе делятся поровну между новыми желе (с округлением вниз).',
    "Trigger: The pirate is hit by a melee attack roll while holding a weapon. Response: The pirate adds 3 to its AC against that attack, possibly causing it to miss. On a miss, the pirate makes one Rapier attack against the triggering creature if within range.":
        'Триггер: по пирату попадает бросок рукопашной атаки, пока он держит оружие. Ответ: пират добавляет 3 к своему КД против этой атаки, из-за чего атака может промахнуться. При промахе пират совершает одну атаку рапирой по существу-триггеру, если оно в пределах досягаемости.',
    "Trigger: An attack roll hits the rust monster. Response: The rust monster uses Antennae.":
        'Триггер: бросок атаки попадает по ржавчинному чудищу. Ответ: ржавчинное чудище использует Антенны.',
    "Trigger: An attack roll hits the wearer of the guardian’s amulet while the wearer is within 5 feet of the guardian. Response: The wearer gains a +5 bonus to AC, including against the triggering attack and possibly causing it to miss, until the start of the guardian’s next turn.":
        'Триггер: бросок атаки попадает по носителю амулета стража, пока носитель находится в пределах 5 футов от стража. Ответ: носитель получает бонус +5 к КД, в том числе против атаки-триггера (из-за чего она может промахнуться), до начала следующего хода стража.',
    "Trigger: The sphinx or another creature within 30 feet makes an ability check or a saving throw. Response: The sphinx adds 2 to the roll.":
        'Триггер: сфинкс или другое существо в пределах 30 футов совершает проверку характеристики или спасбросок. Ответ: сфинкс добавляет 2 к броску.',
    "Trigger: The giant is hit by a ranged attack roll and takes Bludgeoning, Piercing, or Slashing damage from it. Response: The giant reduces the damage it takes from the attack by 11 (1d10 + 6), and if that damage is reduced to 0, the giant can redirect some of the attack’s force. Dexterity Saving Throw: DC 17, one creature the giant can see within 60 feet. Failure: 11 (1d10 + 6) Force damage.":
        'Триггер: по великану попадает бросок дальнобойной атаки, и он получает от неё дробящий, колющий или рубящий урон. Ответ: великан уменьшает получаемый от атаки урон на 11 (1d10 + 6), и если урон уменьшен до 0, великан может перенаправить часть силы атаки. Спасбросок Ловкости: СЛ 17, одно существо, которое великан видит в пределах 60 футов. Провал: 11 (1d10 + 6) урона силовым полем.',
    "If the vampire drops to 0 Hit Points outside its resting place, the vampire uses Shape-Shift to become mist (no action required). If it can’t use ShapeShift, it is destroyed. While it has 0 Hit Points in mist form, it can’t return to its vampire form, and it must reach its resting place within 2 hours or be destroyed. Once in its resting place, it returns to its vampire form and has the Paralyzed condition until it regains any Hit Points, and it regains 1 Hit Point after spending 1 hour there.":
        'Если вампир опускается до 0 хитов вне своего места упокоения, он использует Смену облика, чтобы стать туманом (без затраты действия). Если он не может использовать Смену облика, он уничтожается. Пока у него 0 хитов в облике тумана, он не может вернуться в облик вампира и должен добраться до своего места упокоения в течение 2 часов, иначе будет уничтожен. Оказавшись в месте упокоения, он возвращается в облик вампира и имеет состояние Парализованный, пока не восстановит хоть сколько-то хитов; он восстанавливает 1 хит, проведя там 1 час.',
    "The vampire has these weaknesses:": 'У вампира есть следующие слабости:',
    "The vampire can’t enter a residence without an invitation from an occupant.": 'Вампир не может войти в жилище без приглашения кого-либо из обитателей.',
    "The vampire takes 20 Acid damage if it ends its turn in running water.": 'Вампир получает 20 урона кислотой, если заканчивает свой ход в проточной воде.',
    "If a weapon that deals Piercing damage is driven into the vampire’s heart while the vampire has the Incapacitated condition in its resting place, the vampire has the Paralyzed condition until the weapon is removed.":
        'Если оружие, наносящее колющий урон, вонзают в сердце вампира, пока он имеет состояние Недееспособный в своём месте упокоения, вампир получает состояние Парализованный, пока оружие не будет извлечено.',
    "The vampire takes 20 Radiant damage if it starts its turn in sunlight. While in sunlight, it has Disadvantage on attack rolls and ability checks.":
        'Вампир получает 20 урона излучением, если начинает свой ход под солнечным светом. Находясь под солнечным светом, он совершает броски атаки и проверки характеристик с Помехой.',
    "The vampire makes two Grave Strike attacks and uses Bite.": 'Вампир совершает две атаки Могильным ударом и использует Укус.',
    "Melee Attack Roll: +9, reach 5 ft. Hit: 8 (1d8 + 4) Bludgeoning damage plus 7 (2d6) Necrotic damage. If the target is a Large or smaller creature, it has the Grappled condition (escape DC 14) from one of two hands.":
        'Рукопашная атака: +9, досягаемость 5 футов. Попадание: 8 (1d8 + 4) дробящего урона плюс 7 (2d6) некротического урона. Если цель — существо размером Большой или меньше, она получает состояние Схваченный (СЛ побега 14) одной из двух рук.',
    "Constitution Saving Throw: DC 17, one creature within 5 feet that is willing or that has the Grappled, Incapacitated, or Restrained condition. Failure: 6 (1d4 + 4) Piercing damage plus 13 (3d8) Necrotic damage. The target’s Hit Point maximum decreases by an amount equal to the Necrotic damage taken, and the vampire regains Hit Points equal to that amount. A Humanoid reduced to 0 Hit Points by this damage and then buried rises the following sunset as a Vampire Spawn under the vampire’s control.":
        'Спасбросок Телосложения: СЛ 17, одно существо в пределах 5 футов, которое согласно или имеет состояние Схваченный, Недееспособный или Опутанный. Провал: 6 (1d4 + 4) колющего урона плюс 13 (3d8) некротического урона. Максимум хитов цели уменьшается на величину полученного некротического урона, а вампир восстанавливает столько же хитов. Гуманоид, опущенный этим уроном до 0 хитов и затем похороненный, восстаёт на следующем закате как Порождение вампира под контролем вампира.',
    "The vampire moves up to half its Speed, and it makes one Grave Strike attack.": 'Вампир перемещается на расстояние до половины своей Скорости и совершает одну атаку Могильным ударом.',
    "Trigger: The octopus takes damage while underwater. Response: The octopus releases ink that fills a 10-foot Cube centered on itself, and the octopus moves up to its Swim Speed. The Cube is Heavily Obscured for 1 minute or until a strong current or similar effect disperses the ink.":
        'Триггер: осьминог получает урон под водой. Ответ: осьминог выпускает чернила, заполняющие 10-футовый Куб с центром на нём, и перемещается на расстояние до своей Скорости плавания. Куб остаётся Сильно заслонённым в течение 1 минуты или пока сильное течение или подобный эффект не рассеет чернила.',
    "The octopus can move through a space as narrow as 1 inch without expending extra movement to do so.": 'Осьминог может проходить через пространство шириной всего в 1 дюйм, не тратя на это дополнительного движения.',
    "The octopus can breathe only underwater.": 'Осьминог может дышать только под водой.',
    "Melee Attack Roll: +4, reach 5 ft. Hit: 1 Bludgeoning damage.": 'Рукопашная атака: +4, досягаемость 5 футов. Попадание: 1 дробящего урона.',
    "Trigger: A creature ends its turn within 5 feet of the octopus while underwater. Response: The octopus releases ink that fills a 5-foot Cube centered on itself, and the octopus moves up to its Swim Speed. The Cube is Heavily Obscured for 1 minute or until a strong current or similar effect disperses the ink.":
        'Триггер: существо заканчивает ход в пределах 5 футов от осьминога под водой. Ответ: осьминог выпускает чернила, заполняющие 5-футовый Куб с центром на нём, и перемещается на расстояние до своей Скорости плавания. Куб остаётся Сильно заслонённым в течение 1 минуты или пока сильное течение или подобный эффект не рассеет чернила.',
    # классы 2024: обрывки строк исходных данных
    "turn, but attack rolls against you have Advantage during that time.": 'ход, но броски атаки по вам в это время совершаются с Преимуществом.',
})
TEXT_LAST.update({
    'Water Breathing': 'Подводное дыхание',
    'Parry': 'Парирование', 'Split': 'Деление', 'Unnerving Gaze': 'Пугающий взгляд', 'Spike (level 5 version)': 'Шип (версия 5-го уровня)',
    'Shriek': 'Вопль', 'Redirect Attack': 'Перенаправление атаки', 'Coven Magic': 'Магия ковена', 'Whirlwind of Sand': 'Песчаный вихрь',
    'Pursuit': 'Преследование', 'Nightmare Haunting (Requires Soul Bag)': 'Кошмарное наваждение (требуется мешок душ)', 'Riposte': 'Рипост',
    'Reflexive Antennae': 'Рефлекторные антенны', 'Protection': 'Защита', 'Burst of Ingenuity': 'Вспышка находчивости',
    'Deflect Missile': 'Отражение снаряда', 'Vampire Weakness': 'Слабости вампира', 'Stake to the Heart': 'Кол в сердце',
    'Grave Strike': 'Могильный удар', 'Beguile': 'Обольщение', 'Deathless Strike': 'Бессмертный удар', 'Tusk': 'Клык',
    'Scratch': 'Царапина', 'Ink Cloud': 'Чернильное облако', 'Compression': 'Сжатие', 'Tentacles': 'Щупальца',
})


TEXT.update({
    "Turn Undead. As a Magic action, you present your Holy Symbol and censure Undead creatures. Each Undead of your choice within 30 feet of you must make a Wisdom saving throw. If the creature fails its save, it has the Frightened and Incapacitated conditions for 1 minute. For that duration, it tries":
        'Изгнание нежити. Действием «Магия» вы демонстрируете свой священный символ и порицаете Нежить. Каждая Нежить по вашему выбору в пределах 30 футов от вас должна совершить спасбросок Мудрости. При провале существо получает состояния Испуганный и Недееспособный на 1 минуту. На это время оно пытается',
    "actions as a Bonus Action, and your jump distance is doubled for the turn.": 'действия как Бонусное действие, и дальность вашего прыжка на этот ход удваивается.',
    "end of each of your turns: Charmed, Frightened, or Poisoned.": 'в конце каждого своего хода: Очарованный, Испуганный или Отравленный.',
    "An event in your past left an indelible mark on you, infusing you with simmering magic. As a Bonus Action, you can unleash that magic for 1 minute, during which you gain the following benefits: - The spell save DC of your Sorcerer spells increases by 1.":
        'Событие в вашем прошлом оставило на вас неизгладимый след, наполнив вас бурлящей магией. Бонусным действием вы можете высвободить эту магию на 1 минуту, в течение которой вы получаете следующие преимущества: - СЛ спасбросков ваших заклинаний чародея увеличивается на 1.',
    "The number of spells on your list increases as you gain Warlock levels, as shown in the Prepared Spells column of the Warlock Features table. Whenever that number increases, choose additional Warlock spells until the number of spells on your list matches the number in the table. The chosen spells must be of a level no higher than what's shown in the table's Slot Level column for your level. When you reach level 6, for example, you learn a new Warlock spell, which can be of levels 1–3.":
        'Количество заклинаний в вашем списке растёт по мере получения уровней колдуна, как показано в столбце «Подготовленные заклинания» таблицы «Умения колдуна». Всякий раз, когда это число увеличивается, выбирайте дополнительные заклинания колдуна, пока количество заклинаний в списке не сравняется с числом в таблице. Выбранные заклинания должны быть уровня не выше указанного в столбце «Уровень ячейки» таблицы для вашего уровня. Например, при достижении 6-го уровня вы изучаете новое заклинание колдуна, которое может быть 1–3-го уровня.',
    "another Wizard cantrip of your choice, as shown in the Cantrips column of the Wizard Features table.": 'ещё один заговор волшебника на свой выбор, как показано в столбце «Заговоры» таблицы «Умения волшебника».',
    "For example, if you're a level 3 Bard, your list of": 'Например, если вы бард 3-го уровня, ваш список',
    "prepared spells can include six spells of levels 1 and 2 in any combination.": 'подготовленных заклинаний может включать шесть заклинаний 1-го и 2-го уровней в любом сочетании.',
    "Draconic Spells Sorcerer Level | Spells": 'Драконьи заклинания Уровень чародея | Заклинания',
    "Fiend Spells Warlock Level | Spells": 'Заклинания исчадия Уровень колдуна | Заклинания',
    "Land Type / Resistance": 'Тип земли / Сопротивление',
    "Arid / Fire": 'Засушливая / Огонь', "Polar / Cold": 'Полярная / Холод', "Temperate / Lightning": 'Умеренная / Электричество', "Tropical / Poison": 'Тропическая / Яд',
})

TEXT.update({
    "Melee Attack Roll: +5, reach 5 ft. Hit: 10 (2d6 + 3) Piercing damage. If the target is a Medium or smaller creature and the wereboar moved 20+ feet straight toward it immediately before the hit, the target takes an extra 7 (2d6) Piercing damage and has the Prone condition.":
        'Рукопашная атака: +5, досягаемость 5 футов. Попадание: 10 (2d6 + 3) колющего урона. Если цель — существо размером Средний или меньше, и непосредственно перед попаданием кабан-оборотень переместился по прямой к ней на 20+ футов, цель получает дополнительные 7 (2d6) колющего урона и получает состояние Сбитый с ног.',
})

TEXT.update({
    "The creature's Slam damage increases by 1d4 (Medium or smaller), 1d6 (Large), or 1d12 (Huge) for each spell slot level above 5.":
        'Урон Хлопка существа увеличивается на 1d4 (Средний или меньше), 1d6 (Большой) или 1d12 (Огромный) за каждый уровень ячейки заклинания выше 5-го.',
    "Use the spell slot's level for the spell's level in the stat block.": 'Используйте уровень ячейки заклинания как уровень заклинания в статблоке.',
    "The barrier blocks spells of 1 level higher for each spell slot level above 6.": 'Барьер блокирует заклинания на 1 уровень выше за каждый уровень ячейки заклинания выше 6-го.',
    "You can target one additional creature for each spell slot level above 5.": 'Вы можете выбрать одно дополнительное существо за каждый уровень ячейки заклинания выше 5-го.',
    "You can target one additional Humanoid for each spell slot level above 2.": 'Вы можете выбрать одного дополнительного Гуманоида за каждый уровень ячейки заклинания выше 2-го.',
})

TEXT.update({
    "When you cast this spell using a level 6 or higher location, you can target an additional creature for each level of location beyond the fifth. The creatures must be within 30 feet o f each other when you target them.":
        'Когда вы накладываете это заклинание, используя ячейку 6-го уровня или выше, вы можете выбрать дополнительное существо за каждый уровень ячейки выше пятого. Существа должны находиться в пределах 30 футов друг от друга, когда вы выбираете их целями.',
    "When you cast this spell using a 3 or higher level spell slot, the damage of the spell increases by 1d8 for each level of higher spell slot 2.":
        'Когда вы накладываете это заклинание, используя ячейку 3-го уровня или выше, урон заклинания увеличивается на 1d8 за каждый уровень ячейки выше 2-го.',
})

_DMG2014 = {'piercing': 'Колющего', 'slashing': 'Рубящего', 'bludgeoning': 'Дробящего', 'fire': 'Огненного', 'cold': 'Холодного', 'lightning': 'Электрического',
            'poison': 'Ядовитого', 'acid': 'Кислотного', 'necrotic': 'Некротического', 'radiant': 'Излучением', 'psychic': 'Психического', 'thunder': 'Звукового',
            'force': 'Силового'}
_TGT = {'one target': 'одна цель', 'one creature': 'одно существо', 'one creature or object': 'одно существо или объект'}


def _atk2014(m, ctx):
    kind, bonus, rng, tgt, dmg, dice, typ = m.groups()
    t = typ.lower()
    if t not in _DMG2014 or tgt not in _TGT: return None
    k = {'Melee': 'Рукопашная атака оружием', 'Ranged': 'Дальнобойная атака оружием', 'Melee or Ranged': 'Рукопашная или дальнобойная атака оружием'}[kind]
    rng = re.sub(r'reach (\d+) ft\.', r'досягаемость \1 фт.', rng)
    rng = re.sub(r'range (\d+)/(\d+) ft\.', r'дистанция \1/\2 фт.', rng).replace(' or ', ' или ')
    word = 'урона' if t != 'radiant' else 'урона'
    tail = _DMG2014[t] + ' ' + word if t != 'radiant' else 'урона излучением'
    return '%s: +%s к попаданию, %s, %s. Попадание: %s (%s) %s.' % (k, bonus, rng, _TGT[tgt], dmg, dice.replace('d', 'к'), tail)


RULES.append((re.compile(r'^(Melee or Ranged|Melee|Ranged) Weapon Attack: \+(\d+) to hit, ((?:reach \d+ ft\.|range \d+/\d+ ft\.)(?: or (?:reach \d+ ft\.|range \d+/\d+ ft\.))?), (one target|one creature|one creature or object)\. Hit: (\d+) \((\d+d\d+(?: [+-] \d+)?)\) (\w+) damage\.$'), _atk2014))


def spell_row(piece, ctx):
    """Строки таблиц классов: «3 / Misty Step», «5 | Fear, Fly 7 | Arcane Eye, Charm Monster» — только числа и названия заклинаний."""
    names = getattr(ctx, 'spell_names', None)
    if not names or not re.match(r'^\d+\s*[/|]\s', piece): return None
    pat = re.compile('|'.join(re.escape(n) for n in sorted(names, key=len, reverse=True)))
    rest = pat.sub('', piece)
    if re.sub(r'[\d\s,/|]', '', rest): return None
    return pat.sub(lambda m: names[m.group(0)], piece)


def rules(piece, ctx):
    for rx, fn in RULES:
        m = rx.match(piece)
        if m:
            r = fn(m, ctx)
            if r: return r
    return spell_row(piece, ctx)
