# -*- coding: utf-8 -*-
"""Русские названия для записей SRD. Точные словари + правила для составных названий.
Всё, чего нет в словарях, остаётся на английском (поиск работает и по английскому имени)."""
import re

MONSTERS = {
    'Aboleth': 'Аболет', 'Acolyte': 'Послушник', 'Air Elemental': 'Воздушный элементаль', 'Allosaurus': 'Аллозавр', 'Androsphinx': 'Андросфинкс',
    'Animated Armor': 'Ожившие доспехи', 'Animated Flying Sword': 'Летающий меч', 'Animated Rug of Smothering': 'Удушающий ковёр', 'Ankheg': 'Анкег', 'Ankylosaurus': 'Анкилозавр',
    'Ape': 'Обезьяна', 'Archelon': 'Архелон', 'Archmage': 'Архимаг', 'Assassin': 'Ассасин', 'Awakened Shrub': 'Пробуждённый куст', 'Awakened Tree': 'Пробуждённое дерево',
    'Axe Beak': 'Топороклюв', 'Azer': 'Азер', 'Azer Sentinel': 'Азер-страж', 'Baboon': 'Бабуин', 'Badger': 'Барсук', 'Balor': 'Балор', 'Bandit': 'Бандит', 'Bandit Captain': 'Главарь бандитов',
    'Barbed Devil': 'Шипастый дьявол', 'Basilisk': 'Василиск', 'Bat': 'Летучая мышь', 'Bearded Devil': 'Бородатый дьявол', 'Behir': 'Бехир', 'Berserker': 'Берсерк', 'Black Bear': 'Чёрный медведь',
    'Black Pudding': 'Чёрная слизь', 'Blink Dog': 'Мерцающий пёс', 'Blood Hawk': 'Кровавый ястреб', 'Boar': 'Кабан', 'Bone Devil': 'Костяной дьявол', 'Brown Bear': 'Бурый медведь',
    'Bugbear': 'Багбир', 'Bugbear Stalker': 'Багбир-охотник', 'Bugbear Warrior': 'Багбир-воин', 'Bulette': 'Булетта', 'Camel': 'Верблюд', 'Cat': 'Кошка', 'Centaur': 'Кентавр', 'Centaur Trooper': 'Кентавр-боец',
    'Chain Devil': 'Цепной дьявол', 'Chimera': 'Химера', 'Chuul': 'Чуул', 'Clay Golem': 'Глиняный голем', 'Cloaker': 'Плащевик', 'Cloud Giant': 'Облачный великан', 'Cockatrice': 'Кокатрис',
    'Commoner': 'Обыватель', 'Constrictor Snake': 'Змея-констриктор', 'Couatl': 'Коатль', 'Crab': 'Краб', 'Crocodile': 'Крокодил', 'Cult Fanatic': 'Фанатик культа', 'Cultist': 'Культист',
    'Cultist Fanatic': 'Фанатик культа', 'Darkmantle': 'Тёмная мантия', 'Death Dog': 'Пёс смерти', 'Deep Gnome (Svirfneblin)': 'Глубинный гном (свирфнеблин)', 'Deer': 'Олень', 'Deva': 'Дэва',
    'Dire Wolf': 'Лютый волк', 'Djinni': 'Джинн', 'Doppelganger': 'Доппельгангер', 'Draft Horse': 'Тягловая лошадь', 'Dragon Turtle': 'Драконья черепаха', 'Dretch': 'Дретч', 'Drider': 'Драйдер',
    'Drow': 'Дроу', 'Druid': 'Друид', 'Dryad': 'Дриада', 'Duergar': 'Дуэргар', 'Dust Mephit': 'Пыльный мефит', 'Eagle': 'Орёл', 'Earth Elemental': 'Земляной элементаль', 'Efreeti': 'Ифрит',
    'Elephant': 'Слон', 'Elk': 'Лось', 'Erinyes': 'Эриния', 'Ettercap': 'Эттеркап', 'Ettin': 'Эттин', 'Fire Elemental': 'Огненный элементаль', 'Fire Giant': 'Огненный великан',
    'Flesh Golem': 'Голем из плоти', 'Flying Snake': 'Летающая змея', 'Flying Sword': 'Летающий меч', 'Frog': 'Лягушка', 'Frost Giant': 'Ледяной великан', 'Gargoyle': 'Горгулья',
    'Gelatinous Cube': 'Желатиновый куб', 'Ghast': 'Гаст', 'Ghost': 'Призрак', 'Ghoul': 'Упырь', 'Gibbering Mouther': 'Бормочущий ротовик', 'Glabrezu': 'Глабрезу', 'Gladiator': 'Гладиатор',
    'Gnoll': 'Гнолл', 'Gnoll Warrior': 'Гнолл-воин', 'Goat': 'Коза', 'Goblin': 'Гоблин', 'Goblin Boss': 'Гоблин-главарь', 'Goblin Minion': 'Гоблин-прислужник', 'Goblin Warrior': 'Гоблин-воин',
    'Gorgon': 'Горгон', 'Gray Ooze': 'Серая слизь', 'Green Hag': 'Зелёная карга', 'Grick': 'Грик', 'Griffon': 'Грифон', 'Grimlock': 'Гримлок', 'Guard': 'Стражник', 'Guard Captain': 'Капитан стражи',
    'Guardian Naga': 'Нага-хранитель', 'Gynosphinx': 'Гиносфинкс', 'Half-Dragon': 'Полудракон', 'Half-Red Dragon Veteran': 'Ветеран-полукрасный дракон', 'Harpy': 'Гарпия', 'Hawk': 'Ястреб',
    'Hell Hound': 'Адская гончая', 'Hezrou': 'Хезру', 'Hill Giant': 'Холмовой великан', 'Hippogriff': 'Гиппогриф', 'Hippopotamus': 'Бегемот', 'Hobgoblin': 'Хобгоблин', 'Hobgoblin Captain': 'Хобгоблин-капитан',
    'Hobgoblin Warrior': 'Хобгоблин-воин', 'Homunculus': 'Гомункул', 'Horned Devil': 'Рогатый дьявол', 'Hunter Shark': 'Акула-охотник', 'Hydra': 'Гидра', 'Hyena': 'Гиена', 'Ice Devil': 'Ледяной дьявол',
    'Ice Mephit': 'Ледяной мефит', 'Imp': 'Бес', 'Incubus': 'Инкуб', 'Invisible Stalker': 'Невидимый охотник', 'Iron Golem': 'Железный голем', 'Jackal': 'Шакал', 'Killer Whale': 'Косатка',
    'Knight': 'Рыцарь', 'Kobold': 'Кобольд', 'Kobold Warrior': 'Кобольд-воин', 'Kraken': 'Кракен', 'Lamia': 'Ламия', 'Lemure': 'Лемур', 'Lich': 'Лич', 'Lion': 'Лев', 'Lizard': 'Ящерица',
    'Lizardfolk': 'Людоящер', 'Mage': 'Маг', 'Magma Mephit': 'Магмовый мефит', 'Magmin': 'Магмин', 'Mammoth': 'Мамонт', 'Manticore': 'Мантикора', 'Marilith': 'Марилит', 'Mastiff': 'Мастиф',
    'Medusa': 'Медуза', 'Merfolk': 'Мерфолк', 'Merfolk Skirmisher': 'Мерфолк-застрельщик', 'Merrow': 'Мерроу', 'Mimic': 'Мимик', 'Minotaur': 'Минотавр', 'Minotaur Skeleton': 'Скелет минотавра',
    'Minotaur of Baphomet': 'Минотавр Бафомета', 'Mule': 'Мул', 'Mummy': 'Мумия', 'Mummy Lord': 'Повелитель мумий', 'Nalfeshnee': 'Нальфешни', 'Night Hag': 'Ночная карга', 'Nightmare': 'Кошмар',
    'Noble': 'Дворянин', 'Ochre Jelly': 'Охровое желе', 'Octopus': 'Осьминог', 'Ogre': 'Огр', 'Ogre Zombie': 'Огр-зомби', 'Oni': 'Они', 'Orc': 'Орк', 'Otyugh': 'Отиг', 'Owl': 'Сова', 'Owlbear': 'Совомедведь',
    'Panther': 'Пантера', 'Pegasus': 'Пегас', 'Phase Spider': 'Фазовый паук', 'Piranha': 'Пиранья', 'Pirate': 'Пират', 'Pirate Captain': 'Капитан пиратов', 'Pit Fiend': 'Исчадие преисподней',
    'Planetar': 'Планетар', 'Plesiosaurus': 'Плезиозавр', 'Poisonous Snake': 'Ядовитая змея', 'Polar Bear': 'Белый медведь', 'Pony': 'Пони', 'Priest': 'Жрец', 'Priest Acolyte': 'Жрец-послушник',
    'Pseudodragon': 'Псевдодракон', 'Pteranodon': 'Птеранодон', 'Purple Worm': 'Пурпурный червь', 'Quasit': 'Квазит', 'Quipper': 'Квиппер', 'Rakshasa': 'Ракшаса', 'Rat': 'Крыса', 'Raven': 'Ворон',
    'Reef Shark': 'Рифовая акула', 'Remorhaz': 'Реморхаз', 'Rhinoceros': 'Носорог', 'Riding Horse': 'Верховая лошадь', 'Roc': 'Рух', 'Roper': 'Ропер', 'Rug of Smothering': 'Удушающий ковёр',
    'Rust Monster': 'Ржавильщик', 'Saber-Toothed Tiger': 'Саблезубый тигр', 'Sahuagin': 'Сахуагин', 'Sahuagin Warrior': 'Сахуагин-воин', 'Salamander': 'Саламандра', 'Satyr': 'Сатир', 'Scorpion': 'Скорпион',
    'Scout': 'Разведчик', 'Sea Hag': 'Морская карга', 'Sea Horse': 'Морской конёк', 'Seahorse': 'Морской конёк', 'Shadow': 'Тень', 'Shambling Mound': 'Ползущая насыпь', 'Shield Guardian': 'Щитовой страж',
    'Shrieker': 'Визгун', 'Shrieker Fungus': 'Гриб-визгун', 'Skeleton': 'Скелет', 'Solar': 'Солар', 'Specter': 'Спектр', 'Sphinx of Lore': 'Сфинкс знаний', 'Sphinx of Valor': 'Сфинкс доблести',
    'Sphinx of Wonder': 'Сфинкс чудес', 'Spider': 'Паук', 'Spirit Naga': 'Нага-дух', 'Sprite': 'Спрайт', 'Spy': 'Шпион', 'Steam Mephit': 'Паровой мефит', 'Stirge': 'Кровосос', 'Stone Giant': 'Каменный великан',
    'Stone Golem': 'Каменный голем', 'Storm Giant': 'Штормовой великан', 'Succubus': 'Суккуб', 'Succubus/Incubus': 'Суккуб / Инкуб', 'Tarrasque': 'Тараск', 'Thug': 'Головорез', 'Tiger': 'Тигр',
    'Tough': 'Громила', 'Tough Boss': 'Главарь громил', 'Treant': 'Трент', 'Tribal Warrior': 'Воин племени', 'Triceratops': 'Трицератопс', 'Troll': 'Тролль', 'Troll Limb': 'Конечность тролля',
    'Tyrannosaurus Rex': 'Тираннозавр', 'Unicorn': 'Единорог', 'Vampire Familiar': 'Фамильяр вампира', 'Vampire Spawn': 'Порождение вампира', 'Vampire, Bat Form': 'Вампир (облик летучей мыши)',
    'Vampire, Mist Form': 'Вампир (облик тумана)', 'Vampire, Vampire Form': 'Вампир', 'Venomous Snake': 'Ядовитая змея', 'Veteran': 'Ветеран', 'Violet Fungus': 'Фиолетовый гриб', 'Vrock': 'Врок',
    'Vulture': 'Стервятник', 'Warhorse': 'Боевой конь', 'Warhorse Skeleton': 'Скелет боевого коня', 'Warrior Infantry': 'Пехотинец', 'Warrior Veteran': 'Воин-ветеран', 'Water Elemental': 'Водный элементаль',
    'Weasel': 'Ласка', 'Wight': 'Умертвие', "Will-o'-Wisp": 'Блуждающий огонёк', 'Will-o’-Wisp': 'Блуждающий огонёк', 'Winter Wolf': 'Зимний волк', 'Wolf': 'Волк', 'Worg': 'Ворг', 'Wraith': 'Привидение',
    'Wyvern': 'Виверна', 'Xorn': 'Ксорн', 'Zombie': 'Зомби', 'Giant Rat (Diseased)': 'Гигантская крыса (больная)', 'Giant Sea Horse': 'Гигантский морской конёк', 'Giant Seahorse': 'Гигантский морской конёк',
    'Giant Fire Beetle': 'Гигантский огненный жук', 'Giant Wolf Spider': 'Гигантский паук-волк', 'Giant Poisonous Snake': 'Гигантская ядовитая змея', 'Giant Venomous Snake': 'Гигантская ядовитая змея',
    'Giant Constrictor Snake': 'Гигантская змея-констриктор',
}
GIANT = {'Ape': 'Гигантская обезьяна', 'Badger': 'Гигантский барсук', 'Bat': 'Гигантская летучая мышь', 'Boar': 'Гигантский кабан', 'Centipede': 'Гигантская многоножка', 'Crab': 'Гигантский краб',
         'Crocodile': 'Гигантский крокодил', 'Eagle': 'Гигантский орёл', 'Elk': 'Гигантский лось', 'Frog': 'Гигантская лягушка', 'Goat': 'Гигантская коза', 'Hyena': 'Гигантская гиена', 'Lizard': 'Гигантская ящерица',
         'Octopus': 'Гигантский осьминог', 'Owl': 'Гигантская сова', 'Rat': 'Гигантская крыса', 'Scorpion': 'Гигантский скорпион', 'Shark': 'Гигантская акула', 'Spider': 'Гигантский паук', 'Toad': 'Гигантская жаба',
         'Vulture': 'Гигантский стервятник', 'Wasp': 'Гигантская оса', 'Weasel': 'Гигантская ласка'}
