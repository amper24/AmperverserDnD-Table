// Dependencies from a character sheet on compendium packs. These IDs are
// preserved alongside snapshots so a character remains traceable even if a pack
// is later disabled for its campaign.
window.PackDependencies = (() => {
  function fromSheet(sheet) {
    const found = new Map();
    const records = [
      ...(Array.isArray(sheet?.modules) ? sheet.modules : []),
      ...(Array.isArray(sheet?.inventory) ? sheet.inventory : []),
      ...(Array.isArray(sheet?.spells?.known) ? sheet.spells.known : []),
      ...(Array.isArray(sheet?.features) ? sheet.features : []),
    ];
    for (const record of records) {
      const snapshot = record?.snapshot || {};
      const id = record?.pack_id || snapshot.pack_id;
      if (typeof id !== 'string' || !id) continue;
      const name = record?.pack_name || snapshot.pack_name || record?.source || snapshot.source || '';
      const previous = found.get(id);
      if (!previous?.name && name) found.set(id, { id, name });
      else if (!previous) found.set(id, { id, name: '' });
    }
    return [...found.values()];
  }

  function missing(sheet, enabledPacks) {
    const enabled = new Set((enabledPacks || []).map(pack => pack.id));
    return fromSheet(sheet).filter(pack => !enabled.has(pack.id));
  }

  function label(pack, knownPacks = []) {
    return pack.name || knownPacks.find(item => item.id === pack.id)?.name || `Набор ${pack.id.slice(0, 8)}`;
  }

  return { fromSheet, missing, label };
})();
