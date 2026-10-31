"use strict";
/* RF Recon (beta), full web version: stands in for the PC app's server. The PC app's own screens (app/static)
   run unchanged; their /api/* calls are answered here from a field pack held in this browser, and their map
   tiles come straight from the sources instead of the PC's tile cache. Packs are shared with the phone app
   (same site, same browser storage). Nothing is sent anywhere. Ports of app.py's query_area, heatmap,
   geocode and exports; keep them in step with it. */
(() => {
const PACK_VERSION = 1, MAX_ROWS = 25000, MI_KM = 1.609344, EARTH_KM = 6371.0088, SQLJS = "../vendor/sqljs/";
const rad = d => d * Math.PI / 180;

/* ---------- storage: the phone app's database, so a pack loaded in either works in both ---------- */
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

/* ---------- the pack ---------- */
let DB = null, META = null, PACK = null, SQLP;
const sqlReady = () => SQLP || (SQLP = initSqlJs({locateFile: f => SQLJS + f}));
async function unpack(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return u8;
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}
const readMeta = db => Object.fromEntries((db.exec("SELECT k, v FROM meta")[0]?.values || []).map(([k, v]) => [k, JSON.parse(v)]));
async function openPack(id) {
  const info = await idb.get("packs", id), buf = await idb.get("packdata", id);
  if (!info || !buf) return false;
  const SQL = await sqlReady(), db = new SQL.Database(await unpack(buf));
  if (DB) DB.close();
  DB = db; META = readMeta(db); PACK = info;
  await idb.put("kv", id, "activePack");
  return true;
}
const ready = (async () => {
  try {
    const [active, packs] = await Promise.all([idb.get("kv", "activePack"), idb.all("packs")]);
    const id = active && packs.some(p => p.id === active) ? active : packs[0]?.id;
    if (id) await openPack(id);
  } catch (e) { console.error("RF Recon: couldn't open the pack", e); }
})();
async function importPack(file) {
  const buf = await file.arrayBuffer(), raw = await unpack(buf);
  if (String.fromCharCode(...raw.subarray(0, 15)) !== "SQLite format 3") throw new Error(`${file.name} isn't an RF Recon pack. Pick a file ending in .rfpack.`);
  const SQL = await sqlReady(), db = new SQL.Database(raw);
  let meta;
  try { meta = readMeta(db); } finally { db.close(); }
  if (!meta.pack_version) throw new Error(`${file.name} isn't an RF Recon pack.`);
  if (meta.pack_version > PACK_VERSION) throw new Error("That pack was made by a newer RF Recon. Reload this page to update, then try again.");
  const id = `${meta.name}|${meta.made_at}`;
  const info = {id, name: meta.name, made_at: meta.made_at, area: meta.area, counts: meta.counts, fcc_built_at: meta.fcc_built_at,
    bbox: meta.bbox, bboxes: meta.bboxes, size: buf.byteLength, raw: raw.length, added: new Date().toISOString(), file: file.name};
  await idb.put("packdata", buf, id);
  await idb.put("packs", info);
  for (const p of await idb.all("packs")) if (p.name === meta.name && p.id !== id) { await idb.del("packs", p.id); await idb.del("packdata", p.id); }
  await idb.put("kv", id, "activePack");
  navigator.storage?.persist?.().catch(() => {});
  return info;
}
/* state packs published beside this page (../packs/, phone/state_packs.py). On a computer the one around a search
   loads by itself: the search is kept in the address, so the page reloads on the new pack and runs it again. */
let SITE_PACKS = null;
async function sitePacks() {
  if (!SITE_PACKS) { try { SITE_PACKS = (await (await realFetch("../packs/index.json", {cache: "no-cache"})).json()).packs || []; } catch (e) { return []; } }
  return SITE_PACKS;
}
const packHas = (p, lat, lon) => (p?.bboxes || (p?.bbox ? [p.bbox] : [])).some(b => lat >= b[0] && lat <= b[1] && lon >= b[2] && lon <= b[3]);
async function statePackFor(lat, lon) {  // the smallest state box around the spot (they overlap along borders)
  const size = s => (s.bbox[1] - s.bbox[0]) * (s.bbox[3] - s.bbox[2]);
  return (await sitePacks()).filter(s => packHas(s, lat, lon)).sort((a, b) => size(a) - size(b))[0] || null;
}
async function loadSitePack(s) {
  const r = await realFetch(`../packs/${s.file}`);
  if (!r.ok) throw new Error(`The RF Recon site didn't send ${s.name} (${r.status}).`);
  return importPack(new File([await r.blob()], s.file));
}
// a pin no loaded pack covers: use a pack already in this browser that does, else fetch its state's pack; then reload
async function packForPin(lat, lon) {
  const saved = (await idb.all("packs")).find(p => p.id !== PACK?.id && packHas(p, lat, lon));
  const s = saved ? null : await statePackFor(lat, lon);
  if (!saved && !s) return null;
  if (saved) await idb.put("kv", saved.id, "activePack"); else await loadSitePack(s);
  // the page writes a search into the address only once it succeeds: put this pin there, or the reload brings back the last one
  const h = new URLSearchParams(location.hash.slice(1));
  h.set("tab", !h.get("tab") || h.get("tab") === "data" ? "map" : h.get("tab")); h.set("lat", lat); h.set("lon", lon);  // Packs (data) -> the map
  history.replaceState(null, "", "#" + h.toString());
  setTimeout(() => location.reload(), 50);
  return saved ? `Switching to ${saved.name}, already in this browser…` : `Loading ${s.name} (${s.mb.toFixed(1)} MB) from the RF Recon site…`;
}
async function packUpdate() {  // the web version's data updates: a newer pack of the same area on the site
  if (!PACK) return null;
  const s = (await sitePacks()).find(x => x.name === PACK.name);
  return s && (s.made_at || "") > (PACK.made_at || "") ? s : null;
}
async function removePack(id) {
  await idb.del("packs", id); await idb.del("packdata", id);
  if (PACK?.id === id) { await idb.del("kv", "activePack"); DB?.close(); DB = META = PACK = null; }
}

/* the FCC history layer (expired, cancelled, terminated, removed): each state's history file from the site
   (packs/history/, fieldpack.build_history), fetched the first time the layer is on and kept in this browser */
let HRAW = null, HDBS = null;
const packStates = () => { const a = META?.area; return [...new Set((a?.areas || [a]).flatMap(x => x?.states || []))]; };
async function historyFiles() {
  if (HRAW) return HRAW;
  const out = [];
  for (const st of packStates()) {
    const key = `history:${st}:${META?.fcc_built_at || ""}`;
    let buf = await idb.get("packdata", key);
    if (!buf) {
      const s = (await sitePacks()).find(x => x.st === st && x.history);
      if (!s) continue;
      const st_ = document.getElementById("status");
      if (st_) st_.textContent = `Loading the FCC history for ${s.name} (${s.history_mb} MB) from the RF Recon site…`;
      const r = await realFetch(`../packs/${s.history}`);
      if (!r.ok) continue;
      buf = await r.arrayBuffer();
      await idb.put("packdata", buf, key);
    }
    out.push(await unpack(buf));
  }
  return HRAW = out;
}
async function historyDbs() {
  if (!HDBS) { const SQL = await sqlReady(); HDBS = (await historyFiles()).map(b => new SQL.Database(b)); }
  return HDBS;
}

/* ---------- geo (geo.py) ---------- */
function distKm(a1, o1, a2, o2) {
  const p1 = rad(a1), p2 = rad(a2), dp = p2 - p1, dl = rad(o2 - o1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}
function bearingDeg(a1, o1, a2, o2) {
  const p1 = rad(a1), p2 = rad(a2), dl = rad(o2 - o1);
  return (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
}
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = b => COMPASS[Math.floor((b + 11.25) / 22.5) % 16];
function bbox(lat, lon, mi) {
  const r = mi * MI_KM, dlat = r / 111, dlon = r / (111 * Math.max(0.05, Math.cos(rad(lat))));
  return [lat - dlat, lat + dlat, lon - dlon, lon + dlon];
}
const fsplRx = (erp, d, f) => !erp || !f || d == null ? null
  : 10 * Math.log10(erp * 1000) + 2.15 - (20 * Math.log10(Math.max(d, 0.05)) + 20 * Math.log10(f) + 32.44);

/* ---------- queries (app.py) ---------- */
function qd(db, sql, args = []) {
  const st = db.prepare(sql);
  try { st.bind(args); const out = []; while (st.step()) out.push(st.getAsObject()); return out; } finally { st.free(); }
}
const q = (sql, args = []) => qd(DB, sql, args);
const fnum = (p, k, d = null) => { const v = p.get(k); if (v == null || v === "") return d; const n = parseFloat(v); return isNaN(n) ? d : n; };
const fstr = (p, k) => (p.get(k) || "").trim();
const hasTable = name => q("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [name]).length > 0;
const normCounty = c => (c || "").trim().toUpperCase().replace(/\s+(COUNTY|PARISH|BOROUGH|CENSUS AREA|MUNICIPALITY|CITY AND BOROUGH)$/, "") || null;
const fmtMhz = (f, kind) => kind === "AM" ? `${+(f * 1000).toFixed(3)} kHz` : `${+f.toFixed(6)} MHz`;

function areaFilter(p) {
  const lat = fnum(p, "lat"), lon = fnum(p, "lon"), radius = fnum(p, "radius", 10);
  const state = fstr(p, "state").toUpperCase(), county = fstr(p, "county").toUpperCase();
  if (lat != null && lon != null) return {point: [lat, lon], radius, sql: "lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?", args: bbox(lat, lon, radius)};
  if (state) return {point: null, radius: null, sql: "state = ?" + (county ? " AND county = ?" : ""), args: county ? [state, county] : [state], state, county};
  if (fstr(p, "scope") === "nationwide") return {point: null, radius: null, sql: "1", args: [], nationwide: true};
  return null;
}
function ulsFilters(p, hist = false) {  // hist: only what removed entries keep (service, mode), as app.py
  const where = [], args = [];
  const svc = fstr(p, "svc").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  if (svc.length) { where.push(`service IN (${svc.map(() => "?").join(",")})`); args.push(...svc); }
  if (fstr(p, "tech")) { where.push("mode LIKE ?"); args.push(`%${fstr(p, "tech")}%`); }
  if (hist) return [where, args];
  if (fstr(p, "emission")) { where.push("emissions LIKE ?"); args.push(`%${fstr(p, "emission").toUpperCase()}%`); }
  const ymd = col => `(substr(${col},7,4)||substr(${col},1,2)||substr(${col},4,2))`;  // MM/DD/YYYY -> YYYYMMDD
  for (const [key, col, op] of [["granted_from", "grant_date", ">="], ["granted_to", "grant_date", "<="], ["expires_from", "expired_date", ">="], ["expires_to", "expired_date", "<="]]) {
    const v = fstr(p, key).replace(/-/g, "");
    if (/^\d{8}$/.test(v)) { where.push(`${ymd(col)} ${op} ?`); args.push(v); }
  }
  return [where, args];
}
function decorate(f, area) {
  if (area.point && f.lat != null) {
    const d = distKm(area.point[0], area.point[1], f.lat, f.lon);
    if (d > area.radius * MI_KM) return false;
    const b = bearingDeg(area.point[0], area.point[1], f.lat, f.lon);
    f.dist_mi = Math.round(d / MI_KM * 1000) / 1000; f.bearing = Math.round(b); f.compass = compass(b);
    const erp = f.erp_w || f.power_out_w;
    if (["uls", "broadcast", "noaa"].includes(f.layer) && erp && f.freq_mhz) f.est_rx_dbm = Math.round(fsplRx(erp, d, f.freq_mhz) * 10) / 10;
  } else if (area.point) return false;
  return true;
}
function queryArea(p, hist = []) {
  if (!DB) return {error: "Load a data pack first: Packs tab, then Load a pack."};
  const area = areaFilter(p);
  if (!area) return {error: "Drop a pin or pick a state/county."};
  const layers = new Set((fstr(p, "layers") || "uls,broadcast,noaa,faa,towers").split(","));
  const text = fstr(p, "q"), fmin = fnum(p, "fmin"), fmax = fnum(p, "fmax"), hideMobile = fstr(p, "hide_mobile") === "1";
  const [advWhere, advArgs] = ulsFilters(p);
  if (area.nationwide && !(text || advWhere.length || fmin != null || fmax != null))
    return {error: "A search across the pack needs a call sign, licensee, radio service, technology or frequency."};
  const out = [];
  let truncated = false;
  const freq = (where, args) => { if (fmin != null) { where.push("freq_mhz >= ?"); args.push(fmin); } if (fmax != null) { where.push("freq_mhz <= ?"); args.push(fmax); } };
  if (layers.has("uls")) {  // packs hold current licences; the history layer reads the history files (hist)
    const where = [area.sql, "status = 'A'"], args = [...area.args];
    freq(where, args);
    if (hideMobile) where.push("is_mobile = 0");
    if (text) { where.push("(licensee LIKE ? OR call_sign LIKE ? OR city LIKE ? OR address LIKE ?)"); args.push(...Array(4).fill(`%${text}%`)); }
    where.push(...advWhere); args.push(...advArgs);
    const rows = q(`SELECT * FROM tx WHERE ${where.join(" AND ")} LIMIT ${MAX_ROWS + 1}`, args);
    truncated = rows.length > MAX_ROWS;
    for (const f of rows.slice(0, MAX_ROWS)) {
      Object.assign(f, {layer: "uls", fid: `uls:${f.id}`, label: f.licensee, sig_type: f.sig_type || "Unknown"});
      if (decorate(f, area)) out.push(f);
    }
  }
  if (layers.has("uls_hist")) for (const h of hist) {  // licences that aren't active, then entries gone since an earlier import
    const where = [area.sql], args = [...area.args];
    freq(where, args);
    if (hideMobile) where.push("is_mobile = 0");
    if (text) { where.push("(licensee LIKE ? OR call_sign LIKE ? OR city LIKE ? OR address LIKE ?)"); args.push(...Array(4).fill(`%${text}%`)); }
    where.push(...advWhere); args.push(...advArgs);
    for (const f of qd(h, `SELECT * FROM tx_old WHERE ${where.join(" AND ")} LIMIT ${MAX_ROWS + 1}`, args)) {
      Object.assign(f, {layer: "uls_hist", fid: `uls:${f.id}`, label: f.licensee, sig_type: f.sig_type || "Unknown",
        category: "History: " + ({E: "Expired", C: "Cancelled", T: "Terminated"}[f.status] || f.status || "Inactive")});
      if (decorate(f, area)) out.push(f);
    }
    const hw = [area.sql], ha = [...area.args];
    freq(hw, ha);
    if (text) { hw.push("(licensee LIKE ? OR call_sign LIKE ?)"); ha.push(`%${text}%`, `%${text}%`); }
    const [w2, a2] = ulsFilters(p, true);
    for (const f of qd(h, `SELECT * FROM tx_history WHERE ${[...hw, ...w2].join(" AND ")} LIMIT 5000`, [...ha, ...a2])) {
      Object.assign(f, {layer: "uls_hist", fid: "hist:" + f.hkey, label: f.licensee, category: "History: Removed", status: "REMOVED",
        sig_type: f.sig_type || "Unknown"});
      if (decorate(f, area)) out.push(f);
    }
  }
  if (layers.has("towers")) {
    const filtered = fmin != null || fmax != null || !!text || advWhere.length > 0;
    const regs = filtered ? new Set(out.map(f => f.tower_reg).filter(Boolean)) : null;
    let trows;
    if (area.nationwide) { const rl = [...(regs || [])]; trows = []; for (let i = 0; i < rl.length; i += 900) trows.push(...q(`SELECT * FROM tower WHERE reg IN (${rl.slice(i, i + 900).map(() => "?").join(",")})`, rl.slice(i, i + 900))); }
    else trows = q(`SELECT * FROM tower WHERE ${area.sql} LIMIT 5000`, area.args);
    for (const f of trows) {
      if (filtered && !regs.has(f.reg) && !(text && (f.owner || "").toLowerCase().includes(text.toLowerCase()))) continue;
      Object.assign(f, {layer: "towers", fid: `tower:${f.reg}`, label: `${f.struct_type || "Structure"} ${f.overall_agl_m ?? "?"} m · ${f.owner || ""}`.trim(),
        category: "Tower / structure", sig_type: null, freq_mhz: null});
      if (decorate(f, area)) out.push(f);
    }
  }
  if (layers.has("broadcast") && area.point && hasTable("bcast")) {
    const where = [area.sql], args = [...area.args];
    freq(where, args);
    if (text) { where.push("(call_sign LIKE ? OR licensee LIKE ? OR city LIKE ?)"); args.push(...Array(3).fill(`%${text}%`)); }
    for (const f of q(`SELECT * FROM bcast WHERE ${where.join(" AND ")} LIMIT 3000`, args)) {
      Object.assign(f, {layer: "broadcast", fid: `bc:${f.id}`, category: "Broadcast / Media", erp_w: f.erp_kw ? f.erp_kw * 1000 : null,
        label: `${f.call_sign} ${fmtMhz(f.freq_mhz, f.kind)} ${f.kind}${f.kind === "TV" ? ` (ch ${f.channel})` : ""}`});
      if (decorate(f, area)) out.push(f);
    }
  }
  if (layers.has("faa") && area.point && hasTable("faa")) {
    const where = [area.sql], args = [...area.args];
    freq(where, args);
    if (text) { where.push("(ident LIKE ? OR name LIKE ? OR call LIKE ? OR use LIKE ?)"); args.push(...Array(4).fill(`%${text}%`)); }
    for (const f of q(`SELECT * FROM faa WHERE ${where.join(" AND ")} LIMIT 5000`, args)) {
      Object.assign(f, {layer: "faa", fid: `faa:${f.id}`, category: "Aviation (FAA)", licensee: f.source !== "FRQ" ? "FAA" : (f.call || f.name),
        label: `${f.ident} ${f.name || ""} · ${f.use || f.kind}`.trim(),
        details: JSON.stringify({"Facility": `${f.ident} ${f.name || ""} (${f.kind})`, "Use": f.use, "Radio call": f.call, "Sector": f.sector,
          "Status": f.status, "Remark": f.remark, "Source": `FAA NASR ${f.source}`})});
      if (decorate(f, area)) out.push(f);
    }
  }
  if (layers.has("noaa") && !area.nationwide && hasTable("nwr")) {
    let nrows;
    if (area.point) nrows = q(`SELECT * FROM nwr WHERE ${area.sql}`, area.args);
    else nrows = q("SELECT * FROM nwr WHERE counties LIKE ?", [`%"st": "${area.state}"%`]).filter(r => !area.county
      || JSON.parse(r.counties).some(c => c.st === area.state && normCounty(c.county) === area.county));
    for (const f of nrows) {
      if ((fmin != null && f.freq_mhz < fmin) || (fmax != null && f.freq_mhz > fmax)) continue;
      const cs = JSON.parse(f.counties || "[]");
      delete f.counties;
      Object.assign(f, {layer: "noaa", fid: `nwr:${f.id}`, category: "NOAA Weather Radio", sig_type: "NOAA Weather Radio", erp_w: f.power_w,
        licensee: "NOAA National Weather Service", label: `${f.call_sign} ${f.site} ${f.freq_mhz.toFixed(3)} MHz`,
        details: JSON.stringify({"Status": f.status, "Forecast office": f.wfo, "Transmitter power": f.power_w ? `${f.power_w} W` : "",
          "Counties warned": cs.map(c => `${c.county} ${c.st}${c.part ? ` (${c.part})` : ""}`).join("; "), "SAME codes": cs.map(c => c.same).filter(Boolean).join(" ")})});
      if (decorate(f, area)) out.push(f);
    }
  }
  if (layers.has("psap") && area.point && hasTable("psap")) {  // 911 call centres, placed at their town's centre
    for (const f of q(`SELECT * FROM psap WHERE ${area.sql} LIMIT 2000`, area.args)) {
      Object.assign(f, {layer: "psap", fid: `psap:${f.psap_id}`, label: f.name, category: "911 call centre (PSAP)", sig_type: null, freq_mhz: null,
        details: JSON.stringify({"PSAP ID": f.psap_id, "City": f.city, "County": f.county, "State": f.state,
          "Position": `approximate: ${f.located} (the registry has no addresses)`,
          "Registry": `FCC 911 Master PSAP Registry, rows last updated ${META?.psap_source_date || ""}`})});
      if (decorate(f, area)) out.push(f);
    }
  }
  if (area.point) out.sort((a, b) => (a.dist_mi ?? 1e9) - (b.dist_mi ?? 1e9) || (a.freq_mhz || 0) - (b.freq_mhz || 0));
  return {rows: out, truncated, center: area.point, radius: area.radius};
}

function mwlinks(p) {  // microwave backhaul links with an end in the map's box (app.py /api/mwlinks)
  const [s, n, w, e] = ["s", "n", "w", "e"].map(k => fnum(p, k));
  if ([s, n, w, e].includes(null)) throw new Error("Give the map's box: s, n, w, e.");
  if (!hasTable("mw_link")) return {links: [], loaded: false};
  const lim = Math.min(fnum(p, "limit", 3000), 6000), seen = new Set(), links = [];
  for (const side of ["tx", "rx"])
    for (const r of q(`SELECT rowid, * FROM mw_link WHERE ${side}_lat BETWEEN ? AND ? AND ${side}_lon BETWEEN ? AND ? LIMIT ?`, [s, n, w, e, lim]))
      if (!seen.has(r.rowid)) { seen.add(r.rowid); links.push(r); }
  return {links: links.slice(0, lim), loaded: links.length > 0 || q("SELECT 1 FROM mw_link LIMIT 1").length > 0, truncated: links.length > lim};
}

/* ---------- heatmaps (app.py heatmap, geo.py grid_* and colorize) ---------- */
const RAMP = [[0, [48, 18, 59]], [.15, [70, 107, 227]], [.3, [41, 187, 236]], [.45, [49, 241, 152]], [.6, [163, 253, 61]], [.75, [237, 208, 58]], [.88, [251, 128, 34]], [1, [180, 4, 38]]];
function ramp(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < RAMP.length; i++) if (t <= RAMP[i][0]) {
    const [t0, c0] = RAMP[i - 1], [t1, c1] = RAMP[i], k = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    return c0.map((v, j) => Math.trunc(v + (c1[j] - v) * k));
  }
  return RAMP[RAMP.length - 1][1];
}
function heatExtent(rows) {  // a county search has no pin: cover where its entries are (the middle 98%), as app.py heat_extent
  const la = rows.map(r => r.lat).filter(v => v != null).sort((a, b) => a - b), lo = rows.map(r => r.lon).filter(v => v != null).sort((a, b) => a - b);
  if (!la.length) throw new Error("Nothing in this county has a location to map. Drop a pin for a heatmap.");
  const cut = Math.floor(la.length / 100), s = la[cut], n = la[la.length - 1 - cut], w = lo[cut], e = lo[lo.length - 1 - cut];
  const lat = (s + n) / 2, lon = (w + e) / 2, half = Math.max(distKm(s, lon, n, lon), distKm(lat, w, lat, e)) / 2 / MI_KM;
  return [lat, lon, Math.min(60, Math.max(2, half * 1.05))];
}
function heatmap(p) {
  if (fstr(p, "kind") === "carrier") throw new Error("Carrier coverage comes from the FCC Broadband Map files RF Recon keeps on the PC.");
  let lat = fnum(p, "lat"), lon = fnum(p, "lon"), radius = fnum(p, "radius", 10);
  if (lat == null && !(fstr(p, "state") && fstr(p, "county"))) throw new Error("Heatmaps need a pin or a county.");
  const res = queryArea(p);
  if (res.error) throw new Error(res.error);
  if (lat == null) [lat, lon, radius] = heatExtent(res.rows);
  const kind = fstr(p, "kind") || "predicted", size = Math.max(60, Math.min(Math.round(fnum(p, "size", 200)), 600));
  const [s, n, w, e] = bbox(lat, lon, radius), dy = (n - s) / size, dx = (e - w) / size;
  const vals = new Float64Array(size * size).fill(NaN);
  const set = k => new Set(fstr(p, k).split("|").filter(Boolean));
  const types = set("types"), bands = set("bands"), cats = set("cats"), ident = fstr(p, "ident").toLowerCase();
  const rows = res.rows.filter(r => (!types.size || types.has(r.sig_type || "Unknown")) && (!bands.size || bands.has(r.band || "Other"))
    && (!cats.size || cats.has(r.category || "Other")) && (!ident || `${r.ident || ""} ${r.label || ""}`.toLowerCase().includes(ident)));
  let unit = "dBm", desc;
  if (kind === "predicted") {
    const seen = new Set(), tx = [];
    for (const r of rows) {
      if (!["uls", "broadcast", "noaa"].includes(r.layer) || r.lat == null || r.is_mobile || (r.freq_mhz || 0) < 30) continue;  // AM and HF: ground wave, not modelled
      const erp = r.erp_w || r.power_out_w, key = `${r.lat}|${r.lon}|${r.freq_mhz}`;
      if (erp && r.freq_mhz && !seen.has(key)) { seen.add(key); tx.push([r.lat, r.lon, erp, r.freq_mhz]); }
    }
    if (!tx.length) throw new Error("No licensed transmitters (30 MHz and up, with power on file) match the layers and filters on: predicted heatmaps need some.");
    tx.sort((a, b) => b[2] - a[2]);
    const use = tx.slice(0, 400), sum = fstr(p, "combine") === "sum";
    // level in mW at 0.05 km and beyond: A / d^2, with A from ERP and frequency; one log per cell at the end
    const A = use.map(([, , erp, f]) => 10 ** ((10 * Math.log10(erp * 1000) + 2.15 - 20 * Math.log10(f) - 32.44) / 10));
    for (let r = 0; r < size; r++) {
      const la = n - (r + .5) * dy, cosLa = Math.cos(rad(la));
      for (let c = 0; c < size; c++) {
        const lo = w + (c + .5) * dx;
        let best = 0;
        for (let i = 0; i < use.length; i++) {
          const [tl, to] = use[i], cosM = (cosLa + Math.cos(rad(tl))) / 2;
          const dkm = EARTH_KM * Math.hypot(rad(la - tl), rad(lo - to) * cosM), d2 = Math.max(dkm, 0.05) ** 2, v = A[i] / d2;
          best = sum ? best + v : Math.max(best, v);
        }
        const dbm = best > 0 ? 10 * Math.log10(best) : -Infinity;
        if (dbm >= -120) vals[r * size + c] = dbm;
      }
    }
    desc = `Free-space predicted level (best case) from ${use.length} licensed transmitters`;
  } else if (kind === "density") {
    const pts = rows.filter(r => r.lat != null), acc = new Float64Array(size * size), cr = 6, sig2 = 2 * (cr / 2) ** 2;
    for (const r of pts) {
      const r0 = Math.trunc((n - r.lat) / dy), c0 = Math.trunc((r.lon - w) / dx);
      for (let a = -cr; a <= cr; a++) for (let b = -cr; b <= cr; b++) {
        const rr = r0 + a, cc = c0 + b;
        if (rr >= 0 && rr < size && cc >= 0 && cc < size) acc[rr * size + cc] += Math.exp(-(a * a + b * b) / sig2);
      }
    }
    let mx = 0;
    for (const v of acc) if (v > mx) mx = v;
    mx = mx || 1;
    acc.forEach((v, i) => { const x = 100 * v / mx; if (x > 1) vals[i] = x; });
    unit = "%"; desc = `Density of ${pts.length} RF points`;
  } else {
    desc = "Measured level from 0 survey points (captures are kept in RF Recon on the PC)";
  }
  const floor = fnum(p, "floor");
  if (floor != null) vals.forEach((v, i) => { if (v < floor) vals[i] = NaN; });
  const sorted = [...vals].filter(v => !isNaN(v)).sort((a, b) => a - b);
  let vmin = fnum(p, "vmin"), vmax = fnum(p, "vmax");
  if (vmin == null) vmin = sorted.length ? sorted[Math.trunc(.02 * (sorted.length - 1))] : 0;
  if (vmax == null) vmax = sorted.length ? sorted[Math.trunc(.98 * (sorted.length - 1))] : 1;
  const span = (vmax - vmin) || 1, alpha = Math.round(fnum(p, "alpha", 190));
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d"), img = ctx.createImageData(size, size);
  vals.forEach((v, i) => { if (!isNaN(v)) { const [r, g, b] = ramp((v - vmin) / span); img.data.set([r, g, b, alpha], i * 4); } });
  ctx.putImageData(img, 0, 0);
  return {png: cv.toDataURL("image/png").split(",")[1], bounds: [[s, w], [n, e]], vmin, vmax, unit, desc};
}

/* ---------- address search (app.py geocode): towns and counties from the pack, addresses from Photon online ---------- */
const STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR GU VI AS MP".split(" "));
const title = s => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
const placeLabel = r => r.kind === "county" ? `${title(r.name)}${title(r.name).endsWith(" City") ? "" : r.state === "LA" ? " Parish" : " County"}, ${r.state}` : `${title(r.name)}, ${r.state}`;
async function geocode(p) {
  const text = fstr(p, "q");
  if (text.length < 2) return {results: [], online: null};
  const words = text.split(/[\s,]+/).filter(Boolean), last = words[words.length - 1].toUpperCase();
  const state = words.length > 1 && STATES.has(last) ? last : null;
  const name = (state ? words.slice(0, -1) : words).join(" ").replace(/\s+(county|parish)$/i, "");
  const here = [fnum(p, "lat"), fnum(p, "lon")], local = [];
  if (DB) {
    const found = q("SELECT * FROM place WHERE name LIKE ?" + (state ? " AND state = ?" : "") + " ORDER BY n DESC LIMIT 60", [name + "%", ...(state ? [state] : [])]);
    const key = r => [r.name.toLowerCase() !== name.toLowerCase() ? 1 : 0, r.kind !== "county" ? 1 : 0, here[0] != null ? distKm(here[0], here[1], r.lat, r.lon) : -r.n];
    found.sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
    for (const r of found.slice(0, 6)) local.push({label: placeLabel(r), sub: r.kind === "county" ? "County" : "Town", lat: +r.lat.toFixed(5), lon: +r.lon.toFixed(5),
      kind: r.kind, state: r.state, county: r.kind === "county" ? r.name : null, source: "local"});
  }
  let remote = null;
  try {
    const u = new URL("https://photon.komoot.io/api/");
    u.search = new URLSearchParams({q: text, limit: 7, lang: "en", ...(here[0] != null ? {lat: here[0], lon: here[1]} : {})});
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4000);
    const feats = (await (await realFetch(u, {signal: ctl.signal})).json()).features || [];
    clearTimeout(t);
    remote = [];
    for (const f of feats) {
      const pr = f.properties || {}, [lo, la] = f.geometry.coordinates;
      if (pr.countrycode !== "US") continue;
      const street = [pr.housenumber, pr.street].filter(Boolean).join(" "), head = pr.name || street || pr.city || "";
      const tail = [street !== head ? street : null, pr.city, pr.state].filter(Boolean).join(", ");
      remote.push({label: head + (tail ? `, ${tail}` : ""), sub: title((pr.osm_value || pr.type || "").replace(/_/g, " ")), lat: +la.toFixed(6), lon: +lo.toFixed(6), kind: "address", source: "photon"});
    }
  } catch (e) { remote = null; }  // offline: the pack's towns and counties still answer
  const first = /^\d/.test(text) ? (remote || []) : [];
  return {results: [...first, ...local, ...(remote || []).filter(x => !first.includes(x))].slice(0, 10), online: remote !== null};
}

/* ---------- exports (app.py to_csv, features_kml) ---------- */
function toCsv(rows) {
  const keys = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k) && k !== "details" && k !== "extra") keys.push(k);
  const cell = v => { const s = v == null ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [keys.join(","), ...rows.map(r => keys.map(k => cell(r[k])).join(","))].join("\r\n") + "\r\n";
}
function toKml(rows, center, radius) {
  const x = s => String(s ?? "").replace(/[<>&'"]/g, c => ({"<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;"}[c]));
  const kmlColor = h => "ff" + h.slice(5, 7) + h.slice(3, 5) + h.slice(1, 3);
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document>', "<name>RF Recon export</name>"];
  const styles = {};
  for (const r of rows) { const t = r.sig_type || r.layer; if (!(t in styles)) { styles[t] = "s" + Object.keys(styles).length;
    parts.push(`<Style id="${styles[t]}"><IconStyle><color>${kmlColor(META?.sig_lib?.[t]?.color || "#6e7781")}</color><scale>0.8</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>`); } }
  if (center) {
    parts.push(`<Placemark><name>Pin (${radius} mi)</name><Point><coordinates>${center[1]},${center[0]},0</coordinates></Point></Placemark>`);
    const d = radius * MI_KM / EARTH_KM, la1 = rad(center[0]), ring = [];
    for (let i = 0; i < 73; i++) { const b = rad(i * 5), la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
      const lo2 = rad(center[1]) + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
      ring.push(`${(lo2 * 180 / Math.PI).toFixed(6)},${(la2 * 180 / Math.PI).toFixed(6)},0`); }
    parts.push(`<Placemark><name>Search radius</name><Style><LineStyle><color>ff888888</color><width>2</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style><LineString><coordinates>${ring.join(" ")}</coordinates></LineString></Placemark>`);
  }
  const byLayer = {};
  for (const r of rows) if (r.lat != null) (byLayer[r.layer] ||= []).push(r);
  for (const [layer, rs] of Object.entries(byLayer)) {
    parts.push(`<Folder><name>${x(layer)}</name>`);
    for (const r of rs) {
      const ext = Object.entries(r).filter(([k, v]) => v != null && v !== "" && k !== "details" && k !== "extra").map(([k, v]) => `<Data name="${x(k)}"><value>${x(v)}</value></Data>`).join("");
      const nm = (r.freq_mhz ? `${r.freq_mhz.toFixed(5)} MHz ` : "") + (r.label || r.call_sign || "");
      parts.push(`<Placemark><name>${x(nm)}</name><styleUrl>#${styles[r.sig_type || r.layer]}</styleUrl><ExtendedData>${ext}</ExtendedData><Point><coordinates>${r.lon},${r.lat},0</coordinates></Point></Placemark>`);
    }
    parts.push("</Folder>");
  }
  parts.push("</Document></kml>");
  return parts.join("");
}
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], {type}));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
function exportFile(kind, qs) {
  const res = queryArea(new URLSearchParams(qs));
  if (res.error) throw new Error(res.error);
  if (kind === "csv") download("rf_recon.csv", toCsv(res.rows), "text/csv");
  else download("rf_recon.kml", toKml(res.rows, res.center, res.radius), "application/vnd.google-earth.kml+xml");
}

/* ---------- one emitter's coverage (coverage.py, terrain.py): the same models; terrain straight from AWS ---------- */
const COV_MODELS = {free: "Free space (best case)", suburban: "Hata, suburban", urban: "Hata, urban", open: "Hata, open land"};
const fsplDb = (d, f) => 20 * Math.log10(Math.max(d, 0.001)) + 20 * Math.log10(f) + 32.44;
function hataDb(d, f, hbIn, hm, env) {
  const lf = Math.log10(f), hb = Math.max(10, Math.min(hbIn, 300)), a = (1.1 * lf - 0.7) * hm - (1.56 * lf - 0.8);
  const slope = (44.9 - 6.55 * Math.log10(hb)) * Math.log10(Math.max(d, 0.05));
  let L = f <= 1500 ? 69.55 + 26.16 * lf - 13.82 * Math.log10(hb) - a + slope : 46.3 + 33.9 * lf - 13.82 * Math.log10(hb) - a + slope + (env === "urban" ? 3 : 0);
  if (env === "suburban" && f <= 1500) L -= 2 * Math.log10(f / 28) ** 2 + 5.4;
  else if (env === "open") L -= 4.78 * lf ** 2 - 18.33 * lf + 40.94;
  return Math.max(L, fsplDb(d, f));
}
const patternDb = (b, az, bw) => az == null || !bw || bw >= 360 ? 0 : -Math.min(12 * (Math.abs(((b - az + 180) % 360 + 360) % 360 - 180) / bw) ** 2, 25);
const knifeEdgeDb = v => v <= -0.78 ? 0 : 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
function dest(lat, lon, brg, dkm) {
  const p1 = rad(lat), l1 = rad(lon), b = rad(brg), d = dkm / EARTH_KM;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  return [p2 * 180 / Math.PI, (l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2))) * 180 / Math.PI];
}
const TERR = new Map(), K43 = 4 / 3, EARTH_M = EARTH_KM * 1000;
const txy = (lat, lon, z) => { const n = 2 ** z, la = Math.max(-85, Math.min(85, lat));
  return [(lon + 180) / 360 * n, (1 - Math.asinh(Math.tan(rad(la))) / Math.PI) / 2 * n]; };