SWARM = {'Bats': 'летучих мышей', 'Beetles': 'жуков', 'Centipedes': 'многоножек', 'Crawling Claws': 'ползающих когтей', 'Insects': 'насекомых', 'Piranhas': 'пираний', 'Poisonous Snakes': 'ядовитых змей',
         'Quippers': 'квипперов', 'Rats': 'крыс', 'Ravens': 'воронов', 'Spiders': 'пауков', 'Venomous Snakes': 'ядовитых змей', 'Wasps': 'ос'}
COLORS = {'Black': 'Чёрный', 'Blue': 'Синий', 'Brass': 'Латунный', 'Bronze': 'Бронзовый', 'Copper': 'Медный', 'Gold': 'Золотой', 'Green': 'Зелёный', 'Red': 'Красный', 'Silver': 'Серебряный', 'White': 'Белый'}
AGES = {'Adult': 'Взрослый', 'Ancient': 'Древний', 'Young': 'Молодой'}
WERE = {'Werebear': 'Вермедведь', 'Wereboar': 'Веркабан', 'Wererat': 'Веркрыса', 'Weretiger': 'Вертигр', 'Werewolf': 'Вервольф'}
FORMS = {'Human Form': 'облик человека', 'Hybrid Form': 'гибридный облик', 'Bear Form': 'облик медведя', 'Boar Form': 'облик кабана', 'Rat Form': 'облик крысы', 'Tiger Form': 'облик тигра', 'Wolf Form': 'облик волка'}


