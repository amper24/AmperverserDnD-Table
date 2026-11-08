#!/usr/bin/env node
// Emit standalone subclass and subrace compendium entries from the legacy nested SRD shape.
// Class data keeps its old subclass snapshots for compatibility with existing sheets/clients;
// new editors and builders use the standalone records linked by slug.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const slugPart = value => String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'variant';
for (const edition of ['2014', '2024']) {
  const file = path.join(root, 'data_seed', `srd_${edition}.json`);
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bySlug = new Set(entries.map(e => e.slug));
  const races = entries.filter(e => e.category === 'race' && !e.data?.parent);
  const rootFor = name => races.find(e => e.name === name || e.data?.name_en === name);
  for (const entry of entries) {
    if (entry.category === 'race' && entry.data?.subrace) {
      entry.category = 'subrace';
      const parent = rootFor(entry.data.parent);
      if (parent) entry.data.parent_slug = parent.slug;
    }
  }
  const children = [];
  for (const klass of entries.filter(e => e.category === 'class')) {
    const refs = [];
    const translated = klass.data?.i18n?.en?.['subclasses!'] || klass.data?.i18n?.en?.subclasses || [];
    for (const [index, sub] of (klass.data?.subclasses || []).entries()) {
      if (!sub || typeof sub !== 'object' || !sub.name) continue;
      const slug = `${klass.slug}-subclass-${slugPart(sub.name_en || sub.name)}`;
      refs.push(slug);
      const parentNameEn = klass.data?.i18n?.en?.name || klass.data?.name_en || '';
      const data = { ...JSON.parse(JSON.stringify(sub)), edition, parent_class: klass.name,
        parent_class_slug: klass.slug, parent_class_name_en: parentNameEn };
      const en = translated[index];
      if (en && typeof en === 'object') {
        const overlay = JSON.parse(JSON.stringify(en));
        overlay.parent_class = parentNameEn;
        if (overlay.features) { overlay['features!'] = overlay.features; delete overlay.features; }
        if (overlay.feature_texts) { overlay['feature_texts!'] = overlay.feature_texts; delete overlay.feature_texts; }
        data.i18n = { ...(data.i18n || {}), en: overlay };
      }
      const record = { category: 'subclass', slug, name: sub.name, data };
      const existing = entries.find(e => e.slug === slug);
      if (existing) Object.assign(existing, record); else children.push(record);
      bySlug.add(slug);
    }
    if (refs.length) klass.data.subclass_ids = refs;
  }
  entries.push(...children);
  fs.writeFileSync(file, JSON.stringify(entries));
  console.log(`${edition}: ${children.length} standalone subclasses; ${entries.filter(e => e.category === 'subrace').length} standalone subraces`);
}