function terrTile(z, x, y) {  // AWS Terrain Tiles (CORS open), decoded through a canvas, kept for this visit
  const k = `${z}/${x}/${y}`;
  if (!TERR.has(k)) TERR.set(k, (async () => {
    const r = await realFetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
    if (!r.ok) return null;
    const bmp = await createImageBitmap(await r.blob(), {colorSpaceConversion: "none", premultiplyAlpha: "none"});
    const c = document.createElement("canvas"); c.width = c.height = 256;
    const ctx = c.getContext("2d", {willReadFrequently: true}); ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, 256, 256).data, out = new Int16Array(65536);
    for (let i = 0; i < 65536; i++) out[i] = Math.round(d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768);
    return out;
  })().catch(() => null));
  return TERR.get(k);
}
async function terrainFor(lat, lon, rkm, z) {  // load the tiles around a place; returns a lookup (null where missing)
  const [s, n, w, e] = bbox(lat, lon, rkm / MI_KM), [x0, y0] = txy(n, w, z), [x1, y1] = txy(s, e, z), got = new Map();
  const jobs = [];
  for (let x = Math.trunc(x0); x <= Math.trunc(x1); x++) for (let y = Math.trunc(y0); y <= Math.trunc(y1); y++) jobs.push(terrTile(z, x, y).then(t => got.set(`${x}/${y}`, t)));
  await Promise.all(jobs);
  const missing = [...got.values()].filter(t => !t).length;
  return {missing, total: got.size, elev: (la, lo) => { const [x, y] = txy(la, lo, z), tx = Math.trunc(x), ty = Math.trunc(y), t = got.get(`${tx}/${ty}`);
    return t ? t[Math.min(255, Math.trunc((y - ty) * 256)) * 256 + Math.min(255, Math.trunc((x - tx) * 256))] : null; }};
}
const zoomFor = rkm => rkm <= 15 ? 12 : rkm <= 40 ? 11 : 10;
function profileOf(el, lat1, lon1, h1, lat2, lon2, h2, f, skipEnd) {
  const D = distKm(lat1, lon1, lat2, lon2) * 1000, n = Math.max(20, Math.min(600, Math.trunc(D / 30))), ground = [];
  for (let i = 0; i <= n; i++) { const e = el(lat1 + (lat2 - lat1) * i / n, lon1 + (lon2 - lon1) * i / n); if (e == null) return null; ground.push(e); }
  const lam = 299.792458 / f, tx = ground[0] + h1, rx = ground[n] + h2, pts = [];
  let worstV = -1e9, worst = null, minRatio = 1e9;
  for (let i = 1; i < n; i++) {
    const d1 = D * i / n, d2 = D - d1, g = ground[i] + d1 * d2 / (2 * K43 * EARTH_M), los = tx + (rx - tx) * i / n, f1 = Math.sqrt(lam * d1 * d2 / D);
    minRatio = Math.min(minRatio, (los - g) / f1);
    const v = (g - los) * Math.sqrt(2 * D / (lam * d1 * d2));
    if (v > worstV && d2 >= skipEnd) { worstV = v; worst = [d1, g, los]; }
    if (i % Math.max(1, Math.trunc(n / 120)) === 0) pts.push([+(d1 / 1000).toFixed(3), +g.toFixed(1), +los.toFixed(1), +f1.toFixed(1)]);
  }
  return {status: minRatio >= 0.6 ? "clear" : minRatio >= 0 ? "Fresnel zone partly blocked" : "blocked by terrain", loss_db: +knifeEdgeDb(worstV).toFixed(1),
    clearance_f1: +minRatio.toFixed(2), worst_at_km: worst ? worst[0] / 1000 : null, worst_above_los_m: worst ? +(worst[1] - worst[2]).toFixed(1) : null,
    ground1_m: ground[0], ground2_m: ground[n], points: pts};
}
async function coverage(p) {
  const lat = fnum(p, "lat"), lon = fnum(p, "lon"), f = fnum(p, "freq");
  if (lat == null || lon == null) throw new Error("Coverage needs the transmitter's location.");
  if (!f) throw new Error("Coverage needs the transmitter's frequency.");
  if (f < 30) throw new Error(`${f} MHz travels by ground wave and skywave (AM broadcast, HF); RF Recon's coverage models start at 30 MHz.`);
  let eirp, src;
  if (fnum(p, "eirp") != null) { eirp = fnum(p, "eirp"); src = `${eirp} dBm EIRP, set by you`; }
  else if (fnum(p, "erp")) { eirp = 10 * Math.log10(fnum(p, "erp") * 1000) + 2.15; src = `licensed ERP ${fnum(p, "erp")} W`; }
  else if (fnum(p, "power")) { eirp = 10 * Math.log10(fnum(p, "power") * 1000) + (fnum(p, "gain") || 0); src = `transmitter ${fnum(p, "power")} W`; }
  else throw new Error("No power on file for this transmitter, so its coverage can't be estimated. Set the EIRP by hand.");
  const notes = [], hTx = fnum(p, "h") || 30, hRx = fnum(p, "rx", 1.5), thr = fnum(p, "threshold", -95), az = fnum(p, "az"), bw = fnum(p, "bw");
  let model = COV_MODELS[fstr(p, "model")] ? fstr(p, "model") : "suburban";
  if (model !== "free" && !(f >= 30 && f <= 3800)) { model = "free"; notes.push(`${f} MHz is far outside Hata's range, so free space is used (best case).`); }
  else if (model !== "free" && !(f >= 150 && f <= 2000)) notes.push(`${f} MHz is outside Hata's tested 150-2000 MHz: treat the levels as rough.`);
  const lam = 299.792458 / f;
  let g0 = null, hb = hTx, haveT = false;
  if (fstr(p, "terrain") !== "0") {
    const near = await terrainFor(lat, lon, 16, 11);
    g0 = near.elev(lat, lon);
    if (g0 == null) notes.push("No terrain here (offline?), so hills aren't counted.");
    else { haveT = true; const ring = [];
      for (let b = 0; b < 360; b += 10) for (let d = 3; d <= 15; d++) { const e = near.elev(...dest(lat, lon, b, d)); if (e != null) ring.push(e); }
      if (ring.length) hb = hTx + g0 - ring.reduce((a, x) => a + x, 0) / ring.length; }
  }
  if (fnum(p, "haat") != null) hb = fnum(p, "haat");
  const hbSrc = fnum(p, "haat") != null ? "licensed HAAT" : haveT ? "height above the average ground 3-15 km out" : "height above ground";
  if (model !== "free" && hb < 30) notes.push(`Effective antenna height ${Math.round(hb)} m is below Hata's 30 m: levels near the site are rough.`);
  const loss = d => model === "free" ? fsplDb(d, f) : hataDb(d, f, hb, hRx, model);
  let radius = fnum(p, "radius");
  if (!radius) { let d = 0.2; while (d < 60 * MI_KM && eirp - loss(d) >= thr - 10) d *= 1.05; radius = Math.max(1, Math.min(60, d / MI_KM * 1.1)); }
  const R = radius * MI_KM, z = zoomFor(R), STEPS = 240, step = R / STEPS;
  let el = () => null;
  if (haveT) { const t = await terrainFor(lat, lon, R, z); el = t.elev; if (t.missing) notes.push(`Terrain is missing for ${t.missing} of ${t.total} areas (offline?): hills there aren't counted.`); g0 = el(lat, lon) ?? g0; }
  const base = [], drop = [];
  for (let i = 1; i <= STEPS; i++) { base.push(eirp - loss(step * i)); drop.push((step * i * 1000) ** 2 / (2 * K43 * EARTH_M)); }
  const gap = Math.max(1, Math.ceil(1 / step)), gSite = haveT ? g0 : 0, H = gSite + hTx, levels = [], edge = [];
  for (let b = 0; b < 360; b++) {
    const pat = patternDb(b, az, bw), row = new Float64Array(STEPS), ground = new Float64Array(STEPS);
    let ePrev = gSite, best = -1e18, od = null, oh = null, edgeKm = 0;
    for (let i = 1; i <= STEPS; i++) {
      const d = step * i;
      if (haveT) { const e = el(...dest(lat, lon, b, d)); if (e != null) ePrev = e; }
      const g = ePrev - drop[i - 1]; ground[i - 1] = g;
      const k = i - 1 - gap;
      if (k >= 0) { const s = (ground[k] - H) / (step * (k + 1)); if (s > best) { best = s; od = step * (k + 1); oh = ground[k]; } }
      let lvl = base[i - 1] + pat;
      if (od != null) { const los = H + (g + hRx - H) * od / d; lvl -= knifeEdgeDb((oh - los) * Math.sqrt(2 * d / (lam * od * (d - od) * 1000))); }
      row[i - 1] = lvl;
      if (lvl >= thr) edgeKm = d;
    }
    levels.push(row); edge.push(edgeKm);
  }
  const size = Math.max(80, Math.min(Math.round(fnum(p, "size", 200)), 400)), [s, n, w, e] = bbox(lat, lon, radius), dy = (n - s) / size, dx = (e - w) / size;
  const floor = fstr(p, "only") === "1" ? thr : thr - 25, vmin = thr - 25, vmax = thr + 45, kx = 111 * Math.cos(rad(lat));
  const cv = document.createElement("canvas"); cv.width = cv.height = size;
  const ctx = cv.getContext("2d"), img = ctx.createImageData(size, size);
  for (let r = 0; r < size; r++) { const yk = (n - (r + .5) * dy - lat) * 111;
    for (let c = 0; c < size; c++) { const xk = (w + (c + .5) * dx - lon) * kx, d = Math.hypot(xk, yk); if (d > R) continue;
      const v = levels[((Math.round(Math.atan2(xk, yk) * 180 / Math.PI) % 360) + 360) % 360][Math.min(STEPS, Math.max(1, Math.round(d / step))) - 1];
      if (v >= floor) { const [rr, gg, bb] = ramp((v - vmin) / (vmax - vmin)); img.data.set([rr, gg, bb, 190], (r * size + c) * 4); } } }
  ctx.putImageData(img, 0, 0);
  const mi = edge.map(x => x / MI_KM).sort((a, b) => a - b);
  const res = {png: cv.toDataURL("image/png").split(",")[1], bounds: [[s, w], [n, e]], vmin, vmax, unit: "dBm", model: COV_MODELS[model], terrain: haveT,
    radius_mi: +radius.toFixed(2), threshold: thr, eirp_dbm: +eirp.toFixed(1), eirp_src: src, hb_m: +hb.toFixed(1), hb_src: hbSrc, h_tx: hTx, h_rx: hRx, ground_m: g0, notes,
    contour: Array.from({length: 180}, (_, i) => dest(lat, lon, i * 2, edge[i * 2])),
    reach_mi: {max: +mi[359].toFixed(2), median: +mi[180].toFixed(2), min: +mi[0].toFixed(2), beyond: Math.trunc(edge.filter(x => x >= R).length * 100 / 360)},
    pattern: az != null && bw && bw < 360 ? Array.from({length: 72}, (_, i) => +patternDb(i * 5, az, bw).toFixed(1)) : null, az, bw,
    attribution: haveT ? "Terrain: AWS Terrain Tiles (USGS 3DEP, SRTM and others)" : ""};
  res.desc = `${COV_MODELS[model]}${haveT ? " + terrain" : " + smooth earth"}: estimated level from this transmitter (${Math.round(eirp)} dBm EIRP, ${hTx} m up). Edge drawn at ${thr} dBm, the farthest it reaches each way.`;
  const plat = fnum(p, "plat"), plon = fnum(p, "plon");
  if (plat != null && plon != null) {
    const d = distKm(lat, lon, plat, plon), b = (Math.atan2(Math.sin(rad(plon - lon)) * Math.cos(rad(plat)), Math.cos(rad(lat)) * Math.sin(rad(plat)) - Math.sin(rad(lat)) * Math.cos(rad(plat)) * Math.cos(rad(plon - lon))) * 180 / Math.PI + 360) % 360;
    let lvl = eirp - loss(Math.max(d, 0.01)) + patternDb(b, az, bw);
    const pin = {dist_mi: +(d / MI_KM).toFixed(2), bearing: Math.round(b), compass: ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.trunc((b + 11.25) / 22.5) % 16]};
    if (haveT && d > 0.05) {
      const t = await terrainFor((lat + plat) / 2, (lon + plon) / 2, d / 2 + 1, d <= 15 ? 12 : 11), pr = profileOf(t.elev, lat, lon, hTx, plat, plon, hRx, f, d > 2 ? 1000 : 0);
      if (pr) { lvl -= pr.loss_db; Object.assign(pin, {path: pr.status, terrain_loss_db: pr.loss_db, clearance_f1: pr.clearance_f1, profile: pr.points}); }
    }
    pin.level_dbm = +lvl.toFixed(1); pin.margin_db = +(lvl - thr).toFixed(1); res.pin = pin;
  }
  return res;
}

