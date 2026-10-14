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
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
const Q_TIMEOUT = 90;                  // timeout declarat în query: mic = acceptat mai ușor de server
const Q_MAXSIZE = 128 * 1024 * 1024;   // memorie declarată: mică = acceptat mai ușor
const MAX_DEPTH = 3;                   // o zonă care eșuează se împarte în 4, de maximum 3 ori
const PAUSE_MS = 3000;                 // pauză între cereri reușite

// Zone mici (9° lat x 6° lng): fiecare cerere termină repede, înainte ca serverul să dea 504.
// [sud, vest, nord, est] — SUA continentală + sudul Canadei, apoi Alaska, Hawaii, Puerto Rico
function makeBoxes() {
  const boxes = [];
  for (let s = 24; s < 60; s += 9) {
    for (let w = -125; w < -66; w += 6) boxes.push([s, w, Math.min(s + 9, 60), Math.min(w + 6, -66)]);
  }
  boxes.push([51, -180, 72, -154.5], [51, -154.5, 72, -129]);
  boxes.push([18, -161, 23, -154]);
  boxes.push([17.5, -68, 18.6, -65]);
  return boxes;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const host = (u) => new URL(u).host;

function query(b) {
  const bb = b.map((v) => +v.toFixed(4)).join(',');
  return `[out:json][timeout:${Q_TIMEOUT}][maxsize:${Q_MAXSIZE}];` +
    `(node["surveillance:type"="ALPR"](${bb});node["highway"="speed_camera"](${bb}););out body qt;`;
}

// O încercare pe toate serverele, începând cu ultimul care a mers
let epStart = 0;
async function tryAllEndpoints(q, label) {
  let lastErr = null;
  for (let k = 0; k < ENDPOINTS.length; k++) {
    const idx = (epStart + k) % ENDPOINTS.length;
    const url = ENDPOINTS[idx];
    const t0 = Date.now();
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'camroute-builder (github.com/DenisPr0/cameras)' },
        body: new URLSearchParams({ data: q }),
        signal: AbortSignal.timeout((Q_TIMEOUT + 60) * 1000)
      });
      if (!r.ok) {
        const body = (await r.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
        throw new Error(`HTTP ${r.status}${body ? ' — ' + body : ''}`);
      }
      const data = await r.json();
      if (data.remark && /error|timed out|out of memory/i.test(data.remark)) throw new Error(data.remark);
      if (!Array.isArray(data.elements)) throw new Error('răspuns fără elements');
      epStart = idx;
      return data;
    } catch (e) {
      lastErr = e;
      console.warn(`    ${label}: ${host(url)} a eșuat după ${((Date.now() - t0) / 1000).toFixed(0)} s (${e.message})`);
    }
  }
  throw lastErr || new Error('niciun server');
}

// Descarcă o zonă; dacă nu merge, o împarte în 4 și încearcă bucățile
async function fetchBox(box, depth, label) {
  const q = query(box);
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    try {
      const data = await tryAllEndpoints(q, label);
      console.log(`${label}: ${data.elements.length} noduri în ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      return [data];
    } catch (e) {
      if (attempt === 0) await sleep(20000);
    }
  }
  if (depth >= MAX_DEPTH) throw new Error(`${label}: Overpass nu a răspuns nici după împărțirea zonei.`);
  console.log(`${label}: împart zona în 4`);
  const [s, w, n, e] = box;
  const mLat = (s + n) / 2, mLng = (w + e) / 2;
  const subs = [[s, w, mLat, mLng], [s, mLng, mLat, e], [mLat, w, n, mLng], [mLat, mLng, n, e]];
  const out = [];
  for (let i = 0; i < 4; i++) {
    out.push(...await fetchBox(subs[i], depth + 1, `${label}.${i + 1}`));
    await sleep(PAUSE_MS);
  }
  return out;
}

const clean = (s) => String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' ').trim();
const num = (x) => String(+x.toFixed(5));

async function main() {
  const nodes = new Map();
  let osmBase = '';
  const boxes = makeBoxes();
  const tStart = Date.now();
  for (let i = 0; i < boxes.length; i++) {
    const label = `zona ${i + 1}/${boxes.length} [${boxes[i].join(', ')}]`;
    const parts = await fetchBox(boxes[i], 0, label);
    for (const data of parts) {
      for (const el of data.elements) if (el.type === 'node' && Number.isFinite(el.lat)) nodes.set(el.id, el);
      if (data.osm3s && data.osm3s.timestamp_osm_base) osmBase = data.osm3s.timestamp_osm_base;
    }
    if (i < boxes.length - 1) await sleep(PAUSE_MS);
  }
  console.log(`Descărcare terminată în ${((Date.now() - tStart) / 60000).toFixed(1)} min`);

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
