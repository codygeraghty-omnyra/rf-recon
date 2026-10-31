"use strict";
/* RF Recon (beta) for phones: one area's FCC data, offline. Map, list, area report and a field log.
   Packs (.rfpack) are made by RF Recon on the PC and kept in the RF Recon folder in Google Drive. The phone's file
   picker loads them from there and they stay on this phone. Nothing is uploaded anywhere. */

const APP_VERSION = "1.0", BUILD = "ea974c1c51";  // publish.py writes BUILD
const PACK_VERSION = 1;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const fmtF = f => f == null || f === "" ? "" : Number(f).toFixed(5).replace(/0{1,2}$/, "");
const num = (v, d = 0) => v == null || v === "" || isNaN(v) ? "" : Number(v).toFixed(d);
const int = n => Number(n || 0).toLocaleString();
const countBy = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); };

/* ---------- geo (the same maths as the PC app's geo.py) ---------- */
const MI_KM = 1.609344, EARTH_KM = 6371.0088, rad = d => d * Math.PI / 180;
function distKm(a1, o1, a2, o2) {
  const p1 = rad(a1), p2 = rad(a2), dp = p2 - p1, dl = rad(o2 - o1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}
function bearing(a1, o1, a2, o2) {
  const p1 = rad(a1), p2 = rad(a2), dl = rad(o2 - o1);
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = b => COMPASS[Math.floor((b + 11.25) / 22.5) % 16];
function bbox(lat, lon, mi) {
  const r = mi * MI_KM, dlat = r / 111, dlon = r / (111 * Math.max(0.05, Math.cos(rad(lat))));
  return [lat - dlat, lat + dlat, lon - dlon, lon + dlon];
}
// free-space received level at a 0 dBi antenna: best case, no terrain
const fsplRx = (erpW, dKm, f) => !erpW || !f || dKm == null ? null
  : 10 * Math.log10(erpW * 1000) + 2.15 - (20 * Math.log10(Math.max(dKm, 0.05)) + 20 * Math.log10(f) + 32.44);

/* ---------- what the PC app calls things ---------- */
const LAYERS = {
  uls: {label: "FCC licensed", color: "#0b6e4f"}, broadcast: {label: "Broadcast (AM / FM / TV)", color: "#953800"},
  noaa: {label: "NOAA Weather Radio", color: "#1b7c83"}, faa: {label: "Aviation (FAA)", color: "#0550ae"},
  towers: {label: "Towers (FCC ASR)", color: "#57606a"}};
const CLASS = {FB: "Base station", FB2: "Repeater (mobile relay)", FB4: "Community repeater", FB6: "Private carrier base", FB8: "Trunked base",
  FX: "Fixed station", FX1: "Control station", MO: "Mobile units", MO3: "Mobile / control", FBT: "Temporary base"};
const classLabel = c => !c ? "" : CLASS[c] || (c.startsWith("FB") ? `Base / repeater (${c})` : c.startsWith("FX") ? `Fixed (${c})` : c.startsWith("MO") ? `Mobile (${c})` : c);
const STATE_FIPS = {AL: 1, AK: 2, AZ: 4, AR: 5, CA: 6, CO: 8, CT: 9, DE: 10, DC: 11, FL: 12, GA: 13, HI: 15, ID: 16, IL: 17, IN: 18, IA: 19, KS: 20, KY: 21,
  LA: 22, ME: 23, MD: 24, MA: 25, MI: 26, MN: 27, MS: 28, MO: 29, MT: 30, NE: 31, NV: 32, NH: 33, NJ: 34, NM: 35, NY: 36, NC: 37, ND: 38, OH: 39, OK: 40,
  OR: 41, PA: 42, RI: 44, SC: 45, SD: 46, TN: 47, TX: 48, UT: 49, VT: 50, VA: 51, WA: 53, WV: 54, WI: 55, WY: 56};
const rrStateUrl = st => STATE_FIPS[st] ? `https://www.radioreference.com/db/browse/stid/${STATE_FIPS[st]}` : null;
const typeOf = r => r.layer === "towers" ? "Tower / structure" : (r.sig_type || "Unknown");
const colorOf = r => r.layer === "towers" ? LAYERS.towers.color : (S.meta?.sig_lib?.[r.sig_type]?.color || LAYERS[r.layer]?.color || "#8c959f");
const DIGITAL = /P25|DMR|NXDN|Digital|Data|TETRA/;
const USGS = id => `https://basemap.nationalmap.gov/arcgis/rest/services/${id}/MapServer/tile/{z}/{y}/{x}`;
const BASES = {  // USGS maps are public domain, so they can be saved for offline; OpenStreetMap's rules forbid bulk saving
  topo: {label: "Topo (USGS)", url: USGS("USGSTopo"), max: 16, save: true, attr: "USGS The National Map"},
  imagery: {label: "Satellite (USGS)", url: USGS("USGSImageryOnly"), max: 16, save: true, attr: "USGS The National Map"},
  hybrid: {label: "Satellite + labels", url: USGS("USGSImageryTopo"), max: 16, save: true, attr: "USGS The National Map"},
  street: {label: "Street (OpenStreetMap)", url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", max: 19, save: false,
    attr: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}};
const RADII = [0.5, 1, 2, 5, 10, 25];
const MAX_ROWS = 20000;

const S = {db: null, meta: null, pack: null, packs: [], center: null, radius: 5, tab: "map", mode: "area", query: "", rows: [], truncated: false,
  layerOn: new Set(Object.keys(LAYERS)), fmin: null, fmax: null, text: "", base: "topo", me: null, log: [], shown: 200};

/* ---------- storage: packs, the field log and settings stay in this phone's browser storage ---------- */
const idb = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open("rfrecon", 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("packs", {keyPath: "id"}); d.createObjectStore("packdata");
      d.createObjectStore("log", {keyPath: "id", autoIncrement: true}); d.createObjectStore("kv"); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const run = async (store, mode, fn) => { const d = await open(); return new Promise((res, rej) => {
    const t = d.transaction(store, mode), req = fn(t.objectStore(store));
    t.oncomplete = () => res(req?.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error("Storage is full"));
  }); };
  return {get: (s, k) => run(s, "readonly", o => o.get(k)), all: s => run(s, "readonly", o => o.getAll()),
    put: (s, v, k) => run(s, "readwrite", o => k === undefined ? o.put(v) : o.put(v, k)), del: (s, k) => run(s, "readwrite", o => o.delete(k))};
})();
const kv = {get: k => idb.get("kv", k).catch(() => undefined), set: (k, v) => idb.put("kv", v, k).catch(() => {})};

/* ---------- packs ---------- */
let SQLP;
const sqlReady = () => SQLP || (SQLP = initSqlJs({locateFile: f => "vendor/sqljs/" + f}));
async function unpack(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return u8;
  if (!("DecompressionStream" in window)) throw new Error("This browser can't open packs. Update the phone's software (iOS 16.4 or later, or current Chrome).");
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}
const isSqlite = u8 => u8.length > 100 && String.fromCharCode(...u8.subarray(0, 15)) === "SQLite format 3";
function q(sql, args = []) {
  const st = S.db.prepare(sql);
  try { st.bind(args); const out = []; while (st.step()) out.push(st.getAsObject()); return out; } finally { st.free(); }
}
function readMeta(db) {
  const m = {};
  for (const [k, v] of db.exec("SELECT k, v FROM meta")[0]?.values || []) m[k] = JSON.parse(v);
  return m;
}
async function importPack(file) {
  busy(`Opening ${file.name}…`);
  try {
    const buf = await file.arrayBuffer(), raw = await unpack(buf);
    if (!isSqlite(raw)) throw new Error(`${file.name} isn't an RF Recon pack. Pick a file ending in .rfpack from the "field packs" folder.`);
    const SQL = await sqlReady(), db = new SQL.Database(raw);
    let meta;
    try { meta = readMeta(db); } catch (e) { db.close(); throw new Error(`${file.name} isn't an RF Recon pack.`); }
    if (!meta.pack_version) { db.close(); throw new Error(`${file.name} isn't an RF Recon pack.`); }
    if (meta.pack_version > PACK_VERSION) { db.close(); throw new Error("That pack was made by a newer RF Recon. Reload this app to update it, then try again."); }
    const id = `${meta.name}|${meta.made_at}`;
    const info = {id, name: meta.name, made_at: meta.made_at, area: meta.area, counts: meta.counts, fcc_built_at: meta.fcc_built_at,
      bbox: meta.bbox, bboxes: meta.bboxes, size: buf.byteLength, raw: raw.length, added: new Date().toISOString(), file: file.name};
    await idb.put("packdata", buf, id);
    await idb.put("packs", info);
    for (const p of S.packs) if (p.name === meta.name && p.id !== id) { await idb.del("packs", p.id); await idb.del("packdata", p.id); }  // a newer copy replaces the old one
    if (S.db) S.db.close();
    S.db = db; S.meta = meta; S.pack = info;
    await kv.set("activePack", id);
    S.packs = await idb.all("packs");
    navigator.storage?.persist?.().catch(() => {});  // ask the phone not to clear it when space runs low
    busy();
    afterPackOpened(true);
    toast(`Loaded ${meta.name}: ${int(meta.counts?.licences)} licences, ${int(meta.counts?.towers)} towers.`);
  } catch (e) { busy(); toast(e.message || String(e)); }
}
async function openPack(id) {
  const info = await idb.get("packs", id), buf = await idb.get("packdata", id);
  if (!info || !buf) return false;
  const SQL = await sqlReady(), db = new SQL.Database(await unpack(buf));
  if (S.db) S.db.close();
  S.db = db; S.meta = readMeta(db); S.pack = info;
  await kv.set("activePack", id);
  return true;
}
function afterPackOpened(fit) {
  $("#packchip").textContent = S.pack ? S.pack.name : "No data pack";
  if (S.center && !inPack(S.center)) S.center = null;
  if (!S.center && S.pack?.bbox) {
    const [s, n, w, e] = S.pack.bbox;
    if (fit && map) map.fitBounds([[s, w], [n, e]]);
  }
  run(fit);
}
const inPack = c => {  // a pack of several areas holds each area's box
  const bs = S.pack?.bboxes || (S.pack?.bbox ? [S.pack.bbox] : null);
  return !bs || bs.some(b => c[0] >= b[0] - .5 && c[0] <= b[1] + .5 && c[1] >= b[2] - .5 && c[1] <= b[3] + .5);
};

/* ---------- state packs on the RF Recon site (packs/, phone/state_packs.py), loaded on a tap: they cost phone data ---------- */
let SITE_PACKS = null;
async function sitePacks() {
  if (!SITE_PACKS) { try { SITE_PACKS = (await (await fetch("packs/index.json", {cache: "no-cache"})).json()).packs || []; } catch (e) { return []; } }
  return SITE_PACKS;
}
const packHas = (p, c) => (p?.bboxes || (p?.bbox ? [p.bbox] : [])).some(b => c[0] >= b[0] && c[0] <= b[1] && c[1] >= b[2] && c[1] <= b[3]);
async function stateFor(c) {  // the smallest state box around the spot (they overlap along borders)
  const size = s => (s.bbox[1] - s.bbox[0]) * (s.bbox[3] - s.bbox[2]);
  return (await sitePacks()).filter(s => packHas(s, c)).sort((a, b) => size(a) - size(b))[0] || null;
}
async function loadSitePack(s) {
  busy(`Downloading ${s.name} (${num(s.mb, 1)} MB)…`);
  try {
    const r = await fetch(`packs/${s.file}`);
    if (!r.ok) throw new Error(`The RF Recon site didn't send ${s.name} (${r.status}). Try again with signal.`);
    await importPack(new File([await r.blob()], s.file));
  } catch (e) { busy(); toast(e.message || String(e)); }
}
// a spot no loaded pack covers: switch to a saved pack that does, or offer its state from the site
async function offerPackFor(c) {
  const saved = S.packs.find(p => p.id !== S.pack?.id && packHas(p, c));
  if (saved) { toast(`That spot is in ${saved.name}, saved on this phone.`, async () => { busy("Opening pack…"); await openPack(saved.id); busy(); afterPackOpened(false); setCenter(c); }, "Switch"); return; }
  const s = await stateFor(c), was = S.pack ? `That spot is outside ${S.pack.name}.` : "No pack loaded yet.";
  if (s) toast(`${was} ${s.name} is on the RF Recon site (${num(s.mb, 1)} MB).`, async () => { await loadSitePack(s); if (S.db) setCenter(c); }, "Load it");
  else toast(S.pack ? "That spot is outside this pack's area, so nothing will show. Load the pack for that area." : "Load a data pack first: Packs, then Load a pack.");
}

/* ---------- queries ---------- */
function decorate(f, center, radiusMi) {
  if (f.lat == null || !center) return !radiusMi;
  const d = distKm(center[0], center[1], f.lat, f.lon);
  if (radiusMi && d > radiusMi * MI_KM) return false;
  const b = bearing(center[0], center[1], f.lat, f.lon);
  f.dist_mi = d / MI_KM; f.bearing = Math.round(b); f.compass = compass(b);
  const erp = f.erp_w || f.power_out_w;
  if (["uls", "broadcast", "noaa"].includes(f.layer) && erp && f.freq_mhz) f.est_rx_dbm = fsplRx(erp, d, f.freq_mhz);
  return true;
}
const asTx = f => Object.assign(f, {layer: "uls", fid: "uls:" + f.id, label: f.licensee});
const asBcast = f => Object.assign(f, {layer: "broadcast", fid: "bc:" + f.id, category: "Broadcast / Media", erp_w: f.erp_kw ? f.erp_kw * 1000 : null,
  label: `${f.call_sign} ${f.kind === "AM" ? fmtF(f.freq_mhz * 1000) + " kHz" : fmtF(f.freq_mhz) + " MHz"} ${f.kind}${f.kind === "TV" ? ` (ch ${f.channel})` : ""}`});
const asNwr = f => Object.assign(f, {layer: "noaa", fid: "nwr:" + f.id, category: "NOAA Weather Radio", sig_type: "NOAA Weather Radio", erp_w: f.power_w,
  licensee: "NOAA National Weather Service", label: `${f.call_sign} ${f.site} ${num(f.freq_mhz, 3)} MHz`});
const asFaa = f => Object.assign(f, {layer: "faa", fid: "faa:" + f.id, category: "Aviation (FAA)",
  licensee: f.source !== "FRQ" ? "FAA" : (f.call || f.name), label: `${f.ident} ${f.name || ""} · ${f.use || f.kind}`});
const asTower = f => Object.assign(f, {layer: "towers", fid: "tower:" + f.reg, category: "Tower / structure", sig_type: null, freq_mhz: null,
  label: `${f.struct_type || "Structure"} ${f.overall_agl_m ?? "?"} m${f.owner ? " · " + f.owner : ""}`});
const textHit = (f, t) => [f.licensee, f.call_sign, f.city, f.label, f.owner, f.ident, f.name].some(v => v && String(v).toLowerCase().includes(t));

function areaQuery() {
  const [lat, lon] = S.center, [s, n, w, e] = bbox(lat, lon, S.radius);
  const box = "lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?", a = [s, n, w, e];
  const fw = [], fa = [];
  if (S.fmin != null) { fw.push("freq_mhz >= ?"); fa.push(S.fmin); }
  if (S.fmax != null) { fw.push("freq_mhz <= ?"); fa.push(S.fmax); }
  const fsql = fw.length ? " AND " + fw.join(" AND ") : "", t = S.text.toLowerCase();
  let out = [], truncated = false;
  if (S.layerOn.has("uls")) {
    const rows = q(`SELECT * FROM tx WHERE ${box}${fsql} LIMIT ${MAX_ROWS + 1}`, [...a, ...fa]);
    truncated = rows.length > MAX_ROWS;
    out.push(...rows.slice(0, MAX_ROWS).map(asTx));
  }
  if (S.layerOn.has("broadcast")) out.push(...q(`SELECT * FROM bcast WHERE ${box}${fsql}`, [...a, ...fa]).map(asBcast));
  if (S.layerOn.has("noaa")) out.push(...q(`SELECT * FROM nwr WHERE ${box}${fsql}`, [...a, ...fa]).map(asNwr));
  if (S.layerOn.has("faa")) out.push(...q(`SELECT * FROM faa WHERE ${box}${fsql}`, [...a, ...fa]).map(asFaa));
  if (t) out = out.filter(f => textHit(f, t));
  if (S.layerOn.has("towers")) {
    // with a frequency or text filter on, only the towers carrying a matching licence (or an owner match)
    const filtered = S.fmin != null || S.fmax != null || !!t, regs = new Set(out.map(f => f.tower_reg).filter(Boolean));
    for (const f of q(`SELECT * FROM tower WHERE ${box} LIMIT 5000`, a).map(asTower))
      if (!filtered || regs.has(f.reg) || (t && (f.owner || "").toLowerCase().includes(t))) out.push(f);
  }
  out = out.filter(f => decorate(f, S.center, S.radius));
  out.sort((x, y) => (x.dist_mi ?? 1e9) - (y.dist_mi ?? 1e9) || (x.freq_mhz || 0) - (y.freq_mhz || 0));
  return {rows: out, truncated};
}
function parseFreq(s) {
  let m = /^\s*(\d+(?:\.\d+)?)\s*(mhz)?\s*$/i.exec(s);
  if (m) { const f = +m[1]; return f > 0 && f < 100000 ? [f - 0.0005, f + 0.0005] : null; }
  m = /^\s*(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(mhz)?\s*$/i.exec(s);
  return m ? [Math.min(+m[1], +m[2]), Math.max(+m[1], +m[2])] : null;
}
function parseLoc(s) {
  const m = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(s) || /[?&](?:q|ll|query)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/.exec(s) || /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (String(m[1]).includes(".") || String(m[2]).includes(".")) ? [lat, lon] : null;
}
function packSearch(s) {
  const fr = parseFreq(s), from = S.me ? [S.me.lat, S.me.lon] : S.center;
  let out = [];
  if (fr) {
    const a = fr;
    out.push(...q("SELECT * FROM tx WHERE freq_mhz BETWEEN ? AND ? LIMIT 3000", a).map(asTx));
    out.push(...q("SELECT * FROM bcast WHERE freq_mhz BETWEEN ? AND ?", a).map(asBcast));
    out.push(...q("SELECT * FROM nwr WHERE freq_mhz BETWEEN ? AND ?", a).map(asNwr));
    out.push(...q("SELECT * FROM faa WHERE freq_mhz BETWEEN ? AND ? LIMIT 1000", a).map(asFaa));
  } else {
    const like = `%${s}%`, pre = `${s.toUpperCase()}%`;
    out.push(...q("SELECT * FROM tx WHERE licensee LIKE ? OR call_sign LIKE ? LIMIT 3000", [like, pre]).map(asTx));
    out.push(...q("SELECT * FROM bcast WHERE call_sign LIKE ? OR licensee LIKE ?", [pre, like]).map(asBcast));
    out.push(...q("SELECT * FROM faa WHERE ident LIKE ? OR name LIKE ? OR call LIKE ? LIMIT 1000", [pre, like, like]).map(asFaa));
    out.push(...q("SELECT * FROM tower WHERE owner LIKE ? OR reg = ? LIMIT 2000", [like, s.trim()]).map(asTower));
  }
  out = out.filter(f => S.layerOn.has(f.layer));
  out.forEach(f => decorate(f, from, null));
  out.sort((x, y) => (x.dist_mi ?? 1e9) - (y.dist_mi ?? 1e9) || (x.freq_mhz || 0) - (y.freq_mhz || 0));
  return out;
}
function run(fit) {
  if (!S.db) { S.rows = []; render(); return; }
  if (S.mode === "search" && S.query) { S.rows = packSearch(S.query); S.truncated = false; }
  else if (S.center) { S.mode = "area"; const r = areaQuery(); S.rows = r.rows; S.truncated = r.truncated; }
  else S.rows = [];
  S.shown = 200;
  drawMap(fit);
  render();
  writeHash();
}
const groupItems = rows => { const m = new Map();  // one entry per (site, call sign, frequency)
  for (const r of rows) { const k = r.layer === "uls" ? `${r.lat}|${r.lon}|${r.call_sign}|${fmtF(r.freq_mhz)}` : r.fid; if (!m.has(k)) m.set(k, r); }
  return [...m.values()]; };

/* ---------- map ---------- */
let map, baseLayer, dots, ring, ringCase, pin, meDot, meRing;
const canvas = L.canvas({padding: 0.4, tolerance: 12});  // a fingertip is wider than a 5 px dot
const pinIcon = () => L.divIcon({className: "pin", iconSize: [30, 40], iconAnchor: [15, 38],
  html: `<svg width="30" height="40" viewBox="0 0 30 40"><path d="M15 39s13-13.6 13-24A13 13 0 0 0 2 15c0 10.4 13 24 13 24z" fill="${getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#f0a07a"}" stroke="#000c" stroke-width="2"/><circle cx="15" cy="15" r="5" fill="#111"/></svg>`});
function initMap() {
  map = L.map("map", {preferCanvas: true, zoomControl: false, renderer: canvas, worldCopyJump: true}).setView([39.5, -98.35], 4);
  setBase(S.base);
  dots = L.layerGroup().addTo(map);
  map.on("click", e => { closeSuggest(); setCenter([e.latlng.lat, e.latlng.lng], false); });
}
function setBase(id) {
  const b = BASES[id] || BASES.topo;
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = L.tileLayer(b.url, {maxNativeZoom: b.max, maxZoom: 19, crossOrigin: "anonymous", attribution: b.attr}).addTo(map);
  S.base = BASES[id] ? id : "topo";
  kv.set("base", S.base);
}
function sitesOf(rows) {
  const m = new Map();
  for (const r of rows) {
    if (r.lat == null) continue;
    const k = `${(+r.lat).toFixed(5)},${(+r.lon).toFixed(5)}`;
    if (!m.has(k)) m.set(k, {key: k, lat: r.lat, lon: r.lon, rows: []});
    m.get(k).rows.push(r);
  }
  return [...m.values()];
}
function siteColor(site) {
  const radios = site.rows.filter(r => r.layer !== "towers");
  if (!radios.length) return LAYERS.towers.color;
  const top = countBy(radios, typeOf)[0][0];
  return colorOf(radios.find(r => typeOf(r) === top));
}
function drawMap(fit) {
  if (!map) return;
  dots.clearLayers();
  for (const l of [ringCase, ring, pin]) if (l) map.removeLayer(l);
  ring = ringCase = pin = null;
  if (S.mode === "area" && S.center) {
    // a dark casing under the accent ring keeps it visible on a white topo map in the pale skins
    ringCase = L.circle(S.center, {radius: S.radius * 1609.344, color: "rgba(0,0,0,.55)", weight: 4.5, fill: false, interactive: false}).addTo(map);
    ring = L.circle(S.center, {radius: S.radius * 1609.344, color: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#f0a07a",
      weight: 2.5, dashArray: "8 6", fill: false, interactive: false}).addTo(map);
    pin = L.marker(S.center, {icon: pinIcon(), interactive: false, keyboard: false}).addTo(map);
  }
  const sites = sitesOf(S.rows);
  S.sites = new Map(sites.map(s => [s.key, s]));
  for (const s of sites) {
    const n = s.rows.length;
    L.circleMarker([s.lat, s.lon], {renderer: canvas, radius: n > 20 ? 7.5 : n > 4 ? 6 : 4.8, color: "rgba(0,0,0,.55)", weight: 1,
      fillColor: siteColor(s), fillOpacity: 0.92, bubblingMouseEvents: false}).on("click", () => openSite(s)).addTo(dots);
  }
  if (fit) {
    if (S.mode === "area" && S.center) map.fitBounds(L.latLng(S.center).toBounds(S.radius * 1609.344 * 2.2), {paddingTopLeft: [0, 120], paddingBottomRight: [0, 70]});
    else if (sites.length) map.fitBounds(L.latLngBounds(sites.map(s => [s.lat, s.lon])).pad(0.1), {maxZoom: 14, paddingTopLeft: [0, 120], paddingBottomRight: [0, 70]});
  }
  summary();
}
function summary() {
  const el = $("#summary");
  if (!S.db) { el.textContent = "Load a data pack to start"; return; }
  if (!S.rows.length && !S.center && S.mode !== "search") { el.textContent = "Tap the map or search"; return; }
  const radios = S.rows.filter(r => r.layer !== "towers");
  const f = new Set(radios.map(r => fmtF(r.freq_mhz))).size, t = S.rows.length - radios.length;
  el.textContent = S.mode === "search" ? `${int(groupItems(S.rows).length)} results for “${S.query}”`
    : `${int(f)} frequencies · ${int(t)} towers${S.truncated ? " (first 20,000)" : ""}`;
}
function setCenter(c, fit = true) {
  if (!S.db) { offerPackFor(c); return; }
  S.center = c; S.mode = "area"; S.query = ""; $("#q").value = ""; closeSuggest();
  if (!inPack(c)) offerPackFor(c);
  run(fit);
}
function locate(thenCenter = true) {
  return new Promise(res => {
    if (!navigator.geolocation) { toast("This phone isn't sharing its location with the browser."); return res(null); }
    $("#locateBtn").classList.add("on");
    navigator.geolocation.getCurrentPosition(p => {
      S.me = {lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, ts: p.timestamp};
      if (meDot) { map.removeLayer(meDot); map.removeLayer(meRing); }
      meRing = L.circle([S.me.lat, S.me.lon], {radius: S.me.acc, color: "#3d8bfd", weight: 1, fillOpacity: .12, interactive: false}).addTo(map);
      meDot = L.marker([S.me.lat, S.me.lon], {icon: L.divIcon({className: "", html: '<div class="me"></div>', iconSize: [16, 16]}), interactive: false}).addTo(map);
      if (thenCenter) setCenter([S.me.lat, S.me.lon]);
      res(S.me);
    }, err => {
      $("#locateBtn").classList.remove("on");
      toast(err.code === 1 ? "Location is off for this app. Allow it in the phone's settings (Safari or Chrome, Location)." : "Couldn't get a position. Try again outside or near a window.");
      res(null);
    }, {enableHighAccuracy: true, timeout: 15000, maximumAge: 10000});
  });
}

/* ---------- search box ---------- */
let sugT;
function suggest() {
  const s = $("#q").value.trim(), box = $("#suggest");
  if (!s || !S.db) { closeSuggest(); S.suggest = []; return; }
  const items = [], ll = parseLoc(s), fr = parseFreq(s);
  if (ll) items.push({k: "Go to", t: `${ll[0]}, ${ll[1]}`, go: () => setCenter(ll)});
  if (fr) items.push({k: "Frequency", t: fr[1] - fr[0] < 0.01 ? `${fmtF((fr[0] + fr[1]) / 2)} MHz anywhere in the pack` : `${fmtF(fr[0])}–${fmtF(fr[1])} MHz anywhere in the pack`, go: () => packMode(s)});
  if (!ll && !fr && s.length >= 2) {
    for (const p of q("SELECT * FROM place WHERE name LIKE ? ORDER BY (name = ?) DESC, n DESC LIMIT 6", [s + "%", s]))
      items.push({k: p.kind || "Place", t: `${p.name}, ${p.state}`, go: () => setCenter([p.lat, p.lon])});
    items.push({k: "Search", t: `Licensees, call signs and towers matching “${s}”`, go: () => packMode(s)});
  }
  box.innerHTML = items.map((it, i) => `<button type="button" data-i="${i}"><span class="k">${esc(it.k)}</span><span>${esc(it.t)}</span></button>`).join("");
  box.hidden = !items.length;
  box.onclick = e => { const b = e.target.closest("button[data-i]"); if (!b) return; closeSuggest(); $("#q").blur(); items[+b.dataset.i].go(); };
  S.suggest = items;
}
const closeSuggest = () => { $("#suggest").hidden = true; };
function packMode(s) { S.mode = "search"; S.query = s; $("#q").value = s; closeSuggest(); run(true); }

/* ---------- views ---------- */
function setTab(t, push = true) {
  S.tab = t;
  document.body.dataset.tab = t;
  $$("#nav button").forEach(b => b.dataset.t === t ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
  closeSuggest();
  if (t === "map" && map) setTimeout(() => map.invalidateSize(), 0);
  render();
  writeHash(push);
}
function render() {
  if (S.tab === "map") return;
  const v = $("#page");
  ({list: viewList, report: viewReport, log: viewLog, das: v => window.viewDas?.(v), packs: viewPacks})[S.tab]?.(v);  // das.js
  v.scrollTop = 0;
}
const noPack = () => `<div class="card glass empty" style="--i:1"><h2>No data pack yet</h2>
  <p>Packs hold the FCC data for an area. They're in the RF Recon folder in Google Drive, under “field packs”.</p>
  <button class="btn primary" data-act="load">Load a pack</button></div>`;
const where = () => S.mode === "search" ? `results for “${esc(S.query)}” across ${esc(S.pack?.name)}`
  : S.center ? `within ${S.radius} mi of <span class="mono">${S.center[0].toFixed(4)}, ${S.center[1].toFixed(4)}</span>` : "";
function itemHtml(r) {
  const lvl = r.est_rx_dbm != null ? `<small>${num(r.est_rx_dbm)} dBm est.</small>` : "";
  const f = r.freq_mhz != null ? (r.layer === "broadcast" && r.kind === "AM" ? `${fmtF(r.freq_mhz * 1000)} kHz` : `${fmtF(r.freq_mhz)}`) : "";
  const sub = [typeOf(r), r.call_sign || r.reg || r.ident, r.dist_mi != null ? `${num(r.dist_mi, r.dist_mi < 10 ? 2 : 1)} mi ${r.compass}` : (r.state || "")].filter(Boolean).join(" · ");
  return `<div class="item" data-fid="${esc(r.fid)}"><span class="dot" style="background:${colorOf(r)}"></span>
    <div class="main"><div class="t">${esc(r.label || r.licensee || "")}</div><div class="s">${esc(sub)}</div></div>
    <div class="f">${f}${lvl}</div></div>`;
}
function viewList(v) {
  if (!S.db) { v.innerHTML = head("List", "") + noPack(); return; }
  const g = groupItems(S.rows);
  if (!g.length) { v.innerHTML = head("List", where()) + `<div class="card glass empty"><p>${S.center || S.mode === "search" ? "Nothing here with the layers and filters on." : "Tap the map, use where you are, or search."}</p>
    <button class="btn" data-act="map">Open the map</button></div>`; return; }
  v.innerHTML = head("List", `${int(g.length)} entries ${where()}${S.truncated ? ". Showing the first 20,000 licences: zoom in with a smaller radius." : ""}`)
    + takRow()
    + `<div class="card glass" style="--i:1">${g.slice(0, S.shown).map(itemHtml).join("")}
    ${g.length > S.shown ? `<div class="row" style="justify-content:center;padding-top:10px"><button class="btn small" data-act="more">Show ${Math.min(200, g.length - S.shown)} more</button></div>` : ""}</div>`;
}
const head = (title, line) => `<div class="head"><h1>${title}</h1>${line ? `<p>${line}</p>` : ""}</div>`;
const takRow = () => `<div class="row" style="margin:0 2px 12px"><button class="btn small" data-act="tak" title="TAK data package: a marker per site with its frequencies, and the search ring">Send to ATAK / iTAK</button></div>`;
async function sendToTak() {  // tak.js: the same data package the PC app makes
  if (!S.rows.length) { toast("Nothing to send yet: pick a spot or search first."); return; }
  const area = S.mode === "search" ? `“${S.query}”` : `${S.center[0].toFixed(4)}, ${S.center[1].toFixed(4)} ${S.radius} mi`;
  const pkg = await RFTak.save({rows: S.rows, center: S.mode === "area" ? S.center : null, radius: S.radius, name: `RF Recon - ${area}`,
    colorOf, typeOf, fccDate: S.meta?.fcc_built_at});
  toast(`${pkg.name}: ${int(pkg.sites)} sites${pkg.skipped ? ` (nearest ${int(pkg.sites)})` : ""}. In ATAK or iTAK: Import, then the file.`);
}
function viewReport(v) {
  if (!S.db) { v.innerHTML = head("Area report", "") + noPack(); return; }
  if (S.mode !== "area" || !S.center) { v.innerHTML = head("Area report", "") + `<div class="card glass empty"><p>The area report needs a spot: tap the map, use where you are, or search a place.</p>
    <button class="btn primary" data-act="here">Use where I am</button> <button class="btn" data-act="map">Open the map</button></div>`; return; }
  const radios = S.rows.filter(r => r.layer !== "towers"), towers = S.rows.filter(r => r.layer === "towers");
  const freqs = new Set(radios.map(r => fmtF(r.freq_mhz))), lics = new Set(radios.map(r => r.licensee));
  const byBand = new Map();
  for (const r of radios) { const b = r.band || "Other"; if (!byBand.has(b)) byBand.set(b, []); byBand.get(b).push(r); }
  const bands = [...byBand.entries()].map(([band, rs]) => ({band, rs, lo: Math.min(...rs.map(r => r.freq_mhz)), hi: Math.max(...rs.map(r => r.freq_mhz)),
    freqs: new Set(rs.map(r => fmtF(r.freq_mhz))).size, lics: new Set(rs.map(r => r.licensee)).size, techs: countBy(rs, typeOf),
    near: Math.min(...rs.map(r => r.dist_mi ?? 1e9)), best: Math.max(...rs.map(r => r.est_rx_dbm ?? -1e9))})).sort((a, b) => a.lo - b.lo);
  const techs = countBy(radios, typeOf);
  const digital = radios.length ? Math.round(100 * radios.filter(r => DIGITAL.test(r.mode || "")).length / radios.length) : 0;
  const nearest = radios.length ? Math.min(...radios.map(r => r.dist_mi ?? 1e9)) : null;
  const maxF = Math.max(1, ...bands.map(b => b.freqs));
  const st = countBy(radios, r => r.state || "?").find(([s]) => rrStateUrl(s))?.[0];
  const filters = S.fmin != null || S.fmax != null || S.text || S.layerOn.size < Object.keys(LAYERS).length;
  v.innerHTML = head("Area report", `${where()}: <b>${int(freqs.size)}</b> licensed frequencies from <b>${int(lics.size)}</b> licensees, ${digital}% digital${nearest != null && nearest < 1e9 ? `; nearest site ${num(nearest, 2)} mi` : ""}.${filters ? " Filters are on: counts follow them." : ""}`)
    + takRow()
    + `<div class="kpis">${[[int(freqs.size), "Frequencies"], [int(lics.size), "Licensees"], [bands.length, "Bands"], [techs.length, "Technologies"], [int(towers.length), "Towers"],
      [nearest != null && nearest < 1e9 ? num(nearest, nearest < 10 ? 2 : 1) : "–", "Nearest mi"]].map(([val, k], i) => `<div class="kpi glass" style="--i:${i}"><div class="v">${val}</div><div class="k">${k}</div></div>`).join("")}</div>
    <div class="card glass" style="--i:2"><h2>Bands</h2>${bands.length ? `<div class="tw"><table><thead><tr><th>Band</th><th>MHz</th><th class="n">Freqs</th><th class="n">Nearest</th><th class="n">Best dBm</th></tr></thead><tbody>
      ${bands.map(b => `<tr><td>${esc(b.band)}<div class="bar" title="${esc(b.techs.map(([t, n]) => `${t} ${n}`).join(", "))}">${b.techs.map(([t, n]) => `<span style="width:${100 * n / b.rs.length}%;background:${colorOf(b.rs.find(r => typeOf(r) === t))}"></span>`).join("")}</div></td>
        <td class="mono" style="font-size:12.5px">${fmtF(b.lo)}${b.hi > b.lo ? `–${fmtF(b.hi)}` : ""}</td>
        <td class="n" style="background:linear-gradient(90deg,var(--accent-wash) ${Math.round(100 * b.freqs / maxF)}%,transparent 0)">${int(b.freqs)}</td>
        <td class="n">${b.near < 1e9 ? num(b.near, 1) : ""}</td><td class="n">${b.best > -1e9 ? num(b.best) : ""}</td></tr>`).join("")}</tbody></table></div>
      <p class="hint">Levels are free-space estimates from licensed power: best case, no terrain. The bar under each band shows its mix of technologies.</p>` : '<p class="hint">No licensed frequencies with the layers and filters on.</p>'}</div>
    <div class="card glass" style="--i:3"><h2>Technologies</h2>${techs.map(([t, n]) => { const u = t !== "Unknown" && S.meta.sig_lib?.[t]?.url;
      return `<div class="item" style="cursor:default"><span class="dot" style="background:${colorOf(radios.find(r => typeOf(r) === t))}"></span><div class="main"><div class="t">${esc(t)}</div>
        <div class="s">${esc([...new Set(radios.filter(r => typeOf(r) === t).map(r => r.band || "Other"))].join(", "))}${u ? ` · <a href="${esc(u)}" target="_blank" rel="noopener">Signal ID wiki</a>` : ""}</div></div><div class="f">${int(n)}</div></div>`; }).join("") || '<p class="hint">None.</p>'}</div>
    <div class="card glass" style="--i:4"><h2>Every licensed frequency, by band</h2>${bands.map(b => { const g = groupItems(b.rs).sort((x, y) => x.freq_mhz - y.freq_mhz || (x.dist_mi ?? 0) - (y.dist_mi ?? 0));
      return `<details><summary><b>${esc(b.band)}</b><span class="hint">${b.freqs} freqs · ${b.lics} licensees</span></summary>${g.slice(0, 80).map(itemHtml).join("")}
        ${g.length > 80 ? `<p class="hint">First 80 of ${g.length}. The List has them all.</p>` : ""}</details>`; }).join("") || '<p class="hint">None.</p>'}</div>
    ${st ? `<div class="card glass" style="--i:5"><h2>Compare</h2><p style="margin:0">What scanner listeners have logged here: <a href="${rrStateUrl(st)}" target="_blank" rel="noopener">RadioReference ${esc(st)}</a> (pick the county).</p></div>` : ""}
    <p class="hint" style="margin:4px">FCC data as of ${esc(S.meta.fcc_built_at || "?")} · pack ${esc(S.pack.name)}, made ${esc(S.pack.made_at)}.</p>`;
}

/* ---------- detail sheet ---------- */
function openSheet(title, sub, body, onOpen) {
  const sh = $("#sheet");
  sh.innerHTML = `<div class="sh"><div style="flex:1;min-width:0"><h3>${title}</h3>${sub ? `<div class="sub">${sub}</div>` : ""}</div>
    <button class="ibtn" type="button" data-act="close" aria-label="Close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="sb">${body}</div>`;
  sh.hidden = false; $("#scrim").hidden = false;
  sh.onclick = null;  // the sheet is reused: drop the last one's handler
  onOpen?.(sh);
}
function closeSheet() { $("#sheet").hidden = true; $("#scrim").hidden = true; }
function openSite(site) {
  const rows = site.rows.slice().sort((a, b) => (a.layer === "towers" ? -1 : 0) - (b.layer === "towers" ? -1 : 0) || (a.freq_mhz || 0) - (b.freq_mhz || 0));
  const tower = rows.find(r => r.layer === "towers"), radios = groupItems(rows.filter(r => r.layer !== "towers"));
  const any = rows[0], lics = countBy(radios, r => r.licensee || r.label);
  const title = radios.length ? (lics[0][0] || "Licensed site") : (tower?.label || "Structure");
  const sub = [any.dist_mi != null ? `${num(any.dist_mi, 2)} mi ${any.compass} of the pin` : "", radios.length ? `${radios.length} frequencies` : "",
    lics.length > 1 ? `${lics.length} licensees` : ""].filter(Boolean).join(" · ");
  openSheet(esc(title), esc(sub), (tower ? towerHtml(tower) : "") + radios.map(rowHtml).join("")
    + `<p class="hint mono">${(+site.lat).toFixed(5)}, ${(+site.lon).toFixed(5)}</p>`);
}
function towerHtml(t) {
  return `<div class="card glass" style="margin:6px 0 10px;padding:12px 14px"><h2>Tower / structure</h2><dl class="kv">${kvs([["Registration", t.reg], ["Type", t.struct_type],
    ["Height", t.overall_agl_m != null ? `${num(t.overall_agl_m, 1)} m above ground (${num(t.overall_agl_m * 3.2808)} ft)` : ""], ["Top above sea level", t.overall_amsl_m != null ? `${num(t.overall_amsl_m, 1)} m` : ""],
    ["Owner", t.owner], ["Address", [t.street, t.city, t.county, t.state].filter(Boolean).join(", ")], ["Status", t.status], ["Built", t.constructed]])}</dl></div>`;
}
const kvs = pairs => pairs.filter(([, v]) => v != null && v !== "").map(([k, v]) => `<dt>${esc(k)}</dt><dd>${typeof v === "object" ? v.html : esc(v)}</dd>`).join("");
function rowHtml(r) {
  const fid = esc(r.fid);
  let pairs = [];
  if (r.layer === "uls") pairs = [["Licensee", r.licensee], ["Call sign", {html: `<span class="mono">${esc(r.call_sign)}</span>${r.usi ? ` · <a href="https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey=${r.usi}" target="_blank" rel="noopener">FCC licence ↗</a>` : ""}`}],
    ["Service", r.service_name], ["Category", r.category], ["Station", classLabel(r.station_class)], ["Technology", r.mode], ["Emission", r.emissions],
    ["Bandwidth", r.bandwidth_khz ? `${num(r.bandwidth_khz, 2)} kHz` : ""], ["ERP", r.erp_w ? `${num(r.erp_w, r.erp_w < 10 ? 1 : 0)} W` : ""], ["Transmitter power", r.power_out_w ? `${num(r.power_out_w, 1)} W` : ""],
    ["Antenna", [r.height_tip_m != null ? `${num(r.height_tip_m, 1)} m tip` : "", r.haat_m != null ? `HAAT ${num(r.haat_m)} m` : "", r.azimuth != null ? `azimuth ${num(r.azimuth)}°` : ""].filter(Boolean).join(", ")],
    ["Units", r.units], ["Granted", r.grant_date], ["Expires", r.expired_date], ["Address", [r.address, r.city, r.county, r.state].filter(Boolean).join(", ")], ["Tower", r.tower_reg]];
  else if (r.layer === "broadcast") pairs = [["Station", `${r.call_sign} ${r.kind}${r.kind === "TV" ? ` channel ${r.channel}` : ""}`], ["Licensee", r.licensee], ["Class", r.class],
    ["ERP", r.erp_kw != null ? `${num(r.erp_kw, r.erp_kw < 10 ? 2 : 1)} kW` : ""], ["HAAT", r.haat_m != null ? `${num(r.haat_m)} m` : ""], ["Hours", r.hours], ["Directional", r.directional],
    ["City", [r.city, r.state].filter(Boolean).join(", ")], ["Facility ID", r.facility_id], ["Status", r.status]];
  else if (r.layer === "noaa") { let cs = []; try { cs = JSON.parse(r.counties || "[]"); } catch (e) { /* older pack */ }
    pairs = [["Site", `${r.site}, ${r.city || ""} ${r.state || ""}`], ["Forecast office", r.wfo], ["Power", r.power_w ? `${num(r.power_w)} W` : ""], ["Status", r.status],
      ["Counties warned", cs.map(c => `${c.county} ${c.st}${c.part ? ` (${c.part})` : ""}`).join("; ")], ["SAME codes", cs.map(c => c.same).filter(Boolean).join(" ")]]; }
  else if (r.layer === "faa") pairs = [["Facility", `${r.ident} ${r.name || ""} (${r.kind})`], ["Use", r.use], ["Radio call", r.call], ["Sector", r.sector], ["Status", r.status],
    ["Remark", r.remark], ["Source", `FAA NASR ${r.source}`]];
  const wiki = r.sig_type !== "Unknown" && S.meta?.sig_lib?.[r.sig_type]?.url, rr = rrStateUrl(r.state);
  const links = [wiki ? `<a href="${esc(wiki)}" target="_blank" rel="noopener">Signal ID wiki: ${esc(r.sig_type)}</a>` : "", rr ? `<a href="${rr}" target="_blank" rel="noopener">RadioReference ${esc(r.state)}</a>` : ""].filter(Boolean).join(" · ");
  return `<details class="rowd"><summary><span style="display:flex;gap:10px;min-width:0;flex:1"><span class="dot" style="background:${colorOf(r)};margin-top:6px"></span>
      <span style="min-width:0"><b class="mono">${r.layer === "broadcast" && r.kind === "AM" ? `${fmtF(r.freq_mhz * 1000)} kHz` : `${fmtF(r.freq_mhz)} MHz`}</b>
      <span class="hint" style="display:block">${esc([typeOf(r), r.call_sign || r.ident, classLabel(r.station_class)].filter(Boolean).join(" · "))}</span></span></span>
      <span class="hint" style="white-space:nowrap">${r.est_rx_dbm != null ? `${num(r.est_rx_dbm)} dBm` : ""}</span></summary>
    <dl class="kv">${kvs(pairs)}</dl>${links ? `<p class="hint" style="margin:4px 0 8px">${links}</p>` : ""}
    <div class="row" style="margin-bottom:10px"><button class="btn small" data-act="logthis" data-fid="${fid}">＋ Log this signal</button></div></details>`;
}
function findRow(fid) { return S.rows.find(r => r.fid === fid); }

/* ---------- field log ---------- */
function authority(mhz, type) {
  const m = S.meta || {};
  if ((m.part15_types || []).includes(type)) return ["Unlicensed (Part 15)", type];
  if ((m.cell_types || []).includes(type)) return ["Cellular (market licence)", type];
  for (const [lo, hi, cat, note] of m.authority || []) if (mhz >= lo && mhz < hi) return [cat, note];
  return null;
}
function licenceCheck(e) {
  if (!S.db || e.freq_mhz == null || e.lat == null) return null;
  if (!inPack([e.lat, e.lon])) return {kind: "outside", text: `Outside ${S.pack.name}: load the pack for this area to check it.`};
  const f = e.freq_mhz, tol = f < 30 ? 0.0006 : 0.003, a = [f - tol, f + tol, ...bbox(e.lat, e.lon, 40)];
  const box = "freq_mhz BETWEEN ? AND ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?";
  const hits = [...q(`SELECT * FROM tx WHERE ${box} LIMIT 2000`, a).map(asTx), ...q(`SELECT * FROM bcast WHERE ${box}`, a).map(asBcast),
    ...q(`SELECT * FROM nwr WHERE ${box}`, a).map(asNwr), ...q(`SELECT * FROM faa WHERE ${box}`, a).map(asFaa)].filter(r => decorate(r, [e.lat, e.lon], 40));
  hits.sort((x, y) => x.dist_mi - y.dist_mi);
  if (hits.length) { const h = hits[0];
    return {kind: "licensed", text: `Licensed: ${h.licensee || h.label}${h.call_sign ? ` (${h.call_sign})` : ""}, ${num(h.dist_mi, 1)} mi ${h.compass}${hits.length > 1 ? `, and ${hits.length - 1} more within 40 mi` : ""}.`}; }
  const au = authority(f, e.sig_type);
  if (au) return {kind: "allowed", text: `${au[0]}: ${au[1]}. No site licence needed.`};
  return {kind: "unlisted", text: "Unlisted: no FCC licence on this frequency within 40 mi and no rule that allows it. Worth a second look."};
}
async function loadLog() { S.log = (await idb.all("log").catch(() => [])).sort((a, b) => (b.ts || "").localeCompare(a.ts || "")); }
function logForm(pre = {}) {
  const types = Object.keys(S.meta?.sig_lib || {}).sort();
  openSheet("Log a signal", "Records where you are and checks it against the licences in your pack.", `
    <form id="logForm">
      <div class="two"><div class="field"><label for="lf_f">Frequency, MHz</label><input id="lf_f" inputmode="decimal" placeholder="155.475" value="${esc(pre.freq_mhz != null ? fmtF(pre.freq_mhz) : "")}"></div>
        <div class="field"><label for="lf_l">Level, dBm</label><input id="lf_l" inputmode="decimal" placeholder="-85"></div></div>
      <div class="field"><label for="lf_b">Bearing, degrees (optional)</label><input id="lf_b" inputmode="decimal" placeholder="the direction it came from, e.g. 215">
        <p class="hint" style="margin:4px 0 0">From true north. Bearings taken from a few places cross where the signal is (RF Recon on the PC, Mission, Lines of bearing).</p></div>
      <div class="field"><label for="lf_t">What it sounds or looks like</label><select id="lf_t"><option value="">Unknown</option>${types.map(t => `<option ${t === pre.sig_type ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></div>
      <div class="field"><label for="lf_lab">Label</label><input id="lf_lab" placeholder="e.g. county fire dispatch" value="${esc(pre.label || "")}"></div>
      <div class="field"><label for="lf_n">Notes</label><textarea id="lf_n" rows="2"></textarea></div>
      <p class="hint" id="lf_pos">Getting your position…</p>
      <div class="row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-act="close">Cancel</button></div>
    </form>`, sh => {
    let pos = null;
    const show = () => { $("#lf_pos").innerHTML = pos ? `Position: <span class="mono">${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}</span>${pos.acc != null ? ` ±${num(pos.acc)} m` : " (the pin)"}` : "No position: it will be saved without one."; };
    locate(false).then(me => { pos = me || (S.center ? {lat: S.center[0], lon: S.center[1], acc: null} : null); if ($("#lf_pos")) show(); });
    $("#logForm", sh).onsubmit = async ev => {
      ev.preventDefault();
      const fv = parseFloat($("#lf_f").value), lv = parseFloat($("#lf_l").value), bv = parseFloat($("#lf_b").value);
      const e = {ts: new Date().toISOString(), lat: pos?.lat ?? null, lon: pos?.lon ?? null, acc: pos?.acc ?? null,
        freq_mhz: isFinite(fv) ? fv : null, dbm: isFinite(lv) ? -Math.abs(lv) : null,  // received levels are negative; "85" means -85 dBm
        sig_type: $("#lf_t").value || null, label: $("#lf_lab").value.trim(), notes: $("#lf_n").value.trim(), pack: S.pack?.name || "",
        bearing: isFinite(bv) ? ((bv % 360) + 360) % 360 : null};
      e.check = licenceCheck(e);
      e.id = await idb.put("log", e);
      await loadLog();
      closeSheet();
      toast(e.check ? e.check.text : "Saved to the field log.");
      if (S.tab === "log") render();
    };
  });
}
function viewLog(v) {
  const n = S.log.length;
  v.innerHTML = head("Field log", n ? `${n} signal${n === 1 ? "" : "s"} logged on this phone. Export saves them as a CSV you can put in Drive and import on the PC (Mission, Import captures).`
    : "Signals you hear or see, with where you were.")
    + `<div class="row" style="margin:0 2px 12px"><button class="btn primary" data-act="newlog">＋ Log a signal</button>${n ? '<button class="btn" data-act="export">Export CSV</button>' : ""}</div>`
    + (n ? S.log.map((e, i) => { const c = e.check;
      return `<div class="card glass" style="--i:${Math.min(i, 8)}"><div class="row" style="justify-content:space-between;align-items:baseline">
        <b class="mono" style="font-size:17px">${e.freq_mhz != null ? fmtF(e.freq_mhz) + " MHz" : "No frequency"}</b><span class="hint">${esc(new Date(e.ts).toLocaleString())}</span></div>
        <div class="s" style="color:var(--ink-2)">${esc([e.sig_type || "Unknown", e.dbm != null ? `${e.dbm} dBm` : "", e.bearing != null ? `bearing ${Math.round(e.bearing)}°` : "", e.label].filter(Boolean).join(" · "))}</div>
        ${e.notes ? `<p style="margin:6px 0">${esc(e.notes)}</p>` : ""}
        ${c ? `<div class="check ${esc(c.kind)}">${esc(c.text)}</div>` : ""}
        <div class="row" style="margin-top:10px">${e.lat != null ? `<button class="btn small" data-act="showlog" data-id="${e.id}">Show on map</button>` : ""}
          <button class="btn small danger" data-act="dellog" data-id="${e.id}">Delete</button><span class="hint">${e.lat != null ? `${e.lat.toFixed(5)}, ${e.lon.toFixed(5)}${e.acc != null ? ` ±${num(e.acc)} m` : ""}` : ""}</span></div></div>`; }).join("")
      : `<div class="card glass empty"><p>Nothing logged yet. Tap “Log a signal” when you hear or see one: it records where you are and says whether a licence in your pack explains it.</p></div>`);
}
const csvCell = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function logCsv() {  // the columns RF Recon on the PC reads in Mission, Import captures
  const cols = ["time", "lat", "lon", "accuracy", "freq_mhz", "dbm", "bearing", "type", "label", "notes", "check", "pack"];
  const lines = [cols.join(",")].concat(S.log.slice().reverse().map(e => [e.ts, e.lat, e.lon, e.acc != null ? Math.round(e.acc) : "", e.freq_mhz, e.dbm, e.bearing ?? "", e.sig_type || "",
    e.label, e.notes, e.check?.text || "", e.pack].map(csvCell).join(",")));
  const d = new Date(), stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  return {name: `RF Recon field log ${stamp}.csv`, text: lines.join("\r\n") + "\r\n"};
}
async function exportLog() {
  const {name, text} = logCsv(), file = new File([text], name, {type: "text/csv"});
  try {
    if (navigator.canShare?.({files: [file]})) { await navigator.share({files: [file], title: file.name}); return; }
  } catch (e) { if (e.name === "AbortError") return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file); a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* ---------- packs view ---------- */
let installEvt = null;
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
async function viewPacks(v) {
  const est = await navigator.storage?.estimate?.().catch(() => null), persisted = await navigator.storage?.persisted?.().catch(() => null);
  const p = S.pack, other = S.packs.filter(x => x.id !== p?.id);
  const area = a => a?.areas ? a.areas.map(area).join(" + ") : a?.states ? a.states.join(", ") : a?.center ? (a.label || `${a.radius_mi} mi around ${a.center[0]}, ${a.center[1]}`) : "";
  v.innerHTML = head("Data packs", p ? `Using <b>${esc(p.name)}</b>. Everything works without signal once a pack is loaded.` : "Load the FCC data for an area to start.")
    + (!matchMedia("(pointer: coarse)").matches ? `<div class="card glass" style="--i:0"><h2>On a computer?</h2><p style="margin:0">This is RF Recon lite (beta), the phone version.
      <a href="full/"><b>Open the full web version</b></a>: every RF Recon tab in this browser, from the same packs.
      On the PC where RF Recon is installed: <a href="http://localhost:8765/">RF Recon (beta) on this PC</a>.</p></div>` : "")
    + (!standalone() ?`<div class="card glass" style="--i:0"><h2>Put it on your home screen</h2><p style="margin:0 0 8px">${isIOS()
      ? "In Safari, tap Share, then <b>Add to Home Screen</b>. Open RF Recon lite from that icon: it keeps your packs and works offline."
      : "Tap <b>Install</b> (or the browser menu, then <b>Add to Home screen</b>). Open RF Recon lite from that icon: it keeps your packs and works offline."}</p>
      ${installEvt ? '<button class="btn primary" data-act="install">Install</button>' : ""}</div>` : "")
    + (p ? `<div class="card glass" style="--i:1"><h2>In use</h2><div class="t" style="font-size:18px;font-weight:700">${esc(p.name)}</div>
      <dl class="kv">${kvs([["Area", area(p.area)], ["FCC data", p.fcc_built_at], ["Pack made", p.made_at], ["Licences", int(p.counts?.licences)], ["Towers", int(p.counts?.towers)],
        ["Broadcast", int(p.counts?.broadcast)], ["NOAA / FAA", `${int(p.counts?.noaa)} / ${int(p.counts?.faa)}`], ["Size", `${num(p.size / 1e6, 1)} MB (${num(p.raw / 1e6)} MB open)`]])}</dl></div>` : "")
    + (other.length ? `<div class="card glass" style="--i:2"><h2>Also on this phone</h2>${other.map(o => `<div class="item" style="cursor:default"><div class="main"><div class="t">${esc(o.name)}</div>
      <div class="s">${esc(area(o.area))} · made ${esc(o.made_at)} · ${num(o.size / 1e6, 1)} MB</div></div>
      <div class="row"><button class="btn small" data-act="use" data-id="${esc(o.id)}">Use</button><button class="btn small danger" data-act="rmpack" data-id="${esc(o.id)}">Remove</button></div></div>`).join("")}</div>` : "")
    + `<div class="card glass" style="--i:3"><h2>Load a pack</h2><p style="margin:0 0 10px">Packs are in the RF Recon folder in Google Drive, under <b>field packs</b>. Tap below and pick
      ${isIOS() ? "<b>Browse</b>, then <b>Google Drive</b> (turn it on under Browse, the ⋯ menu, Edit, if it isn't listed)" : "<b>Drive</b> from the picker's menu"}. Only people the folder is shared with can see them.
      A pack made on the PC with “Make a field pack” (Data &amp; updates) appears there when Drive has synced.</p>
      <div class="row"><button class="btn primary" data-act="load">Load a pack</button>${p ? '<button class="btn danger" data-act="rmpack" data-id="' + esc(p.id) + '">Remove this pack</button>' : ""}</div></div>`
    + `<div class="card glass" style="--i:3"><h2>A state from the RF Recon site</h2><p style="margin:0 0 10px">Every state's FCC data is kept on the RF Recon site, so you
      don't need Drive for it: pick one and it downloads to this phone (1 to 25 MB, so use Wi-Fi for the big ones). A search outside your pack offers its state too.</p>
      <div class="row"><select id="spSel" style="flex:1"><option value="">Getting the list…</option></select><button class="btn primary" data-act="sitepack">Load</button></div></div>`
    + `<div class="card glass" style="--i:4"><h2>Map without signal</h2><p style="margin:0 0 10px">Map tiles you've looked at stay on the phone. To save more before you go, set the pin and radius,
      then save that area (USGS maps, zoom 8 to 15). Street maps can't be saved: OpenStreetMap's rules don't allow it.</p>
      <div class="row"><button class="btn" data-act="savemap">Save the map around the pin</button><button class="btn small danger" data-act="clearmap">Clear saved map</button></div>
      <p class="hint" id="mapsave"></p></div>`
    + `<div class="card glass" style="--i:5"><h2>This phone</h2><dl class="kv">${kvs([["Storage used", est ? `${num(est.usage / 1e6)} MB` : ""],
      ["Kept when space is low", persisted == null ? "" : persisted ? "Yes" : "Not guaranteed (add to home screen)"], ["App version", `${APP_VERSION} (${BUILD})`]])}</dl>
      <p class="hint" style="margin:0">Your packs and field log stay in this phone's browser storage. Nothing is sent anywhere.</p></div>`;
  sitePacks().then(list => { const sel = $("#spSel"); if (!sel) return;
    sel.innerHTML = list.length ? list.map(s => `<option value="${esc(s.st)}">${esc(s.name)} · ${num(s.mb, 1)} MB</option>`).join("") : '<option value="">Not reachable: try again with signal</option>'; });
}

/* ---------- saving map tiles for offline ---------- */
let saving = null;
function tilesFor(center, mi, zmin, zmax) {
  const [s, n, w, e] = bbox(center[0], center[1], mi), out = [];
  const tx = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z), ty = (lat, z) => Math.floor((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2 * 2 ** z);
  for (let z = zmin; z <= zmax; z++) for (let x = tx(w, z); x <= tx(e, z); x++) for (let y = ty(n, z); y <= ty(s, z); y++) out.push({z, x, y});
  return out;
}
async function saveMap() {
  const out = $("#mapsave");
  if (saving) { saving.stop = true; return; }
  if (!S.center) { out.textContent = "Set a pin first (Map, tap where you'll be)."; return; }
  const b = BASES[S.base]?.save ? BASES[S.base] : BASES.topo;
  const tiles = tilesFor(S.center, Math.max(S.radius, 1), 8, 15);
  if (tiles.length > 6000) { out.textContent = `${int(tiles.length)} tiles is too many: pick a smaller radius (10 mi or less).`; return; }
  saving = {stop: false};
  let done = 0, failed = 0, i = 0;
  const work = async () => {
    while (i < tiles.length && !saving.stop) {
      const t = tiles[i++];
      try { const r = await fetch(L.Util.template(b.url, t), {mode: "cors"}); if (!r.ok) failed++; } catch (e) { failed++; }
      done++;
      if (done % 20 === 0 || done === tiles.length) out.textContent = `Saving ${b.label}: ${int(done)} of ${int(tiles.length)} tiles…`;
    }
  };
  out.textContent = `Saving ${b.label}: 0 of ${int(tiles.length)} tiles…`;
  await Promise.all([work(), work(), work(), work()]);
  out.textContent = saving.stop ? `Stopped after ${int(done)} tiles.` : `Saved ${int(done - failed)} tiles of ${b.label} for ${Math.max(S.radius, 1)} mi around the pin${failed ? ` (${failed} failed: no signal?)` : ""}.`;
  saving = null;
}

/* ---------- filters and layers ---------- */
function filterSheet() {
  const bands = (S.meta?.bands || []).filter(([lo, hi]) => hi < 1e8);
  openSheet("Layers and filters", "", `
    <div class="field"><label>Layers</label><div class="chips">${Object.entries(LAYERS).map(([k, l]) => `<button type="button" class="chip ${S.layerOn.has(k) ? "on" : ""}" data-layer="${k}"><span class="dot" style="background:${l.color}"></span>${esc(l.label)}</button>`).join("")}</div></div>
    <div class="two"><div class="field"><label for="ff_min">From MHz</label><input id="ff_min" inputmode="decimal" value="${S.fmin ?? ""}"></div>
      <div class="field"><label for="ff_max">To MHz</label><input id="ff_max" inputmode="decimal" value="${S.fmax ?? ""}"></div></div>
    <div class="field"><label>Or a band</label><div class="chips">${bands.map(([lo, hi, l]) => `<button type="button" class="chip ${S.fmin === lo && S.fmax === hi ? "on" : ""}" data-band="${lo},${hi}">${esc(l)}</button>`).join("")}</div></div>
    <div class="field"><label for="ff_t">Licensee, call sign or city contains</label><input id="ff_t" value="${esc(S.text)}"></div>
    <div class="field"><label>Map</label><div class="chips">${Object.entries(BASES).map(([k, b]) => `<button type="button" class="chip ${S.base === k ? "on" : ""}" data-base="${k}">${esc(b.label)}</button>`).join("")}</div></div>
    <div class="row"><button class="btn primary" data-act="apply">Apply</button><button class="btn" data-act="clearf">Clear filters</button></div>`, sh => {
    sh.onclick = e => {
      const c = e.target.closest(".chip"); if (!c) return;
      if (c.dataset.layer) c.classList.toggle("on");
      if (c.dataset.band) { const [lo, hi] = c.dataset.band.split(",").map(Number); const on = !c.classList.contains("on");
        $$(".chip[data-band]", sh).forEach(x => x.classList.remove("on")); c.classList.toggle("on", on);
        $("#ff_min").value = on ? lo : ""; $("#ff_max").value = on ? hi : ""; }
      if (c.dataset.base) { $$(".chip[data-base]", sh).forEach(x => x.classList.toggle("on", x === c)); setBase(c.dataset.base); }
    };
  });
}
function applyFilters() {
  const sh = $("#sheet"), f = id => { const v = parseFloat($(id, sh).value); return isFinite(v) ? v : null; };
  S.layerOn = new Set($$(".chip[data-layer].on", sh).map(c => c.dataset.layer));
  S.fmin = f("#ff_min"); S.fmax = f("#ff_max"); S.text = $("#ff_t", sh).value.trim();
  kv.set("filters", {layers: [...S.layerOn], fmin: S.fmin, fmax: S.fmax, text: S.text});
  $("#filterBtn").classList.toggle("on", S.fmin != null || S.fmax != null || !!S.text || S.layerOn.size < Object.keys(LAYERS).length);
  closeSheet();
  run(false);
}

/* ---------- toast, busy, address bar ---------- */
let toastT;
function toast(msg, undo, label = "Undo") {
  const t = $("#toast");
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button class="btn small" data-act="undo">${esc(label)}</button>` : ""}`;
  t.hidden = false; t.style.animation = "none"; void t.offsetWidth; t.style.animation = "";
  t.onclick = e => { if (e.target.closest("[data-act=undo]")) { undo(); t.hidden = true; } };
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, undo ? 7000 : 5000);
}
function busy(msg) {
  let b = $(".loading");
  if (!msg) { b?.remove(); return; }
  if (!b) { b = document.createElement("div"); b.className = "loading"; b.innerHTML = '<div class="glass over"></div>'; document.body.appendChild(b); }
  b.firstChild.textContent = msg;
}
function writeHash(push) {
  const p = new URLSearchParams();
  p.set("t", S.tab);
  if (S.mode === "search" && S.query) p.set("q", S.query);
  else if (S.center) { p.set("c", `${S.center[0].toFixed(5)},${S.center[1].toFixed(5)}`); p.set("r", S.radius); }
  const h = "#" + p.toString();
  if (h !== location.hash) history[push ? "pushState" : "replaceState"](null, "", h);
  kv.set("view", {center: S.center, radius: S.radius});
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const c = (p.get("c") || "").split(",").map(Number);
  return {tab: p.get("t"), q: p.get("q"), center: c.length === 2 && c.every(isFinite) ? c : null, radius: +p.get("r") || null};
}

/* ---------- wiring ---------- */
document.addEventListener("click", async e => {
  const a = e.target.closest("[data-act]");
  if (a) {
    const act = a.dataset.act;
    if (act === "close") closeSheet();
    else if (act === "load") $("#packfile").click();
    else if (act === "sitepack") { const s = (await sitePacks()).find(x => x.st === $("#spSel")?.value); if (s) { await loadSitePack(s); render(); } }
    else if (act === "map") setTab("map");
    else if (act === "here") { setTab("map"); locate(true); }
    else if (act === "more") { S.shown += 200; const y = $("#page").scrollTop; render(); $("#page").scrollTop = y; }
    else if (act === "apply") applyFilters();
    else if (act === "clearf") { S.layerOn = new Set(Object.keys(LAYERS)); S.fmin = S.fmax = null; S.text = ""; kv.set("filters", null); $("#filterBtn").classList.remove("on"); closeSheet(); run(false); }
    else if (act === "newlog") logForm();
    else if (act === "logthis") { const r = findRow(a.dataset.fid); logForm({freq_mhz: r?.freq_mhz, sig_type: r?.sig_type, label: r?.licensee || r?.label}); }
    else if (act === "export") exportLog();
    else if (act === "tak") sendToTak();
    else if (act === "showlog") { const en = S.log.find(x => x.id === +a.dataset.id); if (en) { setTab("map"); setCenter([en.lat, en.lon]); } }
    else if (act === "dellog") { const en = S.log.find(x => x.id === +a.dataset.id); if (!en) return;
      await idb.del("log", en.id); await loadLog(); render();
      toast("Deleted from the field log.", async () => { await idb.put("log", en); await loadLog(); render(); }); }
    else if (act === "use") { busy("Opening pack…"); await openPack(a.dataset.id); busy(); afterPackOpened(true); render(); }
    else if (act === "rmpack") { const info = S.packs.find(x => x.id === a.dataset.id); if (!info) return;
      const data = await idb.get("packdata", info.id);
      await idb.del("packs", info.id); await idb.del("packdata", info.id); S.packs = await idb.all("packs");
      if (S.pack?.id === info.id) { S.db?.close(); S.db = S.meta = S.pack = null; const next = S.packs[0]; if (next) await openPack(next.id); afterPackOpened(false); }
      render();
      toast(`Removed ${info.name}.`, async () => { await idb.put("packdata", data, info.id); await idb.put("packs", info); S.packs = await idb.all("packs");
        if (!S.pack) { await openPack(info.id); afterPackOpened(true); } render(); }); }
    else if (act === "savemap") saveMap();
    else if (act === "clearmap") { await caches.delete("rfr-tiles").catch(() => {}); $("#mapsave").textContent = "Saved map cleared."; }
    else if (act === "install" && installEvt) { installEvt.prompt(); installEvt = null; }
    return;
  }
  const it = e.target.closest(".item[data-fid]");
  if (it) { const r = findRow(it.dataset.fid); if (r?.lat != null) { const s = S.sites?.get(`${(+r.lat).toFixed(5)},${(+r.lon).toFixed(5)}`); if (s) openSite(s); }
    else if (r) openSheet(esc(r.label || r.licensee), esc(`${r.state || ""} · no fixed site (mobile or area licence)`), rowHtml(r)); }
});
$("#scrim").onclick = closeSheet;
document.addEventListener("keydown", e => { if (e.key === "Escape") { closeSheet(); closeSuggest(); } });
$("#nav").onclick = e => { const b = e.target.closest("button[data-t]"); if (b) setTab(b.dataset.t); };
$("#packchip").onclick = () => setTab("packs");
$("#packfile").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) importPack(f); };
$("#searchForm").onsubmit = e => { e.preventDefault(); const s = $("#q").value.trim(); if (!s) return; clearTimeout(sugT); suggest(); if (S.suggest?.length) { closeSuggest(); $("#q").blur(); S.suggest[0].go(); } };
$("#q").addEventListener("input", () => { clearTimeout(sugT); sugT = setTimeout(suggest, 150); });
$("#q").addEventListener("focus", () => { if ($("#q").value.trim()) suggest(); });
$("#filterBtn").onclick = () => filterSheet();
$("#locateBtn").onclick = () => locate(true);
$("#logBtn").onclick = () => S.db ? logForm() : toast("Load a data pack first: Packs, then Load a pack.");
$("#radius").innerHTML = RADII.map(r => `<option value="${r}">${r} mi</option>`).join("");
$("#radius").onchange = e => { S.radius = +e.target.value; if (S.center) run(true); };
addEventListener("popstate", () => { const h = readHash(); if (h.tab && h.tab !== S.tab) setTab(h.tab, false); });
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; if (S.tab === "packs") render(); });

