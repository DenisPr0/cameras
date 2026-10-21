// Construiește baza de weigh stations (stații de cântărire) pentru extensie din OpenStreetMap.
// Doar LOCAȚII (OSM nu are status deschis/închis live). Ieșire în ACELAȘI repo cu camerele:
//   <out>/weigh-stations.tsv.gz, <out>/weigh-meta.json
// Rulare: node scripts/build-weigh.mjs out
// Infrastructura (grilă de zone, retry, împărțire la eșec, verificare prospețime) e identică cu build.mjs.
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
const Q_TIMEOUT = 90;
const Q_MAXSIZE = 128 * 1024 * 1024;
const MAX_DEPTH = 3;
const PAUSE_MS = 3000;
const MAX_LAG_H = +(process.env.MAX_LAG_H || 72);

// Zone mari (18° x 12°) — weigh stations sunt mult mai puține decât camerele, deci zonele pot fi mari.
function makeBoxes() {
  const boxes = [];
  for (let s = 24; s < 60; s += 12) {
    for (let w = -125; w < -66; w += 12) boxes.push([s, w, Math.min(s + 12, 60), Math.min(w + 12, -66)]);
  }
  boxes.push([51, -180, 72, -129]);        // Alaska
  boxes.push([18, -161, 23, -154]);        // Hawaii
  boxes.push([17.5, -68, 18.6, -65]);      // Puerto Rico
  return boxes;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const host = (u) => new URL(u).host;

// weigh stations in OSM: highway=weigh_station (nod sau way), amenity=weighbridge
function query(b) {
  const bb = b.map((v) => +v.toFixed(4)).join(',');
  // În OSM, cântarele sunt sub amenity=weighbridge (highway=weigh_station nu există ca tag real).
  // Luăm tot și FILTRĂM mai jos: păstrăm stațiile de inspecție de stat, scoatem CAT Scale / gunoaie / comerciale.
  return `[out:json][timeout:${Q_TIMEOUT}][maxsize:${Q_MAXSIZE}];` +
    `(node["amenity"="weighbridge"](${bb});way["amenity"="weighbridge"](${bb}););out center tags qt;`;
}

const staleServers = new Set();
const seenBase = new Map();
const served = {};
let oldestBase = null;

function checkFresh(url, data) {
  const base = data.osm3s && data.osm3s.timestamp_osm_base;
  if (!base) return;
  if (!seenBase.has(host(url))) { seenBase.set(host(url), base); console.log(`    ${host(url)}: date OSM din ${base}`); }
  const lagH = (Date.now() - Date.parse(base)) / 3.6e6;
  if (lagH > MAX_LAG_H) { staleServers.add(url); throw new Error(`date vechi (${base}, cu ${Math.round(lagH / 24)} zile în urmă); nu mai folosesc serverul`); }
  if (!oldestBase || Date.parse(base) < Date.parse(oldestBase)) oldestBase = base;
}

let epStart = 0;
async function tryAllEndpoints(q, label) {
  let lastErr = null;
  for (let k = 0; k < ENDPOINTS.length; k++) {
    const idx = (epStart + k) % ENDPOINTS.length;
    const url = ENDPOINTS[idx];
    if (staleServers.has(url)) continue;
    const t0 = Date.now();
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'weigh-builder (github.com/DenisPr0/cameras)' },
        body: new URLSearchParams({ data: q }),
        signal: AbortSignal.timeout((Q_TIMEOUT + 60) * 1000)
      });
      if (!r.ok) { const body = (await r.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120); throw new Error(`HTTP ${r.status}${body ? ' — ' + body : ''}`); }
      const data = await r.json();
      if (data.remark && /error|timed out|out of memory/i.test(data.remark)) throw new Error(data.remark);
      if (!Array.isArray(data.elements)) throw new Error('răspuns fără elements');
      checkFresh(url, data);
      served[host(url)] = (served[host(url)] || 0) + 1;
      epStart = idx;
      return data;
    } catch (e) { lastErr = e; console.warn(`    ${label}: ${host(url)} a eșuat după ${((Date.now() - t0) / 1000).toFixed(0)} s (${e.message})`); }
  }
  throw lastErr || new Error('niciun server actualizat disponibil');
}

async function fetchBox(box, depth, label) {
  const q = query(box);
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    try { const data = await tryAllEndpoints(q, label); console.log(`${label}: ${data.elements.length} elemente în ${((Date.now() - t0) / 1000).toFixed(1)} s`); return [data]; }
    catch (e) { if (attempt === 0) await sleep(20000); }
  }
  if (depth >= MAX_DEPTH) throw new Error(`${label}: Overpass nu a răspuns nici după împărțire.`);
  console.log(`${label}: împart zona în 4`);
  const [s, w, n, e] = box; const mLat = (s + n) / 2, mLng = (w + e) / 2;
  const subs = [[s, w, mLat, mLng], [s, mLng, mLat, e], [mLat, w, n, mLng], [mLat, mLng, n, e]];
  const out = [];
  for (let i = 0; i < 4; i++) { out.push(...await fetchBox(subs[i], depth + 1, `${label}.${i + 1}`)); await sleep(PAUSE_MS); }
  return out;
}

