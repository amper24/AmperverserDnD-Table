// Переменные листа: чистые проверки sheet.vars без DOM (static/sheet/sheet-vars.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('static/sheet/sheet-vars.js', 'utf8'), ctx);
const V = ctx.window.SheetVars;
const plain = value => JSON.parse(JSON.stringify(value));

test('имена: 1–32 символа [a-z0-9_], занятое имя отклоняется', () => {
  assert.equal(V.validName('bonus_1'), true);
  assert.equal(V.validName('a'.repeat(32)), true);
  assert.equal(V.validName('a'.repeat(33)), false);
  assert.equal(V.validName(''), false);
  assert.equal(V.validName('Бонус'), false);
  assert.equal(V.validName('bonus-1'), false);
  assert.equal(V.validName(' bonus'), false);
  assert.equal(V.validName(null), false);
  assert.equal(V.nameError('', []), V.NAME_ERROR);
  assert.equal(V.nameError('bad-name', []), V.NAME_ERROR);
  assert.equal(V.nameError('bonus', ['bonus']), 'Такая переменная уже есть.');
  assert.equal(V.nameError(' bonus ', ['bonus']), 'Такая переменная уже есть.', 'пробелы обрезаются');
  assert.equal(V.nameError('bonus', ['other']), '');
});

test('значение: конечное число, запятая как разделитель, мусор — null', () => {
  for (const [input, expected] of [['7', 7], ['-2.5', -2.5], [' 3 ', 3], ['1,5', 1.5], [4, 4], [0, 0]]) {
    assert.equal(V.parseValue(input), expected, String(input));
  }
  for (const bad of ['', '  ', 'abc', '1e999', 'Infinity', 'NaN', null, undefined, {}, []]) {
    assert.equal(V.parseValue(bad), null, String(bad));
  }
});

test('normalize отбрасывает мусор, чинит числовые строки и не меняет исходный объект', () => {
  const source = { bonus: 3, malformed: 'x', 'bad-name': 1, list: [1], str: '2.5' };
  assert.deepEqual(plain(V.normalize(source)), { bonus: 3, str: 2.5 });
  assert.equal(source.bonus, 3);
  assert.deepEqual(plain(V.normalize(null)), {});
  assert.deepEqual(plain(V.normalize([1, 2])), {});
  // «__proto__» проходит regex, но должен стать обычной парой, а не прототипом.
  const proto = V.normalize(JSON.parse('{"__proto__":5}'));
  assert.deepEqual(plain(proto), JSON.parse('{"__proto__":5}'));
  assert.deepEqual(plain(V.upsert({}, '__proto__', 6)), JSON.parse('{"__proto__":6}'));
});

test('entries сортирует имена, upsert/remove возвращают копии', () => {
  assert.deepEqual(plain(V.entries({ b: 1, a: 2 })), [['a', 2], ['b', 1]]);
  assert.deepEqual(plain(V.entries({ 10: 1, 2: 2, x: 3 })), [['10', 1], ['2', 2], ['x', 3]]);
  const base = { a: 1 };
  assert.deepEqual(plain(V.upsert(base, 'b', '2')), { a: 1, b: 2 });
  assert.deepEqual(plain(V.upsert(base, 'bad-name', 1)), { a: 1 });
  assert.deepEqual(plain(V.upsert(base, 'b', 'нет')), { a: 1 });
  assert.deepEqual(plain(V.remove(base, 'a')), {});
  assert.deepEqual(base, { a: 1 });
});

test('лист подключает помощники до sheet.js и использует их в панели', () => {
  const html = fs.readFileSync('static/sheet.html', 'utf8');
  assert.match(html, /sheet-vars\.js[\s\S]*sheet\.js/, 'порядок загрузки');
  const sheet = fs.readFileSync('static/sheet/sheet.js', 'utf8');
  assert.match(sheet, /Переменные…/, 'кнопка в шапке');
  assert.match(sheet, /window\.SheetVars/, 'панель использует общие проверки');
  assert.match(sheet, /Переменных пока нет — их создаёт действие с узлом «Записать переменную»\./, 'пустое состояние');
  assert.match(fs.readFileSync('static/style.css', 'utf8'), /\.sheet-vars-dialog/, 'стили диалога');
});
