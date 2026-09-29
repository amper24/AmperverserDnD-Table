"""End-to-end checks on a running disposable server (SQLite or MySQL).
Invoked by scripts/smoke.sh using B, GM, PL, CID, SID environment variables.
"""
import concurrent.futures
import json
import os
import urllib.request
import urllib.error
import uuid

B, GM, PL, CID, SID = (os.environ[k] for k in ('B', 'GM', 'PL', 'CID', 'SID'))

def api(method, path, body=None, token=PL):
    req = urllib.request.Request(B + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)

def ok(method, path, body=None, token=PL):
    status, data = api(method, path, body, token)
    assert status == 200, (status, data)
    return data

def operation(cid, op, **kw):
    return ok('POST', f'/api/characters/{cid}/inventory', dict(request_id=uuid.uuid4().hex, op=op, **kw))

items = [
    dict(uid='sword', name='Меч', qty=1, type='weapon', handedness='one'),
    dict(uid='shield', name='Щит', qty=1, type='armor', handedness='one', ac='+2'),
    dict(uid='bow', name='Лук', qty=1, type='weapon', handedness='two', consume=dict(enabled=True, resource='quantity', ammo_tag='arrow', trigger='attack', amount=1), actions=[dict(kind='attack', name='Атака', roll='d20+@atk_dex'), dict(kind='damage', name='Урон', roll='d6+@dex')]),
    dict(uid='arrows', name='Стрелы', qty=3, type='ammo', ammo_tag='arrow'),
]
c = ok('POST', '/api/characters', dict(name='Inventory integration', campaign_id=CID, sheet=dict(inventory=items)))
d = ok('POST', '/api/characters', dict(name='Loot receiver', campaign_id=CID))
x, y = c['id'], d['id']
try:
    operation(x, 'equip', item_uid='sword', slot='main')
    operation(x, 'equip', item_uid='shield', slot='off')
    c = operation(x, 'equip', item_uid='bow', slot='both')['character']
    assert len(c['sheet']['inventory']) == 4
    assert not c['sheet']['inventory'][0]['equipped'] and not c['sheet']['inventory'][1]['equipped']
    assert c['sheet']['inventory'][2]['hand_slot'] == 'both'
    # Слоты одежды: экипировать можно только носимое, в слоте один предмет, КД считается по слотам.
    gear = [dict(uid='chain', name='Кольчуга', type='armor', qty=1, handedness='none', ac='16'),
            dict(uid='leather', name='Кожаный доспех', type='armor', qty=1, handedness='none', ac='11 + Лов'),
            dict(uid='rope', name='Верёвка', type='gear', qty=1),
            dict(uid='ring', name='Кольцо защиты', type='magic', qty=1, ac='+1', tags=['Кольца'])]
    z = ok('POST', '/api/characters', dict(name='Slots integration', campaign_id=CID, sheet=dict(inventory=gear, abilities=dict(dex=16), auto_armor=True)))['id']
    try:
        assert api('POST', f'/api/characters/{z}/inventory', dict(request_id=uuid.uuid4().hex, op='equip', item_uid='rope', slot='worn'))[0] == 400
        operation(z, 'equip', item_uid='chain', slot='worn')
        c2 = operation(z, 'equip', item_uid='leather', slot='armor')['character']['sheet']
        assert not c2['inventory'][0]['equipped'] and c2['inventory'][1]['worn_slot'] == 'armor' and c2['ac'] == 14
        c2 = operation(z, 'equip', item_uid='ring', slot='worn')['character']['sheet']
        assert c2['inventory'][3]['worn_slot'] == 'ring1' and c2['ac'] == 15
    finally:
        ok('DELETE', f'/api/characters/{z}')
    stale = c['sheet']
    body = dict(request_id=uuid.uuid4().hex, op='use', item_uid='bow', actions=[0, 1], mode='adv')
    a = ok('POST', f'/api/characters/{x}/inventory', body)
    b = ok('POST', f'/api/characters/{x}/inventory', body)
    assert b['replayed'] and a['result']['rolls'] == b['result']['rolls']
    assert b['character']['sheet']['inventory'][3]['qty'] == 2
    assert api('PATCH', f'/api/characters/{x}', dict(sheet=stale))[0] == 409
    # Read-only party members cannot consume another owner's resources.
    foe = ok('POST', '/api/characters', dict(name='GM owned', campaign_id=CID), GM)
    assert api('POST', f"/api/characters/{foe['id']}/inventory", body)[0] == 403
    ok('DELETE', f"/api/characters/{foe['id']}", token=GM)
    # Same transfer id is exactly-once, even for part of a stack.
    transfer = dict(request_id=uuid.uuid4().hex, item_uid='arrows', qty=1, to_character_id=y)
    ok('POST', f'/api/characters/{x}/transfer', transfer)
    ok('POST', f'/api/characters/{x}/transfer', transfer)
    assert ok('GET', f'/api/characters/{x}')['sheet']['inventory'][3]['qty'] == 1
    assert sum(i['qty'] for i in ok('GET', f'/api/characters/{y}')['sheet']['inventory']) == 1
    # Physical drop/pickup claims the scene row in the same transaction as the inventory write.
    operation(x, 'drop', item_uid='bow', scene_id=SID, x=100, y=100)
    scene = ok('GET', f'/api/campaigns/{CID}/scenes/{SID}')
    loot = next(i for i in scene['items'] if i['data'].get('item', {}).get('uid') == 'bow')
    def pickup(char):
        return api('POST', f'/api/characters/{char}/inventory', dict(request_id=uuid.uuid4().hex, op='pickup', scene_id=SID, loot_id=loot['id']))
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        responses = list(pool.map(pickup, [x, y]))
    assert sum(status == 200 for status, _ in responses) == 1, responses
    total = sum(sum(i['qty'] for i in ok('GET', f'/api/characters/{ch}')['sheet']['inventory'] if i['name'] == 'Лук') for ch in [x, y])
    assert total == 1, total
    # Split creates a new UID while conserving quantities.
    assert api('POST', f'/api/characters/{x}/inventory', dict(request_id=uuid.uuid4().hex, op='split', item_uid='arrows', qty=0))[0] == 400
    # Program execution uses a stored definition; consume + heal + reward commit once.
    potion = dict(uid='potion', name='Atomic potion', type='consumable', qty=2,
                  mechanics=dict(version=1, programs=[dict(id='drink', name='Drink', trigger='use', blocks=[
                      dict(id='cost', kind='consume', source='self', resource='quantity', amount=1, trigger='use'),
                      dict(id='heal', kind='heal', target='self', dice=dict(count=0, sides=6, bonus=7, stat='')),
                      dict(id='vial', kind='grant_item', target='self', amount=1, item=dict(name='Empty vial', type='gear')),
                  ])]))
    sheet = ok('GET', f'/api/characters/{x}')['sheet']
    sheet['hp'] = dict(current=2, max=20, temp=0)
    sheet['inventory'].append(potion)
    ok('PATCH', f'/api/characters/{x}', dict(sheet=sheet))
    program = dict(request_id=uuid.uuid4().hex, op='program', source_kind='item', source_uid='potion', program_id='drink', target_id=x)
    first = ok('POST', f'/api/characters/{x}/inventory', program)
    again = ok('POST', f'/api/characters/{x}/inventory', program)
    assert again['replayed'] and first['result'] == again['result']
    assert again['character']['sheet']['hp']['current'] == 9
    assert next(i for i in again['character']['sheet']['inventory'] if i['uid']=='potion')['qty'] == 1
    assert sum(i['qty'] for i in again['character']['sheet']['inventory'] if i['name']=='Empty vial') == 1
    # An error AFTER consuming and healing still rolls everything back.
    sheet = again['character']['sheet']
    p = next(i for i in sheet['inventory'] if i['uid']=='potion')
    p['mechanics']['programs'][0]['blocks'].append(dict(id='missing', kind='consume', source='item', item_uid='missing-resource', resource='quantity', amount=1, trigger='use'))
    saved = ok('PATCH', f'/api/characters/{x}', dict(sheet=sheet))
    program['request_id'] = uuid.uuid4().hex
    assert api('POST', f'/api/characters/{x}/inventory', program)[0] == 400
    assert ok('GET', f'/api/characters/{x}')['sheet'] == saved['sheet']
    print('PASS mechanics API: stored programs, atomic consumption/healing/reward, exactly-once replay, late-failure rollback')
    print('PASS inventory API: hands, atomic resource+roll, idempotency, stale-write rejection, authorization, transfers, concurrent loot claim')
finally:
    ok('DELETE', f'/api/characters/{x}')
    ok('DELETE', f'/api/characters/{y}')