const clean = (s) => String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' ').trim();
const num = (x) => String(+x.toFixed(5));
// nume scurt pentru stație, din tag-urile OSM
function stationName(t) {
  return clean(t.name || t.official_name || t.alt_name || t.operator || 'Weigh Station');
}
// direcția, dacă e cunoscută (EB/WB/NB/SB sau text)
function stationDir(t) {
  return clean(t.direction || t['traffic_sign:direction'] || '');
}
// autostrada, dacă e menționată
function stationRef(t) {
  return clean(t.ref || t.highway_ref || t['addr:highway'] || '');
}

async function main() {
  const items = new Map();   // id unic -> {lat,lng,tags}
  const boxes = makeBoxes();
  const tStart = Date.now();
  for (let i = 0; i < boxes.length; i++) {
    const label = `zona ${i + 1}/${boxes.length} [${boxes[i].join(', ')}]`;
    const parts = await fetchBox(boxes[i], 0, label);
    for (const data of parts) {
      for (const el of data.elements) {
        const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
        const lon = el.lon != null ? el.lon : (el.center && el.center.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const t = el.tags || {};
        // Păstrăm doar stațiile de INSPECȚIE (DOT/poliție). Scoatem cântarele comerciale și de gunoi.
        const nm = String(t.name || '').toLowerCase();
        const br = String(t.brand || '').toLowerCase();
        const op = String(t.operator || '').toLowerCase();
        const all = nm + ' ' + br + ' ' + op;
        // comerciale / neinspectie — scoatem
        if (/cat ?scale|quiktrip|pilot|loves|love's|flying ?j|ta travel|petro|truck ?stop/.test(all)) continue;         // benzinării
        if (/recycl|landfill|waste|garbage|refuse|disposal|gfl|environmental|scrap|salvage/.test(all)) continue;         // gunoi
        if (/quarry|aggregate|materials|concrete|cement|asphalt|gravel|sand|cadman|icon materials/.test(all)) continue;  // construcții
        if (/grain|co-?op|cooperative|elevator|farm|feed|agri/.test(all)) continue;                                      // agricultură
        if (/public ?scale|rawlins public/.test(all)) continue;                                                          // cântare publice comerciale
        // tag-uri OSM care arată comercial
        if (t.fee === 'yes' && !/dot|highway|patrol|inspection|transport|department|dmv|state/i.test(all)) continue;
        const key = el.type[0] + el.id;   // n123 / w456
        items.set(key, { lat, lon, tags: t });
      }
    }
    if (i < boxes.length - 1) await sleep(PAUSE_MS);
  }
  console.log(`Descărcare terminată în ${((Date.now() - tStart) / 60000).toFixed(1)} min`);
  console.log(`Cereri servite: ${JSON.stringify(served)}${staleServers.size ? `; ignorate (date vechi): ${[...staleServers].map(host).join(', ')}` : ''}`);
  console.log(`Cele mai vechi date folosite: ${oldestBase}`);

  const rows = ['#weigh v1\tid\tlat\tlng\tname\tdir\tref'];
  const sorted = [...items.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [key, it] of sorted) {
    rows.push([key, num(it.lat), num(it.lon), stationName(it.tags), stationDir(it.tags), stationRef(it.tags)].join('\t'));
  }
  const count = sorted.length;
  console.log(`Total weigh stations: ${count}`);
  if (count < 100) throw new Error(`Prea puține stații (${count}); nu public.`);

  if (PREV_META_URL && !FORCE) {
    try {
      const r = await fetch(PREV_META_URL, { signal: AbortSignal.timeout(20000) });
      if (r.ok) { const prev = await r.json(); if (prev.count && count < prev.count * MIN_KEEP) throw new Error(`Numărul a scăzut de la ${prev.count} la ${count}. Nu public. Rulează cu FORCE=1 dacă e corect.`); }
    } catch (e) { if (/Nu public/.test(e.message)) throw e; console.warn(`Versiunea anterioară nu s-a putut citi (${e.message}); continui.`); }
  }

  const gz = gzipSync(Buffer.from(rows.join('\n') + '\n', 'utf8'), { level: 9 });
  const meta = {
    version: 1, updated: new Date().toISOString(), osm_base: oldestBase,
    count, file: 'weigh-stations.tsv.gz', bytes: gz.length,
    license: 'ODbL 1.0 — © OpenStreetMap contributors'
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/weigh-stations.tsv.gz`, gz);
  writeFileSync(`${OUT}/weigh-meta.json`, JSON.stringify(meta, null, 2) + '\n');
  console.log(`Scris ${OUT}/weigh-stations.tsv.gz — ${count} stații, ${(gz.length / 1024).toFixed(0)} KB`);
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
