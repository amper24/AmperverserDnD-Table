const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = { window: {}, crypto: require('node:crypto').webcrypto };
vm.createContext(context);
vm.runInContext(fs.readFileSync('static/dice-physics.js', 'utf8'), context);
const Physics = context.window.DicePhysics;
const plain = value => JSON.parse(JSON.stringify(value));

function seeded(seed) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
}

test('physical dice models have the correct visible face counts', () => {
  for (const [sides, vertices, faces, verticesPerFace] of [
    [4, 4, 4, 3], [6, 8, 6, 4], [8, 6, 8, 3], [10, 7, 10, 3], [12, 20, 12, 5], [20, 12, 20, 3],
  ]) {
    const model = Physics.modelFor(sides);
    assert.equal(model.vertices.length, vertices, `d${sides} vertices`);
    assert.equal(model.faces.length, faces, `d${sides} faces`);
    assert.ok(model.faces.every(face => face.indices.length === verticesPerFace), `d${sides} face geometry`);
    assert.equal(Physics.modelFor(sides), model, `d${sides} mesh is cached between dice`);
  }
});

test('every simulated die settles at its rest point with the accepted result facing up', () => {
  for (const sides of [4, 6, 8, 10, 12, 20, 100]) for (const value of [1, Math.ceil(sides / 2), sides]) {
    const die = Physics.createDie({ sides, value }, seeded(sides * 100 + value));
    Physics.place(die, { x: 217, y: 143, size: 42, landX: 240, landY: 130, restX: 252, restY: 136 });
    Physics.step(die, 1 / 120);
    assert.ok(die.height > 0, `d${sides} begins with a physical upward toss`);
    for (let frame = 1; frame < 220; frame++) Physics.step(die, 1 / 120);
    assert.equal(die.settled, true, `d${sides} settles`);
    assert.equal(Physics.faceUp(die).label, value, `d${sides} shows the accepted ${value}`);
    assert.ok(Physics.faceUp(die).alignment > .97, `d${sides} result face is aimed at the camera`);
    assert.deepEqual(plain(die.angularVelocity), [0, 0, 0], `d${sides} stops without an extra spin`);
    assert.deepEqual([die.x, die.y], [die.restX, die.restY], `d${sides} finishes at its rest point`);
    assert.equal(die.height, 0);
  }
});

test('unknown polyhedral sizes remain renderable without inventing a roll result', () => {
  for (const sides of [1, 2, 3, 7, 1000]) {
    const die = Physics.createDie({ sides, value: sides }, seeded(sides));
    for (let frame = 0; frame < 190; frame++) Physics.step(die, 1 / 120);
    assert.equal(Physics.faceUp(die).label, sides);
  }
});

test('a die is tossed from the centre, lands near it, rolls a little and stops at the rest point', () => {
  const centre = [400, 163], land = [430, 143], rest = [446, 156];
  const die = Physics.createDie({ sides: 6, value: 3 }, seeded(42));
  Physics.place(die, { x: centre[0], y: centre[1], size: 50, landX: land[0], landY: land[1], restX: rest[0], restY: rest[1] });
  assert.equal(die.scale < 1, true, 'the die appears smaller and grows at the throw');
  const start = [die.x, die.y];
  Physics.step(die, 1 / 120);
  assert.ok(Math.hypot(die.x - centre[0], die.y - centre[1]) < 3, 'the throw starts at the centre');
  assert.deepEqual(start, [centre[0], centre[1]]);

  let landedAt = null, rolledPast = false, maxFromCentre = 0;
  for (let frame = 1; frame < 220 && !die.settled; frame++) {
    Physics.step(die, 1 / 120);
    maxFromCentre = Math.max(maxFromCentre, Math.hypot(die.x - centre[0], die.y - centre[1]));
    if (landedAt === null && die.elapsed >= 0.56 + 0.18) landedAt = [die.x, die.y];
    if (landedAt && die.elapsed > 0.8 && die.elapsed < 1.1 && Math.hypot(die.x - land[0], die.y - land[1]) > 2) rolledPast = true;
  }
  assert.equal(die.settled, true);
  assert.deepEqual([die.x, die.y], rest, 'the die comes to rest at the planned spot');
  assert.ok(Math.hypot(land[0] - centre[0], land[1] - centre[1]) < 60, 'the landing is close to the centre');
  assert.ok(rolledPast, 'the die slides across the table after its hop');
  assert.ok(maxFromCentre < 80, 'the whole motion stays close to the centre');
  assert.equal(Physics.faceUp(die).label, 3);
});

test('rest points are reproducible for the same layout and the roll never changes the face', () => {
  const run = () => {
    const die = Physics.createDie({ sides: 20, value: 17 }, seeded(9));
    Physics.place(die, { x: 300, y: 150, size: 40, landX: 320, landY: 140, restX: 330, restY: 146 });
    for (let frame = 0; frame < 220 && !die.settled; frame++) Physics.step(die, 1 / 120);
    return { face: Physics.faceUp(die).label, rest: [die.x, die.y] };
  };
  assert.deepEqual(run(), run());
  assert.equal(run().face, 17);
});