def monster(name):
    if name in MONSTERS: return MONSTERS[name]
    m = re.match(r'^(Adult|Ancient|Young) (\w+) Dragon$', name)
    if m: return f'{AGES[m[1]]} {COLORS[m[2]].lower()} дракон'
    m = re.match(r'^(\w+) Dragon Wyrmling$', name)
    if m: return f'{COLORS[m[1]]} дракон-вирмлинг'
    m = re.match(r'^Giant (.+)$', name)
    if m and m[1] in GIANT: return GIANT[m[1]]
    m = re.match(r'^Swarm of (.+)$', name)
    if m and m[1] in SWARM: return 'Рой ' + SWARM[m[1]]
    m = re.match(r'^(\w+), (.+)$', name)
    if m and m[1] in WERE and m[2] in FORMS: return f'{WERE[m[1]]} ({FORMS[m[2]]})'
    return None


EQUIPMENT = {
    'Abacus': 'Счёты', 'Acid': 'Кислота', 'Acid (vial)': 'Кислота (флакон)', "Alchemist's Fire": 'Алхимический огонь', "Alchemist's fire (flask)": 'Алхимический огонь (фляга)', "Alchemist's Supplies": 'Инструменты алхимика',
    'Alms box': 'Ящик для подаяний', 'Amulet': 'Амулет', 'Animal Feed (1 day)': 'Корм для животных (1 день)', 'Antitoxin': 'Противоядие', 'Antitoxin (vial)': 'Противоядие (флакон)', 'Arrow': 'Стрела', 'Arrows': 'Стрелы',
    'Backpack': 'Рюкзак', 'Bagpipes': 'Волынка', 'Ball bearings': 'Металлические шарики', 'Ball bearings (bag of 1,000)': 'Металлические шарики (мешочек, 1000 шт.)', 'Barrel': 'Бочка', 'Basket': 'Корзина',
    'Battleaxe': 'Боевой топор', 'Bedroll': 'Спальник', 'Bell': 'Колокольчик', 'Bit and bridle': 'Удила и уздечка', 'Blanket': 'Одеяло', 'Block and tackle': 'Полиспаст', 'Block of incense': 'Брусок благовоний',
    'Blowgun': 'Духовая трубка', 'Blowgun needle': 'Игла для духовой трубки', 'Bolts': 'Арбалетные болты', 'Book': 'Книга', 'Bottle, Glass': 'Бутылка стеклянная', 'Bottle, glass': 'Бутылка стеклянная', 'Breastplate': 'Кираса',
    "Brewer's Supplies": 'Инструменты пивовара', 'Bucket': 'Ведро', 'Bullets, Firearm': 'Пули', 'Bullets, Sling': 'Снаряды для пращи', "Burglar's Pack": 'Набор взломщика', "Calligrapher's Supplies": 'Инструменты каллиграфа',
    'Caltrops': 'Калтропы', 'Camel': 'Верблюд', 'Candle': 'Свеча', "Carpenter's Tools": 'Инструменты плотника', 'Carriage': 'Карета', 'Cart': 'Телега', "Cartographer's Tools": 'Инструменты картографа',
    'Case, Crossbow Bolt': 'Футляр для болтов', 'Case, crossbow bolt': 'Футляр для болтов', 'Case, Map or Scroll': 'Тубус для карт и свитков', 'Case, map or scroll': 'Тубус для карт и свитков', 'Censer': 'Кадило',
    'Chain': 'Цепь', 'Chain (10 feet)': 'Цепь (10 футов)', 'Chain Mail': 'Кольчуга', 'Chain Shirt': 'Кольчужная рубаха', 'Chalk (1 piece)': 'Мел (1 кусок)', 'Chariot': 'Колесница', 'Chest': 'Сундук',
    "Climber's Kit": 'Набор скалолаза', 'Clothes, Fine': 'Одежда дорогая', 'Clothes, fine': 'Одежда дорогая', "Clothes, Traveler's": 'Одежда дорожная', "Clothes, traveler's": 'Одежда дорожная', 'Clothes, common': 'Одежда обычная',
    'Clothes, costume': 'Костюм', 'Club': 'Дубинка', "Cobbler's Tools": 'Инструменты сапожника', 'Component Pouch': 'Мешочек с компонентами', 'Component pouch': 'Мешочек с компонентами', "Cook's Utensils": 'Кухонная утварь',
    "Cook's utensils": 'Кухонная утварь', 'Costume': 'Костюм', 'Crossbow bolt': 'Арбалетный болт', 'Crossbow, hand': 'Ручной арбалет', 'Crossbow, heavy': 'Тяжёлый арбалет', 'Crossbow, light': 'Лёгкий арбалет',
    'Crowbar': 'Ломик', 'Crystal': 'Кристалл', 'Dagger': 'Кинжал', 'Dart': 'Дротик', 'Dice': 'Кости', 'Dice Set': 'Набор игральных костей', "Diplomat's Pack": 'Набор дипломата', 'Disguise Kit': 'Набор для грима',
    'Donkey': 'Осёл', 'Dragonchess': 'Драконьи шахматы', 'Drum': 'Барабан', 'Dulcimer': 'Цимбалы', "Dungeoneer's Pack": 'Набор исследователя подземелий', 'Elephant': 'Слон', 'Emblem': 'Эмблема',
    "Entertainer's Pack": 'Набор артиста', "Explorer's Pack": 'Набор путешественника', 'Fishing tackle': 'Рыболовные снасти', 'Flail': 'Цеп', 'Flask': 'Фляга', 'Flask or tankard': 'Фляга или кружка', 'Flute': 'Флейта',
    'Forgery Kit': 'Набор для фальсификации', 'Galley': 'Галера', 'Glaive': 'Глефа', "Glassblower's Tools": 'Инструменты стеклодува', 'Grappling Hook': 'Кошка', 'Grappling hook': 'Кошка', 'Greataxe': 'Секира',
    'Greatclub': 'Палица', 'Greatsword': 'Двуручный меч', 'Halberd': 'Алебарда', 'Half Plate Armor': 'Полулаты', 'Half-Plate Armor': 'Полулаты', 'Hammer': 'Молоток', 'Hammer, sledge': 'Кувалда',
    'Hand Crossbow': 'Ручной арбалет', 'Handaxe': 'Ручной топор', "Healer's Kit": 'Набор целителя', 'Heavy Crossbow': 'Тяжёлый арбалет', 'Herbalism Kit': 'Набор травника', 'Hide Armor': 'Шкурный доспех',
    'Holy Water': 'Святая вода', 'Holy water (flask)': 'Святая вода (фляга)', 'Horn': 'Рог', 'Horse, draft': 'Тягловая лошадь', 'Horse, riding': 'Верховая лошадь', 'Hourglass': 'Песочные часы',
    'Hunting Trap': 'Охотничий капкан', 'Hunting trap': 'Охотничий капкан', 'Ink': 'Чернила', 'Ink (1 ounce bottle)': 'Чернила (бутылочка 1 унция)', 'Ink Pen': 'Перо', 'Ink pen': 'Перо', 'Javelin': 'Метательное копьё',
    "Jeweler's Tools": 'Инструменты ювелира', 'Jug': 'Кувшин', 'Jug or pitcher': 'Кувшин', 'Keelboat': 'Килевая лодка', 'Ladder': 'Лестница', 'Ladder (10-foot)': 'Лестница (10 футов)', 'Lamp': 'Лампа', 'Lance': 'Длинное копьё',
    'Lantern, Bullseye': 'Фонарь направленный', 'Lantern, bullseye': 'Фонарь направленный', 'Lantern, Hooded': 'Фонарь закрытый', 'Lantern, hooded': 'Фонарь закрытый', 'Leather Armor': 'Кожаный доспех',
    "Leatherworker's Tools": 'Инструменты кожевника', 'Light Crossbow': 'Лёгкий арбалет', 'Light Hammer': 'Лёгкий молот', 'Light hammer': 'Лёгкий молот', 'Little bag of sand': 'Мешочек песка', 'Lock': 'Замок',
    'Longbow': 'Длинный лук', 'Longship': 'Драккар', 'Longsword': 'Длинный меч', 'Lute': 'Лютня', 'Lyre': 'Лира', 'Mace': 'Булава', 'Magnifying Glass': 'Увеличительное стекло', 'Magnifying glass': 'Увеличительное стекло',
    'Manacles': 'Кандалы', 'Map': 'Карта', "Mason's Tools": 'Инструменты каменщика', 'Mastiff': 'Мастиф', 'Maul': 'Молот', 'Mess Kit': 'Столовый набор', 'Mirror': 'Зеркало', 'Mirror, steel': 'Зеркало стальное',
    'Morningstar': 'Моргенштерн', 'Mule': 'Мул', 'Musket': 'Мушкет', "Navigator's Tools": 'Инструменты навигатора', 'Needles': 'Иглы', 'Net': 'Сеть', 'Oil': 'Масло', 'Oil (flask)': 'Масло (фляга)', 'Orb': 'Сфера',
    'Padded Armor': 'Стёганый доспех', "Painter's Supplies": 'Инструменты художника', 'Pan flute': 'Флейта Пана', 'Paper': 'Бумага', 'Paper (one sheet)': 'Бумага (1 лист)', 'Parchment': 'Пергамент',
    'Parchment (one sheet)': 'Пергамент (1 лист)', 'Perfume': 'Духи', 'Perfume (vial)': 'Духи (флакон)', "Pick, miner's": 'Кирка', 'Pike': 'Пика', 'Pistol': 'Пистолет', 'Piton': 'Крюк', 'Plate Armor': 'Латы',
    'Playing Card Set': 'Колода карт', 'Playing Cards': 'Игральные карты', 'Poison, Basic': 'Яд простой', 'Poison, basic (vial)': 'Яд простой (флакон)', "Poisoner's Kit": 'Набор отравителя', 'Pole': 'Шест',
    'Pole (10-foot)': 'Шест (10 футов)', 'Pony': 'Пони', 'Pot, Iron': 'Котелок железный', 'Pot, iron': 'Котелок железный', 'Potion of Healing': 'Зелье лечения', "Potter's Tools": 'Инструменты гончара', 'Pouch': 'Поясной кошель',
    "Priest's Pack": 'Набор священника', 'Quarterstaff': 'Боевой посох', 'Quiver': 'Колчан', 'Ram, Portable': 'Таран переносной', 'Ram, portable': 'Таран переносной', 'Rapier': 'Рапира', 'Rations': 'Рационы',
    'Rations (1 day)': 'Рационы (1 день)', 'Reliquary': 'Реликварий', 'Ring Mail': 'Колечный доспех', 'Robe': 'Роба', 'Robes': 'Роба', 'Rod': 'Жезл', 'Rope': 'Верёвка', 'Rope, hempen (50 feet)': 'Верёвка пеньковая (50 футов)',
    'Rope, silk (50 feet)': 'Верёвка шёлковая (50 футов)', 'Rowboat': 'Вёсельная лодка', 'Sack': 'Мешок', 'Saddle, Exotic': 'Седло экзотическое', 'Saddle, Military': 'Седло военное', 'Saddle, Pack': 'Седло вьючное',
    'Saddle, Riding': 'Седло верховое', 'Saddlebags': 'Седельные сумки', 'Sailing ship': 'Парусный корабль', 'Scale Mail': 'Чешуйчатый доспех', "Scale, merchant's": 'Весы торговые', "Scholar's Pack": 'Набор учёного',
    'Scimitar': 'Скимитар', 'Sealing wax': 'Сургуч', 'Shawm': 'Шалмей', 'Shield': 'Щит', 'Shortbow': 'Короткий лук', 'Shortsword': 'Короткий меч', 'Shovel': 'Лопата', 'Sickle': 'Серп', 'Signal Whistle': 'Свисток', 'Signal whistle': 'Свисток',
    'Signet ring': 'Перстень с печаткой', 'Sled': 'Сани', 'Sling': 'Праща', 'Sling bullet': 'Снаряд для пращи', 'Small knife': 'Ножик', "Smith's Tools": 'Инструменты кузнеца', 'Soap': 'Мыло', 'Spear': 'Копьё',
    'Spell Scroll, Cantrip': 'Свиток заклинания (заговор)', 'Spell Scroll, Level 1': 'Свиток заклинания (1 уровень)', 'Spellbook': 'Книга заклинаний', 'Spike, iron': 'Костыль железный', 'Spikes, Iron': 'Костыли железные',
    'Splint Armor': 'Наборный доспех', 'Sprig of Mistletoe': 'Веточка омелы', 'Sprig of mistletoe': 'Веточка омелы', 'Spyglass': 'Подзорная труба', 'Stabling (1 day)': 'Стойло (1 день)', 'Staff': 'Посох',
    'String': 'Бечёвка', 'String (10 feet)': 'Бечёвка (10 футов)', 'Studded Leather Armor': 'Проклёпанный кожаный доспех', 'Tent': 'Палатка', 'Tent, two-person': 'Палатка двухместная', "Thieves' Tools": 'Воровские инструменты',
    'Three-Dragon Ante': 'Три дракона', 'Tinderbox': 'Трутница', "Tinker's Tools": 'Инструменты ремонтника', 'Torch': 'Факел', 'Totem': 'Тотем', 'Trident': 'Трезубец', 'Vestments': 'Облачение', 'Vial': 'Флакон',
    'Viol': 'Виола', 'Wagon': 'Повозка', 'Wand': 'Волшебная палочка', 'War Pick': 'Боевая кирка', 'War pick': 'Боевая кирка', 'Warhammer': 'Боевой молот', 'Warhorse': 'Боевой конь', 'Warship': 'Военный корабль',
    'Waterskin': 'Бурдюк', "Weaver's Tools": 'Инструменты ткача', 'Whetstone': 'Точильный камень', 'Whip': 'Кнут', "Woodcarver's Tools": 'Инструменты резчика по дереву', 'Wooden staff': 'Деревянный посох',
    'Yew Wand': 'Тисовая палочка', 'Yew wand': 'Тисовая палочка',
}
BARDING = {'Breastplate': 'кираса', 'Chain mail': 'кольчуга', 'Chain shirt': 'кольчужная рубаха', 'Half plate': 'полулаты', 'Hide': 'шкурный', 'Leather': 'кожаный', 'Padded': 'стёганый', 'Plate': 'латы',
           'Ring mail': 'колечный', 'Scale mail': 'чешуйчатый', 'Splint': 'наборный', 'Studded Leather': 'проклёпанный кожаный'}


