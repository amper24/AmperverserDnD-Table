# Права и доступ

Один источник правды — `src/domain/access.rs`: возможности (capabilities), роли и проверки.
Сервер проверяет их на каждом HTTP-эндпоинте и на каждом сообщении WebSocket;
клиент получает готовый список прав в ответе кампании и только показывает/скрывает
кнопки (`static/access.js`, `Access.can`).

## Возможности

| Возможность | Что разрешает |
|---|---|
| `campaign.read` | видеть кампанию, участников, чат, страницу участников |
| `campaign.manage_members` | менять роль участника, исключать участников |
| `campaign.manage_characters` | мастерские операции с персонажами: перенос чужого персонажа в другую кампанию / отвязка от кампании |
| `campaign.invite` | создавать, смотреть и удалять ссылки-приглашения |
| `character.read_own` | читать свои листы персонажей |
| `character.read_shared` | читать чужие листы, если владелец поставил `sheet.shared` |
| `character.edit_own` | создавать и править свои листы (в т.ч. в кампании) |
| `character.edit_any` | читать и править любые листы кампании (мастер) |
| `table.read` | видеть сцену, токены, чат стола (в т.ч. подключиться к WS) |
| `table.place_character` | ставить на стол токен своего персонажа |
| `table.place_any_character` | ставить на стол любого персонажа и NPC/монстров |
| `table.move_own_token` | двигать/удалять свои токены и подбирать лут |
| `table.move_any_token` | двигать/удалять любые элементы сцены, раскладывать слои |
| `table.manage_scene` | создавать/менять/удалять сцены, сетку, слои, активную карту |
| `table.manage_fog` | менять туман войны |
| `table.manage_members_tokens` | назначать владельца любого токена, скрывать его от игроков |

## Роли

* `gm` — мастер: все 16 возможностей.
* `player` — игрок: `campaign.read`, `character.read_own`, `character.read_shared`,
  `character.edit_own`, `table.read`, `table.place_character`, `table.move_own_token`.
* Посторонний (нет строки в `campaign_members`, неизвестная роль в БД) — ничего:
  любой доступ к кампании даёт 403.

Матрица (✔ — есть):

| Возможность | gm | player | посторонний |
|---|:--:|:--:|:--:|
| `campaign.read` | ✔ | ✔ | — |
| `campaign.manage_members` | ✔ | — | — |
| `campaign.manage_characters` | ✔ | — | — |
| `campaign.invite` | ✔ | — | — |
| `character.read_own` | ✔ | ✔ | — |
| `character.read_shared` | ✔ | ✔ | — |
| `character.edit_own` | ✔ | ✔ | — |
| `character.edit_any` | ✔ | — | — |
| `table.read` | ✔ | ✔ | — |
| `table.place_character` | ✔ | ✔ | — |
| `table.place_any_character` | ✔ | — | — |
| `table.move_own_token` | ✔ | ✔ | — |
| `table.move_any_token` | ✔ | — | — |
| `table.manage_scene` | ✔ | — | — |
| `table.manage_fog` | ✔ | — | — |
| `table.manage_members_tokens` | ✔ | — | — |

Правила, которые не вынесены в отдельную возможность:

* владельца кампании нельзя разжаловать и исключить (сервер отвечает 400);
* из кампании можно выйти самому (`DELETE /members/:uid` для себя) — право
  `manage_members` нужно только для исключения другого;
* чужой лист без `shared` не читается и не правится (403), `shared` даёт только
  чтение;
* скрытые элементы сцены (`data.hidden`) игроку не отдаются и не рассылаются.

## Как клиент узнаёт права

`GET /api/campaigns` и `GET /api/campaigns/:cid` возвращают:

```json
{ "id": "…", "role": "gm", "permissions": ["campaign.read", "campaign.manage_members", "…"] }
```

* `role` — для бейджа («Мастер»/«Игрок»), `permissions` — для `Access.can()`.
* `src/domain/access.rs` — эталон; `static/access.js` — зеркало тех же строк для UI
  (тест `tests/access.test.cjs` сверяет списки и ловит расхождение).
* Сообщение об отказе по WS — `{ "type": "error", "code": "forbidden", "message": "…" }`;
  по HTTP — `403 {"detail": "Недостаточно прав: <возможность>"}`.

## HTTP-эндпоинты

