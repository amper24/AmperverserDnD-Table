const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = { window: {}, crypto: require('node:crypto').webcrypto };
vm.createContext(context);
vm.runInContext(fs.readFileSync('static/dice.js', 'utf8'), context);
const D = context.window.DiceEngine;
const plain = v => JSON.parse(JSON.stringify(v));

test('strict grammar and matching server bounds', () => {
  for (const expr of ['', '+', 'd20+', 'd20++5', 'd20--2', '2garbage', '0d6', 'd0', '101d6', '60d6+41d6', '2d6kh0', '2d6kh3', 'd1001', '1000001', '999999999999999999999999d6', '1.5d6']) assert.throws(() => D.parse(expr), undefined, expr);
  for (const expr of ['d20', '-d4+5', '4d6kh3', '2d20kl1', '2К6 + 3', 'd100', '0', '100d1', 'd1000']) assert.ok(D.parse(expr));
});
test('deterministic keep highest and lowest including tied faces', () => {
  const r = D.evaluate('4d6kh3+2', () => 0);
  assert.equal(r.total, 5); assert.deepEqual(plain(r.parts[0].kept_indices), [0,1,2]);
  const values = [.95, .2]; const low = D.evaluate('2d20kl1-2', () => values.shift());
  assert.equal(low.total, 3); assert.deepEqual(plain(low.parts[0].kept_indices), [1]);
});
test('old saved records drop the right number of duplicate dice', () => {
  assert.deepEqual(plain(D.keptIndices({ rolls: [3,3,3,3], kept: [3,3,3] })), [0,1,2]);
});
test('advantage/disadvantage alter only the first plain d20', () => {
  assert.equal(D.withMode('d20+5','adv'), '2d20kh1+5');
  assert.equal(D.withMode('1d20-2','dis'), '2d20kl1-2');
  assert.equal(D.withMode('2d20kh1+3','adv'), '2d20kh1+3');
  assert.equal(D.withMode('d6+1d20','adv'), 'd6+2d20kh1');
  assert.equal(D.withMode('d200','adv'), 'd200');
});
test('negative terms and constants are computed exactly', () => {
  assert.equal(D.evaluate('2d1-3+d1').total, 0);
  assert.equal(D.evaluate('-2d6+3',()=>.99).total, -9);
});
test('critical attack doubles damage dice, not modifier or healing', () => {
  const result = D.evaluateBatch([{kind:'attack',expr:'d20+5'},{kind:'damage',expr:'d8+3'},{kind:'heal',expr:'d4+2'}],()=>.999);
  assert.equal(result[0].crit,true); assert.equal(result[1].expr,'2d8+3'); assert.equal(result[1].total,19); assert.equal(result[2].expr,'d4+2');
  assert.equal(D.doubleDice('4d6kh3+1d8kl1+5'), '8d6kh6+2d8kl2+5', 'keep counts double with the dice pool');
  assert.equal(D.parse('−d6+2').expr, '-d6+2', 'typographic minus is normalized before validation');
});
test('a later noncritical attack resets the critical state', () => {
  const values=[.999,.5,0,0];
  const result=D.evaluateBatch([{kind:'attack',expr:'d20'},{kind:'attack',expr:'d20'},{kind:'damage',expr:'d8+3'}],()=>values.shift());
  assert.equal(result[2].doubled,false); assert.equal(result[2].expr,'d8+3');
});
test('natural 20 on a save does not double damage, natural 20 damage is not crit', () => {
  const r=D.evaluateBatch([{kind:'save',expr:'d20'},{kind:'damage',expr:'d20'}],()=>.999);
  assert.equal(r[1].crit,false); assert.equal(r[1].doubled,false);
});
test('native secure random produces bounded results for every supported die', () => {
  for(const sides of [4,6,8,10,12,20,100,1000]) {
    const r=D.evaluate('100d'+sides);
    assert.ok(r.parts[0].rolls.every(v=>v>=1&&v<=sides)); assert.ok(r.total>=100&&r.total<=100*sides);
  }
});
test('dice model: every face carries a number and the rolled face turns to the viewer', () => {
  for (const sides of [4, 6, 8, 10, 12, 20, 100]) {
    const m = D.mesh(sides);
    assert.equal(m.faces.length, m.normals.length, 'd' + sides);
    for (let value = 1; value <= sides; value++) {
      const { labels, target } = D.faceLabels(sides, m.faces.length, value);
      assert.equal(labels.length, m.faces.length);
      assert.equal(labels[target], value, `d${sides} face ${value}`);
      assert.equal(labels.filter(v => v === value).length, 1, `d${sides} value ${value} once`);
      // Доворот: нормаль грани с результатом смотрит точно на зрителя (ось Z).
      const p = D.rotate(m.normals[target], D.faceAngles(m.normals[target], 0.7));
      assert.ok(Math.abs(p[2] - 1) < 1e-9 && Math.hypot(p[0], p[1]) < 1e-9, `d${sides}/${value} → ${JSON.stringify(p)}`);
    }
  }
});