def equipment(name):
    if name in EQUIPMENT: return EQUIPMENT[name]
    m = re.match(r'^Barding: (.+)$', name)
    if m and m[1] in BARDING: return 'Конский доспех: ' + BARDING[m[1]]
    return None


MAGIC = {
    'Adamantine Armor': 'Адамантиновый доспех', 'Ammunition': 'Боеприпасы', 'Ammunition of Slaying': 'Боеприпас убийства', 'Amulet of Health': 'Амулет здоровья',
    'Amulet of Proof against Detection and Location': 'Амулет защиты от обнаружения и наблюдения', 'Amulet of the Planes': 'Амулет планов', 'Animated Shield': 'Оживлённый щит', 'Apparatus of the Crab': 'Аппарат Краба',
    'Armor': 'Доспех', 'Armor of Invulnerability': 'Доспех неуязвимости', 'Armor of Resistance': 'Доспех сопротивления', 'Armor of Vulnerability': 'Доспех уязвимости', 'Arrow of Slaying': 'Стрела убийства',
    'Arrow-Catching Shield': 'Щит, ловящий стрелы', 'Bag of Beans': 'Мешочек бобов', 'Bag of Devouring': 'Мешок пожирания', 'Bag of Holding': 'Сумка хранения', 'Bag of Tricks': 'Мешочек фокусов', 'Bead of Force': 'Бусина силы',
    'Belt of Dwarvenkind': 'Пояс дварфов', 'Belt of Giant Strength': 'Пояс силы великана', 'Berserker Axe': 'Топор берсерка', 'Boots of Elvenkind': 'Сапоги эльфов', 'Boots of Levitation': 'Сапоги левитации',
    'Boots of Speed': 'Сапоги скорости', 'Boots of Striding and Springing': 'Сапоги шага и прыжка', 'Boots of the Winterlands': 'Сапоги зимних земель', 'Bowl of Commanding Water Elementals': 'Чаша повелевания водными элементалями',
    'Bracers of Archery': 'Наручи лучника', 'Bracers of Defense': 'Наручи защиты', 'Brazier of Commanding Fire Elementals': 'Жаровня повелевания огненными элементалями', 'Brooch of Shielding': 'Брошь щита',
    'Broom of Flying': 'Летающая метла', 'Candle of Invocation': 'Свеча воззвания', 'Cape of the Mountebank': 'Плащ шарлатана', 'Carpet of Flying': 'Ковёр-самолёт', 'Censer of Controlling Air Elementals': 'Кадило управления воздушными элементалями',
    'Chime of Opening': 'Колокольчик открывания', 'Circlet of Blasting': 'Диадема взрыва', 'Cloak of Arachnida': 'Плащ арахниды', 'Cloak of Displacement': 'Плащ смещения', 'Cloak of Elvenkind': 'Плащ эльфов',
    'Cloak of Protection': 'Плащ защиты', 'Cloak of the Bat': 'Плащ летучей мыши', 'Cloak of the Manta Ray': 'Плащ ската', 'Crystal Ball': 'Хрустальный шар', 'Crystal Ball of Mind Reading': 'Хрустальный шар чтения мыслей',
    'Crystal Ball of Telepathy': 'Хрустальный шар телепатии', 'Crystal Ball of True Seeing': 'Хрустальный шар истинного зрения', 'Cube of Force': 'Куб силы', 'Cubic Gate': 'Кубические врата', 'Dagger of Venom': 'Кинжал яда',
    'Dancing Sword': 'Танцующий меч', 'Decanter of Endless Water': 'Графин бесконечной воды', 'Deck of Illusions': 'Колода иллюзий', 'Deck of Many Things': 'Колода многих вещей', 'Defender': 'Защитник', 'Demon Armor': 'Демонический доспех',
    'Dimensional Shackles': 'Пространственные кандалы', 'Dragon Orb': 'Драконья сфера', 'Dragon Scale Mail': 'Чешуйчатый доспех из драконьей чешуи', 'Dragon Slayer': 'Убийца драконов', 'Dust of Disappearance': 'Пыль исчезновения',
    'Dust of Dryness': 'Пыль сухости', 'Dust of Sneezing and Choking': 'Пыль чихания и удушья', 'Dwarven Plate': 'Дварфийские латы', 'Dwarven Thrower': 'Дварфийский метатель', 'Efficient Quiver': 'Вместительный колчан',
    'Efreeti Bottle': 'Бутылка ифрита', 'Elemental Gem': 'Самоцвет элементаля', 'Elven Chain': 'Эльфийская кольчуга', 'Eversmoking Bottle': 'Вечнодымящая бутылка', 'Eyes of Charming': 'Глаза очарования',
    'Eyes of Minute Seeing': 'Глаза мелкого зрения', 'Eyes of the Eagle': 'Глаза орла', 'Feather Token': 'Перьевой жетон', 'Figurine of Wondrous Power': 'Фигурка чудесной силы', 'Flame Tongue': 'Язык пламени',
    'Folding Boat': 'Складная лодка', 'Frost Brand': 'Ледяное клеймо', 'Gauntlets of Ogre Power': 'Рукавицы силы огра', 'Gem of Brightness': 'Самоцвет яркости', 'Gem of Seeing': 'Самоцвет зрения', 'Giant Slayer': 'Убийца великанов',
    'Glamoured Studded Leather': 'Зачарованный проклёпанный кожаный доспех', 'Glamoured Studded Leather Armor': 'Зачарованный проклёпанный кожаный доспех', 'Gloves of Missile Snaring': 'Перчатки ловли снарядов',
    'Gloves of Swimming and Climbing': 'Перчатки плавания и лазания', 'Goggles of Night': 'Очки ночи', 'Hammer of Thunderbolts': 'Молот громовержца', 'Handy Haversack': 'Удобный ранец', 'Hat of Disguise': 'Шляпа маскировки',
    'Headband of Intellect': 'Обруч интеллекта', 'Helm of Brilliance': 'Шлем блеска', 'Helm of Comprehending Languages': 'Шлем понимания языков', 'Helm of Telepathy': 'Шлем телепатии', 'Helm of Teleportation': 'Шлем телепортации',
    'Holy Avenger': 'Святой мститель', 'Horn of Blasting': 'Рог взрыва', 'Horn of Valhalla': 'Рог Вальхаллы', 'Horseshoes of Speed': 'Подковы скорости', 'Horseshoes of a Zephyr': 'Подковы зефира', 'Immovable Rod': 'Недвижимый жезл',
    'Instant Fortress': 'Мгновенная крепость', 'Ioun Stone': 'Камень Иоун', 'Iron Bands': 'Железные оковы', 'Iron Bands of Binding': 'Железные оковы связывания', 'Iron Flask': 'Железная фляга', 'Javelin of Lightning': 'Копьё молнии',
    'Lantern of Revealing': 'Фонарь раскрытия', 'Luck Blade': 'Клинок удачи', 'Mace of Disruption': 'Булава разрушения', 'Mace of Smiting': 'Булава кары', 'Mace of Terror': 'Булава ужаса', 'Mantle of Spell Resistance': 'Мантия сопротивления заклинаниям',
    'Manual of Bodily Health': 'Руководство по телесному здоровью', 'Manual of Clay Golems': 'Руководство по глиняным големам', 'Manual of Flesh Golems': 'Руководство по големам из плоти', 'Manual of Gainful Exercise': 'Руководство по полезным упражнениям',
    'Manual of Golems': 'Руководство по големам', 'Manual of Iron Golems': 'Руководство по железным големам', 'Manual of Quickness of Action': 'Руководство по быстроте действий', 'Manual of Stone Golems': 'Руководство по каменным големам',
    'Marvelous Pigments': 'Чудесные краски', 'Medallion of Thoughts': 'Медальон мыслей', 'Mirror of Life Trapping': 'Зеркало заточения жизни', 'Mithral Armor': 'Мифриловый доспех', 'Mysterious Deck': 'Таинственная колода',
    'Necklace of Adaptation': 'Ожерелье адаптации', 'Necklace of Fireballs': 'Ожерелье огненных шаров', 'Necklace of Prayer Beads': 'Ожерелье молитвенных бусин', 'Nine Lives Stealer': 'Похититель девяти жизней', 'Oathbow': 'Лук клятвы',
    'Oil of Etherealness': 'Масло эфирности', 'Oil of Sharpness': 'Масло остроты', 'Oil of Slipperiness': 'Масло скользкости', 'Orb of Dragonkind': 'Сфера драконов', 'Pearl of Power': 'Жемчужина силы', 'Periapt of Health': 'Ладанка здоровья',
    'Periapt of Proof against Poison': 'Ладанка защиты от яда', 'Periapt of Wound Closure': 'Ладанка закрытия ран', 'Philter of Love': 'Любовное зелье', 'Pipes of Haunting': 'Флейта наваждения', 'Pipes of the Sewers': 'Флейта канализации',
    'Plate Armor of Etherealness': 'Латы эфирности', 'Portable Hole': 'Переносная дыра', 'Potion of Animal Friendship': 'Зелье дружбы с животными', 'Potion of Clairvoyance': 'Зелье ясновидения', 'Potion of Climbing': 'Зелье лазания',
    'Potion of Diminution': 'Зелье уменьшения', 'Potion of Flying': 'Зелье полёта', 'Potion of Gaseous Form': 'Зелье газообразной формы', 'Potion of Giant Strength': 'Зелье силы великана', 'Potion of Greater Healing': 'Зелье большого лечения',
    'Potion of Growth': 'Зелье роста', 'Potion of Healing': 'Зелье лечения', 'Potions of Healing': 'Зелья лечения', 'Potion of Heroism': 'Зелье героизма', 'Potion of Invisibility': 'Зелье невидимости', 'Potion of Mind Reading': 'Зелье чтения мыслей',
    'Potion of Poison': 'Зелье яда', 'Potion of Resistance': 'Зелье сопротивления', 'Potion of Speed': 'Зелье скорости', 'Potion of Superior Healing': 'Зелье превосходного лечения', 'Potion of Supreme Healing': 'Зелье высшего лечения',
    'Potion of Water Breathing': 'Зелье подводного дыхания', 'Restorative Ointment': 'Восстанавливающая мазь', 'Ring of Animal Influence': 'Кольцо влияния на животных', 'Ring of Djinni Summoning': 'Кольцо призыва джинна',
    'Ring of Elemental Command': 'Кольцо повелевания элементалями', 'Ring of Evasion': 'Кольцо уклонения', 'Ring of Feather Falling': 'Кольцо падения пёрышком', 'Ring of Free Action': 'Кольцо свободы действий', 'Ring of Invisibility': 'Кольцо невидимости',
    'Ring of Jumping': 'Кольцо прыжков', 'Ring of Mind Shielding': 'Кольцо защиты разума', 'Ring of Protection': 'Кольцо защиты', 'Ring of Regeneration': 'Кольцо регенерации', 'Ring of Resistance': 'Кольцо сопротивления',
    'Ring of Shooting Stars': 'Кольцо падающих звёзд', 'Ring of Spell Storing': 'Кольцо хранения заклинаний', 'Ring of Spell Turning': 'Кольцо отражения заклинаний', 'Ring of Swimming': 'Кольцо плавания', 'Ring of Telekinesis': 'Кольцо телекинеза',
    'Ring of Three Wishes': 'Кольцо трёх желаний', 'Ring of Warmth': 'Кольцо тепла', 'Ring of Water Walking': 'Кольцо хождения по воде', 'Ring of X-ray Vision': 'Кольцо рентгеновского зрения', 'Ring of the Ram': 'Кольцо барана',
    'Robe of Eyes': 'Роба глаз', 'Robe of Scintillating Colors': 'Роба сверкающих цветов', 'Robe of Stars': 'Роба звёзд', 'Robe of Useful Items': 'Роба полезных вещей', 'Robe of the Archmagi': 'Роба архимагов', 'Rod of Absorption': 'Жезл поглощения',
    'Rod of Alertness': 'Жезл бдительности', 'Rod of Lordly Might': 'Жезл властной мощи', 'Rod of Rulership': 'Жезл правления', 'Rod of Security': 'Жезл безопасности', 'Rope of Climbing': 'Верёвка лазания', 'Rope of Entanglement': 'Верёвка опутывания',
    'Scarab of Protection': 'Скарабей защиты', 'Scimitar of Speed': 'Скимитар скорости', 'Shield': 'Щит', 'Shield of Missile Attraction': 'Щит притяжения снарядов', 'Slippers of Spider Climbing': 'Туфли паучьего лазания', 'Sovereign Glue': 'Универсальный клей',
    'Spell Scroll': 'Свиток заклинания', 'Spellguard Shield': 'Щит защиты от заклинаний', 'Sphere of Annihilation': 'Сфера аннигиляции', 'Staff of Charming': 'Посох очарования', 'Staff of Fire': 'Посох огня', 'Staff of Frost': 'Посох мороза',
    'Staff of Healing': 'Посох лечения', 'Staff of Power': 'Посох могущества', 'Staff of Striking': 'Посох ударов', 'Staff of Swarming Insects': 'Посох роя насекомых', 'Staff of Thunder and Lightning': 'Посох грома и молнии', 'Staff of Withering': 'Посох увядания',
    'Staff of the Magi': 'Посох магов', 'Staff of the Python': 'Посох питона', 'Staff of the Woodlands': 'Посох лесов', 'Stone of Controlling Earth Elementals': 'Камень управления земляными элементалями', 'Stone of Good Luck (Luckstone)': 'Камень удачи',
    'Sun Blade': 'Солнечный клинок', 'Sword of Life Stealing': 'Меч похищения жизни', 'Sword of Sharpness': 'Меч остроты', 'Sword of Wounding': 'Меч ранения', 'Talisman of Pure Good': 'Талисман чистого добра', 'Talisman of Ultimate Evil': 'Талисман абсолютного зла',
    'Talisman of the Sphere': 'Талисман сферы', 'Tome of Clear Thought': 'Том ясной мысли', 'Tome of Leadership and Influence': 'Том лидерства и влияния', 'Tome of Understanding': 'Том понимания', 'Trident of Fish Command': 'Трезубец повелевания рыбами',
    'Universal Solvent': 'Универсальный растворитель', 'Vicious Weapon': 'Злобное оружие', 'Vorpal Sword': 'Стрижающий меч', 'Wand of Binding': 'Палочка связывания', 'Wand of Enemy Detection': 'Палочка обнаружения врагов', 'Wand of Fear': 'Палочка страха',
    'Wand of Fireballs': 'Палочка огненных шаров', 'Wand of Lightning Bolts': 'Палочка молний', 'Wand of Magic Detection': 'Палочка обнаружения магии', 'Wand of Magic Missiles': 'Палочка волшебных стрел', 'Wand of Paralysis': 'Палочка паралича',
    'Wand of Polymorph': 'Палочка превращения', 'Wand of Secrets': 'Палочка тайн', 'Wand of Web': 'Палочка паутины', 'Wand of Wonder': 'Палочка чудес', 'Wand of the War Mage': 'Палочка боевого мага', 'Weapon': 'Оружие', 'Weapon of Warning': 'Оружие предупреждения',
    'Well of Many Worlds': 'Колодец многих миров', 'Wind Fan': 'Веер ветра', 'Winged Boots': 'Крылатые сапоги', 'Wings of Flying': 'Крылья полёта',
}
GIANTS = {'Cloud': 'облачного', 'Fire': 'огненного', 'Frost': 'ледяного', 'Hill': 'холмового', 'Stone': 'каменного', 'Storm': 'штормового'}
ELEMENTS = {'Air': 'воздуха', 'Earth': 'земли', 'Fire': 'огня', 'Water': 'воды'}
DMG = {'Acid': 'кислоте', 'Cold': 'холоду', 'Fire': 'огню', 'Force': 'силовому полю', 'Lightning': 'электричеству', 'Necrotic': 'некротической энергии', 'Poison': 'яду', 'Psychic': 'психической энергии', 'Radiant': 'излучению', 'Thunder': 'звуку'}
IOUN = {'Absorption': 'поглощения', 'Agility': 'ловкости', 'Awareness': 'бдительности', 'Fortitude': 'стойкости', 'Greater Absorption': 'большого поглощения', 'Insight': 'проницательности', 'Intellect': 'интеллекта', 'Leadership': 'лидерства',
        'Mastery': 'мастерства', 'Protection': 'защиты', 'Regeneration': 'регенерации', 'Reserve': 'запаса', 'Strength': 'силы', 'Sustenance': 'насыщения'}
