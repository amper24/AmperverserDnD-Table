// Лист персонажа. Работает и в iframe поверх стола (embed=1), и как отдельная страница/окно.
(async function () {
  const app = document.getElementById('app');
  const id = location.pathname.split('/').pop();
  const embed = new URLSearchParams(location.search).get('embed') === '1';
  let me; try { me = await API.get('/api/auth/me'); } catch { app.innerHTML = '<div class="center"><div class="card">Нужно войти. <a href="/">На главную</a></div></div>'; return; }
  let ch; try { ch = await API.get('/api/characters/' + id); } catch (e) { app.innerHTML = `<div class="center"><div class="card">${e.message}</div></div>`; return; }
  const s = ch.sheet; let readonly = false;
  // проверим право записи пустым патчем
  try { await API.patch('/api/characters/' + id, {}); } catch { readonly = true; }
  document.title = ch.name + ' — лист';

  let saveTimer;
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(async () => { if (readonly) return; try { await API.patch('/api/characters/' + id, { sheet: s }); status.textContent = 'сохранено'; } catch (e) { status.textContent = 'ошибка: ' + e.message; } }, 500); status.textContent = '…'; }
  const status = el('span', { class: 'muted', style: 'font-size:11px' });

  const prof = () => s.proficiency_bonus || Math.ceil(1 + (s.level || 1) / 4);
  const abMod = (k) => mod(s.abilities[k]);
  const skillVal = (k, ab) => abMod(ab) + (s.expertise.includes(k) ? 2 : s.skills.includes(k) ? 1 : 0) * prof();
  const saveVal = (k) => abMod(k) + (s.saving_throws.includes(k) ? prof() : 0);
  const passive = () => 10 + skillVal('perception', 'wis');

  function roll(expr, label) {
    const r = rollDice(expr);
    if (embed && window.parent !== window) window.parent.postMessage({ type: 'roll', expr, label: `${ch.name}: ${label}` }, '*');
    else if (window.opener && !window.opener.closed) window.opener.postMessage({ type: 'roll', expr, label: `${ch.name}: ${label}` }, '*');
    else toast(`${label}: ${r.total}  (${r.parts.map(p => p.rolls ? '[' + p.rolls.join(',') + ']' : p.term).join(' ')})`, 4000);
  }

  function render() {
    app.innerHTML = '';
    const root = el('div', { class: 'sheet' });
    // ---- шапка ----
    const portrait = el('div', { class: 'portrait', title: 'Загрузить портрет' }, '🧙');
    if (ch.portrait_asset_id) assetURL(ch.portrait_asset_id).then(u => { portrait.innerHTML = ''; portrait.append(el('img', { src: u })); });
    const pf = el('input', { type: 'file', accept: 'image/*', class: 'hidden' });
    pf.addEventListener('change', async () => { const fd = new FormData(); fd.append('file', pf.files[0]); fd.append('name', ch.name); fd.append('kind', 'portrait'); if (ch.campaign_id) fd.append('campaign_id', ch.campaign_id); const a = await API.upload('/api/assets', fd); ch.portrait_asset_id = a.id; await API.patch('/api/characters/' + id, { portrait_asset_id: a.id }); render(); });
    if (!readonly) portrait.addEventListener('click', () => pf.click());
    const inp = (key, ph, type = 'text', w) => el('input', { value: s[key] ?? '', placeholder: ph, type, style: w ? 'width:' + w : '', disabled: readonly ? '' : null, onchange: e => { s[key] = type === 'number' ? +e.target.value : e.target.value; if (key === 'level') s.proficiency_bonus = Math.ceil(1 + s.level / 4); save(); if (['level', 'name'].includes(key)) render(); } });
    const head = el('div', { class: 'head' }, portrait, el('div', {},
      el('div', { class: 'row', style: 'margin-bottom:6px' }, el('div', { style: 'flex:2' }, el('label', {}, 'Имя'), inp('name', 'Имя персонажа')), el('div', {}, el('label', {}, 'Уровень'), inp('level', '1', 'number')), el('div', {}, el('label', {}, 'Опыт'), inp('xp', '0', 'number'))),
      el('div', { class: 'row' }, el('div', { class: 'dropslot', 'data-cat': 'race' }, el('label', {}, 'Раса ⤓'), inp('race', 'перетащите из справочника')), el('div', { class: 'dropslot', 'data-cat': 'class' }, el('label', {}, 'Класс ⤓'), inp('class', 'перетащите')), el('div', {}, el('label', {}, 'Подкласс'), inp('subclass', '')), el('div', { class: 'dropslot', 'data-cat': 'background' }, el('label', {}, 'Предыстория ⤓'), inp('background', '')), el('div', {}, el('label', {}, 'Мировоззрение'), inp('alignment', '')))));
    root.append(el('div', { class: 'row', style: 'margin-bottom:6px' }, el('h1', { style: 'flex:1' }, ch.name), status,
      embed ? el('button', { class: 'small', style: 'flex:0', onclick: () => window.open('/sheet/' + id, 'sheet_' + id, 'width=1000,height=800') }, '⧉ В окно') : null,
      el('button', { class: 'small', style: 'flex:0', onclick: () => toggleComp() }, '📚 Справочник'),
      readonly ? el('span', { class: 'badge' }, 'только чтение') : el('label', { style: 'flex:0;white-space:nowrap' }, el('input', { type: 'checkbox', style: 'width:auto', checked: s.shared ? '' : null, onchange: e => { s.shared = e.target.checked; save(); } }), ' виден игрокам')), head);

    const cols = el('div', { class: 'cols' });
    // ---- колонка 1: характеристики ----
    const c1 = el('div');
    const abil = el('div', { class: 'abil' });
    for (const [k, name] of Object.entries(ABIL)) {
      abil.append(el('div', { class: 'ab', title: 'Клик — проверка характеристики', onclick: e => { if (e.target.tagName !== 'INPUT') roll('d20' + fmtMod(abMod(k)), 'проверка ' + name); } },
        el('small', {}, name), el('div', { class: 'mod' }, fmtMod(abMod(k))), el('input', { type: 'number', value: s.abilities[k], disabled: readonly ? '' : null, onchange: ev => { s.abilities[k] = +ev.target.value; save(); render(); }, onclick: ev => ev.stopPropagation() })));
    }
    c1.append(abil);
    c1.append(el('div', { class: 'card', style: 'margin-top:8px' }, el('h3', {}, 'Спасброски'), el('div', { class: 'skills' }, ...Object.entries(ABIL).map(([k, name]) => el('div', { onclick: e => { if (e.target.classList.contains('pip')) return; roll('d20' + fmtMod(saveVal(k)), 'спасбросок ' + name); } },
      el('span', { class: 'pip' + (s.saving_throws.includes(k) ? ' on' : ''), onclick: () => { if (readonly) return; s.saving_throws = s.saving_throws.includes(k) ? s.saving_throws.filter(x => x !== k) : [...s.saving_throws, k]; save(); render(); } }), el('span', { class: 'val' }, fmtMod(saveVal(k))), name)))));
    c1.append(el('div', { class: 'card', style: 'margin-top:8px' }, el('h3', {}, 'Навыки'), el('div', { class: 'skills' }, ...SKILLS.map(([k, name, ab]) => el('div', { onclick: e => { if (e.target.classList.contains('pip')) return; roll('d20' + fmtMod(skillVal(k, ab)), name); } },
      el('span', { class: 'pip' + (s.expertise.includes(k) ? ' exp' : s.skills.includes(k) ? ' on' : ''), title: 'клик: нет → владение → компетентность', onclick: () => { if (readonly) return; if (s.expertise.includes(k)) { s.expertise = s.expertise.filter(x => x !== k); s.skills = s.skills.filter(x => x !== k); } else if (s.skills.includes(k)) s.expertise.push(k); else s.skills.push(k); save(); render(); } }),
      el('span', { class: 'val' }, fmtMod(skillVal(k, ab))), name, el('span', { class: 'muted', style: 'font-size:10px' }, ' (' + ABIL[ab].slice(0, 3) + ')')))),
      el('div', { class: 'muted', style: 'margin-top:6px;font-size:12px' }, 'Пассивное восприятие: ', el('b', {}, passive()), ' · Бонус мастерства: ', el('b', {}, fmtMod(prof())))));
    // ---- колонка 2: бой ----
    const c2 = el('div');
    const hp = s.hp;
    c2.append(el('div', { class: 'stat3' },
      el('div', { class: 'card' }, el('label', {}, 'КД'), el('input', { class: 'inline', type: 'number', value: s.ac, disabled: readonly ? '' : null, onchange: e => { s.ac = +e.target.value; save(); } })),
      el('div', { class: 'card', style: 'cursor:pointer', onclick: () => roll('d20' + fmtMod(abMod('dex') + (s.initiative_bonus || 0)), 'инициатива') }, el('label', {}, 'Инициатива'), el('b', {}, fmtMod(abMod('dex') + (s.initiative_bonus || 0)))),
      el('div', { class: 'card' }, el('label', {}, 'Скорость'), el('input', { class: 'inline', type: 'number', value: s.speed, disabled: readonly ? '' : null, onchange: e => { s.speed = +e.target.value; save(); } }))));
    c2.append(el('div', { class: 'card', style: 'margin-top:8px' }, el('h3', {}, 'Хиты'),
      el('div', { class: 'row' }, el('div', {}, el('label', {}, 'Текущие'), el('input', { type: 'number', value: hp.current, disabled: readonly ? '' : null, onchange: e => { hp.current = +e.target.value; save(); render(); } })), el('div', {}, el('label', {}, 'Макс'), el('input', { type: 'number', value: hp.max, disabled: readonly ? '' : null, onchange: e => { hp.max = +e.target.value; save(); render(); } })), el('div', {}, el('label', {}, 'Врем.'), el('input', { type: 'number', value: hp.temp, disabled: readonly ? '' : null, onchange: e => { hp.temp = +e.target.value; save(); } })), el('div', {}, el('label', {}, 'Кость хитов'), el('input', { value: hp.hit_dice, disabled: readonly ? '' : null, onchange: e => { hp.hit_dice = e.target.value; save(); } }))),
      el('div', { class: 'hpbar' }, el('div', { style: `width:${Math.max(0, Math.min(100, hp.current / (hp.max || 1) * 100))}%` })),
      el('div', { class: 'row', style: 'margin-top:6px' }, el('button', { class: 'small', onclick: () => { const v = +prompt('Урон:', '0') || 0; hp.current -= v; save(); render(); } }, '− Урон'), el('button', { class: 'small', onclick: () => { const v = +prompt('Лечение:', '0') || 0; hp.current = Math.min(hp.max, hp.current + v); save(); render(); } }, '+ Лечение'), el('button', { class: 'small', onclick: () => roll(hp.hit_dice + fmtMod(abMod('con')), 'кость хитов') }, '🎲 КХ')),
      el('div', { class: 'row', style: 'margin-top:6px;font-size:12px' }, el('span', {}, 'Спасброски от смерти: ', ...[0, 1, 2].map(i => el('span', { class: 'pip' + (s.death_saves.success > i ? ' on' : ''), style: 'display:inline-block;width:12px;height:12px;border-radius:50%;border:1px solid var(--ok);margin:0 2px;cursor:pointer;background:' + (s.death_saves.success > i ? 'var(--ok)' : 'transparent'), onclick: () => { s.death_saves.success = s.death_saves.success > i ? i : i + 1; save(); render(); } })), ' / ', ...[0, 1, 2].map(i => el('span', { style: 'display:inline-block;width:12px;height:12px;border-radius:50%;border:1px solid var(--danger);margin:0 2px;cursor:pointer;background:' + (s.death_saves.fail > i ? 'var(--danger)' : 'transparent'), onclick: () => { s.death_saves.fail = s.death_saves.fail > i ? i : i + 1; save(); render(); } }))),
        el('label', { style: 'flex:0;white-space:nowrap' }, el('input', { type: 'checkbox', style: 'width:auto', checked: s.inspiration ? '' : null, onchange: e => { s.inspiration = e.target.checked; save(); } }), ' Вдохновение'))));
    // атаки
    const atk = el('div', { class: 'card dropslot', 'data-cat': 'item', style: 'margin-top:8px' }, el('h3', {}, 'Атаки и заклинания ⤓'));
    atk.append(el('div', { class: 'atk-row muted', style: 'font-size:11px' }, el('span', {}, 'Название'), el('span', {}, 'Атака'), el('span', {}, 'Урон'), el('span'), el('span')));
    s.attacks.forEach((a, i) => atk.append(el('div', { class: 'atk-row' },
      el('input', { value: a.name, disabled: readonly ? '' : null, onchange: e => { a.name = e.target.value; save(); } }), el('input', { value: a.bonus, disabled: readonly ? '' : null, onchange: e => { a.bonus = e.target.value; save(); } }), el('input', { value: a.damage, disabled: readonly ? '' : null, onchange: e => { a.damage = e.target.value; save(); } }),
      el('button', { class: 'small', title: 'Бросок атаки', onclick: () => roll('d20' + (a.bonus.startsWith('+') || a.bonus.startsWith('-') ? a.bonus : '+' + (a.bonus || 0)), a.name + ' (атака)') }, '🎯'),
      el('button', { class: 'small', title: 'Урон', onclick: () => roll(a.damage.replace(/[^\dкd+\-khl]/gi, ''), a.name + ' (урон)') }, '💥'),
      readonly ? null : el('button', { class: 'small danger', style: 'grid-column:1/-1;justify-self:end;padding:0 6px', onclick: () => { s.attacks.splice(i, 1); save(); render(); } }, 'убрать'))));
    if (!readonly) atk.append(el('button', { class: 'small', style: 'margin-top:6px', onclick: () => { s.attacks.push({ name: 'Атака', bonus: fmtMod(abMod('str') + prof()), damage: '1d8' + fmtMod(abMod('str')) }); save(); render(); } }, '+ Атака'));
    c2.append(atk);
    // особенности
    const feats = el('div', { class: 'card dropslot', 'data-cat': 'feat', style: 'margin-top:8px' }, el('h3', {}, 'Умения и черты ⤓'));
    s.features.forEach((f, i) => feats.append(el('details', {}, el('summary', {}, el('b', {}, f.name), readonly ? null : el('button', { class: 'small danger', style: 'float:right;padding:0 6px', onclick: () => { s.features.splice(i, 1); save(); render(); } }, '×')), el('div', { class: 'muted', style: 'white-space:pre-wrap;font-size:12px' }, f.text))));
    if (!readonly) feats.append(el('button', { class: 'small', style: 'margin-top:6px', onclick: async () => { const n = await prompt2('Название'); if (n) { s.features.push({ name: n, text: '' }); save(); render(); } } }, '+ Умение'));
    c2.append(feats);
    // ---- колонка 3: инвентарь, заклинания, личность ----
    const c3 = el('div');
    const inv = el('div', { class: 'card dropslot', 'data-cat': 'item' }, el('h3', {}, 'Инвентарь ⤓'));
    inv.append(el('div', { class: 'row', style: 'margin-bottom:6px;font-size:12px' }, ...['pp', 'gp', 'ep', 'sp', 'cp'].map(c => el('label', {}, c.toUpperCase(), el('input', { type: 'number', value: s.currency[c], disabled: readonly ? '' : null, style: 'padding:3px', onchange: e => { s.currency[c] = +e.target.value; save(); } })))));
    s.inventory.forEach((it, i) => inv.append(el('div', { class: 'inv-row' }, el('span', { title: it.desc || '', style: 'cursor:help' }, it.name), el('input', { type: 'number', value: it.qty, disabled: readonly ? '' : null, onchange: e => { it.qty = +e.target.value; save(); } }), el('span', { class: 'muted' }, it.weight ? it.weight * it.qty + ' фнт' : ''), readonly ? el('span') : el('button', { class: 'small danger', style: 'padding:0 6px', onclick: () => { s.inventory.splice(i, 1); save(); render(); } }, '×'))));
    inv.append(el('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, 'Вес: ', s.inventory.reduce((a, b) => a + (b.weight || 0) * (b.qty || 1), 0), ' / ', s.abilities.str * 15, ' фнт'));
    if (!readonly) inv.append(el('button', { class: 'small', style: 'margin-top:6px', onclick: async () => { const n = await prompt2('Предмет'); if (n) { s.inventory.push({ name: n, qty: 1, weight: 0 }); save(); render(); } } }, '+ Предмет'));
    c3.append(inv);
    const sp = s.spells;
    const spells = el('div', { class: 'card dropslot', 'data-cat': 'spell', style: 'margin-top:8px' }, el('h3', {}, 'Заклинания ⤓'));
    const spAb = sp.ability || 'int';
    spells.append(el('div', { class: 'row', style: 'font-size:12px;margin-bottom:6px' }, el('label', {}, 'Хар-ка ', el('select', { style: 'width:auto;padding:2px', disabled: readonly ? '' : null, onchange: e => { sp.ability = e.target.value; save(); render(); } }, ...['int', 'wis', 'cha'].map(k => el('option', { value: k, selected: spAb === k ? '' : null }, ABIL[k])))),
      el('span', {}, 'СЛ ', el('b', {}, 8 + prof() + abMod(spAb))), el('span', { style: 'cursor:pointer', onclick: () => roll('d20' + fmtMod(prof() + abMod(spAb)), 'атака заклинанием') }, 'Атака ', el('b', {}, fmtMod(prof() + abMod(spAb))))));
    const slots = el('div', { style: 'display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;font-size:11px' });
    for (let l = 1; l <= 9; l++) { const sl = sp.slots[l] || { max: 0, used: 0 }; if (!sl.max && readonly) continue; slots.append(el('span', { class: 'chip', title: `Ячейки ${l} круга: клик — потратить, ПКМ — вернуть`, oncontextmenu: e => { e.preventDefault(); sl.used = Math.max(0, sl.used - 1); sp.slots[l] = sl; save(); render(); }, onclick: () => { sl.used = Math.min(sl.max, sl.used + 1); sp.slots[l] = sl; save(); render(); } }, l + ': ', el('span', {}, (sl.max - sl.used) + '/'), readonly ? sl.max : el('input', { type: 'number', value: sl.max, style: 'width:36px;padding:0 2px', onclick: e => e.stopPropagation(), onchange: e => { sl.max = +e.target.value; sp.slots[l] = sl; save(); } }))); }
    spells.append(slots);
    [...sp.known].sort((a, b) => a.level - b.level).forEach((x) => { const i = sp.known.indexOf(x); spells.append(el('details', {}, el('summary', {}, el('span', { class: 'badge' }, x.level === 0 ? 'заг' : x.level), ' ', el('b', {}, x.name), x.prepared ? ' ✓' : '', readonly ? null : el('span', { style: 'float:right' }, el('button', { class: 'small', style: 'padding:0 6px', title: 'подготовлено', onclick: () => { x.prepared = !x.prepared; save(); render(); } }, '✓'), el('button', { class: 'small danger', style: 'padding:0 6px', onclick: () => { sp.known.splice(i, 1); save(); render(); } }, '×'))), el('div', { class: 'muted', style: 'font-size:12px' }, [x.casting_time, x.range, x.duration].filter(Boolean).join(' · ')), el('div', { style: 'font-size:12px' }, x.desc || ''))); });
    if (!readonly) spells.append(el('button', { class: 'small', style: 'margin-top:6px', onclick: async () => { const n = await prompt2('Заклинание'); if (n) { sp.known.push({ name: n, level: 1 }); save(); render(); } } }, '+ Заклинание'));
    c3.append(spells);
    const pers = el('div', { class: 'card', style: 'margin-top:8px' }, el('h3', {}, 'Личность'));
    for (const [k, n] of [['personality', 'Черты характера'], ['ideals', 'Идеалы'], ['bonds', 'Привязанности'], ['flaws', 'Слабости']]) pers.append(el('div', { class: 'field' }, el('label', {}, n), el('textarea', { disabled: readonly ? '' : null, style: 'min-height:40px', onchange: e => { s.traits[k] = e.target.value; save(); } }, s.traits[k] || '')));
    pers.append(el('div', { class: 'field' }, el('label', {}, 'Заметки'), el('textarea', { disabled: readonly ? '' : null, onchange: e => { s.notes = e.target.value; save(); } }, s.notes || '')));
    c3.append(pers);
    cols.append(c1, c2, c3);
    root.append(cols);
    app.append(root);
    if (!readonly) bindDrops(root);
  }

  // ---- drag&drop из справочника ----
  function bindDrops(root) {
    root.querySelectorAll('.dropslot').forEach(slot => {
      slot.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('application/x-compendium')) { e.preventDefault(); slot.classList.add('dragover'); } });
      slot.addEventListener('dragleave', () => slot.classList.remove('dragover'));
      slot.addEventListener('drop', e => { e.preventDefault(); slot.classList.remove('dragover'); const entry = JSON.parse(e.dataTransfer.getData('application/x-compendium')); applyEntry(entry, slot.dataset.cat); });
    });
    // на любое место листа — авто-определение категории
    root.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('application/x-compendium')) e.preventDefault(); });
    root.addEventListener('drop', e => { if (e.defaultPrevented) return; e.preventDefault(); const raw = e.dataTransfer.getData('application/x-compendium'); if (raw) applyEntry(JSON.parse(raw)); });
  }
  function applyEntry(e, slotCat) {
    const d = e.data || {};
    switch (e.category) {
      case 'race': {
        s.race = e.name;
        if (d.asi && confirm(`Применить бонусы расы к характеристикам? (${Object.entries(d.asi).filter(([k]) => ABIL[k]).map(([k, v]) => ABIL[k] + ' +' + v).join(', ')})`)) for (const [k, v] of Object.entries(d.asi)) if (ABIL[k]) s.abilities[k] += v;
        if (d.speed) s.speed = d.speed;
        (d.traits || []).forEach(t => { if (!s.features.some(f => f.name === t.name)) s.features.push({ name: t.name, text: t.text }); });
        break;
      }
      case 'class': {
        s.class = e.name;
        if (d.saves && confirm('Установить спасброски и кость хитов класса?')) { s.saving_throws = [...d.saves]; s.hp.hit_dice = (s.level || 1) + d.hit_die; if (s.level === 1) { s.hp.max = parseInt(d.hit_die.slice(1)) + abMod('con'); s.hp.current = s.hp.max; } }
        if (d.spellcasting) s.spells.ability = d.spellcasting;
        Object.entries(d.features || {}).forEach(([lvl, fs]) => { if (+lvl <= (s.level || 1)) fs.forEach(n => { if (!s.features.some(f => f.name === n)) s.features.push({ name: n, text: `${e.name}, ${lvl} ур.` }); }); });
        break;
      }
      case 'background': {
        s.background = e.name;
        const map = Object.fromEntries(SKILLS.map(([k, n]) => [n, k]));
        (d.skills || []).forEach(n => { if (map[n] && !s.skills.includes(map[n])) s.skills.push(map[n]); });
        if (d.feature) s.features.push({ name: d.feature, text: `Умение предыстории «${e.name}»` });
        break;
      }
      case 'item': {
        if (d.type === 'weapon' && (slotCat === 'item' || confirm('Добавить как атаку?'))) {
          const fin = (d.properties || []).some(p => p.startsWith('Фехтовальное')), ranged = d.category?.includes('дальнобойное');
          const ab = ranged ? 'dex' : fin ? (abMod('dex') > abMod('str') ? 'dex' : 'str') : 'str';
          s.attacks.push({ name: e.name, bonus: fmtMod(abMod(ab) + prof()), damage: d.damage.replace('к', 'd') + fmtMod(abMod(ab)) + ' ' + d.damage_type });
        }
        if (d.type === 'armor' && confirm('Надеть? КД будет пересчитан.')) { const base = parseInt(d.ac); if (d.ac.startsWith('+')) s.ac += base; else s.ac = base + (d.ac.includes('Лов') ? (d.ac.includes('макс 2') ? Math.min(2, abMod('dex')) : abMod('dex')) : 0); }
        const ex = s.inventory.find(i => i.name === e.name); if (ex) ex.qty++; else s.inventory.push({ name: e.name, qty: 1, weight: d.weight || 0, desc: d.desc || '' });
        break;
      }
      case 'spell': if (!s.spells.known.some(x => x.name === e.name)) s.spells.known.push({ name: e.name, level: d.level, casting_time: d.casting_time, range: d.range, duration: d.duration, desc: d.desc }); break;
      case 'feat': case 'condition': s.features.push({ name: e.name, text: d.desc || '' }); break;
      default: toast('Нельзя применить к листу');
    }
    save(); render(); toast(`${e.name} добавлено`);
  }

  // ---- встроенный справочник (для отдельного окна) ----
  let compEl;
  function toggleComp() {
    if (compEl) { compEl.remove(); compEl = null; return; }
    compEl = floatWindow('Справочник (перетаскивайте на лист)', el('div', { style: 'height:100%;padding:8px' }, Compendium.widget({ campaignId: ch.campaign_id })), { x: window.innerWidth - 640, y: 60, w: 620, h: 520 });
  }

  render();
})();
