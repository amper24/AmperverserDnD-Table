// Импорт персонажа из Long Story Short (longstoryshort.app), формат экспорта .json:
// { jsonType:'character', version:'2', data:'<json-строка>' } либо сам объект персонажа (name, info, stats, ...).
window.LSS = (() => {
  const M = () => window.Modules;
  const SKILL_MAP = { 'acrobatics': 'acrobatics', 'animal handling': 'animal', 'arcana': 'arcana', 'athletics': 'athletics', 'deception': 'deception', 'history': 'history', 'insight': 'insight', 'intimidation': 'intimidation', 'investigation': 'investigation', 'medicine': 'medicine', 'nature': 'nature', 'perception': 'perception', 'performance': 'performance', 'persuasion': 'persuasion', 'religion': 'religion', 'sleight of hand': 'sleight', 'stealth': 'stealth', 'survival': 'survival' };
  const num = (v, d = 0) => { const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : d; };
  const val = (o) => (o && typeof o === 'object' && 'value' in o) ? o.value : o;
  const str = (o) => { const v = val(o); return v === null || v === undefined ? '' : String(v).trim(); };

  // ---- tiptap-документ LSS → плоский текст / список абзацев ----
  function docText(node, out = [], line = { t: '' }) {
    if (!node) return out;
    if (typeof node === 'string') { line.t += node; return out; }
    if (Array.isArray(node)) { node.forEach(n => docText(n, out, line)); return out; }
    const type = node.type;
    const flush = () => { if (line.t.trim()) out.push(line.t.trim()); line.t = ''; };
    if (type === 'text') { line.t += node.text || ''; return out; }
    if (type === 'hardBreak') { flush(); return out; }
    if (type === 'resource') { line.t += node.attrs?.name ? `[${node.attrs.name}]` : ''; return out; }
    if (['paragraph', 'heading', 'listItem', 'blockquote', 'tableCell', 'tableRow'].includes(type)) { flush(); docText(node.content, out, line); flush(); return out; }
    if (type === 'bulletList' || type === 'orderedList') { flush(); (node.content || []).forEach((li, i) => { const sub = docText(li, []); if (sub.length) out.push((type === 'orderedList' ? (i + 1) + '. ' : '• ') + sub.join(' ')); }); return out; }
    docText(node.content, out, line);
    if (type === 'doc') flush();
    return out;
  }
  function textBlock(t) {
    // t: { value: { data: {type:'doc'} } } | { value: 'строка' } | 'строка' | {data:{...}}
    if (!t) return [];
    const v = val(t);
    if (typeof v === 'string') return v.split(/\n+/).map(x => x.trim()).filter(Boolean);
    if (v && v.data) return docText(v.data);
    if (v && v.type === 'doc') return docText(v);
    return [];
  }
  const joinText = (t) => textBlock(t).join('\n');

  function unwrap(raw) {
    let d = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (d && typeof d.data === 'string') { try { const inner = JSON.parse(d.data); d = { ...inner, __outer: d }; } catch { } }
    else if (d && d.data && typeof d.data === 'object' && d.data.stats) d = { ...d.data, __outer: d };
    if (!d || !d.stats || !d.name) throw new Error('Это не файл персонажа Long Story Short');
    return d;
  }

  function parseClass(s) {
    // "Плут (3)" | "Плут 3" | "Воин (2) / Плут (1)" | "Клирик"
    s = (s || '').trim();
    const parts = s.split('/').map(x => x.trim()).filter(Boolean);
    const first = parts[0] || '';
    const m = first.match(/^(.*?)\s*[\(\s](\d+)\)?\s*$/);
    return { cls: parts.length > 1 ? parts.map(p => p.replace(/\s*\(?\d+\)?\s*$/, '')).join(' / ') : (m ? m[1].trim() : first), lvl: m ? +m[2] : 0 };
  }

  /// Преобразование LSS → наш лист (структура default_sheet). Возвращает { name, sheet, notes: [строки о том, что не удалось перенести] }.
  function convert(raw) {
    const d = unwrap(raw);
    const M_ = M();
    const info = d.info || {};
    const warn = [];
    const { cls, lvl } = parseClass(str(info.charClass));
    const level = num(val(info.level)) || lvl || 1;
    const abilities = {};
    for (const k of ['str', 'dex', 'con', 'int', 'wis', 'cha']) abilities[k] = num(d.stats?.[k]?.score, 10);
    const saving_throws = Object.entries(d.saves || {}).filter(([, v]) => v && (v.isProf === true || v.isProf === 1)).map(([k]) => k);
    const skills = [], expertise = [];
    for (const [k, v] of Object.entries(d.skills || {})) {
      const our = SKILL_MAP[k.toLowerCase()] || SKILL_MAP[(v?.name || '').toLowerCase()];
      if (!our || !v) continue;
      const p = v.isProf === true ? 1 : num(v.isProf);
      if (p >= 2) { skills.push(our); expertise.push(our); } else if (p === 1) skills.push(our);
    }
    const vit = d.vitality || {};
    const hitDie = str(vit['hit-die']).replace(/^к/, 'd');
    const hp = { max: num(val(vit['hp-max']), 10), current: num(val(vit['hp-current']), num(val(vit['hp-max']), 10)), temp: num(val(vit['hp-temp'])), hit_dice: hitDie && hitDie !== 'multiclass' ? `${level}${hitDie.startsWith('d') ? hitDie : 'd' + hitDie}` : `${level}d8` };
    const currency = {}; for (const c of ['cp', 'sp', 'ep', 'gp', 'pp']) currency[c] = num(val(d.coins?.[c]));
    const attacks = (d.weaponsList || []).map(w => ({ name: str(w.name) || 'Атака', bonus: str(w.mod) || '+0', damage: str(w.dmg) || '1d6' })).filter(a => a.name);
    const text = d.text || {};
    const traits = { personality: joinText(text.personality), ideals: joinText(text.ideals), bonds: joinText(text.bonds), flaws: joinText(text.flaws) };
    // умения и черты: каждый абзац — отдельная запись; «Название. описание» / «Название: описание»
    const features = [];
    const toFeature = (line) => {
      const m = line.match(/^(?:•\s*)?([^.:—–\n]{2,60})[.:—–]\s+(.*)$/s);
      if (m) return { name: m[1].trim(), text: m[2].trim() };
      return { name: line.length > 60 ? line.slice(0, 57) + '…' : line, text: line.length > 60 ? line : '' };
    };
    for (const key of ['traits', 'features', 'allies']) for (const line of textBlock(text[key])) features.push(toFeature(line));
    for (const r of Object.values(d.resources || {})) if (r?.name) features.push({ name: r.name, text: `Заряды: ${r.current ?? r.max}/${r.max}${r.isLongRest ? ' (восст. на длинном отдыхе)' : r.isShortRest ? ' (восст. на коротком отдыхе)' : ''}` });
    // снаряжение: строки → предметы
    const inventory = [];
    const itemLine = (line) => {
      let name = line.replace(/^•\s*/, '').trim(); let qty = 1;
      const q = name.match(/^(.*?)(?:\s*[x×хX*]\s*(\d+)|\s*\((\d+)\s*(?:шт\.?)?\)|\s*[-—–]\s*(\d+)\s*шт\.?)\s*$/);
      if (q) { name = q[1].trim(); qty = +(q[2] || q[3] || q[4]) || 1; }
      const type = /меч|топор|лук|кинжал|копь|булав|молот|арбалет|посох|дубин|рапир|скимитар|глефа|алебард|пращ|дротик/i.test(name) ? 'weapon' : /доспех|кольчуг|щит|кожан|латы|бригантин|кираса/i.test(name) ? 'armor' : /зелье|свиток|рацион|факел|масло|бутыл/i.test(name) ? 'consumable' : /стрел|болт|пул/i.test(name) ? 'ammo' : 'gear';
      return M_.newItem({ name, qty, type, source: 'LSS' });
    };
    for (const key of ['equipment', 'items']) for (const line of textBlock(text[key])) { for (const piece of line.split(/[;,]\s+(?=[А-ЯA-Zа-яa-z])/)) if (piece.trim().length > 1) inventory.push(itemLine(piece)); }
    // заклинания: имена по уровням (сопоставление со справочником — асинхронно, см. enrichSpells)
    const spellNames = [];
    for (let l = 0; l <= 9; l++) for (const line of textBlock(text['spells-level-' + l])) for (const piece of line.split(/[;,]\s+/)) if (piece.trim().length > 1) spellNames.push({ name: piece.replace(/^•\s*/, '').trim(), level: l });
    // из режима «книга»
    const outer = d.__outer || {};
    for (const sp of [...(outer.spells?.book || []), ...(outer.spells?.prepared || [])]) { const n = typeof sp === 'string' ? sp : sp?.name || sp?.title; if (n && !spellNames.some(x => x.name === n)) spellNames.push({ name: n, level: sp?.level ?? 1 }); }
    const slots = {};
    for (const [k, v] of Object.entries(d.spells || {})) { const m = k.match(/^slots-(\d)$/); if (m && num(val(v))) slots[m[1]] = { max: num(val(v)), used: Math.max(0, num(val(v)) - num(v?.filled ?? val(v))) }; }
    for (const [k, v] of Object.entries(d.spellsPact || {})) { const m = k.match(/^slots-(\d)$/); if (m && num(val(v))) slots[m[1]] = { max: (slots[m[1]]?.max || 0) + num(val(v)), used: 0 }; }
    const spellAbility = (d.spellsInfo?.base?.code || '').toLowerCase() || '';
    const notesParts = [];
    const prof = textBlock(text.prof); if (prof.length) notesParts.push('Владения и языки:\n' + prof.join('\n'));
    const bg = textBlock(text.background); if (bg.length) notesParts.push('Предыстория:\n' + bg.join('\n'));
    for (const key of ['notes', 'notes-1', 'notes-2', 'quests', 'treasures']) { const t = textBlock(text[key]); if (t.length) notesParts.push(t.join('\n')); }
    const atkText = textBlock(text.attacks); if (atkText.length) notesParts.push('Атаки (текст):\n' + atkText.join('\n'));
    const sub = d.subInfo || {};
    const subLine = ['age', 'height', 'weight', 'eyes', 'skin', 'hair'].map(k => str(sub[k]) ? `${sub[k]?.label || k}: ${str(sub[k])}` : '').filter(Boolean).join(', ');
    if (subLine) notesParts.push(subLine);
    if (d.avatar?.jpeg || d.avatar?.webp) warn.push('Портрет не переносится автоматически — загрузите его на листе (ссылка: ' + (d.avatar.jpeg || d.avatar.webp) + ')');
    const name = str(d.name) || 'Импорт LSS';
    const sheet = {
      name, race: str(info.race), class: cls, level, background: str(info.background), alignment: str(info.alignment), xp: num(val(info.experience)),
      abilities, proficiency_bonus: num(d.proficiency) || Math.ceil(1 + level / 4), saving_throws, skills, expertise,
      hp, ac: num(val(vit.ac), 10), speed: num(val(vit.speed), 30), initiative_bonus: 0, inspiration: !!d.inspiration,
      attacks, inventory, spells: { slots, known: [], ability: spellAbility }, features, traits, notes: notesParts.join('\n\n'), currency,
      conditions: [], death_saves: { success: num(vit.deathSuccesses), fail: num(vit.deathFails) },
    };
    return { name, sheet, spellNames, warn };
  }

  /// Сопоставляет имена заклинаний со справочником (точное совпадение по имени, иначе — пустая карточка нужного уровня).
  async function enrichSpells(res) {
    const M_ = M();
    const known = [];
    let missed = 0;
    for (const { name, level } of res.spellNames) {
      let e = null;
      try { const list = await API.get('/api/compendium?category=spell&q=' + encodeURIComponent(name)); e = list.find(x => x.name.toLowerCase() === name.toLowerCase()) || list.find(x => x.name.toLowerCase().startsWith(name.toLowerCase())) || null; } catch { }
      if (e) known.push(M_.spellFromCompendium(e)); else { missed++; known.push(M_.newSpell({ name, level, school: '', casting_time: '', range: '', components: '', duration: '', source: 'LSS' })); }
    }
    res.sheet.spells.known = known;
    if (missed) res.warn.push(`${missed} закл. не найдено в справочнике — добавлены пустыми карточками`);
    return res;
  }

  /// Диалог импорта: выбор файла → предпросмотр → создание персонажа. opts: { campaignId, onDone(char) }
  async function importDialog(opts = {}) {
    const file = el('input', { type: 'file', accept: '.json,application/json' });
    const info = el('div', { class: 'muted small', style: 'margin-top:8px' }, 'Экспорт: Long Story Short → лист персонажа → «Экспорт» → .json');
    const preview = el('div', { style: 'margin-top:10px' });
    let parsed = null;
    file.addEventListener('change', async () => {
      preview.innerHTML = ''; parsed = null;
      const f = file.files[0]; if (!f) return;
      try {
        parsed = convert(await f.text());
        const s = parsed.sheet;
        preview.append(el('div', { class: 'card', style: 'padding:10px' }, el('b', {}, parsed.name), el('div', { class: 'muted small' }, [s.race, s.class, s.level + ' ур.'].filter(Boolean).join(' · ')),
          el('div', { class: 'small', style: 'margin-top:6px' }, `Хиты ${s.hp.current}/${s.hp.max} · КД ${s.ac} · скорость ${s.speed}`),
          el('div', { class: 'small' }, `Атак: ${s.attacks.length} · предметов: ${s.inventory.length} · заклинаний: ${parsed.spellNames.length} · умений: ${s.features.length}`)));
      } catch (e) { preview.append(el('div', { class: 'auth-err' }, 'Не удалось прочитать: ' + e.message)); }
    });
    const ok = await modal('Импорт из Long Story Short', el('div', {}, file, info, preview), [{ label: 'Импортировать', cls: 'primary', fn: () => parsed || (toast('Выберите файл .json'), false) }]);
    if (!ok) return null;
    toast('Импорт…');
    await enrichSpells(ok);
    const c = await API.post('/api/characters', { name: ok.name, campaign_id: opts.campaignId || null, sheet: ok.sheet });
    toast('Персонаж «' + ok.name + '» импортирован' + (ok.warn.length ? '. ' + ok.warn.join('; ') : ''), ok.warn.length ? 7000 : 2500);
    opts.onDone && opts.onDone(c);
    return c;
  }

  return { convert, enrichSpells, importDialog, unwrap, docText };
})();