FIGURINES = {'Bronze Griffon': 'бронзовый грифон', 'Ebony Fly': 'эбеновая муха', 'Golden Lions': 'золотые львы', 'Ivory Goats': 'костяные козлы', 'Marble Elephant': 'мраморный слон', 'Obsidian Steed': 'обсидиановый скакун',
             'Onyx Dog': 'ониксовый пёс', 'Serpentine Owl': 'серпентиновая сова', 'Silver Raven': 'серебряный ворон'}
TOKENS = {'Anchor': 'якорь', 'Bird': 'птица', 'Fan': 'веер', 'Swan Boat': 'лодка-лебедь', 'Tree': 'дерево', 'Whip': 'кнут'}
HORNS = {'Brass': 'латунный', 'Bronze': 'бронзовый', 'Iron': 'железный', 'Silver': 'серебряный'}
BAGS = {'Gray': 'серый', 'Rust': 'рыжий', 'Tan': 'бурый'}
ORD = {'1st': '1 уровень', '2nd': '2 уровень', '3rd': '3 уровень', '4th': '4 уровень', '5th': '5 уровень', '6th': '6 уровень', '7th': '7 уровень', '8th': '8 уровень', '9th': '9 уровень', 'Cantrip': 'заговор'}


def magic_item(name):
    if name in MAGIC: return MAGIC[name]
    m = re.match(r'^(Armor|Weapon|Shield|Ammunition)(?:,)? (\+\d(?:, \+\d, or \+\d)?)$', name)
    if m: return f"{MAGIC[m[1]]} {m[2].replace(', or ', ' или ').replace(', ', ', ')}"
    m = re.match(r'^Wand of the War Mage,? (\+.+)$', name)
    if m: return 'Палочка боевого мага ' + m[1].replace(', or ', ' или ')
    m = re.match(r'^(Belt|Potion) of (\w+) Giant Strength$', name)
    if m: return ('Пояс силы ' if m[1] == 'Belt' else 'Зелье силы ') + GIANTS[m[2]] + ' великана'
    m = re.match(r'^Potion of (\w+) Resistance$', name)
    if m and m[1] in DMG: return 'Зелье сопротивления ' + DMG[m[1]]
    m = re.match(r'^Ring of (\w+) Resistance$', name)
    if m and m[1] in DMG: return 'Кольцо сопротивления ' + DMG[m[1]]
    m = re.match(r'^Ring of (\w+) Elemental Command$', name)
    if m: return 'Кольцо повелевания элементалями ' + ELEMENTS[m[1]]
    m = re.match(r'^(\w+) Elemental Gem$', name)
    if m: return 'Самоцвет элементаля ' + ELEMENTS[m[1]]
    m = re.match(r'^Ioun Stone of (.+)$', name)
    if m and m[1] in IOUN: return 'Камень Иоун ' + IOUN[m[1]]
    m = re.match(r'^(.+) Figurine of Wondrous Power$', name)
    if m and m[1] in FIGURINES: return 'Фигурка чудесной силы: ' + FIGURINES[m[1]]
    m = re.match(r'^(.+) Feather Token$', name)
    if m and m[1] in TOKENS: return 'Перьевой жетон: ' + TOKENS[m[1]]
    m = re.match(r'^(\w+) Horn of Valhalla$', name)
    if m: return 'Рог Вальхаллы (' + HORNS[m[1]] + ')'
    m = re.match(r'^(\w+) Bag of Tricks$', name)
    if m: return 'Мешочек фокусов (' + BAGS[m[1]] + ')'
    m = re.match(r'^(\w+) Dragon Scale Mail$', name)
    if m and m[1] in COLORS: return 'Чешуйчатый доспех из чешуи: ' + COLORS[m[1]].lower() + ' дракон'
    m = re.match(r'^Spell Scroll \((.+)\)$', name)
    if m and m[1] in ORD: return 'Свиток заклинания (' + ORD[m[1]] + ')'
    m = re.match(r'^Carpet of Flying \((.+)\)$', name)
    if m: return 'Ковёр-самолёт (' + m[1].replace('ft.', 'фт') + ')'
    return None


