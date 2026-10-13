// Construiește baza de camere pentru extensie din OpenStreetMap (Overpass API).
// Ieșire: <out>/cameras.tsv.gz, <out>/meta.json, <out>/README.md
// Rulare: node scripts/build.mjs out
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = process.argv[2] || 'out';
const PREV_META_URL = process.env.PREV_META_URL || '';
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';
const MIN_KEEP = 0.9;   // refuză publicarea dacă numărul scade sub 90% din versiunea anterioară

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];

// [sud, vest, nord, est] — SUA continentală (+ sudul Canadei) în fâșii, apoi Alaska, Hawaii, Puerto Rico
const BOXES = [];
for (let w = -125; w < -66; w += 7.5) BOXES.push([24, w, 60, Math.min(w + 7.5, -66)]);
BOXES.push([51, -180, 72, -129]);
BOXES.push([18, -161, 23, -154]);
BOXES.push([17.5, -68, 18.6, -65]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function query(b) {
  const bb = b.join(',');
  return `[out:json][timeout:300];(node["surveillance:type"="ALPR"](${bb});node["highway"="speed_camera"](${bb}););out body qt;`;
}

async function overpass(q, label) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of ENDPOINTS) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'camroute-builder (github.com/DenisPr0/cameras)' },
          body: new URLSearchParams({ data: q }),
          signal: AbortSignal.timeout(340000)
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (data.remark && /error|timed out|out of memory/i.test(data.remark)) throw new Error(data.remark);
        if (!Array.isArray(data.elements)) throw new Error('răspuns fără elements');
        return data;
      } catch (e) {
        lastErr = e;
        console.warn(`  ${label}: ${new URL(url).host} a eșuat (${e.message})`);
      }
    }
    await sleep(30000 * (attempt + 1));
  }
  throw new Error(`${label}: Overpass nu a răspuns după 3 runde (${lastErr && lastErr.message})`);
}

const clean = (s) => String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' ').trim();
const num = (x) => String(+x.toFixed(5));

async function main() {
  const nodes = new Map();
  let osmBase = '';
  for (let i = 0; i < BOXES.length; i++) {
    const label = `zona ${i + 1}/${BOXES.length} [${BOXES[i].join(', ')}]`;
    const t0 = Date.now();
    const data = await overpass(query(BOXES[i]), label);
    for (const el of data.elements) if (el.type === 'node' && Number.isFinite(el.lat)) nodes.set(el.id, el);
    if (data.osm3s && data.osm3s.timestamp_osm_base) osmBase = data.osm3s.timestamp_osm_base;
    console.log(`${label}: ${data.elements.length} noduri în ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (i < BOXES.length - 1) await sleep(8000);
  }

  let alpr = 0, speed = 0;
  const rows = ['#camroute v1\tid\tlat\tlng\tk\tdir\tmfr\top'];
  const sorted = [...nodes.values()].sort((a, b) => a.id - b.id);
  for (const el of sorted) {
    const t = el.tags || {};
    const isAlpr = t['surveillance:type'] === 'ALPR';
    if (isAlpr) alpr++; else speed++;
    rows.push([
      el.id, num(el.lat), num(el.lon), isAlpr ? 'a' : 's',
      clean(t['camera:direction'] || t.direction),
      clean(t.manufacturer || t.brand || t['camera:manufacturer']),
      clean(t.operator)
    ].join('\t'));
  }
  const count = alpr + speed;
  console.log(`Total: ${count} (ALPR ${alpr}, viteză ${speed})`);
  if (count < 1000) throw new Error(`Prea puține camere (${count}); nu public.`);

  if (PREV_META_URL && !FORCE) {
    try {
      const r = await fetch(PREV_META_URL, { signal: AbortSignal.timeout(20000) });
      if (r.ok) {
        const prev = await r.json();
        if (prev.count && count < prev.count * MIN_KEEP) {
          throw new Error(`Numărul a scăzut de la ${prev.count} la ${count} (probabil date incomplete). Nu public. Rulează manual cu force dacă e corect.`);
        }
      }
    } catch (e) {
      if (/Nu public/.test(e.message)) throw e;
      console.warn(`Versiunea anterioară nu s-a putut citi (${e.message}); continui.`);
    }
  }

  const gz = gzipSync(Buffer.from(rows.join('\n') + '\n', 'utf8'), { level: 9 });
  const meta = {
    version: 1,
    updated: new Date().toISOString(),
    osm_base: osmBase,
    count, alpr, speed,
    file: 'cameras.tsv.gz',
    bytes: gz.length,
    license: 'ODbL 1.0 — © OpenStreetMap contributors'
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/cameras.tsv.gz`, gz);
  writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta, null, 2) + '\n');
  writeFileSync(`${OUT}/README.md`,
`# Date camere (generat automat)

Actualizat: ${meta.updated} — ${count} camere (ALPR ${alpr}, viteză ${speed}).

Format \`cameras.tsv.gz\` (gzip, TSV): \`id, lat, lng, k (a = ALPR, s = viteză), direcție, producător, operator\`.

Date © OpenStreetMap contributors, licență ODbL 1.0 (https://www.openstreetmap.org/copyright).
`);
  console.log(`Scris ${OUT}/cameras.tsv.gz (${(gz.length / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
