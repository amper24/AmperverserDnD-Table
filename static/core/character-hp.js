// Связь текущих/максимальных HP листа и связанного токена.
// Записи всегда читают свежий лист и обновляют только hp, чтобы не затереть
// параллельные правки других полей; конфликты ревизии перечитываются и повторяются.
window.CharacterHp = (() => {
  const pending = new Map();
  const current = hp => Number(hp?.current ?? hp?.cur ?? 0);
  const maximum = hp => Number(hp?.max ?? 0);
  function same(a, b) { return current(a) === current(b) && maximum(a) === maximum(b); }
  function fromSheet(hp) { return { cur: current(hp), max: maximum(hp) }; }
  function fromToken(hp, sheetHp) {
    return { ...(sheetHp || {}), current: Number(hp?.cur ?? 0), max: Number(hp?.max ?? 0) };
  }
  async function write(characterId, hp) {
    if (!characterId || !window.API) return;
    const desired = { cur: Number(hp?.cur ?? 0), max: Number(hp?.max ?? 0) };
    const prev = pending.get(characterId);
    if (prev) { prev.hp = desired; return prev.promise; }
    const entry = { hp: desired, promise: null };
    entry.promise = (async () => {
      try {
        for (;;) {
          const target = { ...entry.hp };
          const character = await API.get('/api/characters/' + encodeURIComponent(characterId));
          if (same(character.sheet?.hp, target)) {
            if (same(entry.hp, target)) break;
            continue;
          }
          const sheet = { ...character.sheet, hp: { ...(character.sheet?.hp || {}), current: target.cur, max: target.max }, _revision: character.revision ?? character.sheet?._revision };
          try { await API.patch('/api/characters/' + encodeURIComponent(characterId), { sheet }); }
          catch (e) {
            if (e.status === 409) continue;
            throw e;
          }
          if (same(entry.hp, target)) break;
        }
      } catch (e) {
        if (e.status !== 403 && e.status !== 404) console.warn('Не удалось синхронизировать HP персонажа', e);
        else if (window.toast) toast('Нет права обновить хиты листа персонажа', 3500);
      } finally {
        pending.delete(characterId);
      }
    })();
    pending.set(characterId, entry);
    return entry.promise;
  }
  return { current, maximum, same, fromSheet, fromToken, write };
})();