/* ---------- what an emitter is networked with (network.py), from the pack's licences ---------- */
const KIND = c => { c = (c || "").toUpperCase(); return c.startsWith("FB") ? "base" : c.startsWith("FX") ? "fixed" : c.startsWith("MO") ? "mobile" : "other"; };
const PAIRS = [[851, 869, -45], [769, 775, 30]];
const bandOf = f => (META?.bandplan || []).find(b => f >= b.lo && f < b.hi)?.label || (f >= 806 && f < 896 ? "800 MHz" : f >= 698 && f < 806 ? "700 MHz" : "Other");
function network(p) {
  if (!DB) throw new Error("Load a data pack first.");
  const cs = fstr(p, "call_sign"), freq = fnum(p, "freq"), radius = fnum(p, "radius", 60);
  const rows = q("SELECT * FROM tx WHERE call_sign = ? AND status = 'A'", [cs]);
  if (!rows.length) throw new Error(`No active licence ${cs} in this pack.`);
  const r0 = rows[0];
  let lat = fnum(p, "lat"), lon = fnum(p, "lon");
  if (lat == null) { const s = rows.find(r => r.lat != null && KIND(r.station_class) !== "mobile"); if (s) { lat = s.lat; lon = s.lon; } }
  const sites = new Map(), mob = new Map();
  for (const r of rows) {
    const k = KIND(r.station_class);
    if (k !== "mobile" && r.lat != null && !r.is_mobile) {
      const key = `${r.lat},${r.lon}`, s = sites.get(key) || {lat: r.lat, lon: r.lon, city: r.city, county: r.county, state: r.state, address: r.address, tower_reg: r.tower_reg,
        height_m: r.height_tip_m, classes: new Set(), freqs: new Set(), erp_w: null};
      s.classes.add(r.station_class || ""); if (r.freq_mhz) s.freqs.add(+r.freq_mhz.toFixed(5)); if (r.erp_w && (s.erp_w || 0) < r.erp_w) s.erp_w = r.erp_w; sites.set(key, s);
    } else {
      const area = r.radius_km && r.lat != null ? `within ${r.radius_km} km of ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}` : [r.county && r.county + " Co.", r.state].filter(Boolean).join(", ") || "area on the licence";
      const key = `${r.freq_mhz}|${r.station_class}|${area}`, m = mob.get(key) || {freq: +(r.freq_mhz || 0).toFixed(5), class: r.station_class, area, units: 0, lat: r.lat, lon: r.lon, radius_km: r.radius_km};
      m.units += r.units || 0; mob.set(key, m);
    }
  }
  const siteList = [...sites.values()].map(s => ({...s, classes: [...s.classes].sort(), freqs: [...s.freqs].sort((a, b) => a - b),
    dist_mi: lat != null ? +(distKm(lat, lon, s.lat, s.lon) / MI_KM).toFixed(2) : null})).sort((a, b) => (a.dist_mi ?? 0) - (b.dist_mi ?? 0));
  const mobiles = [...mob.values()].sort((a, b) => a.freq - b.freq);
  const baseF = [...new Set(siteList.flatMap(s => s.freqs))].sort((a, b) => a - b), mobF = [...new Set(mobiles.map(m => m.freq).filter(Boolean))];
  const pairs = baseF.map(f => { const o = PAIRS.find(([lo, hi]) => f >= lo && f <= hi);
    if (o) return {base: f, mobile: [+(f + o[2]).toFixed(5)], how: "band plan"};
    const same = mobF.filter(m => bandOf(m) === bandOf(f) && m !== f);
    return {base: f, mobile: same.length ? same : mobF.includes(f) ? [f] : [], how: same.length ? "licence" : mobF.includes(f) ? "simplex" : "not on licence"}; });
  const fleet = new Map(); for (const m of mobiles) fleet.set(`${m.class}|${m.area}`, Math.max(fleet.get(`${m.class}|${m.area}`) || 0, m.units));
  const inList = (sql, vals, args = []) => { const out = []; for (let i = 0; i < vals.length; i += 800) { const ch = vals.slice(i, i + 800); out.push(...q(sql.replace("(?)", `(${ch.map(() => "?").join(",")})`), [...args, ...ch])); } return out; };
  const sysd = new Map();
  for (const r of baseF.length || mobF.length ? inList("SELECT call_sign, licensee, service_name, freq_mhz, lat, lon FROM tx WHERE status = 'A' AND freq_mhz IN (?)", [...baseF, ...mobF]) : [])
    if (r.licensee === r0.licensee && r.call_sign !== cs) { const x = sysd.get(r.call_sign) || {call_sign: r.call_sign, service_name: r.service_name, f: new Set(), s: new Set()};
      x.f.add(r.freq_mhz); x.s.add(`${r.lat},${r.lon}`); sysd.set(r.call_sign, x); }
  let shared = [], others = [], cochannel = [], colocated = [], tower = null;
  if (lat != null) {
    const [s, n, w, e] = bbox(lat, lon, radius);
    if (baseF.length) shared = inList("SELECT licensee, call_sign, service_name, COUNT(DISTINCT freq_mhz) shared, MIN(city) city, MIN(state) state FROM tx WHERE status = 'A' AND licensee <> ? "
      + "AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND freq_mhz IN (?) GROUP BY call_sign HAVING shared >= 2 ORDER BY shared DESC LIMIT 60", baseF, [r0.licensee, s, n, w, e]);
    others = q("SELECT call_sign, service_name, COUNT(DISTINCT freq_mhz) freqs, COUNT(DISTINCT lat || ',' || lon) sites, MIN(city) city, MIN(state) state FROM tx "
      + "WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND licensee = ? AND call_sign <> ? AND status = 'A' GROUP BY call_sign ORDER BY sites DESC LIMIT 200", [s, n, w, e, r0.licensee, cs]);
    if (freq) cochannel = q("SELECT licensee, call_sign, station_class, lat, lon, city, state, erp_w FROM tx WHERE status = 'A' AND freq_mhz BETWEEN ? AND ? AND call_sign <> ? "
      + "AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 400", [freq - 0.0006, freq + 0.0006, cs, s, n, w, e])
      .map(r => ({...r, dist_mi: +(distKm(lat, lon, r.lat, r.lon) / MI_KM).toFixed(1)})).filter(r => r.dist_mi <= radius).sort((a, b) => a.dist_mi - b.dist_mi).slice(0, 80);
  }
  const treg = fstr(p, "tower") || siteList.find(s => s.tower_reg)?.tower_reg;
  if (treg) { tower = q("SELECT * FROM tower WHERE reg = ?", [treg])[0] || {reg: treg};
    colocated = q("SELECT licensee, call_sign, service_name, COUNT(DISTINCT freq_mhz) freqs, GROUP_CONCAT(DISTINCT freq_mhz) f FROM tx WHERE tower_reg = ? AND call_sign <> ? AND status = 'A' GROUP BY call_sign ORDER BY licensee LIMIT 150", [treg, cs])
      .map(c => ({...c, f: [...new Set(String(c.f || "").split(",").filter(Boolean).map(x => +(+x).toFixed(5)))].sort((a, b) => a - b).slice(0, 12)})); }
  return {licence: {call_sign: r0.call_sign, licensee: r0.licensee, service: r0.service, service_name: r0.service_name, category: r0.category, usi: r0.usi},
    sites: siteList, mobiles, units: [...fleet.values()].reduce((a, b) => a + b, 0), pairs,
    simulcast: baseF.map(f => ({freq: f, sites: siteList.filter(s => s.freqs.includes(f)).length})).filter(x => x.sites > 1),
    system: [...sysd.values()].map(x => ({call_sign: x.call_sign, service_name: x.service_name, shared: x.f.size, sites: x.s.size})).sort((a, b) => b.shared - a.shared),
    shared, licences: others, tower, colocated, cochannel, microwave: [], microwave_loaded: false, labels: [], talkgroups: [],
    center: lat != null ? [lat, lon] : null, radius_mi: radius,
    links: {fcc: r0.usi ? `https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey=${r0.usi}` : null, radioreference: `https://www.radioreference.com/db/fcc/callsign/${cs}`}};
}

