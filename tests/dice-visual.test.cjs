const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  const canvasContext = {
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, filter: 'none', font: '', textAlign: '', textBaseline: '', shadowColor: '', shadowBlur: 0,
    texts: [],
    save() {}, restore() {}, setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, arcTo() {}, closePath() {},
    fill() {}, stroke() {}, ellipse() {}, arc() {},
    createLinearGradient() { return { addColorStop() {} }; }, createRadialGradient() { return { addColorStop() {} }; },
    fillText(text) { this.texts.push(String(text)); },
  };
  const queue = [];
  let nextFrame = 0;
  const makeElement = (tag, attrs = {}, ...children) => {
    const classes = new Set(String(attrs.class || '').split(/\s+/).filter(Boolean));
    const node = {
      tag, attrs, className: attrs.class || '', children: [], parent: null, isConnected: false, width: 0, height: 0, attributes: {},
      classList: {
        add(name) { classes.add(name); node.className = [...classes].join(' '); },
        remove(name) { classes.delete(name); node.className = [...classes].join(' '); },
        contains(name) { return classes.has(name); },
      },
      append(...items) { for (const item of items.filter(Boolean)) { if (typeof item === 'object') { item.parent = this; item.isConnected = this.isConnected; } this.children.push(item); } },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name] ?? null; },
      getBoundingClientRect() { return { width: 820, height: 286 }; },
      getContext() { return canvasContext; },
      remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
    };
    node.append(...children);
    return node;
  };
  const document = { body: { children: [], append(...items) { for (const item of items) { item.parent = this; item.isConnected = true; this.children.push(item); } } } };
  const window = {
    devicePixelRatio: 1,
    requestAnimationFrame(callback) { const id = ++nextFrame; queue.push({ id, callback }); return id; },
    cancelAnimationFrame(id) { const index = queue.findIndex(item => item.id === id); if (index >= 0) queue.splice(index, 1); },
  };
  const context = { window, document, el: makeElement, crypto: require('node:crypto').webcrypto, Uint32Array, Math, Number, String, Set };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('static/dice-physics.js', 'utf8'), context);
  context.DicePhysics = context.window.DicePhysics;
  vm.runInContext(fs.readFileSync('static/dice-visual.js', 'utf8'), context);
  return { window, document, queue, canvasContext };
}

test('canvas visual uses the accepted values and replaces the same tray on a new result', () => {
  const { window, document, queue, canvasContext } = harness();
  const payload = { label: 'Проверка', expr: 'd20', dice_color: '#e35b82', parts: [{ term: 'd20', sides: 20, rolls: [17], kept: [17], kept_indices: [0] }] };
  assert.equal(window.DiceVisualizer.show(payload), true);
  const tray = document.body.children[0];
  assert.equal(document.body.children.length, 1);
  assert.equal(tray.classList.contains('visible'), true);
  assert.equal(tray.getAttribute('data-values'), '17');
  assert.match(tray.getAttribute('aria-label'), /к20: 17/);

  let time = 0;
  for (let frame = 0; frame < 220 && queue.length; frame++) {
    const next = queue.shift(); time += 1000 / 60; next.callback(time);
  }
  assert.equal(tray.classList.contains('visible'), false, 'the tray fades after a stable result has been shown');
  assert.ok(canvasContext.texts.includes('17'), 'the final face label is actually drawn on the die');

  assert.equal(window.DiceVisualizer.show({ expr: 'd6', parts: [{ term: 'd6', sides: 6, rolls: [4], kept: [4], kept_indices: [0] }] }), true);
  assert.equal(document.body.children.length, 1, 'consecutive results do not stack canvases');
  assert.equal(document.body.children[0], tray, 'the next roll reuses the same stable stage');
  assert.equal(tray.getAttribute('data-values'), '4');
  window.DiceVisualizer.cancel();
  assert.equal(tray.classList.contains('visible'), false);
});

test('dropped dice stay visible and are marked as dropped without changing their values', () => {
  const { window, document } = harness();
  const payload = { parts: [{ term: '4d6kh3', sides: 6, rolls: [2, 5, 5, 1], kept: [2, 5, 5], kept_indices: [0, 1, 2] }] };
  assert.deepEqual(JSON.parse(JSON.stringify(window.DiceVisualizer.collect(payload))), [
    { sides: 6, value: 2, kept: true, name: '' },
    { sides: 6, value: 5, kept: true, name: '' },
    { sides: 6, value: 5, kept: true, name: '' },
    { sides: 6, value: 1, kept: false, name: '' },
  ]);
  window.DiceVisualizer.show(payload);
  assert.equal(document.body.children[0].getAttribute('data-values'), '2,5,5,1');
  window.DiceVisualizer.cancel();
});

test('the layout keeps every die near the centre and inside the stage', () => {
  const { window } = harness();
  const width = 820, height = 286, centreY = 54 + (height - 82) / 2;
  for (const count of [1, 2, 3, 4, 6, 8, 12, 20, 32]) {
    const plan = window.DiceVisualizer.plan(count, width, height);
    assert.equal(plan.spots.length, count);
    for (const spot of plan.spots) {
      const rest = [plan.cx + spot.rest[0], plan.cy + spot.rest[1]];
      assert.ok(rest[0] - plan.size * 1.2 >= 0 && rest[0] + plan.size * 1.2 <= width, `${count} dice stay horizontally visible`);
      assert.ok(rest[1] - plan.size * 1.2 >= 54 && rest[1] + plan.size * 1.2 <= height - 28, `${count} dice stay vertically visible`);
      assert.ok(Math.hypot(rest[0] - width / 2, rest[1] - centreY) < 230, `${count} dice stay close to the centre`);
    }
  }
  assert.equal(window.DiceVisualizer.plan(1, width, height).cy, centreY);
  assert.equal(window.DiceVisualizer.plan(1, width, height).cx, width / 2);
});

