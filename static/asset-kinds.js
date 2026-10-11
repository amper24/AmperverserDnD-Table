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
    // object (объект на столе), avatar (портрет персонажа и аватар игрока), item (картинка предмета), cover (обложка набора).
    { id: 'map', label: 'Карта', plural: 'Карты', layer: 'map', picker: true, square: false, usage: 'scene' },
    { id: 'token', label: 'Токен', plural: 'Токены', layer: 'character', picker: true, square: false, usage: 'token', default: true },
    { id: 'prop', label: 'Объект', plural: 'Объекты', layer: 'prop', picker: true, square: true, usage: 'object' },
    { id: 'portrait', label: 'Портрет', plural: 'Портреты', layer: 'character', picker: true, square: false, usage: 'avatar' },
    { id: 'item', label: 'Предмет', plural: 'Предметы', layer: 'character', picker: false, square: false, usage: 'item' },
    // cover — обложка набора; на стол не кладётся (layer только для совместимости с layerOf).
    { id: 'cover', label: 'Обложка', plural: 'Обложки', layer: 'character', picker: true, square: false, usage: 'cover', table: false },
  ];
  // Слои стола: имена, которыми ассеты и объекты попадают на сцену. Порядок отрисовки — layerOrder (нижние первыми).
  const LAYER = { map: 'map', prop: 'prop', mount: 'mount', character: 'character', attachment: 'attachment', drawing: 'drawing', text: 'text', note: 'note' };
  const layerOrder = ['map', 'prop', 'mount', 'character', 'attachment', 'drawing', 'text', 'note'];
  const byId = Object.fromEntries(KINDS.map(kind => [kind.id, kind]));
  // Неизвестный тип с сервера трактуется как токен (так же, как на сервере при загрузке).
  const DEFAULT = KINDS.find(kind => kind.default) || KINDS[0];
  const get = id => byId[id] || DEFAULT;
  // Тип для действия (usage). Нет такого действия — тип по умолчанию. Код не называет типы напрямую.
  const forUsage = usage => (KINDS.find(kind => kind.usage === usage) || DEFAULT).id;
  // Тип для слоя стола: первый тип, который кладётся на этот слой (слой map → карта, character → токен).
  const kindForLayer = layer => (KINDS.find(kind => kind.layer === layer) || DEFAULT).id;
  const pickers = () => KINDS.filter(kind => kind.picker);
  // Виды для панели ресурсов стола: выбираемые и не помеченные table: false (обложки на стол не кладутся).
  const tableOptions = () => pickers().filter(kind => kind.table !== false).map(kind => [kind.id, kind.plural]);
  // Какие виды показывать в выборе картинки для вида kind (библиотека ресурсов, «Из библиотеки»).
  // Токен — только токены; предмет — любые картинки, кроме карт (карта занимает всю сцену); остальные — свой вид.
  const pickFor = kind => {
    const id = get(kind).id;
    return id === 'item' ? KINDS.filter(k => k.id !== 'map').map(k => k.id) : [id];
  };
  return {
    KINDS,
    LAYER,
    layerOrder,
    ids: KINDS.map(kind => kind.id),
    get,
    label: id => get(id).label,
    layerOf: id => get(id).layer,
    DEFAULT: DEFAULT.id,
    forUsage,
    kindForLayer,
    pickFor,
    // [значение, подпись] для <select> фильтра: «Все типы» + типы с picker.
    filterOptions: () => [['', 'Все типы'], ...pickers().map(kind => [kind.id, kind.plural])],
    // [значение, подпись] для <select> загрузки.
    uploadOptions: () => pickers().map(kind => [kind.id, kind.label]),
    // [значение, подпись] для панели ресурсов стола (без «Все типы»).
    tableOptions,
  };
})();
