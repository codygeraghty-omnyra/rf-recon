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
async function removePack(id) {
  await idb.del("packs", id); await idb.del("packdata", id);
  if (PACK?.id === id) { await idb.del("kv", "activePack"); DB?.close(); DB = META = PACK = null; }
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
function q(sql, args = []) {
  const st = DB.prepare(sql);
  try { st.bind(args); const out = []; while (st.step()) out.push(st.getAsObject()); return out; } finally { st.free(); }
}
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
function ulsFilters(p) {
  const where = [], args = [];
  const svc = fstr(p, "svc").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  if (svc.length) { where.push(`service IN (${svc.map(() => "?").join(",")})`); args.push(...svc); }
  if (fstr(p, "tech")) { where.push("mode LIKE ?"); args.push(`%${fstr(p, "tech")}%`); }
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
function queryArea(p) {
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
  if (layers.has("uls")) {  // packs hold current licences only, so the history layer has nothing to add
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
  if (area.point) out.sort((a, b) => (a.dist_mi ?? 1e9) - (b.dist_mi ?? 1e9) || (a.freq_mhz || 0) - (b.freq_mhz || 0));
  return {rows: out, truncated, center: area.point, radius: area.radius};
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
function heatmap(p) {
  const lat = fnum(p, "lat"), lon = fnum(p, "lon"), radius = fnum(p, "radius", 10);
  if (lat == null) throw new Error("Heatmaps need a pin location.");
  const kind = fstr(p, "kind") || "predicted", size = Math.max(60, Math.min(Math.round(fnum(p, "size", 200)), 600));
  const [s, n, w, e] = bbox(lat, lon, radius), dy = (n - s) / size, dx = (e - w) / size;
  const vals = new Float64Array(size * size).fill(NaN);
  const res = queryArea(p);
  if (res.error) throw new Error(res.error);
  const set = k => new Set(fstr(p, k).split("|").filter(Boolean));
  const types = set("types"), bands = set("bands"), cats = set("cats"), ident = fstr(p, "ident").toLowerCase();
  const rows = res.rows.filter(r => (!types.size || types.has(r.sig_type || "Unknown")) && (!bands.size || bands.has(r.band || "Other"))
    && (!cats.size || cats.has(r.category || "Other")) && (!ident || `${r.ident || ""} ${r.label || ""}`.toLowerCase().includes(ident)));
  let unit = "dBm", desc;
  if (kind === "predicted") {
    const seen = new Set(), tx = [];
    for (const r of rows) {
      if (!["uls", "broadcast", "noaa"].includes(r.layer) || r.lat == null || r.is_mobile) continue;
      const erp = r.erp_w || r.power_out_w, key = `${r.lat}|${r.lon}|${r.freq_mhz}`;
      if (erp && r.freq_mhz && !seen.has(key)) { seen.add(key); tx.push([r.lat, r.lon, erp, r.freq_mhz]); }
    }
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

/* ---------- the server's routes ---------- */
const STUB_STATUS = () => ({net: {online: navigator.onLine, checked: null}, sources: {}, auto: false, wifi_only: false, link: "", running: []});
async function route(path, p, method) {
  if (path === "/meta") return META ? {built_at: META.fcc_built_at, towers_built_at: META.towers_built_at, tx_rows: META.counts?.licences,
    towers_rows: META.counts?.towers, pack: META.name, pack_made: META.made_at} : {};
  if (path === "/sigid") return {library: META?.sig_lib || {}, bandplan: META?.bandplan || []};
  if (path === "/services") return META?.services || {};
  if (path === "/states") return DB ? q("SELECT state, COUNT(*) n FROM tx WHERE state <> '' GROUP BY state ORDER BY state") : [];
  if (path === "/counties") return DB ? q("SELECT county, COUNT(*) n, AVG(lat) lat, AVG(lon) lon FROM tx WHERE state = ? AND county IS NOT NULL GROUP BY county ORDER BY county", [fstr(p, "state").toUpperCase()]) : [];
  if (path === "/area") { const r = queryArea(p); if (r.error) throw new Error(r.error); return r; }
  if (path === "/heatmap") return heatmap(p);
  if (path === "/geocode") return geocode(p);
  if (path === "/report/signals") return {counts: {}, rows: [], layers: []};
  if (path === "/sigwiki/match") return {candidates: []};  // the Signal ID Wiki catalog stays on the PC (its terms)
  if (path === "/sigwiki/range") return {signals: []};
  if (path === "/missions" && method === "GET") return [];
  if (path === "/update/status" || path === "/net/hint") return STUB_STATUS();
  if (path === "/settings" && method === "GET") return {creds: {}, states: ""};
  if (path === "/layers") return {layers: [], fetches: []};
  if (path === "/overlay" || path === "/observation") throw new Error("Labels and observations are kept in RF Recon on the PC. The web version reads packs only.");
  const e = new Error("That part of RF Recon runs on the PC only."); e.status = 404; throw e;
}
const realFetch = window.fetch.bind(window);
window.fetch = async (input, opts) => {
  let u;
  try { u = new URL(typeof input === "string" ? input : input.url, location.href); } catch (e) { return realFetch(input, opts); }
  if (u.origin !== location.origin || !u.pathname.startsWith("/api/")) return realFetch(input, opts);
  await ready;
  const reply = (status, obj) => new Response(JSON.stringify(obj), {status, headers: {"Content-Type": "application/json"}});
  try { return reply(200, await route(u.pathname.slice(4), u.searchParams, (opts?.method || "GET").toUpperCase())); }
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
  use: async id => { await idb.put("kv", id, "activePack"); }, exportFile};
})();
