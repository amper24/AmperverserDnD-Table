#!/usr/bin/env bash
# Сквозной smoke-тест API: запускает бинарник, проходит сценарий мастер/игрок, проверяет ответы.
set -euo pipefail
BIN="${1:-target/release/dnd-table}"
export PORT="${PORT:-8099}" HOST=127.0.0.1 DEV_SHOW_CODE=true
B="http://127.0.0.1:$PORT"
"$BIN" > server.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; echo "--- server.log ---"; tail -n 40 server.log' EXIT
trap 'echo "!!! SMOKE FAILED at line $LINENO: $BASH_COMMAND"' ERR
for i in $(seq 1 60); do curl -fs "$B/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fs "$B/api/health" | grep -q '"ok":true'
J() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

login() { # $1 email, $2 name -> prints token (регистрация с паролем + подтверждение почты)
  code=$(curl -fs -X POST "$B/api/auth/register" -H 'content-type: application/json' -d "{\"email\":\"$1\",\"password\":\"secret123\",\"name\":\"$2\"}" | J "d['dev_code']")
  curl -fs -X POST "$B/api/auth/verify" -H 'content-type: application/json' -d "{\"email\":\"$1\",\"code\":\"$code\"}" | J "d['token']"
}
echo "[0] авторизация: регистрация, пароль, сброс"
GM=$(login gm@test.ru Мастер); PL=$(login pl@test.ru Игрок)
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/auth/login" -H 'content-type: application/json' -d '{"email":"gm@test.ru","password":"wrong"}'); [ "$code" = "400" ]
curl -fs -X POST "$B/api/auth/login" -H 'content-type: application/json' -d '{"email":"gm@test.ru","password":"secret123"}' | J "d['user']['name']" | grep -q Мастер
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/auth/register" -H 'content-type: application/json' -d '{"email":"gm@test.ru","password":"secret123"}'); [ "$code" = "400" ]   # повторная регистрация
rc=$(curl -fs -X POST "$B/api/auth/request-code" -H 'content-type: application/json' -d '{"email":"pl@test.ru"}' | J "d['dev_code']")
curl -fs -X POST "$B/api/auth/reset-password" -H 'content-type: application/json' -d "{\"email\":\"pl@test.ru\",\"code\":\"$rc\",\"password\":\"newpass123\"}" | J "d['ok']" | grep -q True
curl -fs -X POST "$B/api/auth/login" -H 'content-type: application/json' -d '{"email":"pl@test.ru","password":"newpass123"}' | J "d['ok']" | grep -q True
curl -fs -H "Authorization: Bearer $PL" "$B/api/auth/me" | J "d['name']" | grep -q Игрок   # Bearer-токен работает
curl -fs "$B/api/auth/verify?x" -X POST -H 'content-type: application/json' -d '{"email":"nobody@test.ru","code":"1"}' >/dev/null 2>&1 && exit 1 || true
gm() { curl -fsS -H "Authorization: Bearer $GM" "$@" || { echo "!!! gm request failed: $*" >&2; curl -s -H "Authorization: Bearer $GM" "$@" >&2; echo >&2; return 1; }; }
pl() { curl -fsS -H "Authorization: Bearer $PL" "$@" || { echo "!!! pl request failed: $*" >&2; curl -s -H "Authorization: Bearer $PL" "$@" >&2; echo >&2; return 1; }; }

echo "[1] кампания + приглашение"
CAMP=$(gm -X POST "$B/api/campaigns" -H 'content-type: application/json' -d '{"name":"Тест"}')
CID=$(echo "$CAMP" | J "d['id']"); SID=$(echo "$CAMP" | J "d['active_scene_id']")
CODE=$(gm -X POST "$B/api/campaigns/$CID/invites" -H 'content-type: application/json' -d '{"role":"player"}' | J "d['code']")
pl -X POST "$B/api/join/$CODE" | grep -q '"ok":true'
[ "$(pl "$B/api/campaigns/$CID" | J "d['role']")" = "player" ]
[ "$(gm "$B/api/campaigns/$CID" | J "len(d['members'])")" = "2" ]