CLASSES = {'Barbarian': 'Варвар', 'Bard': 'Бард', 'Cleric': 'Жрец', 'Druid': 'Друид', 'Fighter': 'Воин', 'Monk': 'Монах', 'Paladin': 'Паладин', 'Ranger': 'Следопыт', 'Rogue': 'Плут', 'Sorcerer': 'Чародей', 'Warlock': 'Колдун', 'Wizard': 'Волшебник'}
SUBCLASSES = {'Berserker': 'Путь Берсерка', 'Lore': 'Коллегия Знаний', 'Life': 'Домен Жизни', 'Land': 'Круг Земли', 'Champion': 'Чемпион', 'Open Hand': 'Путь Открытой Ладони', 'Devotion': 'Клятва Преданности', 'Hunter': 'Охотник',
              'Thief': 'Вор', 'Draconic': 'Драконья Родословная', 'Fiend': 'Исчадие', 'Evocation': 'Школа Воплощения',
              'Path of the Berserker': 'Путь Берсерка', 'College of Lore': 'Коллегия Знаний', 'Life Domain': 'Домен Жизни', 'Circle of the Land': 'Круг Земли', 'Way of the Open Hand': 'Путь Открытой Ладони',
              'Oath of Devotion': 'Клятва Преданности', 'Draconic Sorcery': 'Драконье Чародейство', 'Draconic Bloodline': 'Драконья Родословная', 'Fiend Patron': 'Покровитель — Исчадие', 'The Fiend': 'Исчадие', 'Evoker': 'Воплотитель', 'School of Evocation': 'Школа Воплощения'}