| Метод и путь | Возможность | Примечание |
|---|---|---|
| `GET /api/campaigns` | — | только свои кампании (`role` + `permissions` в каждом) |
| `POST /api/campaigns` | — | создатель становится `gm` |
| `GET /api/campaigns/:cid` | `campaign.read` | участники; email видят только мастера |
| `PATCH /api/campaigns/:cid` | `gm` | переименование — только мастер |
| `DELETE /api/campaigns/:cid` | владелец | |
| `POST /api/campaigns/:cid/active-scene` | `table.manage_scene` | |
| `GET/POST /api/campaigns/:cid/invites` | `campaign.invite` | |
| `DELETE /api/campaigns/:cid/invites/:code` | `campaign.invite` | |
| `PATCH/DELETE /api/campaigns/:cid/members/:uid` | `campaign.manage_members` | исключить себя можно без права |
| `GET /api/campaigns/:cid/chat` | `campaign.read` | скрытые броски — только автору и мастеру |
| `GET /api/characters?campaign_id=…` | `character.read_own` | мастер — все, игрок — свои и `shared` |
| `GET /api/characters/:id` | владелец / `character.edit_any` / `character.read_shared`+`shared` | |
| `PATCH /api/characters/:id` | владелец / `character.edit_any` | перенос чужого — ещё и `campaign.manage_characters` |
| `DELETE /api/characters/:id` | владелец / `character.edit_any` | |
| `POST /api/characters` | `character.edit_own` (если указана кампания) | |
| `POST /api/characters/:id/inventory` | владелец / `character.edit_any` | `gm_only`-действия — только `character.edit_any` |
| `GET /api/campaigns/:cid/scenes` | `table.read` | |
| `GET /api/campaigns/:cid/scenes/:sid` | `table.read` | скрытые элементы не отдаются игроку |
| `POST/PATCH/DELETE …/scenes[/:sid]` | `table.manage_scene` | дубликат сцены — тоже |
| `WS /ws/:cid` | `table.read` | иначе 403 до upgrade |

## WebSocket-сообщения

| Сообщение | Мастер | Игрок | Посторонний |
|---|---|---|---|
| `chat`, `card`, `roll`, `multi` | ✔ | ✔ | нет соединения |
| `pointer`, `ruler`, `cursor`, `ping` | ✔ | ✔ | нет соединения |
| `item_upsert` (новый элемент) | любой слой | только свои токены/рисунки/надписи и лут (`table.place_character`) | — |
| `item_upsert` (существующий) | полная замена (`table.move_any_token`), кроме физического лута | только игровые поля своего токена (`x`, `y`, `rotation`, `hp`, `conditions`, `attachments`, `dead`); лут и «соавторы» токена — тоже | — |
| `item_delete` | любой элемент | свой токен, лут, «соавтор» | — |
| `items_bulk` | ✔ (`table.move_any_token`) | — | — |
| `scene_update` (сцена, сетка, имя, слои, активная карта) | ✔ (`table.manage_scene`) | — | — |
| `scene_update` с `fog` | ✔ (`table.manage_fog`) | — | — |
| `initiative` | ✔ | — | — |

Детали:

* Игрок не может поставить токен с чужим `character_id`: сервер сверяет
  `characters.owner_id` с автором (мастеру проверка не нужна).
* Игрок не может присвоить чужой токен: `owner_id` не входит в список полей,
  которые ему разрешено менять, а при создании чужой `owner_id` отклоняется.
* Нарушение не меняет состояние: сначала проверка, потом запись; отказ уходит
  только нарушителю (`type: "error"`), остальные не получают ни события, ни
  частичных изменений.

## Присутствие

`presence` в комнате кампании — **один участник = одна запись**, сколько бы
вкладок/соединений у него ни было:

```json
{ "type": "presence", "users": [ { "user_id": "…", "name": "Мастер", "role": "gm", "connections": 2 } ] }
```

`Hub` хранит соединения по `conn_id`, а `presence()` схлопывает их по `user_id`
(порядок — по времени подключения) и считает `connections`. Запись исчезает,
когда закрылось последнее соединение; переподключение не добавляет вторую строку.
Клиент (`app.js`, страница участников) дополнительно дедуплицирует по `user_id`.

## Тесты

* `cargo test` — `access::tests` (матрица роль×возможность, `require`,
  `item_write`, `can_create_item`, дубликаты и JSON), `realtime::presence_tests`
  (дедупликация присутствия и счётчик соединений).
* `node --test tests/access.test.cjs` — `can()`/гейтинг и сверка `static/access.js`
  с `src/domain/access.rs` (нет дрейфа UI и сервера).
* `tests/table-page.browser.cjs` — участники-аккаунты, «На стол» для чужого
  персонажа у мастера и недоступность у игрока, роль/исключение/приглашение.
* `scripts/smoke.sh` — 403 игроку на участниках, приглашениях, сценах, тумане,
  чужом персонаже; мастер ставит чужого персонажа и правит его лист; присутствие
  без дублей (`[4e]`, `[5c]`).