echo "[2] справочник"
[ "$(gm "$B/api/compendium?category=race&edition=2014" | J "len(d)")" = "13" ]
[ "$(gm "$B/api/compendium?category=class&edition=2024" | J "len(d)")" = "12" ]
[ "$(gm "$B/api/compendium?category=spell&edition=2014&limit=3000" | J "len(d)")" = "319" ]
gm "$B/api/compendium?q=fireball" | J "[e['name'] for e in d]" | grep "Огненный шар" >/dev/null
gm "$B/api/compendium?q=меч" | J "[e['name'] for e in d]" | grep "Длинный меч" >/dev/null
HB=$(gm -X POST "$B/api/compendium" -H 'content-type: application/json' -d "{\"category\":\"item\",\"name\":\"Меч Ампера\",\"campaign_id\":\"$CID\",\"data\":{\"type\":\"magic\"}}" | J "d['source']")
[ "$HB" = "Homebrew" ]
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $PL" -X POST "$B/api/compendium" -H 'content-type: application/json' -d "{\"category\":\"item\",\"name\":\"x\",\"campaign_id\":\"$CID\",\"data\":{}}")
[ "$code" = "403" ]

echo "[3] ассеты (встроенные + загрузка + распаковка)"
[ "$(gm "$B/api/assets?kind=token" | J "len(d)")" -ge 18 ]
python3 -c "
from PIL import Image; Image.new('RGB',(3000,2000),'green').save('/tmp/map.png')" 2>/dev/null || python3 -c "
import zlib,struct
def png(w,h):
  raw=b''.join(b'\x00'+b'\x00\x80\x00'*w for _ in range(h))
  def chunk(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
  return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
open('/tmp/map.png','wb').write(png(3000,2000))"
UP=$(gm -X POST "$B/api/assets" -F "file=@/tmp/map.png" -F "kind=map" -F "campaign_id=$CID")
AID=$(echo "$UP" | J "d['id']"); echo "$UP" | J "(d['width'],d['height'],d['mime'],d['raw_size'],d['stored_size'])"
[ "$(echo "$UP" | J "d['width']")" = "3000" ]
gm "$B/api/assets/$AID" | python3 -c "
import sys,json,base64,zlib; d=json.load(sys.stdin); b=zlib.decompress(base64.b64decode(d['data_b64'])); assert b[:2]==b'\xff\xd8', b[:4]; print('decoded jpeg', len(b))"

echo "[4] сцены и персонажи"
gm -X POST "$B/api/campaigns/$CID/scenes/$SID/duplicate" | J "d['name']" | grep -q "копия"
[ "$(pl "$B/api/campaigns/$CID/scenes" | J "len(d)")" = "2" ]
CH=$(pl -X POST "$B/api/characters" -H 'content-type: application/json' -d "{\"name\":\"Торин\",\"campaign_id\":\"$CID\"}" | J "d['id']")
[ "$(gm "$B/api/characters?campaign_id=$CID" | J "d[0]['name']")" = "Торин" ]
gm -X PATCH "$B/api/characters/$CH" -H 'content-type: application/json' -d '{"sheet":{"name":"Торин","level":3}}' | J "d['sheet']['level']" | grep -q 3
pl -X PATCH "$B/api/characters/$CH" >/dev/null   # пустой PATCH (проверка прав из листа)

echo "[4b] наборы (packs)"
PACK=$(pl -X POST "$B/api/packs" -H 'content-type: application/json' -d '{"name":"Набор игрока","is_public":false}' | J "d['id']")
pl -X POST "$B/api/compendium" -H 'content-type: application/json' -d "{\"category\":\"item\",\"name\":\"Кинжал Теней\",\"pack_id\":\"$PACK\",\"data\":{\"type\":\"weapon\",\"actions\":[{\"name\":\"Атака\",\"kind\":\"attack\",\"roll\":\"1d20+@atk\"}]}}" | J "d['pack_id']" | grep -q "$PACK"
pl "$B/api/compendium?q=Теней&campaign_id=$CID" | J "len(d)" | grep -q 1          # владелец видит свой набор
[ "$(gm "$B/api/compendium?q=Теней&campaign_id=$CID" | J "len(d)")" = "0" ]        # мастер — нет, набор не подключён и не публичный
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $GM" -X POST "$B/api/campaigns/$CID/packs/$PACK"); [ "$code" = "403" ]
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $PL" -X PATCH "$B/api/packs/$PACK" -H 'content-type: application/json' -d '{"name":"Набор игрока","is_public":true}'); [ "$code" = "400" ]   # публикация без описания запрещена
# доступ по ссылке: мастер подписывается по коде и видит набор
SHARE=$(pl -X POST "$B/api/packs/$PACK/share" | J "d['share_code']")
[ "$(gm "$B/api/packs/join/$SHARE" | J "d['entries']")" = "1" ]
gm -X POST "$B/api/packs/join/$SHARE" | grep -q '"ok":true'
[ "$(gm "$B/api/packs?scope=subscribed" | J "len(d)")" = "1" ]
[ "$(gm "$B/api/compendium?q=Теней" | J "len(d)")" = "1" ]
gm -X POST "$B/api/campaigns/$CID/packs/$PACK" | grep -q '"ok":true'
# соавтор: мастер может добавлять записи, папки
pl -X POST "$B/api/packs/$PACK/editors" -H 'content-type: application/json' -d '{"email":"gm@test.ru"}' | grep -q '"ok":true'
gm -X POST "$B/api/packs/$PACK/folders" -H 'content-type: application/json' -d '{"folders":["Жители Тавернтона"]}' | J "d['folders'][0]" | grep -q Тавернтона
gm -X POST "$B/api/compendium" -H 'content-type: application/json' -d "{\"category\":\"npc\",\"name\":\"Трактирщик Боб\",\"pack_id\":\"$PACK\",\"data\":{\"role\":\"трактирщик\",\"folder\":\"Жители Тавернтона\"}}" | J "d['category']" | grep -q npc
[ "$(pl "$B/api/compendium?pack_id=$PACK&folder=%D0%96%D0%B8%D1%82%D0%B5%D0%BB%D0%B8%20%D0%A2%D0%B0%D0%B2%D0%B5%D1%80%D0%BD%D1%82%D0%BE%D0%BD%D0%B0" | J "len(d)")" = "1" ]
[ "$(pl "$B/api/packs/$PACK" | J "d['version']")" -ge "2" ]
pl -X DELETE "$B/api/packs/$PACK/editors/$(gm "$B/api/auth/me" | J "d['id']")" | grep -q '"ok":true'
pl -X PATCH "$B/api/packs/$PACK" -H 'content-type: application/json' -d '{"name":"Набор игрока","description":"Тестовый набор для каталога","is_public":true,"tags":"тест"}' | J "d['is_public']" | grep -qi true
[ "$(gm "$B/api/packs?scope=public&q=игрока" | J "len(d)")" = "1" ]
CLONE=$(gm -X POST "$B/api/packs/$PACK/clone" | J "d['id']")
[ "$(gm "$B/api/packs/$CLONE" | J "d['entries']")" = "2" ]
gm -X DELETE "$B/api/packs/$CLONE" | grep -q '"ok":true'
[ "$(gm "$B/api/compendium?q=Теней&campaign_id=$CID" | J "len(d)")" = "1" ]
[ "$(gm "$B/api/campaigns/$CID/packs" | J "d[0]['entries']")" = "2" ]
EXP=$(pl "$B/api/packs/$PACK/export")
IMP=$(gm -X POST "$B/api/packs/import" -H 'content-type: application/json' -d "$(echo "$EXP" | python3 -c "import sys,json; d=json.load(sys.stdin); d['name']='Импорт'; print(json.dumps(d))")")
[ "$(echo "$IMP" | J "d['entries']")" = "2" ]
[ "$(echo "$IMP" | J "d['folders'][0]")" = "Жители Тавернтона" ]
[ "$(gm "$B/api/packs?scope=mine" | J "len(d)")" = "1" ]
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $GM" -X DELETE "$B/api/packs/$PACK"); [ "$code" = "403" ]
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $GM" -X POST "$B/api/compendium" -H 'content-type: application/json' -d "{\"category\":\"lore\",\"name\":\"X\",\"pack_id\":\"$PACK\",\"data\":{}}"); [ "$code" = "403" ]   # соавторство снято

echo "[4c] передача предметов между персонажами"
CH2=$(gm -X POST "$B/api/characters" -H 'content-type: application/json' -d "{\"name\":\"Гимли\",\"campaign_id\":\"$CID\"}" | J "d['id']")
pl -X PATCH "$B/api/characters/$CH" -H 'content-type: application/json' -d '{"sheet":{"name":"Торин","level":3,"inventory":[{"uid":"u1","name":"Факел","qty":5,"type":"gear"}]}}' >/dev/null
pl -X POST "$B/api/characters/$CH/transfer" -H 'content-type: application/json' -d "{\"item_uid\":\"u1\",\"to_character_id\":\"$CH2\",\"qty\":2}" | grep -q '"ok":true'
[ "$(pl "$B/api/characters/$CH" | J "d['sheet']['inventory'][0]['qty']")" = "3" ]
[ "$(gm "$B/api/characters/$CH2" | J "d['sheet']['inventory'][0]['qty']")" = "2" ]
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $PL" -X POST "$B/api/characters/$CH2/transfer" -H 'content-type: application/json' -d "{\"item_uid\":\"u1\",\"to_character_id\":\"$CH\"}"); [ "$code" = "403" ]
gm -X DELETE "$B/api/characters/$CH2" | grep -q '"ok":true'

echo "[5] WebSocket: чат, броски, права игрока"
python3 - "$B" "$CID" "$SID" "$GM" "$PL" <<'PY'
import sys, json, asyncio
B, CID, SID, GM, PL = sys.argv[1:]
import websockets
async def drain(ws, t=0.7):
    out=[]
    try:
        while True: out.append(json.loads(await asyncio.wait_for(ws.recv(), t)))
    except asyncio.TimeoutError: return out
async def main():
    W = B.replace("http","ws")
    async with websockets.connect(f"{W}/ws/{CID}?token={GM}") as g, websockets.connect(f"{W}/ws/{CID}?token={PL}") as p:
        await drain(g); await drain(p)
        await g.send(json.dumps({"type":"item_upsert","scene_id":SID,"item":{"layer":"character","z":0,"data":{"type":"image","asset_id":"x","x":35,"y":35,"w":70,"h":70,"name":"Гоблин","hp":{"cur":7,"max":7}}}}))
        m=[x for x in await drain(p) if x["type"]=="item_upsert"][0]; item=m["item"]; await drain(g)
        await p.send(json.dumps({"type":"item_upsert","scene_id":SID,"item":{"id":item["id"],"layer":"character","data":{**item["data"],"x":999}}}))
        assert not [x for x in await drain(g) if x["type"]=="item_upsert"], "игрок сдвинул чужой токен!"
        item["data"]["owner_id"]=json.loads(json.dumps(item["data"])).get("owner_id")
        # назначаем владельца: узнаём id игрока через presence
        pres=[x for x in await drain(g, 0.2)]
        await g.send(json.dumps({"type":"ping","x":1,"y":1}))
        ping=[x for x in await drain(p) if x["type"]=="ping"][0]; gm_id=ping["user_id"]
        # id игрока — из присутствия
        await p.send(json.dumps({"type":"ping","x":1,"y":1})); pl_id=[x for x in await drain(g) if x["type"]=="ping"][0]["user_id"]
        item["data"]["owner_id"]=pl_id
        await g.send(json.dumps({"type":"item_upsert","scene_id":SID,"item":item})); await drain(g); await drain(p)
        await p.send(json.dumps({"type":"item_upsert","scene_id":SID,"item":{"id":item["id"],"layer":"character","data":{**item["data"],"x":140,"name":"HACK"}}}))
        got=[x for x in await drain(g) if x["type"]=="item_upsert"][0]["item"]["data"]
        assert got["x"]==140 and got["name"]=="Гоблин", got
        await p.send(json.dumps({"type":"chat","text":"/r 2d20kh1+5"}))
        r=[x for x in await drain(g) if x["type"]=="chat"][0]; assert r["kind"]=="roll" and 6<=r["payload"]["total"]<=25, r; await drain(p)
        await g.send(json.dumps({"type":"roll","expr":"d20","gm_only":True}))
        assert not [x for x in await drain(p) if x["type"]=="chat"], "игрок увидел скрытый бросок"
        assert [x for x in await drain(g) if x["type"]=="chat"]
        await g.send(json.dumps({"type":"scene_update","scene_id":SID,"fog":{"enabled":True,"shapes":[]}}))
        assert [x for x in await drain(p) if x["type"]=="scene_update"][0]["fog"]["enabled"] is True
        await p.send(json.dumps({"type":"scene_update","scene_id":SID,"fog":{"enabled":False,"shapes":[]}})); await drain(g)
        print("ws ok")
asyncio.run(main())
PY
echo "[5b] состояние после WS"
[ "$(pl "$B/api/campaigns/$CID/scenes/$SID" | J "(len(d['items']), d['fog']['enabled'])")" = "(1, True)" ]
[ "$(pl "$B/api/campaigns/$CID/chat" | J "len(d)")" = "2" ]   # системное сообщение о передаче + бросок; скрытый бросок мастера игроку не виден
[ "$(gm "$B/api/campaigns/$CID/chat" | J "len(d)")" = "3" ]

echo "[6] удаление кампании владельцем"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $PL" -X DELETE "$B/api/campaigns/$CID"); [ "$code" = "403" ]
gm -X DELETE "$B/api/campaigns/$CID" | grep -q '"ok":true'
echo "SMOKE OK"

echo "[9] root: CLI + права на базовый справочник"
"$BIN" users create root@test.ru rootpass123 --name Root --root | grep root >/dev/null
"$BIN" users list | grep "root@test.ru" >/dev/null
"$BIN" stats | grep "Пользователи" >/dev/null
RT=$(curl -fs -X POST "$B/api/auth/login" -H 'content-type: application/json' -d '{"email":"root@test.ru","password":"rootpass123"}' | J "d['token']")
rt() { curl -fsS -H "Authorization: Bearer $RT" "$@" || { echo "!!! root request failed: $*" >&2; curl -s -H "Authorization: Bearer $RT" "$@" >&2; echo >&2; return 1; }; }
rt "$B/api/auth/me" | J "d['is_root']" | grep -q True
[ "$(gm "$B/api/auth/me" | J "d['is_root']")" = "False" ]
BASE=$(gm "$B/api/compendium?category=race" | J "d[0]['id']")
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $GM" -X PATCH "$B/api/compendium/$BASE" -H 'content-type: application/json' -d '{"category":"race","name":"Хак","data":{}}'); [ "$code" = "403" ]
rt -X PATCH "$B/api/compendium/$BASE" -H 'content-type: application/json' -d '{"category":"race","name":"Дварф (правка root)","data":{"desc":"ok"}}' | J "d['name']" | grep -q "правка root"
rt -X POST "$B/api/compendium" -H 'content-type: application/json' -d '{"category":"item","name":"Базовый предмет root","data":{"type":"weapon"}}' | J "d['source']" | grep -q SRD
[ "$(rt "$B/api/admin/users" | J "len(d)")" -ge 3 ]
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $GM" "$B/api/admin/users"); [ "$code" = "403" ]
NU=$(rt -X POST "$B/api/admin/users" -H 'content-type: application/json' -d '{"email":"new@test.ru","password":"password123","name":"Новый"}' | J "d['id']")
rt -X PATCH "$B/api/admin/users/$NU" -H 'content-type: application/json' -d '{"is_root":true}' | J "d['is_root']" | grep -q True
rt -X DELETE "$B/api/admin/users/$NU" | grep -q '"ok":true'
("$BIN" users revoke-root root@test.ru 2>&1 || true) | grep "единственный" >/dev/null
rt -X POST "$B/api/admin/reseed" | J "d['entries']" | grep 2499 >/dev/null
echo "[10] профиль: два cookie, имя, аватар, смена пароля"
hdrs=$(curl -s -D - -o /dev/null -X POST "$B/api/auth/login" -H 'content-type: application/json' -d '{"email":"gm@test.ru","password":"secret123"}')
[ "$(echo "$hdrs" | grep -ci '^set-cookie: dnd_session')" = "2" ]
COOK=$(echo "$hdrs" | grep -i '^set-cookie: dnd_session_x=' | sed 's/^[Ss]et-[Cc]ookie: //; s/;.*//')
curl -fs -H "Cookie: $COOK" "$B/api/auth/me" | J "d['name']" | grep -q Мастер   # вход по «фреймовому» cookie
gm -X PATCH "$B/api/auth/me" -H 'content-type: application/json' -d '{"name":"Мастер Игры"}' | grep -q '"ok":true'
gm "$B/api/auth/me" | J "d['name']" | grep -q "Мастер Игры"
AV=$(gm -X POST "$B/api/assets" -F "file=@/tmp/map.png" -F "kind=portrait" -F "name=avatar" | J "d['id']")
gm -X PATCH "$B/api/auth/me" -H 'content-type: application/json' -d "{\"avatar_asset_id\":\"$AV\"}" | grep -q '"ok":true'
[ "$(gm "$B/api/auth/me" | J "d['avatar_asset_id']")" = "$AV" ]
pl "$B/api/assets/$AV" | J "d['id']" | grep -q "$AV"   # чужой аватар доступен для показа
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $GM" -X POST "$B/api/auth/change-password" -H 'content-type: application/json' -d '{"old_password":"wrong","password":"another123"}'); [ "$code" = "400" ]
gm -X POST "$B/api/auth/change-password" -H 'content-type: application/json' -d '{"old_password":"secret123","password":"another123"}' | grep -q '"ok":true'
curl -fs -X POST "$B/api/auth/login" -H 'content-type: application/json' -d '{"email":"gm@test.ru","password":"another123"}' | J "d['ok']" | grep -q True
gm "$B/api/auth/me" | J "d['name']" | grep -q "Мастер Игры"   # текущая сессия сохранена
echo "SMOKE OK (root)"
