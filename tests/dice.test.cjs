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
test('local and server results update the journal only, without a screen layer', () => {
  const makeElement = (tag, attrs = {}, ...children) => {
    const node = {
      tag, attrs, className: attrs.class || '', children: [], dataset: {}, parent: null,
      value: attrs.value ?? '', checked: !!attrs.checked, textContent: '',
      style: {}, classList: { add() {} },
      append(...items) { for (const item of items.filter(Boolean)) { if (typeof item === 'object') item.parent = this; this.children.push(item); } },
      replaceChildren(...items) { this.children = []; this.append(...items); },
      remove() { this.removed = true; if (this.parent?.children) this.parent.children = this.parent.children.filter(child => child !== this); },
      addEventListener() {}, focus() {},
      contains(target) { return this === target || this.children.some(child => child.contains?.(target)); },
      querySelector(selector) { return find(this.children, selector); },
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
  const findAll = (nodes, selector, out = []) => {
    for (const node of nodes) {
      if (!node.removed && '.' + node.className === selector) out.push(node);
      findAll(node.children || [], selector, out);
    }
    return out;
  };
  const document = {
    activeElement: null, elementFromPoint() { return null; },
    body: { children: [], append(...nodes) { this.children.push(...nodes); nodes.forEach(node => { node.parent = this; }); } },
    querySelector(selector) { return find(this.body.children, selector); },
    querySelectorAll() { return []; },
  };
  const browser = {
    window: { addEventListener() {} }, document, el: makeElement,
    LS: { getItem: () => '{}', setItem() {} }, toast() {}, crypto: require('node:crypto').webcrypto,
    setTimeout(fn, delay) { const timer = setTimeout(fn, delay); if (delay >= 8000) timer.unref?.(); return timer; }, clearTimeout,
  };
  vm.createContext(browser);
  vm.runInContext(fs.readFileSync('static/dice.js', 'utf8'), browser);
  const engine = browser.window.DiceEngine;
  // Единственное, что движок имеет право повесить поверх страницы: журнал, док и кнопка журнала.
  // Любой другой корневой элемент (сцена, canvas, карточка итога) считается экранным выводом.
  const ALLOWED_ROOTS = ['.dice-journal', '.dice-dock', '.dice-log-button'];
  const noScreenLayer = () => document.body.children.every(node => ALLOWED_ROOTS.includes('.' + node.className)) &&
    ['.dice-global-stage', '.dice-global-burst', '.dice-global-canvas'].every(selector => !document.querySelector(selector));
  const entryCount = () => findAll(document.body.children, '.dice-history-entry').length;

  engine.present({ ...engine.evaluate('d20+5'), label: 'Локальная проверка' }, { local: true });
  assert.ok(document.querySelector('.dice-journal'), 'a local result opens the journal');
  assert.equal(entryCount(), 1);
  assert.ok(noScreenLayer());
  engine.present({ ...engine.evaluate('d6'), label: 'Ещё один локальный бросок' }, { local: true });
  assert.equal(entryCount(), 2, 'the journal refreshes for consecutive results');
  assert.ok(noScreenLayer());

  const message = { kind: 'roll', id: 1, at: '2026-10-08T00:00:00Z', user_id: 'gm', name: 'Мастер', payload: {
    request_id: 'srv-1', expr: 'd8', total: 7, parts: [{ term: 'd8', sides: 8, rolls: [7], kept: [7], kept_indices: [0] }]
  } };
  engine.receive(message); engine.receive(message);
  assert.equal(entryCount(), 3, 'server results are journaled once even when a duplicate arrives');
  assert.ok(noScreenLayer());

  const offline = engine.submit({ type: 'roll', expr: '2d6+3', label: 'Локально через submit' });
  assert.ok(offline.total >= 5 && offline.total <= 15);
  assert.equal(entryCount(), 4, 'offline submit also uses the same journal path');
  assert.ok(noScreenLayer());

  for (let i = 0; i < 52; i++) engine.present({ ...engine.evaluate('d4', () => .5), label: `Бросок ${i}` }, { local: true });
  assert.equal(entryCount(), 50, 'the journal still retains only the newest 50 results');
  assert.ok(noScreenLayer(), 'no number of results can create a central display');
});

test('screen-level dice renderer, APIs and styles are removed', () => {
  for (const name of ['animate', 'dismiss', 'mesh', 'rotate', 'faceLabels', 'faceAngles']) assert.equal(D[name], undefined, `${name} is no longer exposed`);
  const js = fs.readFileSync('static/dice.js', 'utf8');
  const css = fs.readFileSync('static/style.css', 'utf8');
  assert.doesNotMatch(js, /dice-global-(?:stage|burst|canvas)|requestAnimationFrame|Math\.random/);
  assert.doesNotMatch(css, /\.dice-global-(?:stage|burst|canvas)/);
});

// Итог броска живёт только в журнале: центральный вывод вырезан не из одного dice.js,
// а из всей поставки, поэтому вернуть его не может ни страница стола, ни лист, ни мастер.
test('no shipped asset can draw a roll result over the screen', () => {
  const forbidden = /dice-global|dice-stage|dice-scene|dice-burst|dice-canvas|dice-overlay|dice-fullscreen|roll-overlay|roll-banner|roll-stage|roll-scene|result-overlay|result-banner/i;
  for (const file of fs.readdirSync('static').sort()) {
    assert.doesNotMatch(fs.readFileSync('static/' + file, 'utf8'), forbidden, `${file} must not carry a screen-level roll layer`);
  }
  // Ни одно правило стиля, связанное с бросками, не перекрывает экран и не центрируется поверх интерфейса.
  const css = fs.readFileSync('static/style.css', 'utf8');
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/dice|roll/i.test(selector)) continue;
    assert.doesNotMatch(body, /inset:\s*0|top:\s*50%|left:\s*50%/, `${selector.trim()} must not cover the screen`);
  }
  // Публичный API движка — разбор, бросок и журнал: ни сцены, ни анимации, ни canvas.
  for (const name of Object.keys(D)) {
    assert.doesNotMatch(name, /animate|stage|scene|burst|overlay|canvas|dismiss|mesh|rotate|face/i, `${name} must not be a screen renderer`);
  }
});