/* ---------- Search (finder.py) over the pack: places, licences, frequencies, towers, broadcast, aviation, NOAA ---------- */
const SHARED_PS = ["Public Safety (Gov)"], KIND_WORDS = {fire: ["Fire / EMS", ...SHARED_PS], ems: ["Fire / EMS", ...SHARED_PS], rescue: ["Fire / EMS", ...SHARED_PS],
  ambulance: ["Fire / EMS", "Hospital / Medical"], police: ["Law Enforcement", ...SHARED_PS], sheriff: ["Law Enforcement", ...SHARED_PS], law: ["Law Enforcement"],
  911: ["Emergency Mgmt / 911", ...SHARED_PS], dispatch: ["Emergency Mgmt / 911", ...SHARED_PS], emergency: ["Emergency Mgmt / 911", "Fire / EMS"],
  safety: ["Public Safety (Gov)", "Public Safety (Other)"], hospital: ["Hospital / Medical"], medical: ["Hospital / Medical"], school: ["Schools"], schools: ["Schools"],
  utility: ["Utilities"], utilities: ["Utilities"], power: ["Utilities"], electric: ["Utilities"], water: ["Utilities"], gas: ["Utilities"], transit: ["Transportation"],
  bus: ["Transportation"], rail: ["Transportation"], railroad: ["Transportation"], transportation: ["Transportation"], government: ["Local / State Gov"],
  marine: ["Marine"], paging: ["Paging"], aviation: ["Aviation"], airport: ["Aviation"], business: ["Business / Industrial"]};
