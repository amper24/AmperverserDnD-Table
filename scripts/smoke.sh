#!/usr/bin/env bash
# Сквозной smoke-тест API: запускает бинарник, проходит сценарий мастер/игрок, проверяет ответы.
set -euo pipefail
BIN="${1:-target/release/dnd-table}"
export PORT="${PORT:-8099}" HOST=127.0.0.1 DEV_SHOW_CODE=true
B="http://127.0.0.1:$PORT"
"$BIN" > server.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; echo "--- server.log ---"; tail -n 40 server.log' EXIT
for i in $(seq 1 60); do curl -fs "$B/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fs "$B/api/health" | grep -q '"ok":true'
J() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

login() { # $1 email, $2 name -> prints token
  code=$(curl -fs -X POST "$B/api/auth/request-code" -H 'content-type: application/json' -d "{\"email\":\"$1\"}" | J "d['dev_code']")
  curl -fs -X POST "$B/api/auth/verify" -H 'content-type: application/json' -d "{\"email\":\"$1\",\"code\":\"$code\",\"name\":\"$2\"}" | J "d['token']"
}
GM=$(login gm@test.ru Мастер); PL=$(login pl@test.ru Игрок)
gm() { curl -fs -H "Authorization: Bearer $GM" "$@"; }
pl() { curl -fs -H "Authorization: Bearer $PL" "$@"; }

echo "[1] кампания + приглашение"
CAMP=$(gm -X POST "$B/api/campaigns" -H 'content-type: application/json' -d '{"name":"Тест"}')
CID=$(echo "$CAMP" | J "d['id']"); SID=$(echo "$CAMP" | J "d['active_scene_id']")
CODE=$(gm -X POST "$B/api/campaigns/$CID/invites" -H 'content-type: application/json' -d '{"role":"player"}' | J "d['code']")
pl -X POST "$B/api/join/$CODE" | grep -q '"ok":true'
[ "$(pl "$B/api/campaigns/$CID" | J "d['role']")" = "player" ]
[ "$(gm "$B/api/campaigns/$CID" | J "len(d['members'])")" = "2" ]

echo "[2] справочник"
[ "$(gm "$B/api/compendium?category=race" | J "len(d)")" = "9" ]
gm "$B/api/compendium?q=меч" | J "[e['name'] for e in d]" | grep -q "Длинный меч"
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
[ "$(pl "$B/api/campaigns/$CID/chat" | J "len(d)")" = "1" ]   # скрытый бросок мастера игроку не виден
[ "$(gm "$B/api/campaigns/$CID/chat" | J "len(d)")" = "2" ]

echo "[6] удаление кампании владельцем"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $PL" -X DELETE "$B/api/campaigns/$CID"); [ "$code" = "403" ]
gm -X DELETE "$B/api/campaigns/$CID" | grep -q '"ok":true'
echo "SMOKE OK"