RACES = {'Dragonborn': 'Драконорождённый', 'Dwarf': 'Дварф', 'Elf': 'Эльф', 'Gnome': 'Гном', 'Half-Elf': 'Полуэльф', 'Half-Orc': 'Полуорк', 'Halfling': 'Полурослик', 'Human': 'Человек', 'Tiefling': 'Тифлинг', 'Orc': 'Орк', 'Goliath': 'Голиаф', 'Aasimar': 'Аасимар',
         'Hill Dwarf': 'Холмовой дварф', 'High Elf': 'Высший эльф', 'Wood Elf': 'Лесной эльф', 'Drow': 'Дроу', 'Rock Gnome': 'Скальный гном', 'Forest Gnome': 'Лесной гном', 'Deep Gnome': 'Глубинный гном', 'Lightfoot': 'Легконогий', 'Lightfoot Halfling': 'Легконогий полурослик', 'Stout': 'Коренастый', 'Stout Halfling': 'Коренастый полурослик',
         'Black Dragonborn': 'Драконорождённый (чёрный)', 'Blue Dragonborn': 'Драконорождённый (синий)', 'Brass Dragonborn': 'Драконорождённый (латунный)', 'Bronze Dragonborn': 'Драконорождённый (бронзовый)', 'Copper Dragonborn': 'Драконорождённый (медный)',
         'Gold Dragonborn': 'Драконорождённый (золотой)', 'Green Dragonborn': 'Драконорождённый (зелёный)', 'Red Dragonborn': 'Драконорождённый (красный)', 'Silver Dragonborn': 'Драконорождённый (серебряный)', 'White Dragonborn': 'Драконорождённый (белый)',
         'Cloud Giant Goliath': 'Голиаф (облачный)', 'Fire Giant Goliath': 'Голиаф (огненный)', 'Frost Giant Goliath': 'Голиаф (ледяной)', 'Hill Giant Goliath': 'Голиаф (холмовой)', 'Stone Giant Goliath': 'Голиаф (каменный)', 'Storm Giant Goliath': 'Голиаф (штормовой)',
         'Elven Lineage: Drow': 'Эльфийская линия: дроу', 'Elven Lineage: High Elf': 'Эльфийская линия: высший эльф', 'Elven Lineage: Wood Elf': 'Эльфийская линия: лесной эльф',
         'Gnomish Lineage: Forest Gnome': 'Гномья линия: лесной гном', 'Gnomish Lineage: Rock Gnome': 'Гномья линия: скальный гном', "Giant Ancestry: Cloud's Jaunt": 'Наследие великанов: прыжок облачного', "Giant Ancestry: Fire's Burn": 'Наследие великанов: ожог огненного',
         "Giant Ancestry: Frost's Chill": 'Наследие великанов: холод ледяного', "Giant Ancestry: Hill's Tumble": 'Наследие великанов: бросок холмового', "Giant Ancestry: Stone's Endurance": 'Наследие великанов: стойкость каменного', "Giant Ancestry: Storm's Thunder": 'Наследие великанов: гром штормового',
         'Fiendish Legacy: Abyssal': 'Наследие исчадий: бездна', 'Fiendish Legacy: Chthonic': 'Наследие исчадий: хтоническое', 'Fiendish Legacy: Infernal': 'Наследие исчадий: инфернальное',
         'Abyssal Tiefling': 'Тифлинг (бездна)', 'Chthonic Tiefling': 'Тифлинг (хтонический)', 'Infernal Tiefling': 'Тифлинг (инфернальный)', 'Mountain Dwarf': 'Горный дварф', **{f'Draconic Ancestor: {k}': f'Драконий предок: {v.lower()}' for k, v in COLORS.items()}}
