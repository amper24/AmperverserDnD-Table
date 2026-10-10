// Переводит механики SRD-файла из формата блоков v1 в граф v2 тем же конвертером, что использует редактор (Mechanics.migrate).
// Запуск: node tools/srd/graph_convert.cjs <вход.json> [выход.json]
// Нужен Chromium (tests/browser-launch.cjs) и playwright в NODE_PATH. Записи без механик не трогаются.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..', '..');

function assetRoutes(page) {
  return page.route('https://srd-convert.test/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/static/')) return route.fulfill({ body: fs.readFileSync(path.join(ROOT, url.pathname)), contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><div id="app"></div>' + ['common', 'dice', 'formulas', 'equipment', 'mechanics', 'node-params-form', 'node-registry', 'node-menu', 'mechanics-graph', 'asset-kinds', 'modules'].map(n => `<script src="/static/${n}.js"></script>`).join('') });
  });
}

async function convert(rows) {
  const browser = await chromium.launch(await require('../../tests/browser-launch.cjs')());
  try {
    const page = await browser.newPage();
    await assetRoutes(page);
    await page.goto('https://srd-convert.test/');
    return await page.evaluate(rows => {
      const clone = o => JSON.parse(JSON.stringify(o));
      const stats = { converted: 0, skipped: 0, invalid: [], lossy: [] };
      const convertOne = (v1, category, slug, label) => {
        const v2 = Mechanics.migrate({ mechanics: clone(v1) }, category);
        const problem = Mechanics.validate(v2);
        if (problem) stats.invalid.push(`${slug} ${label}: ${problem}`);
        if (v2.origin === 'srd-blocks-v1') v2.origin = 'srd-graph-v2';
        const before = (v1.programs || []).map(p => (p.blocks || []).length).reduce((a, b) => a + b, 0);
        const after = (Mechanics.toLegacy(v2).programs || []).map(p => (p.blocks || []).length).reduce((a, b) => a + b, 0);
        if (before !== after) stats.lossy.push(`${slug} ${label}: блоков ${before} → ${after}`);
        return v2;
      };
      // Оверлей перевода (v1, с id программ и блоков) накладывается на русскую v1-структуру тем же слиянием, что и клиент (массивы по id).
      const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
      const merge = (base, over) => {
        if (!isObj(over) || !isObj(base)) return clone(over);
        const out = clone(base);
        for (const [k, v] of Object.entries(over)) {
          if (k.endsWith('!')) { out[k.slice(0, -1)] = clone(v); continue; }
          const cur = out[k];
          if (isObj(v) && isObj(cur)) out[k] = merge(cur, v);
          else if (Array.isArray(v) && Array.isArray(cur) && [...v, ...cur].every(x => isObj(x) && 'id' in x)) {
            const res = cur.slice(), idx = new Map(cur.map((x, i) => [x.id, i]));
            for (const x of v) { if (idx.has(x.id)) res[idx.get(x.id)] = merge(res[idx.get(x.id)], x); else res.push(clone(x)); }
            out[k] = res;
          } else out[k] = clone(v);
        }
        return out;
      };
      const out = rows.map(row => {
        const v1 = row.data?.mechanics;
        const en1 = row.data?.i18n?.en?.mechanics;
        if (!v1 || v1.version === 2 || v1.graph) { stats.skipped++; return row; }
        const ru2 = convertOne(v1, row.category, row.slug, 'ru');
        const data = { ...row.data, mechanics: ru2 };
        if (en1 && en1.version !== 2 && !en1.graph) {
          const en2 = convertOne(merge(v1, en1), row.category, row.slug, 'en');
          const ruNodes = new Map(ru2.graph.nodes.map(n => [n.id, n]));
          const changed = en2.graph.nodes.filter(n => ruNodes.has(n.id) && JSON.stringify(ruNodes.get(n.id).params) !== JSON.stringify(n.params))
            .map(n => ({ id: n.id, params: n.params }));
          if (en2.graph.nodes.length !== ru2.graph.nodes.length) stats.lossy.push(`${row.slug} en: узлов ${ru2.graph.nodes.length} → ${en2.graph.nodes.length}`);
          data.i18n = { ...row.data.i18n, en: { ...row.data.i18n.en, mechanics: { graph: { nodes: changed } } } };
          if (!changed.length) delete data.i18n.en.mechanics;
        }
        stats.converted++;
        return { ...row, data };
      });
      return { rows: out, stats };
    }, rows);
  } finally {
    await browser.close();
  }
}

(async () => {
  const input = process.argv[2], output = process.argv[3] || input;
  if (!input) { console.error('usage: graph_convert.cjs <input.json> [output.json]'); process.exit(2); }
  const rows = JSON.parse(fs.readFileSync(input, 'utf8'));
  const { rows: out, stats } = await convert(rows);
  fs.writeFileSync(output, JSON.stringify(out), 'utf8');
  console.log(`${path.basename(input)}: converted ${stats.converted}, skipped ${stats.skipped}, invalid ${stats.invalid.length}, lossy ${stats.lossy.length}`);
  for (const line of [...stats.invalid, ...stats.lossy].slice(0, 30)) console.log('  ' + line);
  if (stats.invalid.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exit(1); });
