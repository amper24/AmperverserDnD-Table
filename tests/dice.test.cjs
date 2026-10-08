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
test('advantage/disadvantage work with any die size and preserve d20 targeting', () => {
  assert.equal(D.withMode('d20+5','adv'), '2d20kh1+5');
  assert.equal(D.withMode('1d20-2','dis'), '2d20kl1-2');
  assert.equal(D.withMode('d6+1d20+2d20','adv'), 'd6+2d20kh1+2d20', 'a d20 check keeps priority when present');
  assert.equal(D.withMode('d4+3','adv'), '2d4kh1+3');
  assert.equal(D.withMode('2d6+3','dis'), '4d6kl2+3');
  assert.equal(D.withMode('-d6+5','adv'), '-2d6kl1+5', 'negative dice invert the keep direction to favor the total');
  assert.equal(D.withMode('-d6+5','dis'), '-2d6kh1+5');
  assert.equal(D.withMode('d8+1d6+2','adv'), '2d8kh1+2d6kh1+2', 'without a d20, every dice pool in the formula is modified');
  assert.equal(D.withMode('d6+1d20+5','dis'), 'd6+2d20kl1+5', 'the d20 remains the target if the formula also has other dice');
  assert.equal(D.withMode('d100+3','adv'), '2d100kh1+3');
  assert.equal(D.withMode('d200','dis'), '2d200kl1');
  assert.equal(D.withMode('2d20kh1+3','adv'), '2d20kh1+3');
  assert.equal(D.withMode('2d20kh1+3','dis'), '2d20kl1+3');
  assert.equal(D.withMode('2d20kl1-2','adv'), '2d20kh1-2');
  assert.equal(D.withMode('d20kh1+5','dis'), '2d20kl1+5');
  assert.equal(D.withMode('4d20kh3+3','adv'), '8d20kh3+3', 'custom keep pools double candidates while preserving the output count');
  assert.equal(D.withMode('4d6kh3+3','dis'), '8d6kl3+3');
  assert.equal(D.withMode('4d6kh5+3','adv'), '4d6kh5+3', 'an invalid base formula is never repaired by mode application');
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

test('the final animation frame shows the authoritative face on every supported die', () => {
  const frames = [];
  let currentFrame = null;
  const ctx = {
    fillStyle: '', strokeStyle: '', globalAlpha: 1,
    scale() {}, clearRect() { currentFrame = []; frames.push(currentFrame); },
    beginPath() {}, ellipse() {}, fill() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {},
    fillText(value) { if (this.fillStyle === '#fff') currentFrame.push(String(value)); },
  };
  const callbacks = [];
  let rafId = 0;
  context.devicePixelRatio = 1;
  context.requestAnimationFrame = fn => { callbacks.push([++rafId, fn]); return rafId; };
  context.cancelAnimationFrame = id => { const i = callbacks.findIndex(([key]) => key === id); if (i >= 0) callbacks.splice(i, 1); };
  const dice = [4, 6, 8, 10, 12, 20, 100].map(sides => ({ ...D.evaluate('d' + sides, () => .5), name: 'd' + sides }));
  const expected = dice.map(d => String(d.parts[0].rolls[0]));
  const canvas = { clientWidth: 1280, clientHeight: 800, getContext: () => ctx };
  D.animate(canvas, { rolls: dice }, { color: '#a881e8', speed: 1 });
  let now = 0, frameCount = 0;
  while (callbacks.length && frameCount < 200) {
    const [, callback] = callbacks.shift();
    now += 1000 / 60;
    callback(now);
    frameCount++;
  }
  assert.ok(frameCount > 100 && frameCount < 150, 'the animation reaches its bounded final frame');
  assert.deepEqual([...frames.at(-1)].sort((a, b) => Number(a) - Number(b)), [...expected].sort((a, b) => Number(a) - Number(b)), 'each die finishes with its rolled value as its single highlighted face');
});

test('presentation uses a global screen layer and preserves consecutive rolls', () => {
  const makeElement = (tag, attrs = {}, ...children) => {
    const node = {
      tag, attrs, className: attrs.class || '', children: [], dataset: {}, parent: null,
      value: attrs.value ?? '', checked: !!attrs.checked, textContent: '',
      style: { setProperty() {}, top: '' },
      classList: { add() {} },
      append(...items) { for (const item of items.filter(Boolean)) { item.parent = this; this.children.push(item); } },
      replaceChildren(...items) { this.children = []; this.append(...items); },
      remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
      addEventListener() {}, focus() {},
      contains(target) { return this === target || this.children.some(child => child.contains?.(target)); },
      querySelector(selector) { return this.children.find(child => '.' + child.className === selector) || null; },
    };
    node.append(...children);
    return node;
  };
  const find = (nodes, selector) => {
    for (const node of nodes) {
      if (!node.removed && '.' + node.className === selector) return node;
      const nested = find(node.children || [], selector); if (nested) return nested;
    }
    return null;
  };
  const document = {
    hidden: false, activeElement: null, elementFromPoint() { return null; },
    body: { children: [], append(...nodes) { this.children.push(...nodes); nodes.forEach(node => { node.parent = this; }); } },
    querySelector(selector) { return find(this.body.children, selector); },
    querySelectorAll() { return []; },
  };
  const window = { innerHeight: 800, matchMedia: () => ({ matches: false }), addEventListener() {} };
  const browser = {
    window, document, el: makeElement,
    LS: { getItem: () => '{"animate":false}', setItem() {} },
    toast() {}, crypto: require('node:crypto').webcrypto,
    setTimeout(fn, delay) { const timer = setTimeout(fn, delay); if (delay >= 8000) timer.unref?.(); return timer; }, clearTimeout,
  };
  vm.createContext(browser);
  vm.runInContext(fs.readFileSync('static/dice.js', 'utf8'), browser);
  const engine = browser.window.DiceEngine;

  engine.present({ ...engine.evaluate('d20+5'), label: 'Проверка' }, { local: true });
  const stage = document.querySelector('.dice-global-stage');
  assert.equal(stage.children.filter(node => !node.removed).length, 1, 'the first roll remains visible while its journal auto-opens');
  assert.ok(document.querySelector('.dice-journal'), 'the first roll also opens the journal');
  engine.present({ ...engine.evaluate('d6'), label: 'Повторный бросок' }, { local: true });
  assert.ok(stage, 'result layer exists on the global screen');
  assert.equal(stage.children.length, 2, 'a later roll does not replace the previous one');
  assert.ok(stage.children.every(node => node.className === 'dice-global-burst'));
  assert.ok(stage.children.every(node => node.children.length === 0), 'result totals stay in the journal, not in a centered screen overlay');

  for (let i = 3; i <= 10; i++) engine.present({ ...engine.evaluate('d6'), label: `Сцена ${i}` }, { local: true });
  assert.equal(stage.children.filter(node => !node.removed).length, 10, 'ten scenes can remain visible together');
  const oldest = stage.children.find(node => !node.removed);
  engine.present({ ...engine.evaluate('d6'), label: 'Одиннадцатая сцена' }, { local: true });
  assert.equal(stage.children.filter(node => !node.removed).length, 10, 'the eleventh scene evicts only the oldest');
  assert.equal(oldest.removed, true);

  engine.dismiss();
  assert.ok(stage.children.every(node => node.removed), 'Escape/dismiss removes every active result scene');
});
