// ---------------------------------------------------------------------------
// editor-page.js — отдельная страница редактора записи справочника: класс, раса,
// предыстория. Запись правится на своём экране со своим адресом (/class-editor/<id>),
// а не модалкой поверх справочника: большие записи удобнее править на всю страницу,
// видно все разделы, а ссылку на редактор можно дать другому мастеру.
// Граф механик здесь не показывается: редакторы пишут узлы сами, граф остаётся
// инструментом предметов и макросов.
// Даёт: window.EditorPage { KINDS, kindOfPath, idOfPath, url, available, render, open }.
// ---------------------------------------------------------------------------
window.EditorPage = (() => {
  const KINDS = {
    class: { category: 'class', path: '/class-editor', label: 'Класс', back: '/compendium', editor: () => window.ClassEditor },
    race: { category: 'race', path: '/race-editor', label: 'Раса', back: '/compendium', editor: () => window.RaceEditor },
    background: { category: 'background', path: '/background-editor', label: 'Предыстория', back: '/compendium', editor: () => window.BackgroundEditor },
  };
  /// Отдельная страница возможна, только если редактор умеет отдавать тело (form).
  const available = kind => Boolean(KINDS[kind]?.editor()?.form);
  /// Адрес страницы: /class-editor/<id>; для новой записи места сохранения идут параметрами.
  function url(kind, id, o = {}) {
    const q = new URLSearchParams();
    if (!id) { if (o.packId) q.set('pack', o.packId); if (o.campaignId) q.set('campaign', o.campaignId); }
    const query = q.toString();
    return KINDS[kind].path + (id ? '/' + id : '') + (query ? '?' + query : '');
  }
  const trimPath = pathname => String(pathname || '/').replace(/\/+$/, '') || '/';
  /// Вид редактора по адресу страницы: /class-editor, /race-editor/<id> и подобные.
  function kindOfPath(pathname) {
    const path = trimPath(pathname);
    return Object.keys(KINDS).find(k => path === KINDS[k].path || path.startsWith(KINDS[k].path + '/')) || null;
  }
  const idOfPath = pathname => {
    const kind = kindOfPath(pathname);
    return kind ? (trimPath(pathname).slice(KINDS[kind].path.length).replace(/^\//, '') || null) : null;
  };

  /// Куда возвращаться: в набор, к кампании или в справочник.
  const backURL = o => o.packId ? '/packs' : o.campaignId ? '/campaigns' : '/compendium';
  const backLabel = o => o.packId ? 'Наборы' : o.campaignId ? 'Кампании' : 'Справочник';

  /// Новая запись: где её хранить. Возвращает { node, value() } — до сохранения ничего не создаётся.
  async function destinationField(o) {
    const packs = await Promise.resolve(API.get('/api/packs?scope=mine')).catch(() => []);
    const option = (value, text, selected) => el('option', { value, selected: selected ? '' : null }, text);
    const sel = el('select', { 'aria-label': 'Куда сохранить запись' },
      o.campaignId ? option('campaign:' + o.campaignId, 'Homebrew этой кампании', true) : null,
      ...packs.map(p => option('pack:' + p.id, 'Набор: ' + (p.name || ''), !o.campaignId && p.id === o.packId)),
      window.ME?.is_root ? option('base', 'Базовый справочник (root)') : null,
      option('new', '+ Новый набор…'));
    sel.addEventListener('change', async () => {
      if (sel.value !== 'new') return;
      const previous = sel.options[sel.selectedIndex - 1]?.value;
      const name = await prompt2('Название набора');
      if (!name) { sel.value = previous || sel.options[0]?.value || ''; return; }
      const pack = await API.post('/api/packs', { name });
      const added = option('pack:' + pack.id, 'Набор: ' + name);
      sel.insertBefore(added, sel.firstChild);
      sel.value = 'pack:' + pack.id;
    });
    const value = () => { const v = sel.value || ''; if (v.startsWith('pack:')) return { packId: v.slice(5), campaignId: null };
      if (v.startsWith('campaign:')) return { packId: null, campaignId: v.slice(9) }; return { packId: null, campaignId: null }; };
    return { node: el('label', { class: 'ced-inline' }, el('span', { class: 'muted small' }, 'Сохранить в'), sel), value };
  }

  /// Каталог записей: редактору расы нужен (линия наследует поля корневой расы).
  const catalogOf = async kind => (kind === 'race' ? await Promise.resolve(API.get('/api/compendium?category=race&limit=3000&raw=1')).catch(() => []) : undefined);

  /// Страница редактора: заголовок, разделы и сохранение. host — контейнер страницы.
  async function render(host, o = {}) {
    const kind = o.kind, K = KINDS[kind];
    if (!K) return;
    if (!available(kind)) { host.append(el('p', { class: 'muted' }, 'Редактор не загрузился: обновите страницу.')); return; }
    const params = new URLSearchParams(o.search || '');
    const id = o.id || null;
    let entry = null;
    if (id) {
      try { entry = await API.get('/api/compendium/' + encodeURIComponent(id) + '?raw=1'); }
      catch (e) {
        host.append(el('div', { class: 'card' }, el('h2', {}, 'Запись не найдена'), el('p', { class: 'muted' }, String(e.message || e)),
          el('a', { class: 'btn', href: backURL({}) }, 'В справочник')));
        return;
      }
    }
    const destination = id ? null : await destinationField({ packId: params.get('pack'), campaignId: params.get('campaign') });
    const f = K.editor().form(entry, { catalog: await catalogOf(kind), packId: entry?.pack_id, campaignId: entry?.campaign_id });
    // Запись, в которую сохраняем: у новой она появится после первого сохранения.
    let saved = entry ? { id: entry.id, pack_id: entry.pack_id, campaign_id: entry.campaign_id } : null;
    let dirty = false;
    const status = el('span', { class: 'muted small' });
    const setStatus = text => status.replaceChildren(text);
    const markDirty = () => { if (dirty) return; dirty = true; setStatus('есть несохранённые правки'); };
    f.root.addEventListener('input', markDirty);
    f.root.addEventListener('change', markDirty);
    // Уход со страницы с правками — через вопрос браузера, а не молча.
    const guard = e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener?.('beforeunload', guard);

    const save = async () => {
      const res = f.save(); if (!res) return;                    // пустое название — редактор уже подсказал
      const place = saved ? { packId: saved.pack_id, campaignId: saved.campaign_id } : destination.value();
      const body = { category: K.category, name: res.name, data: res.data, pack_id: place.packId, campaign_id: place.campaignId };
      try {
        if (saved) await API.patch('/api/compendium/' + saved.id, body);
        else {
          const created = await API.post('/api/compendium', body);
          saved = { id: created.id, pack_id: created.pack_id ?? place.packId, campaign_id: created.campaign_id ?? place.campaignId };
          // У новой записи появляется свой адрес: страницу можно обновить или сохранить в закладки.
          history.replaceState(null, '', url(kind, saved.id));
          destination?.node.remove();
        }
        dirty = false; setStatus('сохранено');
        toast('Сохранено');
        o.onSaved && o.onSaved(saved, res);
      } catch (err) { toast('Ошибка: ' + (err.message || err), 4000); }
    };

    const head = el('div', { class: 'row ed-head' },
      el('a', { class: 'btn small', href: backURL(saved || { packId: params.get('pack'), campaignId: params.get('campaign') }) },
        '← ' + backLabel(saved || { packId: params.get('pack'), campaignId: params.get('campaign') })),
      el('h1', { style: 'flex:1;margin:0' }, f.title),
      el('span', { class: 'badge' }, K.label),
      status,
      el('button', { class: 'primary', onclick: save }, 'Сохранить'));
    const lead = el('p', { class: 'muted small' }, saved
      ? 'Правки идут в саму запись справочника: их сразу видят мастер создания, лист персонажа и повышение уровня. Механики графа редактор ведёт сам — открывать его не нужно.'
      : 'Выберите, где хранить запись, заполните разделы и сохраните. Дальше правки идут в саму запись справочника.');
    document.title = f.title + ' — Edge Tablet';
    host.replaceChildren(head, destination ? el('div', { class: 'ed-dest' }, destination.node) : el('div'), lead, f.root);
  }

  /// Открыть редактор записи. Возвращает false, если отдельной страницы нет —
  /// тогда вызывающий (справочник) показывает модалку, как раньше.
  function open(kind, o = {}) {
    if (!available(kind)) return false;
    const href = url(kind, o.id || null, o);
    // На столе и на листе страница открывается рядом (в новой вкладке), чтобы не терять стол.
    if (window.TABLE_CTX || window.SHEET_CTX) window.open(href, '_blank'); else go(href);
    return true;
  }

  return { KINDS, kindOfPath, idOfPath, url, available, render, open, backURL };
})();
