// ---------------------------------------------------------------------------
// asset-kinds.js — реестр типов ассетов (карта, токен, объект, портрет, предмет).
// Единственный источник для подписей, списков выбора, слоя на столе и размера картинки на клиенте.
// Серверный список — ASSET_KINDS в src/assets.rs; tests/asset-kinds.test.cjs сверяет оба списка.
// Чтобы добавить тип: строка здесь + строка в ASSET_KINDS. Логику менять не нужно.
// Даёт: window.AssetKinds.
// ---------------------------------------------------------------------------
window.AssetKinds = (() => {
  const KINDS = [
    // layer — слой стола, куда кладётся ассет; picker — показывать в списках выбора; square — квадратная раскладка на столе.
    // usage — для какого действия тип применяется по умолчанию: scene (карта), token (загрузка токена и умолчание),
    // object (объект на столе), avatar (портрет персонажа и аватар игрока), item (картинка предмета).
    { id: 'map', label: 'Карта', plural: 'Карты', layer: 'map', picker: true, square: false, usage: 'scene' },
    { id: 'token', label: 'Токен', plural: 'Токены', layer: 'character', picker: true, square: false, usage: 'token', default: true },
    { id: 'prop', label: 'Объект', plural: 'Объекты', layer: 'prop', picker: true, square: true, usage: 'object' },
    { id: 'portrait', label: 'Портрет', plural: 'Портреты', layer: 'character', picker: true, square: false, usage: 'avatar' },
    { id: 'item', label: 'Предмет', plural: 'Предметы', layer: 'character', picker: false, square: false, usage: 'item' },
  ];
  const byId = Object.fromEntries(KINDS.map(kind => [kind.id, kind]));
  // Неизвестный тип с сервера трактуется как токен (так же, как на сервере при загрузке).
  const DEFAULT = KINDS.find(kind => kind.default) || KINDS[0];
  const get = id => byId[id] || DEFAULT;
  // Тип для действия (usage). Нет такого действия — тип по умолчанию. Код не называет типы напрямую.
  const forUsage = usage => (KINDS.find(kind => kind.usage === usage) || DEFAULT).id;
  // Тип для слоя стола: первый тип, который кладётся на этот слой (слой map → карта, character → токен).
  const kindForLayer = layer => (KINDS.find(kind => kind.layer === layer) || DEFAULT).id;
  const pickers = () => KINDS.filter(kind => kind.picker);
  return {
    KINDS,
    ids: KINDS.map(kind => kind.id),
    get,
    label: id => get(id).label,
    layerOf: id => get(id).layer,
    DEFAULT: DEFAULT.id,
    forUsage,
    kindForLayer,
    // [значение, подпись] для <select> фильтра: «Все типы» + типы с picker.
    filterOptions: () => [['', 'Все типы'], ...pickers().map(kind => [kind.id, kind.plural])],
    // [значение, подпись] для <select> загрузки.
    uploadOptions: () => pickers().map(kind => [kind.id, kind.label]),
  };
})();