async function start() {
  DashLook.mount($("#lookSlot"), {onChange: () => drawMap(false), nav: false});  // the kit's display sheet; the phone has its own way back
  const [base, filters, view, active] = await Promise.all([kv.get("base"), kv.get("filters"), kv.get("view"), kv.get("activePack")]);
  if (base) S.base = base;
  if (filters) { S.layerOn = new Set(filters.layers); S.fmin = filters.fmin; S.fmax = filters.fmax; S.text = filters.text || "";
    $("#filterBtn").classList.toggle("on", S.fmin != null || S.fmax != null || !!S.text || S.layerOn.size < Object.keys(LAYERS).length); }
  initMap();
  const h = readHash();
  S.radius = h.radius || view?.radius || 5;
  if (!RADII.includes(S.radius)) S.radius = 5;
  $("#radius").value = S.radius;
  S.packs = await idb.all("packs").catch(() => []);
  await loadLog();
  const id = active && S.packs.some(p => p.id === active) ? active : S.packs[0]?.id;
  if (id) { busy("Opening pack…"); try { await openPack(id); } catch (e) { toast(`Couldn't open the pack: ${e.message}`); } busy(); }
  $("#packchip").textContent = S.pack ? S.pack.name : "No data pack";
  if (h.q && S.db) { S.mode = "search"; S.query = h.q; $("#q").value = h.q; }
  else S.center = h.center || view?.center || null;
  setTab(h.tab && ["map", "list", "report", "log", "das", "packs"].includes(h.tab) ? h.tab : (S.db ? "map" : "packs"), false);
  if (S.db) { if (S.center || S.mode === "search") run(true); else afterPackOpened(true); }
  else summary();
}
start().catch(e => { busy(); toast(`RF Recon lite couldn't start: ${e.message}`); console.error(e); });

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").then(reg => {
    reg.addEventListener("updatefound", () => {
      const nw = reg.installing;
      nw?.addEventListener("statechange", () => {
        if (nw.state === "activated" && navigator.serviceWorker.controller) toast("RF Recon lite was updated. Reload to use the new version.", () => location.reload(), "Reload");
      });
    });
  }).catch(() => {});
}
