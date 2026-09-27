// Справочник: список + карточка записи. Записи можно перетаскивать (drag&drop) в лист персонажа / на стол.
window.Compendium = (function () {
  function renderData(e) {
    const d = e.data || {}, rows = [];
    const add = (k, v) => { if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) rows.push([k, Array.isArray(v) ? v.join(', ') : v]); };
    const asi = (a) => a ? Object.entries(a).map(([k, v]) => (ABIL[k] || k) + ' ' + (typeof v === 'number' ? fmtMod(v) : v)).join(', ') : '';
    switch (e.category) {
      case 'race':
        add('Характеристики', asi(d.asi)); add('Размер', d.size); add('Скорость', d.speed && d.speed + ' фт'); add('Тёмное зрение', d.darkvision && d.darkvision + ' фт'); add('Языки', d.languages);
        break;
      case 'class':
        add('Кость хитов', d.hit_die); add('Основная хар-ка', d.primary); add('Спасброски', (d.saves || []).map(s => ABIL[s])); add('Доспехи', d.armor); add('Оружие', d.weapons);
        add('Навыки', d.skills && `${d.skills.choose} из: ${d.skills.from.join(', ')}`); add('Подклассы', d.subclasses);
        break;
      case 'background': add('Навыки', d.skills); add('Инструменты', d.tools); add('Языки', d.languages); add('Умение', d.feature); add('Снаряжение', d.equipment); break;
      case 'item':
        add('Тип', { weapon: 'Оружие', armor: 'Доспех', gear: 'Снаряжение', magic: 'Магический предмет' }[d.type]); add('Категория', d.category); add('Стоимость', d.cost);
        add('Урон', d.damage && `${d.damage} ${d.damage_type}`); add('КД', d.ac); add('Вес', d.weight && d.weight + ' фнт'); add('Свойства', d.properties); add('Редкость', d.rarity); add('Настройка', d.attunement && 'Требуется');
        if (d.stealth_disadvantage) add('Скрытность', 'Помеха'); if (d.str_req) add('Требование', 'Сила ' + d.str_req);
        break;
      case 'spell':
        add('Уровень', d.level === 0 ? 'Заговор' : d.level); add('Школа', d.school); add('Время', d.casting_time); add('Дистанция', d.range); add('Компоненты', d.components);
        add('Длительность', (d.concentration ? 'Концентрация, ' : '') + (d.duration || '')); add('Ритуал', d.ritual && 'Да'); add('Классы', d.classes);
        break;
      case 'monster':
        add('Тип', `${d.size} ${d.type}`); add('КД', d.ac); add('Хиты', d.hp); add('Скорость', d.speed); add('Опасность', `${d.cr} (${d.xp || 0} опыта)`);
        add('Характеристики', d.abilities && Object.entries(d.abilities).map(([k, v]) => `${ABIL[k].slice(0, 3)} ${v} (${fmtMod(mod(v))})`).join(', '));
        add('Чувства', d.senses); add('Языки', d.languages); add('Уязвимости', d.vulnerabilities); add('Иммунитеты', d.immunities);
        break;
    }
    const wrap = el('div');
    wrap.append(el('div', { class: 'row', style: 'align-items:flex-start' }, el('h2', { style: 'flex:1' }, e.name), el('span', { class: 'badge' }, e.source)));
    if (rows.length) wrap.append(el('table', {}, ...rows.map(([k, v]) => el('tr', {}, el('td', {}, k), el('td', {}, String(v))))));
    if (d.desc) wrap.append(el('p', {}, d.desc));
    const block = (title, arr, f) => { if (arr && arr.length) { wrap.append(el('h3', { style: 'margin-top:12px' }, title)); arr.forEach(x => wrap.append(f(x))); } };
    block('Особенности', d.traits, t => el('p', {}, el('b', {}, t.name + '. '), t.text));
    block('Подрасы', d.subraces, s => el('p', {}, el('b', {}, s.name + ' (' + asi(s.asi) + '). '), s.text));
    block('Действия', d.actions, a => {
      const p = el('p', {}, el('b', {}, a.name + '. '), a.text);
      const roll = window.TABLE_CTX?.roll || (window.parent !== window && ((expr, label) => window.parent.postMessage({ type: 'roll', expr, label }, '*')));
      if (roll) {
        const hit = a.text.match(/([+-]\d+)\s*(?:к|к попаданию|,)/);
        const dmg = a.text.match(/(\d+к\d+(?:\s*[+-]\s*\d+)?)/);
        if (hit) p.append(el('span', { class: 'rollbtn', title: 'Бросок атаки', onclick: () => roll('d20' + hit[1], `${e.name}: ${a.name} (атака)`) }, '🎯 ' + hit[1]));
        if (dmg) p.append(el('span', { class: 'rollbtn', title: 'Урон', onclick: () => roll(dmg[1].replace(/\s/g, '').replace(/к/g, 'd'), `${e.name}: ${a.name} (урон)`) }, '💥 ' + dmg[1]));
      }
      return p;
    });
    if (e.category === 'monster' && d.abilities) {
      const roll = window.TABLE_CTX?.roll;
      if (roll) wrap.append(el('p', {}, el('span', { class: 'rollbtn', onclick: () => roll('d20' + fmtMod(mod(d.abilities.dex || 10)), e.name + ': инициатива') }, '🎲 Инициатива'),
        ...Object.entries(d.abilities).map(([k, v]) => el('span', { class: 'rollbtn', onclick: () => roll('d20' + fmtMod(mod(v)), `${e.name}: ${ABIL[k]}`) }, ABIL[k].slice(0, 3) + ' ' + fmtMod(mod(v))))));
    }
    if (d.features) { wrap.append(el('h3', { style: 'margin-top:12px' }, 'Умения по уровням')); Object.entries(d.features).forEach(([lvl, fs]) => wrap.append(el('p', {}, el('b', {}, lvl + ' ур.: '), fs.join(', ')))); }
    if (e.campaign_id && window.TABLE_CTX?.isGM) {
      wrap.append(el('div', { class: 'row', style: 'margin-top:12px' },
        el('button', { class: 'small', onclick: () => editEntry(e) }, 'Редактировать'),
        el('button', { class: 'small danger', onclick: async () => { if (confirm('Удалить запись?')) { await API.del('/api/compendium/' + e.id); e._onDelete && e._onDelete(); } } }, 'Удалить')));
    }
    return wrap;
  }

  async function editEntry(e, campaignId, onSaved) {
    const name = el('input', { value: e?.name || '', placeholder: 'Название' });
    const cat = el('select', {}, ...Object.entries(CAT_NAMES).map(([k, v]) => el('option', { value: k, selected: e?.category === k ? '' : null }, v)));
    const json = el('textarea', { style: 'min-height:200px;font-family:monospace;font-size:12px' }, JSON.stringify(e?.data || { desc: '' }, null, 2));
    const ok = await modal(e ? 'Редактировать запись' : 'Своя запись (homebrew)', el('div', {}, el('div', { class: 'field' }, el('label', {}, 'Категория'), cat), el('div', { class: 'field' }, el('label', {}, 'Название'), name), el('div', { class: 'field' }, el('label', {}, 'Данные (JSON, поля как у базовых записей)'), json)),
      [{ label: 'Сохранить', cls: 'primary', fn: () => { try { JSON.parse(json.value); return true; } catch { alert('Неверный JSON'); return false; } } }]);
    if (!ok) return;
    const body = { category: cat.value, name: name.value, data: JSON.parse(json.value), campaign_id: campaignId || e.campaign_id };
    if (e?.id) await API.patch('/api/compendium/' + e.id, body); else await API.post('/api/compendium', body);
    toast('Сохранено'); onSaved && onSaved();
  }

  // Виджет: категории + поиск + список + карточка. dragType: что класть в dataTransfer.
  function widget(opts = {}) {
    const root = el('div', { class: 'comp' });
    const left = el('div', { style: 'display:flex;flex-direction:column;min-height:0' });
    const catSel = el('select', {}, ...Object.entries(CAT_NAMES).map(([k, v]) => el('option', { value: k }, v)));
    const q = el('input', { placeholder: 'Поиск…' });
    const lst = el('div', { class: 'list lst', style: 'flex:1;margin-top:6px' });
    const det = el('div', { class: 'det' }, el('p', { class: 'muted' }, 'Выберите запись. Записи можно перетаскивать на лист персонажа или на стол.'));
    left.append(catSel, el('div', { style: 'height:6px' }), q, lst);
    if (opts.campaignId && opts.isGM) left.append(el('button', { class: 'small', style: 'margin-top:6px', onclick: () => editEntry(null, opts.campaignId, load) }, '+ Своя запись'));
    root.append(left, det);
    let timer;
    async function load() {
      const params = new URLSearchParams({ category: catSel.value }); if (q.value) params.set('q', q.value); if (opts.campaignId) params.set('campaign_id', opts.campaignId);
      const items = await API.get('/api/compendium?' + params);
      lst.innerHTML = '';
      for (const e of items) {
        const it = el('div', { class: 'item', draggable: 'true' }, el('span', { class: 'grow' }, e.name), e.campaign_id ? el('span', { class: 'badge' }, 'HB') : null);
        it.addEventListener('click', () => { lst.querySelectorAll('.item').forEach(x => x.classList.remove('active')); it.classList.add('active'); e._onDelete = load; det.innerHTML = ''; det.append(renderData(e)); });
        it.addEventListener('dragstart', ev => { ev.dataTransfer.setData('application/x-compendium', JSON.stringify(e)); ev.dataTransfer.setData('text/plain', e.name); ev.dataTransfer.effectAllowed = 'copy'; });
        lst.append(it);
      }
    }
    catSel.addEventListener('change', load);
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
    load();
    return root;
  }
  return { widget, renderData, editEntry };
})();