BACKGROUNDS = {'Acolyte': 'Прислужник', 'Criminal': 'Преступник', 'Sage': 'Мудрец', 'Soldier': 'Солдат', 'Charlatan': 'Шарлатан', 'Entertainer': 'Артист', 'Folk Hero': 'Народный герой', 'Guild Artisan': 'Гильдейский ремесленник',
               'Hermit': 'Отшельник', 'Noble': 'Благородный', 'Outlander': 'Чужеземец', 'Sailor': 'Моряк', 'Urchin': 'Беспризорник'}
FEATS = {'Grappler': 'Борец', 'Alert': 'Бдительный', 'Magic Initiate': 'Посвящённый в магию', 'Savage Attacker': 'Свирепый атакующий', 'Skilled': 'Умелый', 'Ability Score Improvement': 'Увеличение характеристик', 'Archery': 'Стрельба',
         'Defense': 'Оборона', 'Dueling': 'Дуэлянт', 'Great Weapon Fighting': 'Бой большим оружием', 'Two-Weapon Fighting': 'Бой двумя оружиями', 'Two Weapon Fighting': 'Бой двумя оружиями', 'Tough': 'Крепкий', 'Lucky': 'Везучий', 'Musician': 'Музыкант', 'Tavern Brawler': 'Драчун', 'Crafter': 'Ремесленник',
         'Boon of Combat Prowess': 'Дар боевой доблести', 'Boon of Dimensional Travel': 'Дар пространственных странствий', 'Boon of Energy Resistance': 'Дар сопротивления энергии', 'Boon of Fate': 'Дар судьбы', 'Boon of Fortitude': 'Дар стойкости',
         'Boon of Irresistible Offense': 'Дар неотразимого натиска', 'Boon of Recovery': 'Дар восстановления', 'Boon of Skill': 'Дар умений', 'Boon of Speed': 'Дар скорости', 'Boon of Spell Recall': 'Дар воспоминания заклинаний', 'Boon of the Night Spirit': 'Дар ночного духа',
         'Boon of Truesight': 'Дар истинного зрения', 'Blind Fighting': 'Слепой бой', 'Interception': 'Перехват', 'Thrown Weapon Fighting': 'Бой метательным оружием', 'Unarmed Fighting': 'Безоружный бой'}
CONDITIONS = {'Blinded': 'Ослеплённый', 'Charmed': 'Очарованный', 'Deafened': 'Оглохший', 'Exhaustion': 'Истощение', 'Frightened': 'Испуганный', 'Grappled': 'Схваченный', 'Incapacitated': 'Недееспособный', 'Invisible': 'Невидимый',
              'Paralyzed': 'Парализованный', 'Petrified': 'Окаменевший', 'Poisoned': 'Отравленный', 'Prone': 'Сбитый с ног', 'Restrained': 'Опутанный', 'Stunned': 'Ошеломлённый', 'Unconscious': 'Бессознательный'}

SCHOOLS = {'Abjuration': 'Ограждение', 'Conjuration': 'Вызов', 'Divination': 'Прорицание', 'Enchantment': 'Очарование', 'Evocation': 'Воплощение', 'Illusion': 'Иллюзия', 'Necromancy': 'Некромантия', 'Transmutation': 'Преобразование'}
SIZES = {'Tiny': 'Крошечный', 'Small': 'Маленький', 'Medium': 'Средний', 'Large': 'Большой', 'Huge': 'Огромный', 'Gargantuan': 'Громадный'}
MTYPES = {'aberration': 'аберрация', 'beast': 'зверь', 'celestial': 'небожитель', 'construct': 'конструкт', 'dragon': 'дракон', 'elemental': 'элементаль', 'fey': 'фея', 'fiend': 'исчадие', 'giant': 'великан', 'humanoid': 'гуманоид',
          'monstrosity': 'чудовище', 'ooze': 'слизь', 'plant': 'растение', 'undead': 'нежить', 'swarm of Tiny beasts': 'рой крошечных зверей', 'swarm': 'рой'}
ALIGN = {'lawful good': 'законно-добрый', 'neutral good': 'нейтрально-добрый', 'chaotic good': 'хаотично-добрый', 'lawful neutral': 'законно-нейтральный', 'neutral': 'нейтральный', 'true neutral': 'истинно нейтральный', 'chaotic neutral': 'хаотично-нейтральный',
         'lawful evil': 'законно-злой', 'neutral evil': 'нейтрально-злой', 'chaotic evil': 'хаотично-злой', 'unaligned': 'без мировоззрения', 'any alignment': 'любое', 'any evil alignment': 'любое злое', 'any non-good alignment': 'любое недоброе',
         'any non-lawful alignment': 'любое незаконное', 'any chaotic alignment': 'любое хаотичное'}
ABIL = {'STR': 'СИЛ', 'DEX': 'ЛОВ', 'CON': 'ТЕЛ', 'INT': 'ИНТ', 'WIS': 'МДР', 'CHA': 'ХАР'}
SKILLS = {'Acrobatics': 'Акробатика', 'Animal Handling': 'Уход за животными', 'Arcana': 'Магия', 'Athletics': 'Атлетика', 'Deception': 'Обман', 'History': 'История', 'Insight': 'Проницательность', 'Intimidation': 'Запугивание',
          'Investigation': 'Анализ', 'Medicine': 'Медицина', 'Nature': 'Природа', 'Perception': 'Восприятие', 'Performance': 'Выступление', 'Persuasion': 'Убеждение', 'Religion': 'Религия', 'Sleight of Hand': 'Ловкость рук', 'Stealth': 'Скрытность', 'Survival': 'Выживание'}
DMG_TYPES = {'acid': 'кислота', 'bludgeoning': 'дробящий', 'cold': 'холод', 'fire': 'огонь', 'force': 'силовое поле', 'lightning': 'электричество', 'necrotic': 'некротический', 'piercing': 'колющий', 'poison': 'яд', 'psychic': 'психический',
             'radiant': 'излучение', 'slashing': 'рубящий', 'thunder': 'звук'}
WPROPS = {'Ammunition': 'боеприпас', 'Finesse': 'фехтовальное', 'Heavy': 'тяжёлое', 'Light': 'лёгкое', 'Loading': 'перезарядка', 'Range': 'дальнобойное', 'Reach': 'досягаемость', 'Special': 'особое', 'Thrown': 'метательное', 'Two-Handed': 'двуручное',
          'Versatile': 'универсальное', 'Monk': 'монашеское'}