const US_STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR GU VI AS MP".split(" "));
function townKind(ws, lat, lon) {  // "Charlotte fire", "fire Charlotte NC": a place (a state may follow it) and kind words
  const up = ws.map(w => w.toUpperCase());
  for (let k = up.length - 1; k > 0; k--) for (let i = 0; i + k <= up.length; i++) {
    const name = up.slice(i, i + k); let state = null, after = i + k;
    if (name.every(w => KIND_WORDS[w.toLowerCase()])) continue;
    if (after < up.length && US_STATES.has(up[after]) && up.length - k > 1) state = up[after++];
    const rest = [...up.slice(0, i), ...up.slice(after)];
    if (!rest.some(w => KIND_WORDS[w.toLowerCase()])) continue;
    const found = q("SELECT * FROM place WHERE name = ? COLLATE NOCASE" + (state ? " AND state = ?" : "") + " ORDER BY n DESC LIMIT 20", [name.join(" "), ...(state ? [state] : [])]);
    if (found.length) {
      if (lat != null && lon != null) found.sort((a, b) => distKm(lat, lon, a.lat, a.lon) - distKm(lat, lon, b.lat, b.lon));
      return [found[0], rest.map(w => w.toLowerCase())];
    }
  }
  return null;
}
function byLicensee(items) {  // one row per licensee, listing its call signs; the first (best-ranked or nearest) leads
  const out = [], by = {};
  for (const it of items) {
    const k = (it.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const m = by[k];
    if (m) { m.call_signs.push(it.call_sign); if (it.sites != null) m.sites = (m.sites || 0) + it.sites; m.rank = Math.min(m.rank ?? 1, it.rank ?? 1); continue; }
    by[k] = it; it.call_signs = [it.call_sign]; out.push(it);
  }
  for (const it of out) {
    const cs = it.call_signs, s = it.sites;
    it.sub = cs.length === 1 ? `${cs[0]} · ${it.service}` : `${cs.length} call signs · ${it.service}`;
    it.facts = [it.category, s ? `${s} site${s === 1 ? "" : "s"}` : "", it.where, cs.length === 1 ? "" : cs.slice(0, 6).join(", ") + (cs.length > 6 ? ` +${cs.length - 6} more` : "")];
    delete it.sites; delete it.category; delete it.where;
  }
  return out;
}
function findPack(p) {
  if (!DB) throw new Error("Load a data pack first.");
  const qs = fstr(p, "q"); if (qs.length < 2) throw new Error("Type at least two characters.");
  const t0 = Date.now(), Q = qs.toUpperCase(), lk = `%${qs}%`, lat = fnum(p, "lat"), lon = fnum(p, "lon"), groups = [];
  const fm = /^\s*(\d{1,5}(?:\.\d{1,6})?)\s*(mhz)?\s*$/i.exec(qs), f = fm && (fm[1].includes(".") || fm[2]) ? +fm[1] : null;
  const where = (...xs) => xs.filter(Boolean).join(", ");
  const lic = (r, rank = 1) => ({kind: "licence", title: r.licensee || r.call_sign, call_sign: r.call_sign, service: r.service || "", category: r.category || "",
    sites: r.sites ?? null, where: where(r.city, r.state), lat: r.lat, lon: r.lon, rank});
  const add = (key, label, items) => { if (!items.length) return;
    for (const it of items) it.dist_mi = lat != null && lon != null && it.lat != null ? +(distKm(lat, lon, it.lat, it.lon) / MI_KM).toFixed(1) : null;
    if (lat != null) items.sort((a, b) => (a.rank ?? 1) - (b.rank ?? 1) || (a.dist_mi ?? 1e9) - (b.dist_mi ?? 1e9));
    if (key === "licences" || key === "town") items = byLicensee(items);
    for (const it of items) it.facts = (it.facts || []).filter(Boolean);
    groups.push({key, label, count: items.length, items: items.slice(0, 25)}); };
  const pname = r => `${title(r.name)}${r.kind === "county" ? " County" : ""}, ${r.state}`;
  const ws = (qs.match(/[A-Za-z0-9.'-]+/g) || []).slice(0, 8), tk = f == null && ws.length > 1 ? townKind(ws, lat, lon) : null;
  let town = [];
  if (tk) {
    const [pl, rest] = tk, rmi = pl.kind === "county" ? 20 : 12, [a1, a2, o1, o2] = bbox(pl.lat, pl.lon, rmi), conds = [], args = [], first = new Set();
    for (const w of rest) {
      const cats = KIND_WORDS[w] || [];
      for (const c of cats) if (!SHARED_PS.includes(c) || cats.every(x => SHARED_PS.includes(x))) first.add(c);
      conds.push(`(${cats.length ? `category IN (${cats.map(() => "?").join(",")}) OR ` : ""}licensee LIKE ?)`); args.push(...cats, `%${w}%`);
    }
    town = q(`SELECT call_sign, MAX(licensee) licensee, MAX(service_name) service, MAX(category) category, COUNT(DISTINCT lat || ',' || lon) sites, MAX(lat) lat, MAX(lon) lon,
        MAX(city) city, MAX(state) state FROM tx WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND ${conds.join(" AND ")} GROUP BY call_sign LIMIT 400`, [a1, a2, o1, o2, ...args])
      .map(r => Object.assign(lic(r, rest.some(w => (r.licensee || "").toLowerCase().includes(w)) || first.has(r.category) ? 0 : 1), {_d: r.lat != null ? distKm(pl.lat, pl.lon, r.lat, r.lon) : 1e9}))
      .sort((a, b) => a.rank - b.rank || a._d - b._d);
    for (const it of town) delete it._d;
  }
  const places = q("SELECT * FROM place WHERE name LIKE ? ORDER BY n DESC LIMIT 12", [qs + "%"]);
  add("places", "Places", (places.length ? places : town.length ? [tk[0]] : []).map(r => ({kind: "place", title: pname(r),
    sub: r.kind === "county" ? "County" : "Town", lat: r.lat, lon: r.lon, rank: r.name.toUpperCase() === Q ? 0 : 1})));
  if (town.length) add("town", `${title(tk[1].join(" "))} near ${pname(tk[0])}`, town);
  if (f == null) add("licences", "Licences", q(`SELECT call_sign, MAX(licensee) licensee, MAX(service_name) service, MAX(category) category, COUNT(DISTINCT lat || ',' || lon) sites,
      MAX(lat) lat, MAX(lon) lon, MAX(city) city, MAX(state) state FROM tx WHERE call_sign LIKE ? OR licensee LIKE ? GROUP BY call_sign LIMIT 1000`, [Q + "%", lk])
    .map(r => lic(r, r.call_sign === Q ? 0 : 1)));
  else add("frequency", `On ${f} MHz`, q(`SELECT call_sign, MAX(licensee) licensee, MAX(service_name) service, MAX(lat) lat, MAX(lon) lon, MAX(city) city, MAX(state) state,
      MAX(mode) mode FROM tx WHERE freq_mhz BETWEEN ? AND ? GROUP BY call_sign LIMIT 300`, [f - 0.00051, f + 0.00051]).map(r => ({kind: "licence", title: r.licensee || r.call_sign,
    call_sign: r.call_sign, sub: `${r.call_sign} · ${f} MHz · ${r.service || ""}`, facts: [r.mode, where(r.city, r.state)], lat: r.lat, lon: r.lon})));
  add("towers", "Towers (FCC ASR)", q("SELECT * FROM tower WHERE reg = ? OR owner LIKE ? LIMIT 60", [qs, lk]).map(r => ({kind: "tower",
    title: `${r.struct_type || "Structure"} ${r.overall_agl_m ?? "?"} m · ${r.owner || "owner not on file"}`, sub: `ASR ${r.reg}`, lat: r.lat, lon: r.lon,
    facts: [where(r.street, r.city, r.state)], rank: r.reg === qs ? 0 : 1})));
  add("broadcast", "Broadcast stations", q("SELECT * FROM bcast WHERE call_sign LIKE ? OR licensee LIKE ? LIMIT 40", [Q + "%", lk]).map(r => ({kind: "broadcast",
    title: `${r.call_sign} ${r.kind || r.service || ""} ${fmtMhz(r.freq_mhz, r.kind)}`, sub: r.licensee || "", lat: r.lat, lon: r.lon, facts: [where(r.city, r.state)]})));
  add("aviation", "Aviation (FAA)", q("SELECT * FROM faa WHERE ident = ? OR name LIKE ? LIMIT 40", [Q, lk]).map(r => ({kind: "faa", title: `${r.ident || ""} ${r.name || ""}`.trim(),
    sub: r.freq_mhz ? `${r.freq_mhz} MHz · ${r.use || r.kind || ""}` : r.kind || "", lat: r.lat, lon: r.lon, facts: [where(r.city, r.state)]})));
  add("noaa", "NOAA Weather Radio", q("SELECT * FROM nwr WHERE call_sign LIKE ? OR site LIKE ? OR city LIKE ? LIMIT 20", [Q + "%", lk, lk]).map(r => ({kind: "noaa",
    title: `${r.call_sign} ${r.site || ""}`, sub: `${r.freq_mhz} MHz`, lat: r.lat, lon: r.lon, facts: [where(r.city, r.state)]})));
  return {query: qs, groups, notes: ["Searching this pack. Crowd data, captures, missions, DAS and the research are on the PC."], took_ms: Date.now() - t0, index: "ready"};
}

/* ---------- your own base maps (basemaps.py): tile addresses and ATAK map sources, kept in this browser ---------- */
async function basemaps(path, p, method, body) {
  let maps = [];
  try { maps = JSON.parse(localStorage.getItem("rfr.basemaps") || "[]"); } catch (e) {}
  const checkUrl = u => { u = String(u || "").trim().replace("{$z}", "{z}").replace("{$x}", "{x}").replace("{$y}", "{y}").replace("{$s}", "{s}");
    if (!/^https:\/\//i.test(u)) throw new Error("In the web version a tile address must start with https://.");
    if (!["{z}", "{x}", "{y}"].every(k => u.includes(k))) throw new Error("A tile address needs {z}, {x} and {y} (ATAK's {$z}, {$x}, {$y} work too).");
    return u; };
  if (path === "/basemaps/import" && method === "POST") {
    let m;
    if (typeof body === "string" && body.trim().startsWith("{")) { const d = JSON.parse(body); m = {name: (d.name || "My map").slice(0, 80), url: checkUrl(d.url), min: 0, max: 19}; }
    else {
      const text = body instanceof Blob ? await body.text() : String(body || "");
      if (!text.trim().startsWith("<")) throw new Error("MBTiles maps open in RF Recon on the PC; here, import an ATAK map source (.xml) or a tile address.");
      if (/<!DOCTYPE/i.test(text.slice(0, 2000))) throw new Error("That XML has a DOCTYPE; refused.");
      const x = new DOMParser().parseFromString(text, "application/xml"), g = k => x.querySelector(k)?.textContent?.trim();
      if (x.documentElement.nodeName !== "customMapSource") throw new Error("Expected an ATAK map source (<customMapSource>).");
      m = {name: (fstr(p, "name") || g("name") || "Imported map").slice(0, 80), url: checkUrl(g("url")), min: +(g("minZoom") || 0), max: +(g("maxZoom") || 19)};
    }
    Object.assign(m, {kind: "url", format: "png", id: m.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40) || "map"});
    maps = maps.filter(x => x.id !== m.id).concat([m]);
  } else if (path === "/basemaps/delete" && method === "POST") maps = maps.filter(x => x.id !== fstr(p, "id"));
  try { localStorage.setItem("rfr.basemaps", JSON.stringify(maps)); } catch (e) {}
  return {maps};
}

/* ---------- the server's routes ---------- */
const STUB_STATUS = () => ({net: {online: navigator.onLine, checked: null}, sources: {}, auto: false, links: [], link: "", running: []});
async function route(path, p, method, body) {
  if (path === "/meta") return META ? {built_at: META.fcc_built_at, towers_built_at: META.towers_built_at, tx_rows: META.counts?.licences,
    towers_rows: META.counts?.towers, pack: META.name, pack_made: META.made_at} : {};
  if (path === "/sigid") return {library: META?.sig_lib || {}, bandplan: META?.bandplan || []};
  if (path === "/services") return META?.services || {};
  if (path === "/states") return DB ? q("SELECT state, COUNT(*) n FROM tx WHERE state <> '' GROUP BY state ORDER BY state") : [];
  if (path === "/counties") return DB ? q("SELECT county, COUNT(*) n, AVG(lat) lat, AVG(lon) lon FROM tx WHERE state = ? AND county IS NOT NULL GROUP BY county ORDER BY county", [fstr(p, "state").toUpperCase()]) : [];
  if (path === "/area") {
    const lat = fnum(p, "lat"), lon = fnum(p, "lon");
    if (lat != null && lon != null && !packHas(PACK, lat, lon)) { const msg = await packForPin(lat, lon); if (msg) throw new Error(msg); }
    const hist = (fstr(p, "layers") || "").split(",").includes("uls_hist") ? await historyDbs() : [];
    const r = queryArea(p, hist); if (r.error) throw new Error(r.error); return r;
  }
  if (path === "/heatmap") return heatmap(p);
  if (path === "/coverage") return coverage(p);
  if (path === "/network") return network(p);
  if (path.startsWith("/basemaps")) return basemaps(path, p, method, body);
  if (path === "/mwlinks") return mwlinks(p);
  if (path === "/find") return findPack(p);
  if (/^\/research\/(pim|parts|plans|budget)$/.test(path)) {  // the PIM and Parts tabs' research ships with the page
    const r = await realFetch(`static/research/${{pim: "pim", parts: "rf_parts", plans: "plans_materials", budget: "link_budget"}[path.split("/")[2]]}.json`);
    return r.ok ? r.json() : {empty: true};
  }
  if (path === "/bdc/carriers") return {carriers: []};  // carrier coverage stays on the PC
  if (path === "/bdc/at") return {carriers: [], loaded: false};
  if (path === "/ais") return {ships: [], status: "PC only", error: "Live ships stream from RF Recon on the PC (the key stays there)."};
  if (path === "/geocode") return geocode(p);
  if (path === "/sigwiki/match") return {candidates: await sigwikiMatch(fnum(p, "freq"), fnum(p, "bw"), fstr(p, "type"), fnum(p, "limit", 5))};
  if (path === "/sigwiki/range") return {signals: await sigwikiRange(fnum(p, "lo", 0), fnum(p, "hi", 1e6))};
  if (path === "/update/status" || path === "/net/hint") return STUB_STATUS();
  if (path === "/fieldpacks") return {packs: [], folder: "", phone_url: "../", job: {running: false, log: []}};  // packs are made on the PC
  const e = new Error("That part of RF Recon runs on the PC only."); e.status = 404; throw e;
}

/* ---------- the Signal Identification Wiki's catalog (sigwiki.py's match and in_range) ---------- */
// the facts its matching uses, from the copy beside the packs (state_packs.py: no prose, pictures or audio), loaded once
let SIGWIKI = null;
const sigwikiRows = () => SIGWIKI || (SIGWIKI = (async () => {
  const idx = await (await realFetch("../packs/index.json", {cache: "no-cache"})).json();
  const r = idx.sigwiki ? await realFetch(`../packs/${idx.sigwiki.file}`) : null;
  return r?.ok ? r.json() : [];
})().catch(() => { SIGWIKI = null; return []; }));
const SW_LOCAL = /worldwide|united states|usa|\bus\b|north america|americas|global|international/i;
const SW_WORDS = {"P25 Phase 1": ["p25", "project 25"], "P25 Phase 2": ["p25", "project 25"], "DMR": ["dmr", "mototrbo"],
  "NXDN": ["nxdn"], "dPMR": ["dpmr"], "TETRA": ["tetra"], "ADS-B / Mode S": ["ads-b", "mode s"], "UAT": ["uat"], "AIS": ["ais"],
  "LTE": ["lte"], "5G NR": ["5g", "new radio"], "GSM": ["gsm"], "WCDMA/UMTS": ["umts", "wcdma"], "CDMA": ["cdma"],
  "Wi-Fi": ["wi-fi", "wifi", "802.11"], "Bluetooth": ["bluetooth"], "Bluetooth LE": ["bluetooth"],
  "Paging (POCSAG/FLEX)": ["pocsag", "flex", "pager"], "ISM 902-928 (LoRa/FHSS/meters)": ["lora", "ism"], "Amateur": ["amateur", "ham"]};
const swG = x => {  // Python's f"{x:g}": six significant figures, no trailing zeros, an exact half rounded to even
  if (x == null || !isFinite(x) || x === 0) return String(x);
  const digits = Math.abs(x).toExponential(19).split("e")[0].replace(".", "");
  if (/^\d{5}[02468]50*$/.test(digits)) x = Math.sign(x) * (Math.abs(x) - Math.abs(x) * 1e-15);  // a tie: Python keeps the even digit
  const e = Math.floor(Math.log10(Math.abs(+x.toPrecision(6))));
  if (e < -4 || e >= 6) {
    const [m, p] = x.toExponential(5).split("e");
    return `${String(+m)}e${p[0] === "-" ? "-" : "+"}${p.replace(/^[-+]/, "").padStart(2, "0")}`;
  }
  return String(+x.toPrecision(6));
};
async function sigwikiMatch(f, bw, type, limit) {
  if (!f) return [];
  const words = SW_WORDS[type] || [], out = [];
  for (const e of await sigwikiRows()) {
    if (!(e.fmin <= f + 0.05 && e.fmax >= f - 0.05)) continue;
    let best = null;
    for (const [lo, hi] of e.ranges || []) {
      const tol = lo === hi ? Math.max((e.bw_max || 12.5) / 2000, 0.0005) : 0;
      if (lo - tol <= f && f <= hi + tol) best = best == null ? hi - lo : Math.min(best, hi - lo);
    }
    if (best == null) continue;
    let score = 1 / (1 + Math.log10(1 + best));
    const why = [`covers ${swG(f)} MHz` + (best ? ` (${swG(best)} MHz-wide range)` : " (exact)")];
    if (bw && e.bw_min) {
      if (e.bw_min * 0.7 <= bw && bw <= (e.bw_max || e.bw_min) * 1.3) { score += 1; why.push(`bandwidth fits (${swG(e.bw_min)}-${swG(e.bw_max)} kHz)`); }
      else score -= 0.5;
    }
    const hay = `${e.title} ${e.name} ${e.modulation} ${e.categories}`.toLowerCase();
    if (words.length && words.some(w => hay.includes(w))) { score += 2; why.push(`matches ${type}`); }
    if (e.location && SW_LOCAL.test(e.location)) score += 0.5;
    else if (e.location) { score -= 0.5; why.push(`usually heard in ${e.location.slice(0, 60)}`); }
    out.push({name: e.name, title: e.title, url: e.url, score: Math.round(score * 100) / 100, why, mode: e.mode, modulation: e.modulation,
      location: e.location, bw: [e.bw_min, e.bw_max], description: ""});
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit || 5);
}
async function sigwikiRange(lo, hi, limit = 400) {
  return (await sigwikiRows()).filter(e => e.fmin <= hi && e.fmax >= lo).sort((a, b) => (a.fmax - a.fmin) - (b.fmax - b.fmin)).slice(0, limit)
    .map(e => ({name: e.name, title: e.title, url: e.url, ranges: (e.ranges || []).filter(r => r[1] >= lo && r[0] <= hi), mode: e.mode, modulation: e.modulation}));
}
/* ---------- your own work: the PC app's own server, run in this browser (pyworker.js, webhost.py) ---------- */
// what only the PC's code answers: missions, captures, the field log, labels, DAS, talk groups, your layers, cell
// sites, FCC ID look-ups, the unlisted-signal check and the PC's downloads
const PY_ROUTES = /^\/(missions|captures|observation|overlay|fieldlog|compare|das\/|talkgroups|cells|fccid|report\/signals|layers|settings|crowd\/|export\.|heatmap\.zip|coverage\.kmz)/;
// once something is saved in this browser the PC's code answers the map as well, so captures, labels and layers show
const PY_WITH_WORK = /^\/(area|heatmap|network|find|mwlinks)$/;
// asked for at start-up: until something is saved, the empty answer, so a visit that keeps nothing never loads the engine
const PY_EMPTY = {"/missions": {missions: [], active: null}, "/layers": {layers: [], fetches: []}, "/report/signals": {counts: {}, rows: [], layers: []},
  "/settings": {creds: {}, states: ""}, "/fccid/grantees": {source: "site", page: "https://apps.fcc.gov/oetcf/eas/reports/GranteeSearch.cfm"}};
const WORK = "rfr.work";
const hasWork = () => { try { return localStorage.getItem(WORK) === "1"; } catch (e) { return false; } };
let PYW = null, pySeq = 0, pyStart = null, pyHist = false, pyGrantee = false;
const pyWait = new Map();
const pySend = (msg, transfer = []) => new Promise((ok, no) => { const id = ++pySeq; pyWait.set(id, {ok, no}); PYW.postMessage({...msg, id}, transfer); });
function pyBoot() {
  if (pyStart) return pyStart;
  PYW = new Worker("pyworker.js");
  PYW.onmessage = ({data: m}) => { const w = pyWait.get(m.id); if (!w) return; pyWait.delete(m.id);
    m.ok ? w.ok(m) : w.no(Object.assign(new Error(m.error), {status: 500})); };
  PYW.onerror = e => { for (const w of pyWait.values()) w.no(new Error("RF Recon's engine didn't start: " + (e.message || "check the connection")));
    pyWait.clear(); };
  pyStart = (async () => {
    const st = document.getElementById("status"), was = st?.textContent || "", note = "Starting RF Recon's own engine in this browser";
    if (st) st.textContent = `${note} (the first time it downloads about 15 MB)…`;
    try {
      const pack = PACK ? (await unpack(await idb.get("packdata", PACK.id))).slice().buffer : null;
      await pySend({kind: "start", pack}, pack ? [pack] : []);
    } finally { if (st && st.textContent.startsWith(note)) st.textContent = was; }
  })();
  pyStart.catch(() => { pyStart = null; PYW?.terminate(); PYW = null; });
  return pyStart;
}
async function bodyBytes(b) {
  if (b == null) return null;
  if (b instanceof Blob) return b.arrayBuffer();
  if (b instanceof ArrayBuffer) return b.slice(0);
  if (ArrayBuffer.isView(b)) return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return new TextEncoder().encode(String(b)).buffer;
}
async function pyRoute(path, search, method, opts) {
  await pyBoot();
  if (!pyHist && /^\/(area|heatmap|export\.)/.test(path) && (new URLSearchParams(search).get("layers") || "").split(",").includes("uls_hist")) {
    const files = (await historyFiles()).map(b => b.slice().buffer);
    await pySend({kind: "history", files}, files);
    pyHist = true;
  }
  if (!pyGrantee && path === "/fccid") {  // the FCC's equipment-maker codes, one file on the site (fieldpack.build_grantee)
    let buf = await idb.get("packdata", "grantee");
    if (!buf) {
      const name = (await (await realFetch("../packs/index.json", {cache: "no-cache"})).json()).grantee;
      const r = name ? await realFetch(`../packs/${name}`) : null;
      if (r?.ok) { buf = await r.arrayBuffer(); await idb.put("packdata", buf, "grantee"); }
    }
    if (buf) { const file = (await unpack(buf)).slice().buffer; await pySend({kind: "grantee", file}, [file]); }
    pyGrantee = true;
  }
  const body = await bodyBytes(opts?.body);
  const ctype = new Headers(opts?.headers || {}).get("Content-Type") || (opts?.body instanceof Blob ? opts.body.type : "");
  const r = await pySend({kind: "req", method, path: "/api" + path, query: search, body, ctype}, body ? [body] : []);
  if (method !== "GET" && r.status < 400) try { localStorage.setItem(WORK, "1"); } catch (e) {}
  return new Response(r.body, {status: r.status, headers: r.headers});
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, opts) => {
  let u;
  try { u = new URL(typeof input === "string" ? input : input.url, location.href); } catch (e) { return realFetch(input, opts); }
  if (u.origin !== location.origin || !u.pathname.startsWith("/api/")) return realFetch(input, opts);
  await ready;
  const reply = (status, obj) => new Response(JSON.stringify(obj), {status, headers: {"Content-Type": "application/json"}});
  const path = u.pathname.slice(4), method = (opts?.method || "GET").toUpperCase();
  try {
    if (method === "GET" && path in PY_EMPTY && !pyStart && !hasWork()) return reply(200, PY_EMPTY[path]);
    if (PY_ROUTES.test(path) || (PY_WITH_WORK.test(path) && hasWork())) return await pyRoute(path, u.search.slice(1), method, opts);
    return reply(200, await route(path, u.searchParams, method, opts?.body));
  }
  catch (e) { return reply(e.status || 400, {error: e.message || String(e)}); }
};

/* ---------- map tiles: straight from the sources (the PC fetches them through its own cache) ---------- */
const USGS = id => `https://basemap.nationalmap.gov/arcgis/rest/services/${id}/MapServer/tile/{z}/{y}/{x}`;
const TILES = {"osm": "https://tile.openstreetmap.org/{z}/{x}/{y}.png", "usgs-imagery": USGS("USGSImageryOnly"), "usgs-imagery-topo": USGS("USGSImageryTopo"),
  "usgs-topo": USGS("USGSTopo"), "usgs-relief": USGS("USGSShadedReliefOnly"),
  "esri-imagery": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"};
const WM = 20037508.342789244;
const CountyLines = L.TileLayer.extend({getTileUrl(c) {  // TIGERweb draws county and state lines for any box
  const z = this._getZoomForUrl(), size = 2 * WM / 2 ** z, minx = -WM + c.x * size, maxy = WM - c.y * size;
  return "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/export"
    + `?bbox=${minx.toFixed(2)},${(maxy - size).toFixed(2)},${(minx + size).toFixed(2)},${maxy.toFixed(2)}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&dpi=96&f=image`;
}});
const tileLayer = L.tileLayer;
L.tileLayer = (url, opts) => {
  const m = /^\/tiles\/([^/]+)\//.exec(url || "");
  if (!m) return tileLayer(url, opts);
  if (m[1] === "counties") return new CountyLines("", opts);
  return tileLayer(TILES[m[1]] || url, {...opts, crossOrigin: "anonymous"});
};

window.RFPack = {ready, info: () => PACK, meta: () => META, list: () => idb.all("packs"), import: importPack, remove: removePack,
  sitePacks, loadSite: loadSitePack, hasWork, packUpdate,
  use: async id => { await idb.put("kv", id, "activePack"); }, exportFile};
})();
