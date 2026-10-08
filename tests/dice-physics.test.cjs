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

test('every simulated die settles in its original slot with the accepted result facing up', () => {
  for (const sides of [4, 6, 8, 10, 12, 20, 100]) for (const value of [1, Math.ceil(sides / 2), sides]) {
    const die = Physics.createDie({ sides, value }, seeded(sides * 100 + value));
    Physics.setAnchor(die, 217, 143, 42);
    Physics.step(die, 1 / 120);
    assert.ok(die.height > 0, `d${sides} begins with a physical upward toss`);
    for (let frame = 1; frame < 220; frame++) Physics.step(die, 1 / 120);
    assert.equal(die.settled, true, `d${sides} settles`);
    assert.equal(Physics.faceUp(die).label, value, `d${sides} shows the accepted ${value}`);
    assert.ok(Physics.faceUp(die).alignment > .97, `d${sides} result face is aimed at the camera`);
    assert.deepEqual(plain(die.angularVelocity), [0, 0, 0], `d${sides} stops without an extra spin`);
    assert.deepEqual([die.x, die.y], [die.anchorX, die.anchorY], `d${sides} finishes without drifting to another slot`);
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
