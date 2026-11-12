"use strict";
/* DAStastic — Towers (plan 11/10, section 2; Andy Masur on 11/9: "I type in an address and I only want to see the towers...
   I could click on one and it would say this is what's on this tower", and "the three closest towers per carrier, and what
   technologies are supported on each"). Type an address and the report runs, with nothing to set: per carrier, a verdict and
   the 3 closest towers (towerfuse.py, GET /api/towers), on a map that shows towers only. With nothing clicked the results
   viewer (results.js) shows the summary; a click on a tower shows its tiles there, and the map never moves but for Zoom to.
   One click each: Street View, Google Maps, Find a signal, Save, the printed tower report, a CSV and a share link.
   RFTowers.load / reportHtml / csv / print / share / layer serve this tab and any other caller.
   Needs core.js (S, api, post, esc, num, $, setTab, render, pinIcon, mapPrefs, baseLayer, BASEMAPS, addMapLayers, LAYERS),
   results.js, mapexport.js (the report's map image), das.js (dasPrintCopy, dasDl) and Leaflet. */
(() => {
  if (typeof S !== "object" || !S.views) return;  // a page without core.js (the phone app) has no tower report
  const BIG3 = ["AT&T", "Verizon", "T-Mobile"];
  const COLOR = {"AT&T": "#009fdb", "Verizon": "#cd040b", "T-Mobile": "#e20074"};
  const cColor = c => COLOR[c] || "#8c959f";
  const CROWD = ["opencellid", "wigle", "captures"];  // the crowd and survey readings "Show crowd readings" adds
  const KIND = {registered: ["■", "registered", "an FCC registered structure"], mapped: ["▲", "mapped", "a mast mapped in OpenStreetMap"],
    licensed: ["◆", "licensed site", "a carrier's FCC licence location, no registered structure"], cluster: ["◆", "licensed site", "land-mobile licences at one spot"],
    estimated: ["○", "estimated", "estimated from crowd cells: the bubble is how far off it may be"]};
  const kindOf = t => KIND[t.kind] || ["■", t.kind || "tower", ""];
  const LEVEL = {"in reach": ["In reach", "reach"], marginal: ["Marginal", "marginal"], far: ["Far: no off-air BDA", "far"], none: ["None found", "none"], unknown: ["Not known yet", "unknown"]};
  const TECH = {LTE: "LTE", NR: "5G NR", UMTS: "UMTS", GSM: "GSM", CDMA: "CDMA", licensed: "licensed (no cells heard)"};
  // the common names of the bands a US carrier uses (3GPP numbers), for the Bands tile's detail
  const BAND_NAME = {B2: "PCS 1900", B4: "AWS-1", B5: "Cellular 850", B12: "700 MHz lower A/B/C", B13: "700 MHz upper C", B14: "700 MHz FirstNet", B17: "700 MHz lower B/C",
    B25: "PCS 1900 + G", B26: "850 + ESMR", B29: "700 MHz lower D/E (downlink only)", B30: "WCS 2300", B41: "2.5 GHz", B46: "5 GHz LAA", B48: "CBRS 3.5 GHz", B66: "AWS-1/3",
    B70: "AWS-4 / H block", B71: "600 MHz", B85: "700 MHz lower A", n2: "PCS 1900", n5: "Cellular 850", n12: "700 MHz lower", n14: "700 MHz FirstNet", n25: "PCS 1900 + G",
    n26: "850 + ESMR", n29: "700 MHz (downlink only)", n30: "WCS 2300", n41: "2.5 GHz", n48: "CBRS 3.5 GHz", n66: "AWS-1/3", n70: "AWS-4 / H block", n71: "600 MHz",
    n77: "C-band 3.7 GHz", n258: "24 GHz mmWave", n260: "39 GHz mmWave", n261: "28 GHz mmWave"};
  // T.key: the report on screen ("lat,lon"); T.place: its address, kept with it (the address box's label changes as soon as the next
  // address is typed or picked, before its search answers); T.msgFor: what a top-up said for a report no longer on screen
  const T = S.towers = S.towers || {key: null, full: {}, fullAsk: {}, place: "", data: null, err: null, carriers: new Set(), crowd: null, sel: null, picker: false, msg: "", msgFor: {}, spec: {}};
  const store = {get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; /* storage blocked (a private window): the default */ } },
    set(k, v){ try{ localStorage.setItem(k, v); }catch(e){ /* storage blocked: for this page only */ } },
    del(k){ try{ localStorage.removeItem(k); }catch(e){ /* storage blocked: nothing kept */ } }};
  T.labels = T.labels || (["off", "carriers", "tiles"].includes(store.get("rfr.towerLabels")) ? store.get("rfr.towerLabels") : "carriers");
  const fmtMi = x => x == null ? "" : x < 1 ? num(x, 2) : num(x, 1);
  const far = t => t.dist_mi == null ? "" : `${fmtMi(t.dist_mi)} mi ${t.compass || ""} (${t.bearing ?? "?"}° true)`;
  // north: the engine's bearings are from true north (a map's); a hand compass on site reads magnetic. The declination at the
  // report's site (NOAA's WMM2025, wmm.js), once per answer; magnetic = true - declination (east positive), as das.js's donor sheet
  const decls = new WeakMap();
  const declOf = d => { if (!d || !window.WMM) return null; if (!decls.has(d)) { let v = null; try{ v = WMM.declination(+d.lat, +d.lon, new Date()); }catch(e){ v = null; /* outside the model */ } decls.set(d, v); } return decls.get(d); };
  const magOf = (brg, decl) => brg == null || decl == null ? null : Math.round(((brg - decl) % 360 + 360) % 360);
  const declTxt = decl => decl == null ? "" : `${num(Math.abs(decl), 1)}° ${decl < 0 ? "W" : "E"}`;
  // a reading over stale_days old (the engine's: 3 years) is from cells that may be off the air (ex-Sprint LTE, off since 6/2022)
  const isOld = (last, d) => { const t = Date.parse(String(last || "").slice(0, 10)); return !!t && (Date.now() - t) / 864e5 >= ((d && d.stale_days) || 1095); };
  // a carrier's cells on a tower by band and channel, each with its PCIs: the current ones, and those last heard over stale_days
  // ago apart. One entry can hold both: a current T-Mobile eNB and the ex-Sprint cells beside it
  function cellsOf(e, d){
    const out = {cur: new Map(), old: new Map(), oldLast: ""};
    for (const s of e.sites || []) for (const x of s.cells || []) {
      const last = String(x.last || s.last || ""), old = isOld(last, d), m = old ? out.old : out.cur, b = x.band || {}, nr = (b.tech || s.radio) === "NR", k = `${b.band || ""}|${x.channel ?? ""}`;
      if (!m.has(k)) m.set(k, {band: b.band || "", nr, kind: b.kind || (nr ? "NR-ARFCN" : "EARFCN"), ch: x.channel, mhz: b.dl_mhz, pcis: new Set()});
      if (x.pci != null && x.pci !== "") m.get(k).pcis.add(+x.pci);
      if (old && last > out.oldLast) out.oldLast = last;
    }
    return out;
  }
  const chanTxt = g => `${g.band ? `${g.band} ` : ""}${g.kind} ${g.ch ?? "?"}${g.mhz != null ? ` (${num(g.mhz, 1)} MHz)` : ""}: ${g.pcis.size ? `${g.nr ? "NR " : ""}PCI ${[...g.pcis].sort((a, b) => a - b).join(", ")}` : "PCI not on file"}`;
  // the bands a carrier was heard on here only in cells over stale_days old: {band: last heard}
  const oldBands = (e, d) => { const g = cellsOf(e, d), now = new Set([...g.cur.values()].map(x => x.band)), out = {};
    for (const x of g.old.values()) if (x.band && !now.has(x.band)) out[x.band] = g.oldLast.slice(0, 10); return out; };
  const countyLic = x => x.how === "county licence";
  const http = u => /^https?:\/\//i.test(String(u || "")) ? String(u) : null;
  const link = (u, text) => http(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener">${text}</a>` : text;
  const gmaps = t => `https://www.google.com/maps/search/?api=1&query=${(+t.lat).toFixed(6)},${(+t.lon).toFixed(6)}`;
  const street = t => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${(+t.lat).toFixed(6)},${(+t.lon).toFixed(6)}`;
  const today = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

  /* ---------- the answer ---------- */
  const cache = new Map();  // "lat,lon" -> the promise of /api/towers there
  const keyOf = (lat, lon) => `${(+lat).toFixed(5)},${(+lon).toFixed(5)}`;
  // a request with no answer (a half-open connection on a phone, the PC behind the door asleep) gives up after WAIT.ms, so the
  // cache drops it and the address picked again asks again: it said "Finding the towers…" for as long as the browser kept the socket
  const WAIT = {ms: 90000, image: 15000};  // image: what the printed report's sharp map may take (mapImage)
  function load(lat, lon, fresh){
    const k = keyOf(lat, lon);
    if (!fresh && cache.has(k)) return cache.get(k);
    const ctl = typeof AbortController === "function" ? new AbortController() : null, ms = WAIT.ms, timer = ctl ? setTimeout(() => ctl.abort(), ms) : 0;
    const p = api(`/api/towers?lat=${(+lat).toFixed(6)}&lon=${(+lon).toFixed(6)}`, ctl ? {signal: ctl.signal} : undefined)
      .catch(err => { throw ctl && ctl.signal.aborted ? new Error(`no answer in ${Math.round(ms / 1000)} s: pick the address again to ask again`) : err; })
      .finally(() => clearTimeout(timer));
    cache.set(k, p); p.catch(() => { if (cache.get(k) === p) cache.delete(k); });
    if (cache.size > 12) cache.delete(cache.keys().next().value);
    return p;
  }
  // as an address is picked on this tab the report starts at once, beside the area search (core.js runSearch)
  function prefetch(){ const ll = parseLoc($("#loc").value); if (ll) load(ll[0], ll[1]).catch(() => {}); }
  // every tower in the answer, nearest first: the full ones (each carrier's closest and its stale ones) over the map's
  // compact list, and the structures with no carrier known
  function towersOf(d){
    const m = new Map();
    for (const t of d.towers || []) m.set(t.id, {...t, _full: false});
    for (const c of d.carriers || []) for (const t of [...(c.towers || []), ...(c.stale_towers || [])]) m.set(t.id, {...t, _full: true});
    for (const t of d.other_structures || []) if (!m.has(t.id)) m.set(t.id, {...t, _other: true, _full: false});
    return [...m.values()].sort((a, b) => a.dist_km - b.dist_km);
  }
  // the carriers a report shows: the chips on screen, or the set a print took when it started
  const shown = (d, cars = T.carriers) => (d.carriers || []).filter(c => !cars.size || cars.has(c.carrier));
  const siteOf = d => [+d.lat, +d.lon];  // the report's own site, never the live pin
  const placeTxt = d => T.place || `${(+d.lat).toFixed(5)}, ${(+d.lon).toFixed(5)}`;
  const entries = (t, c) => Array.isArray(t.carriers) ? t.carriers.filter(e => !c || e.carrier === c) : [];
  const names = t => t.carrier_names || (Array.isArray(t.carriers) ? t.carriers.map(e => e.carrier) : []);
  const onMap = t => !T.carriers.size ? true : names(t).some(c => T.carriers.has(c));
  // a tower: the answer's full entry, or, for one outside every carrier's 3 closest, the full entry asked for when it was clicked
  const findTower = (d, id) => (d === T.data && T.full[id]) || towersOf(d).find(t => t.id === id) || null;
  // what's on a tower outside every carrier's 3 closest (the answer has only the map's short entry for it): asked for when it's
  // clicked, its carriers' 10 closest within the report's radius, so its bands, tech, sectors and sources show as for the others
  // (it said "Pick its carrier's chip, or open it from the summary", and neither worked; Andy 11/9: "click on one and it would
  // say this is what's on this tower")
  function askFull(t){
    const d = T.data, k = T.key, cs = names(t).filter(c => BIG3.includes(c)); if (!d || !cs.length || t.id in T.full || T.fullAsk[t.id]) return;
    T.fullAsk[t.id] = "asking";
    api(`/api/towers?lat=${d.lat}&lon=${d.lon}&radius=${d.radius_mi || 5}&n=10&carriers=${encodeURIComponent(cs.join(","))}`).then(r => {
      if (T.key !== k) return;
      let got = null; for (const c of r.carriers || []) for (const x of [...(c.towers || []), ...(c.stale_towers || [])]) if (x.id === t.id) got = {...x, _full: true};
      if (got) T.full[t.id] = got; else T.fullAsk[t.id] = "not found";
      if (T.sel === t.id) showViewer();
    }).catch(err => { if (T.key !== k) return; T.fullAsk[t.id] = `not read: ${err.message}`; if (T.sel === t.id) showViewer(); });
  }

  /* ---------- the bands: a channel heard, its band's name and range, and the carrier's licensed block there ---------- */
  const tables = () => (window.sigMetaParts && sigMetaParts.tables) || {};
  function bandRange(b){
    const tb = tables(), r = (tb.LTE || []).concat(tb.LTE_HEARD || []).find(x => x[0] === b);
    if (r) return [r[1], r[5]];
    const n = (tb.NR || []).find(x => x[0] === b); return n ? [n[1], n[2]] : null;
  }
  function specFor(d){  // the county's licensed blocks (/api/spectrum), once per report, in the background
    const k = T.key; if (!k || !d || k in T.spec) return T.spec[k] || null;
    T.spec[k] = null;
    // the blocks go into the band details: drawn again only for the same report, in a viewer still open, when there are blocks, and
    // never over a band detail the user has open (it reopened a viewer just closed and shut a detail just opened)
    api(`/api/spectrum?lat=${d.lat}&lon=${d.lon}`).then(s => { T.spec[k] = s;
      const v = T.map && window.RFResults && RFResults.get(T.map);
      if (T.key === k && s && !s.empty && v && !T.closed && !v.body?.querySelector(".tw-bandinfo:not([hidden])")) showViewer(); }).catch(() => { T.spec[k] = {empty: true}; });
    return null;
  }
  function blockAt(carrier, mhz){
    const s = T.spec[T.key]; if (!s || s.empty || mhz == null) return null;
    const c = (s.carriers || []).find(x => x.brand === carrier); if (!c) return null;
    for (const b of c.bands || []) for (const k of b.blocks || []) for (const [lo, hi] of k.dl || []) if (mhz >= lo && mhz <= hi) return {band: b.band, block: k.block, lo, hi, county: s.county, part: !!k.part};
    return null;
  }
  function bandInfo(x, carrier, heard){
    const nm = BAND_NAME[x.band], rg = bandRange(x.band);
    const head = `${x.band}${nm ? ` (${nm})` : ""}${rg ? `, downlink ${num(rg[0], 0)}–${num(rg[1], 0)} MHz` : ""}`;
    if (!heard) return `${head}. ${carrier} holds it ${x.how === "county licence" ? `in ${(T.data && T.data.licensed_where) || "the county"}'s licences` : x.how || "by licence"}${x.note ? ` (${x.note})` : ""}: licensed, not heard here.`;
    const kind = x.tech === "NR" ? "NR-ARFCN" : "EARFCN";
    const chans = (x.channels || []).map((ch, i) => { const mhz = (x.dl_mhz || [])[i], blk = blockAt(carrier, mhz);
      // a block held only as a part of its market (a split licence) may not reach this county, and its width is the whole block's
      return `${kind} ${ch} = ${num(mhz, 1)} MHz downlink${blk ? blk.part ? `, block ${blk.block} (${num(blk.lo, 1)}–${num(blk.hi, 1)} MHz), which ${carrier} holds only in part of its market: it may not cover ${blk.county}`
        : `, block ${blk.block} (${num(blk.lo, 1)}–${num(blk.hi, 1)} MHz, ${num(blk.hi - blk.lo, 1)} MHz licensed to ${carrier} in ${blk.county})` : ""}`; });
    return `${head}. Heard: ${chans.join("; ")}.${x.also && x.also.length ? ` Could also be ${x.also.join(", ")}.` : ""}${x.note ? ` ${x.note}.` : ""}${T.spec[T.key] && !T.spec[T.key].empty ? "" : " The block shows where carrier spectrum is loaded (Data & updates)."}`;
  }

  /* ---------- the tiles (plan section 4): what each tower shows, in the viewer, the printed report and the CSV ---------- */
  const TILES = [["type", "Type"], ["carriers", "Carriers"], ["bands", "Bands"], ["tech", "Tech"], ["dist", "Distance and bearing"], ["height", "Height"],
    ["sectors", "Sectors"], ["ids", "Site IDs"], ["owner", "Owner"], ["conf", "Confidence"], ["sources", "Sources"], ["links", "Links"]];
  const DEFAULT_TILES = ["type", "carriers", "bands", "tech", "dist", "conf"];
  const TILE_KEY = "rfr.towerTiles";
  let memTiles;  // this page's choice once made: storage can be blocked (a private window, site data off), and it's read from here
  function tilePref(){
    let p = null; try{ p = JSON.parse((memTiles !== undefined ? memTiles : store.get(TILE_KEY)) || "null"); }catch(e){ p = null; /* unreadable: the default */ }
    const ids = TILES.map(x => x[0]);
    if (!p || !Array.isArray(p.order) || !Array.isArray(p.on)) return {order: [...DEFAULT_TILES, ...ids.filter(i => !DEFAULT_TILES.includes(i))], on: [...DEFAULT_TILES]};
    const order = p.order.filter(i => ids.includes(i)); for (const i of ids) if (!order.includes(i)) order.push(i);
    return {order, on: p.on.filter(i => ids.includes(i))};
  }
  const chosen = () => { const p = tilePref(); return p.order.filter(i => p.on.includes(i)); };
  const tileLabel = id => (TILES.find(x => x[0] === id) || [id, id])[1];
  const none = w => `<span class="hint">${w}</span>`;
  const NOT_LISTED = "Listed for each carrier's 3 closest towers.";
  // a structure no carrier is known on has no bands, sectors or site IDs; one off every carrier's closest is asked for when clicked
  const notYet = t => T.fullAsk[t.id] && T.fullAsk[t.id] !== "asking" ? `Not in this report: its carriers' 10 closest ${T.fullAsk[t.id] === "not found" ? "don't include it" : `couldn't be read (${T.fullAsk[t.id]})`}.` : "Asking what's on it…";
  const gap = t => !names(t).length ? none("No carrier known here") : !t._full ? none(T.sel === t.id ? notYet(t) : NOT_LISTED) : null;
  const chip = (c, extra) => `<span class="tw-cc" style="--c:${cColor(c)}">${esc(c)}${extra ? ` <small>${esc(extra)}</small>` : ""}</span>`;
  const per = (es, c, fn) => es.map(e => `${!c && es.length > 1 ? `<span class="tw-who" style="--c:${cColor(e.carrier)}">${esc(e.carrier)}</span> ` : ""}${fn(e)}`).join("<br>");
  const perTxt = (es, c, fn) => es.map(e => `${!c && es.length > 1 ? `${e.carrier}: ` : ""}${fn(e)}`).filter(Boolean).join("; ");
  const sectorsTxt = e => (e.sectors || []).map(s => `${s.az}°${s.faces_site ? " (faces the site)" : ""}`).join(", ");
  // each tile: html(t, c) for the viewer and the printed report, cols [[header, value(t, c)]] for the CSV and a map label; c is one
  // carrier, or null for every carrier on the tower
  const TILE = {
    type: {html: t => { const [sym, word] = kindOf(t);
        return `${esc(t.type || "type not on file")}<br><span class="tw-k">${sym} ${esc(word)}${t.kind === "estimated" && t.uncertainty_m ? `, give or take ${num(t.uncertainty_m, 0)} m` : ""}</span>`; },
      cols: [["Type", t => t.type || ""], ["Kind", t => kindOf(t)[1]], ["Uncertainty (m)", t => t.uncertainty_m ?? ""]]},
    carriers: {html: (t, c) => { const es = entries(t), stale = new Set(t.stale_for || []);
        if (!names(t).length) return none("No carrier known here");
        return names(t).map(n => { const e = es.find(x => x.carrier === n);
          const extra = [e && e.firstnet ? "+ FirstNet Band 14" : "", e && e.ex_sprint ? "ex-Sprint cells" : "", stale.has(n) ? `last heard ${String(e?.last || "long ago").slice(0, 10)}` : ""].filter(Boolean).join(", ");
          return `<div class="tw-ci">${chip(n)}${extra ? ` <small class="hint">${esc(extra)}</small>` : ""}</div>`; }).join(""); },
      cols: [["Carriers on the tower", t => { const es = entries(t); return names(t).map(n => { const e = es.find(x => x.carrier === n);
        return `${n}${e && e.firstnet ? " (+ FirstNet Band 14)" : ""}${(t.stale_for || []).includes(n) ? " (stale)" : ""}`; }).join("; "); }]]},
    bands: {html: (t, c) => { const g = gap(t); if (g) return g; const es = entries(t, c); if (!es.length) return none("No carrier known here");
        return per(es, c, e => { const heard = e.bands?.heard || [], lic = (e.bands?.licensed || []).filter(x => !heard.some(h => h.band === x.band)), old = oldBands(e, T.data);
          // a band heard only in old cells is marked (old), its detail saying when; a band held nationwide or leased (FirstNet's
          // B14, T-Mobile's n41) isn't one of the county's licences
          const b = (x, h) => { const info = bandInfo(x, e.carrier, h) + (h && old[x.band] ? ` Heard here only in cells last heard ${old[x.band]}: check it's still on the air.` : "");
            return `<button type="button" class="tw-band${h ? "" : " lic"}${h && old[x.band] ? " old" : ""}" data-info="${esc(info)}" title="${esc(info)}">${esc(x.band)}</button>`; };
          const county = lic.filter(countyLic), wide = lic.filter(x => !countyLic(x));
          return heard.map(x => b(x, true)).join("") + (county.length ? `${heard.length ? " " : ""}<span class="hint">licensed:</span> ${county.map(x => b(x, false)).join("")}` : "")
            + (wide.length ? `${heard.length || county.length ? " " : ""}<span class="hint">nationwide or leased:</span> ${wide.map(x => b(x, false)).join("")}` : "") || none("none heard"); })
          + `<div class="tw-bandinfo hint" hidden></div>`; },
      cols: [["Bands heard", (t, c) => perTxt(entries(t, c), c, e => { const old = oldBands(e, T.data); return (e.bands?.heard || []).map(x => old[x.band] ? `${x.band} (old: last heard ${old[x.band]})` : x.band).join(" "); })],
        ["Downlink MHz heard", (t, c) => perTxt(entries(t, c), c, e => (e.bands?.heard || []).map(x => `${x.band} ${(x.channels || []).map((ch, i) => `${ch}=${num((x.dl_mhz || [])[i], 1)}`).join(" ")}`).join(", "))],
        ["Bands licensed in the county", (t, c) => perTxt(entries(t, c), c, e => (e.bands?.licensed || []).filter(countyLic).map(x => x.band).join(" "))],
        ["Bands nationwide or leased", (t, c) => perTxt(entries(t, c), c, e => (e.bands?.licensed || []).filter(x => !countyLic(x)).map(x => x.band).join(" "))]]},
    tech: {html: (t, c) => { const g = gap(t); if (g) return g; const es = entries(t, c);
        return per(es, c, e => esc([...(e.techs || []).map(x => TECH[x] || x), ...(e.legacy || []).map(x => `${x.radio} (old cells, off the air)`)].join(", ") || "—")); },
      cols: [["Tech", (t, c) => perTxt(entries(t, c), c, e => (e.techs || []).map(x => TECH[x] || x).join(" "))]]},
    dist: {html: t => { const dc = "_decl" in t ? t._decl : declOf(T.data), m = magOf(t.bearing, dc);
        return `<b>${esc(far(t))}</b>${m != null ? `<br><span class="hint">${esc(m)}° magnetic (a compass here: declination ${esc(declTxt(dc))})</span>` : ""}`; },
      cols: [["Distance (mi)", t => t.dist_mi ?? ""], ["Bearing (° true)", t => t.bearing ?? ""], ["Bearing (° magnetic)", t => magOf(t.bearing, "_decl" in t ? t._decl : declOf(T.data)) ?? ""], ["Compass", t => t.compass || ""]]},
    height: {html: t => t.height_ft != null ? `${num(t.height_ft, 0)} ft` : none("not on file"), cols: [["Height (ft)", t => t.height_ft ?? ""]]},
    sectors: {html: (t, c) => { const g = gap(t); if (g) return g; const es = entries(t, c);
        return per(es, c, e => (e.sectors || []).length ? (e.sectors || []).map(s => `<span class="tw-sec${s.faces_site ? " face" : ""}">${esc(s.az)}°${s.faces_site ? " → site" : ""}</span>`).join(" ")
          + `<br><span class="hint">${(e.sectors || []).every(s => /filed/.test(s.from)) ? "as filed" : "estimates, from crowd bearings"}</span>` : none("none worked out")); },
      cols: [["Sectors (°)", (t, c) => perTxt(entries(t, c), c, sectorsTxt)]]},
    ids: {html: (t, c) => { const g = gap(t); if (g) return g; const es = entries(t, c);
        return per(es, c, e => (e.site_ids || []).length ? `<span class="mono">${esc(e.site_ids.join(", "))}</span>` : none("none: licence only")); },
      cols: [["Site IDs", (t, c) => perTxt(entries(t, c), c, e => (e.site_ids || []).join(" "))]]},
    owner: {html: t => `${t.owner ? esc(t.owner) : none("not on file")}${t.registration ? `<br>${link(t.registration.url, `FCC ${esc(t.registration.number)}`)} <span class="hint">${esc(t.registration.status || "")}</span>` : ""}${t.osm ? `<br>${link(t.osm.url, `OpenStreetMap ${esc(t.osm.id)}`)}` : ""}`,
      cols: [["Owner", t => t.owner || ""], ["FCC registration", t => t.registration ? `${t.registration.number} (${t.registration.status || ""})` : ""]]},
    conf: {html: (t, c) => { const es = entries(t, c);
        if (!es.length) return t.confidence ? `<b class="tw-conf ${esc(String(t.confidence).toLowerCase())}">${esc(t.confidence)}</b><br><span class="hint">${esc(NOT_LISTED)}</span>` : none("No carrier known here");
        return per(es, c, e => `<b class="tw-conf ${esc(String(e.confidence?.level || "").toLowerCase())}">${esc(e.confidence?.level || "")}</b>${e.stale ? ' <span class="tag">stale</span>' : ""}<br><span class="hint">${esc(e.confidence?.why || "")}</span>`); },
      cols: [["Confidence", (t, c) => entries(t, c).length ? perTxt(entries(t, c), c, e => e.confidence?.level || "") : t.confidence || ""],
        ["Why", (t, c) => perTxt(entries(t, c), c, e => e.confidence?.why || "")]]},
    sources: {html: t => (t.sources || []).length ? `<ul class="tw-src">${t.sources.map(s => `<li>${link(s.url, esc(s.name))}${s.date ? ` <span class="hint">${esc(String(s.date).slice(0, 10))}</span>` : ""}${s.licence ? `<br><span class="hint">${esc(s.licence)}</span>` : ""}</li>`).join("")}</ul>` : none(NOT_LISTED),
      cols: [["Sources", t => (t.sources || []).map(s => `${s.name}${s.date ? ` (${String(s.date).slice(0, 10)})` : ""}${http(s.url) ? ` ${s.url}` : ""}`).join("; ")]]},
    links: {html: t => `${link(street(t), "Street View ↗")} · ${link(gmaps(t), "Google Maps ↗")}`, cols: [["Street View", t => street(t)], ["Google Maps", t => gmaps(t)]]},
  };
  const tilesHtml = (t, c, ids = chosen()) => `<div class="tw-tiles">${ids.map(id => `<div class="tw-tile" data-tile="${id}"><div class="tw-tl">${esc(tileLabel(id))}</div><div class="tw-tv">${TILE[id].html(t, c)}</div></div>`).join("")}</div>`;
  // a short line of the chosen tiles for a label on the map ("My tiles")
  const tileText = (t, id) => { const col = TILE[id].cols[0]; return String(col[1](t, null) ?? "").replace(/https?:\/\/\S+/g, "").trim(); };
  const labelText = t => chosen().filter(id => !["sources", "links", "conf"].includes(id)).slice(0, 3).map(id => id === "dist" ? far(t) : tileText(t, id)).filter(Boolean).join(" · ").slice(0, 80);

  /* ---------- the map ---------- */
  const svgMark = (t, sel) => { const dim = t._other, f = dim ? "#8c959f" : "#24292f", s = sel ? "#ff7a1a" : "#fff", w = sel ? 3 : 2;
    const shape = t.kind === "mapped" ? `<path d="M12 3 L21 19 L3 19 Z" fill="${f}" stroke="${s}" stroke-width="${w}" stroke-linejoin="round"/>`
      : t.kind === "estimated" ? `<circle cx="12" cy="12" r="6.5" fill="#fff" fill-opacity=".9" stroke="${sel ? "#ff7a1a" : f}" stroke-width="3"/>`
      : t.kind === "licensed" || t.kind === "cluster" ? `<path d="M12 3 L21 12 L12 21 L3 12 Z" fill="${f}" stroke="${s}" stroke-width="${w}" stroke-linejoin="round"/>`
      : `<rect x="4.5" y="4.5" width="15" height="15" rx="1.5" fill="${f}" stroke="${s}" stroke-width="${w}"/>`;
    return `<svg width="24" height="24" viewBox="0 0 24 24" data-tw="${esc(t.id)}">${sel ? '<circle cx="12" cy="12" r="11" fill="none" stroke="#ff7a1a" stroke-width="2" opacity=".55"/>' : ""}${shape}</svg>`; };
  const markIcon = (t, sel) => L.divIcon({className: "tw-mk", html: svgMark(t, sel), iconSize: [24, 24], iconAnchor: [12, 12]});
  // Carriers: a small square in each carrier's colour beside the tower, no text (a carrier known only from old readings, faint)
  function chipsIcon(t){
    const ns = names(t).filter(c => !T.carriers.size || T.carriers.has(c)), stale = new Set(t.stale_for || []); if (!ns.length) return null;
    const w = ns.length * 12 + 2;
    return L.divIcon({className: "tw-lbm", iconSize: [w, 12], iconAnchor: [-13, 6],
      html: `<svg width="${w}" height="12" viewBox="0 0 ${w} 12">${ns.map((c, i) => `<rect x="${1 + i * 12}" y="1" width="10" height="10" rx="2.5" fill="${cColor(c)}" stroke="#fff" stroke-width="1.2"${stale.has(c) ? ' opacity=".4"' : ""}><title>${esc(c)}</title></rect>`).join("")}</svg>`});
  }
  function ensureMap(){
    if (typeof L === "undefined" || !window.RFMaps) return null;
    return RFMaps.keep("towers", $("#twMap"), el => {
      const map = L.map(el, {preferCanvas: true});
      map._rfScope = towerScope;  // before addMapLayers: Draw lists what Save keeps
      addMapLayers(map);
      // the credit first: Leaflet stacks a bottom corner upward, so the scale bar sits above it, never under it
      const cr = L.control({position: "bottomleft"});
      cr.onAdd = () => { const el = L.DomUtil.create("div", "leaflet-control tw-credit"); L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el);
        el.addEventListener("click", e => { if (!e.target.closest("[data-twcr]")) return; e.preventDefault(); el.classList.toggle("open"); paintCredit(map); }); return el; };
      cr.addTo(map); map._twCreditEl = cr.getContainer();
      L.DomEvent.disableClickPropagation(L.control.scale({imperial: true, metric: true}).addTo(map).getContainer());
      map.on("resize baselayerchange", () => paintCredit(map)); map.on("layeradd layerremove", e => { if (e.layer instanceof L.TileLayer) paintCredit(map); });
      map._twCrowd = L.layerGroup().addTo(map); map._twArea = L.layerGroup().addTo(map); map._twMarks = L.layerGroup().addTo(map); map._twLabels = L.layerGroup().addTo(map);
      map.on("zoomend", () => placeLabels(map));
      if (S.center) map.setView(S.center, 13);
      return map;
    }, {gone: m => { if (T.map === m) T.map = null; }});
  }
  // the credits beside a map: the answer's own lines that a licence asks for (OpenCelliD's, OpenStreetMap's only when the answer
  // carries it, WiGLE's), the first sentence each; the viewer, the printed report and the CSV carry every line in full
  // The map's own credit is one line under the scale bar (Cody 11/11: three lines across the map covered the scale and, with a sheet
  // full, the zoom and layer buttons): "Credits", each licence the answer's lines name, linked to it (OpenCelliD CC BY-SA 4.0,
  // OSM ODbL, WiGLE), then the base map's, cut short where the map is narrow. "Credits" opens every line in full with its URLs,
  // the base map's too; the viewer, the print and the CSV carry them in full as well. Leaflet's own line (mapCredit below) is
  // kept off screen for a saved map image's footer (mapexport.js)
  const LIC = [[/OpenCel+iD/i, '<a href="https://opencellid.org" target="_blank" rel="noopener">OpenCelliD</a> <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">CC BY-SA 4.0</a>'],
    [/OpenStreetMap.*ODbL/i, '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OSM ODbL</a>'], [/WiGLE/i, '<a href="https://wigle.net" target="_blank" rel="noopener">WiGLE</a>']];
  const linkify = x => esc(x).replace(/https?:\/\/[^\s<)]+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  function paintCredit(map){
    const el = map._twCreditEl; if (!el) return;
    const lines = (T.data && T.data.attribution_lines) || [], base = [];
    map.eachLayer(l => { const a = l.getAttribution && l.getAttribution(); if (a && !base.includes(a)) base.push(a); });
    const lic = LIC.filter(([re]) => lines.some(x => re.test(x))).map(x => x[1]);
    el.style.maxWidth = `${Math.max(120, map.getSize().x - 20)}px`;
    el.innerHTML = el.classList.contains("open")
      ? `${base.map(a => `<p>${a}</p>`).join("")}${lines.map(x => `<p>${linkify(x)}</p>`).join("")}<p><a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a> · <a href="#" data-twcr>Close</a></p>`
      : `<a href="#" data-twcr title="Every credit in full">Credits</a>${lic.map(x => `<span class="tw-cr-l"> · ${x}</span>`).join("")}<span class="tw-cr-base">${base.length ? ` · ${base.map(a => a.replace(/<[^>]*>/g, "")).join(" · ")}` : ""}</span>`;
  }
  const mapCredit = d => (d.attribution_lines || []).filter(x => /CC BY-SA|ODbL|WiGLE/.test(x))
    .map(x => esc(String(x).split(". Changes:")[0].replace(/\.$/, "") + (/Changes:/.test(x) ? " (grouped and matched by DAStastic)" : ""))).join(" · ");
  function drawMap(map, d){
    for (const g of [map._twCrowd, map._twArea, map._twMarks, map._twLabels]) g.clearLayers();
    map._twItems = [];
    L.marker(S.center, {icon: pinIcon(), interactive: false, keyboard: false, zIndexOffset: 1000}).addTo(map._twArea);
    // the readings the crowd and your surveys made: off unless asked (Andy, 11/9: "I don't need to know all the crowdsource data")
    if (T.crowd) for (const r of S.rows || []) if (CROWD.includes(r.layer) && r.lat != null)
      L.circleMarker([r.lat, r.lon], {radius: 2.5, weight: 0, fillColor: (LAYERS[r.layer] || {}).color || "#888", fillOpacity: .6, interactive: false}).addTo(map._twCrowd);
    if (!d) return;
    const sel = T.sel && findTower(d, T.sel);
    if (sel) L.polyline([siteOf(d), [sel.lat, sel.lon]], {color: "#ff7a1a", weight: 2.5, dashArray: "7 6", interactive: false}).addTo(map._twArea);
    for (const t of towersOf(d)) {
      if (!onMap(t) || (T.carriers.size && t._other)) continue;
      if (t.kind === "estimated" && t.uncertainty_m)
        L.circle([t.lat, t.lon], {radius: t.uncertainty_m, color: "#57606a", weight: 1, dashArray: "4 4", fillColor: "#57606a", fillOpacity: .07, interactive: false}).addTo(map._twArea);
      const on = T.sel === t.id;
      const mk = L.marker([t.lat, t.lon], {icon: markIcon(t, on), keyboard: false, zIndexOffset: on ? 900 : t._other ? -100 : 0,
        title: `${kindOf(t)[1]}${names(t).length ? `: ${names(t).join(", ")}` : ", no carrier known"} · ${far(t)}`}).addTo(map._twMarks);
      // a click shows the tower in the viewer: no popup, no pan, no fit (Cody 11/10)
      mk.on("click", e => { if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent); pick(t.id); });
      const it = {t, ll: L.latLng(t.lat, t.lon)};
      if (T.labels === "carriers") { const ic = chipsIcon(t); if (ic) it.lbl = L.marker([t.lat, t.lon], {icon: ic, interactive: false, keyboard: false}).addTo(map._twLabels); }
      else if (T.labels === "tiles" && !t._other) { const tx = labelText(t);
        if (tx) it.tip = mk.bindTooltip(esc(tx), {permanent: true, direction: "right", offset: [12, 0], className: "tw-lbl", interactive: false}).getTooltip(); }
      map._twItems.push(it);
    }
    const now = mapCredit(d);
    if (map._twCredit !== now) { if (map._twCredit) map.attributionControl.removeAttribution(map._twCredit); map._twCredit = now; if (now) map.attributionControl.addAttribution(now); }
    paintCredit(map);
    placeLabels(map);
  }
  // labels hide where they'd overlap a nearer tower's label or another tower: zoomed out, a crowded area shows the nearest only
  function placeLabels(map){
    if (!map._twItems || !map._loaded) return;
    const pts = map._twItems.map(it => ({it, p: map.latLngToContainerPoint(it.ll)})), taken = [], W = map.getSize().x;
    for (const {it, p} of pts) {
      const el = it.lbl ? it.lbl.getElement() : it.tip ? it.tip.getElement() : null; if (!el) continue;
      // a My tiles label opens on the side of its tower with room, cut short to fit it (an ellipsis), and goes where neither side
      // has 60 px (on a phone "monopole · AT&T (+ FirstNet Ba" ran off the map's right edge)
      let left = false;
      if (it.tip) { el.style.maxWidth = ""; const nat = el.offsetWidth || 30, roomR = W - p.x - 18, roomL = p.x - 18;
        left = nat > roomR && roomL > roomR; const room = left ? roomL : roomR; el.style.maxWidth = nat > room ? `${Math.max(0, Math.floor(room))}px` : "";
        if (it.tip.options.direction !== (left ? "left" : "right")) { it.tip.options.direction = left ? "left" : "right"; it.tip.options.offset = L.point(left ? -12 : 12, 0); it.tip.update(); } }
      const w = el.offsetWidth || 30, h = el.offsetHeight || 12, b = {x: left ? p.x - 12 - w : p.x + 12, y: p.y - h / 2, w, h};
      const hit = (!!it.tip && w < 60) || b.x < 2 || b.x + b.w > W - 2 || taken.some(o => b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h)
        || pts.some(o => o.it !== it && o.p.x > b.x - 10 && o.p.x < b.x + b.w + 10 && o.p.y > b.y - 10 && o.p.y < b.y + b.h + 10);
      if (it.lbl) it.lbl.setOpacity(hit ? 0 : 1); else it.tip.setOpacity(hit ? 0 : 1);
      if (!hit) taken.push(b);
    }
  }
  const nearest = (d, n = 3, cars) => { const out = new Map(); for (const c of shown(d, cars)) for (const t of (c.towers || []).slice(0, n)) out.set(t.id, t); return [...out.values()]; };
  const fitPts = d => [siteOf(d), ...nearest(d).map(t => [t.lat, t.lon])];
  // a new address's first fit leaves room for the viewer, as its Zoom to does (results.js): beside a side panel, above a sheet and
  // the credits lifted over it, so the site and its nearest towers aren't under them on a phone
  function fit(map, d){
    const pts = fitPts(d), box = map.getContainer(), W = box.clientWidth, H = box.clientHeight;
    const pref = window.RFResults ? RFResults.layout : "card", lay = pref === "auto" ? (W >= 700 ? "side" : "sheet") : pref;
    const br = [28, 28]; if (lay === "side") br[0] = Math.min(W * 0.6, 28 + 360 + 10); if (lay === "sheet") br[1] = Math.min(H * 0.7, 28 + H * 0.52 + 46);
    if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), {paddingTopLeft: [28, 28], paddingBottomRight: br, maxZoom: 16, animate: false});
    else map.setView(siteOf(d), 13, {animate: false});
  }

  /* ---------- the viewer ---------- */
  function say(t){ T.msg = t || ""; const v = T.map && window.RFResults && RFResults.get(T.map); const m = v && v.body && v.body.querySelector(".tw-msg");
    if (m) { m.textContent = T.msg; m.hidden = !T.msg; } else showViewer(); }
  const msgHtml = () => `<p class="tw-msg status" role="status"${T.msg ? "" : " hidden"}>${esc(T.msg)}</p>`;
  const canPost = () => !S.remote || ["full", "admin"].includes(S.remote.role);
  function topupHtml(d){
    const tp = d.topup || {}, unknown = shown(d).some(c => c.verdict?.level === "unknown");
    if (!tp.due && !unknown) return "";
    if (!tp.due) return `<p class="hint tw-topup">${esc(tp.why ? `No top-up now: ${tp.why}.` : "")}</p>`;
    return `<div class="tw-topup"><p style="margin:0 0 4px">${unknown ? "This area's cells haven't been fetched yet, so a nearer tower may not be known. " : ""}Fresh OpenCelliD cells for this spot would help (${esc(tp.why || "")}).</p>
      ${tp.key === false ? `<p class="hint" style="margin:0">This copy has no OpenCelliD key, so it can't fetch them: its admin adds one in Data &amp; updates.</p>`
        : canPost() ? `<button type="button" class="primary" data-twtop>Top up this area</button> <span class="hint">${tp.cost ? `${num(tp.cost, 0)} of this copy's ${num(tp.budget, 0)} requests a day (${num(tp.requests_today || 0, 0)} used today)` : ""}</span>`
        : `<p class="hint" style="margin:0">A view-only login can't top up: ask whoever runs this copy.</p>`}</div>`;
  }
  const creditsHtml = d => `<div class="tw-credits hint">${(d.attribution_lines || []).map(x => `<p>${esc(x)}</p>`).join("")}</div>`;
  function verdictsHtml(d){
    return `<div class="tw-verdicts">${shown(d).map(c => { const [w, cls] = LEVEL[c.verdict?.level] || [c.verdict?.level || "", ""];
      return `<div class="tw-v" style="--c:${cColor(c.carrier)}" data-level="${esc(c.verdict?.level || "")}"><b>${esc(c.carrier)}</b> <span class="tw-lv ${cls}">${esc(w)}</span><div class="tw-vt">${esc(c.verdict?.text || "")}</div></div>`; }).join("")}</div>`;
  }
  const fmtR = x => x == null ? "" : String(+(+x).toFixed(x < 1 ? 2 : 1));  // a radius or a reach: 5, 20, 0.62, 1.9
  const andList = xs => xs.length < 3 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
  // what a report covers, from the carriers it shows (the chips): their names, how many closest each, how far they were searched,
  // and how far this copy's crowd cells reach when that's less. The print's header and the viewer's line say this; it named all
  // three and the widest run's radius whatever was picked
  function coverTxt(d, cs){
    const n = d.n || 3, mi = Math.max(0, ...cs.map(c => +c.searched_mi || 0)) || d.radius_mi || 5, each = cs.length > 1 ? " each" : "";
    const reach = d.crowd_reach_mi != null && d.crowd_reach_mi < mi ? `; this copy's crowd cells reach ${fmtR(d.crowd_reach_mi)} mi` : "";
    return `${andList(cs.map(c => c.carrier))}: ${cs.every(c => (c.towers || []).length === n) ? `the ${n} closest${each}` : `up to ${n} closest${each}`}, searched to ${fmtR(mi)} mi${reach}`;
  }
  // a carrier's heading, by its verdict: "Not known yet" is never "no tower found within 20 mi" (the 11/10 verdict stopped saying
  // that; the headings still did), and a carrier with only stale towers has no current one
  function headOf(c, d){
    const k = (c.towers || []).length, lv = c.verdict?.level, closest = k === 1 ? "the closest" : `the ${k} closest`;
    if (lv === "unknown") return [k ? `${closest} found so far` : "not known yet", d.crowd_reach_mi != null ? `this copy's crowd cells reach ${fmtR(d.crowd_reach_mi)} mi` : `searched to ${fmtR(c.searched_mi)} mi`];
    return [k ? closest : (c.stale_towers || []).length ? "no current tower found" : "no tower found", `within ${fmtR(c.searched_mi)} mi`];
  }
  function summaryHtml(d){
    const cs = shown(d);
    return `${msgHtml()}${verdictsHtml(d)}${topupHtml(d)}
      ${cs.map(c => { const [h, w] = headOf(c, d); return `<h4 class="tw-h" data-carrier="${esc(c.carrier)}">${chip(c.carrier)} ${esc(h)} <span class="hint">${esc(w)}</span></h4>
        ${(c.towers || []).map((t, i) => `<div class="tw-card" data-tw="${esc(t.id)}" role="button" tabindex="0" aria-label="Open tower ${i + 1} for ${esc(c.carrier)}"><div class="tw-rank">#${i + 1} ${kindOf(t)[0]} ${esc(far(t))}</div>${tilesHtml({...t, _full: true}, c.carrier)}</div>`).join("")}
        ${(c.stale_towers || []).length ? `<p class="hint" style="margin:4px 0 2px">Known only from readings over 3 years old (check they're still on the air):</p>${c.stale_towers.map(t => `<div class="tw-card stale" data-tw="${esc(t.id)}" role="button" tabindex="0"><div class="tw-rank">${kindOf(t)[0]} ${esc(far(t))}, last heard ${esc(String(entries(t, c.carrier)[0]?.last || "").slice(0, 10))}</div></div>`).join("")}` : ""}
        ${(c.heard_only || []).length ? `<p class="hint" style="margin:4px 0">Heard only in your own readings, so not placed: ${c.heard_only.map(h => `${esc(h.site_kind)} ${esc(h.site_id)} (${num(h.readings, 0)} readings)`).join(", ")}.</p>` : ""}`; }).join("")}
      ${creditsHtml(d)}`;
  }
  function towerHtml(d, t){
    const cells = entries(t).filter(e => (e.sites || []).some(s => (s.cells || []).length));
    return `${msgHtml()}${tilesHtml(t, null)}${towerActs()}
      ${t.candidates && t.candidates.length ? `<p class="hint">Could be: ${t.candidates.map(x => `${esc(x.id)} (${num(x.dist_m, 0)} m)`).join(", ")}.</p>` : ""}
      ${cells.map(e => `<details class="tw-cells"><summary>${chip(e.carrier)} cells heard: PCI, channel, band</summary><div class="tw"><table><thead><tr><th>Site</th><th>Sector</th><th>PCI</th><th>Channel</th><th>Band</th><th>Downlink MHz</th><th>Last</th></tr></thead><tbody>
        ${e.sites.flatMap(s => (s.cells || []).map(x => `<tr><td class="mono">${esc(s.site_kind)} ${esc(s.site_id)}</td><td>${esc(x.sector ?? "")}</td><td class="mono">${esc(x.pci ?? "")}</td><td class="mono">${esc(x.channel ?? "")}</td>
          <td>${esc(x.band?.band || "")}</td><td class="mono">${x.band ? num(x.band.dl_mhz, 1) : ""}</td><td>${esc(String(x.last || "").slice(0, 10))}</td></tr>`)).join("")}</tbody></table></div></details>`).join("")}
      ${!t._full && names(t).length ? `<p class="hint">Outside every carrier's 3 closest: ${esc(notYet(t))}</p>` : ""}
      ${creditsHtml(d)}`;
  }
  function pickerHtml(){
    const p = tilePref();
    return `<p class="hint" style="margin:2px 0 8px">Tick the tiles each tower shows; the arrows set their order. The printed report's columns and the CSV's first columns follow. Kept in this browser.</p>
      <ul class="tw-pick">${p.order.map((id, i) => `<li><label class="inl"><input type="checkbox" data-tp="${id}" ${p.on.includes(id) ? "checked" : ""}> ${esc(tileLabel(id))}</label>
        <span class="tw-arrows"><button type="button" data-tup="${id}" aria-label="Move ${esc(tileLabel(id))} up" ${i ? "" : "disabled"}>↑</button><button type="button" data-tdn="${id}" aria-label="Move ${esc(tileLabel(id))} down" ${i < p.order.length - 1 ? "" : "disabled"}>↓</button></span></li>`).join("")}</ul>`;
  }
  function wire(body){
    if (!body) return;  // a new body each time the viewer draws (results.js paint)
    body.onclick = e => {
      const b = e.target.closest(".tw-band");
      if (b) { const box = b.closest(".tw-tv")?.querySelector(".tw-bandinfo"); if (box) { const same = !box.hidden && box.dataset.for === b.dataset.info; box.textContent = b.dataset.info; box.dataset.for = b.dataset.info; box.hidden = same; } return; }
      const top = e.target.closest("[data-twtop]"); if (top) { topup(top); return; }
      const ta = e.target.closest("[data-twa]"); if (ta) { towerAct(ta, body); return; }
      const up = e.target.closest("[data-tup]"), dn = e.target.closest("[data-tdn]");
      if (up || dn) { const p = tilePref(), id = (up || dn).dataset[up ? "tup" : "tdn"], i = p.order.indexOf(id), j = i + (up ? -1 : 1);
        if (i >= 0 && j >= 0 && j < p.order.length) { [p.order[i], p.order[j]] = [p.order[j], p.order[i]]; saveTiles(p); } return; }
      const card = e.target.closest(".tw-card"); if (card && !e.target.closest("a,button")) pick(card.dataset.tw);
    };
    body.onkeydown = e => { const card = e.target.closest?.(".tw-card"); if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pick(card.dataset.tw); } };
    body.onchange = e => { const c = e.target.closest("[data-tp]"); if (!c) return; const p = tilePref();
      p.on = c.checked ? [...new Set([...p.on, c.dataset.tp])] : p.on.filter(x => x !== c.dataset.tp); saveTiles(p); };
  }
  function saveTiles(p){
    memTiles = p ? JSON.stringify({order: p.order, on: p.order.filter(i => p.on.includes(i))}) : "null";
    if (p) store.set(TILE_KEY, memTiles); else store.del(TILE_KEY);
    if (T.map && T.data) drawMap(T.map, T.data);
    showViewer();
  }
  // a tower's actions sit under its tiles: one row (Street View, Google Maps, the tower report) and More for the rest (Cody 11/11:
  // on a phone 9 buttons in 3 rows above the tiles left them 49 px of a half sheet). A view-only login isn't offered Save or Hunt,
  // which it can't do (the door refuses the POST; Find a signal keeps its stops in a mission it can't make)
  const TACT = {street: ["Street View ↗", "Google Street View at the tower, in a new tab"], gmaps: ["Google Maps ↗", "The tower in Google Maps, in a new tab"],
    print: ["⎙ Tower report", "The printable tower report: verdicts, a map, a table per carrier and what to check on site (Save as PDF works on a phone)"],
    hunt: ["🎯 Hunt", "Find a signal (Mission tab), set to this tower's band"], save: ["☆ Save", "Keep this tower as a point with the open DAS job or mission (Draw lists it)"],
    csv: ["⇩ CSV", "Each carrier's closest towers as a spreadsheet, the chosen tiles first"], share: ["🔗 Link", "A link that opens this report: the address and the carriers picked"],
    tiles: ["⚙ Tiles", "Pick and order what each tower shows (and the report's columns)"], all: ["← All towers", "Back to the summary"]};
  const actBtn = k => `<button type="button" data-twa="${k}" title="${esc(TACT[k][1])}">${TACT[k][0]}</button>`;
  const moreBtn = () => `<button type="button" data-twa="more" aria-expanded="${!!T.more}" title="More: ${canPost() ? "Hunt, Save, " : ""}CSV, Link, Tiles, All towers">${T.more ? "Less ▴" : "More ▾"}</button>`;
  const towerActs = () => `<div class="tw-acts" role="group" aria-label="This tower">${["street", "gmaps", "print"].map(actBtn).join("")}${moreBtn()}</div>
      <div class="tw-acts tw-more" role="group" aria-label="More"${T.more ? "" : " hidden"}>${[...(canPost() ? ["hunt", "save"] : []), "csv", "share", "tiles", "all"].map(actBtn).join("")}</div>`;
  function towerAct(a, body){
    const k = a.dataset.twa, t = T.data && T.sel && findTower(T.data, T.sel);
    if (k === "more") { T.more = !T.more; const m = body.querySelector(".tw-more"); if (m) m.hidden = !T.more; a.setAttribute("aria-expanded", String(T.more)); a.textContent = T.more ? "Less ▴" : "More ▾"; return; }
    if (k === "print") return print(a);
    if (k === "csv") return downloadCsv();
    if (k === "share") return share();
    if (k === "tiles") { T.picker = true; return showViewer(); }
    if (k === "all") return pick(null);
    if (!t) return;
    if (k === "street") window.open(street(t), "_blank", "noopener");
    else if (k === "gmaps") window.open(gmaps(t), "_blank", "noopener");
    else if (k === "hunt" && canPost()) hunt(t);
    else if (k === "save" && canPost()) saveTower(t, a);
  }
  const ACT = {
    print: {label: "⎙ Tower report", title: "The printable tower report: verdicts, a map, a table per carrier and what to check on site (Save as PDF works on a phone)", run: b => print(b)},
    csv: {label: "⇩ CSV", title: "Each carrier's closest towers as a spreadsheet, the chosen tiles first", run: () => downloadCsv()},
    share: {label: "🔗 Link", title: "A link that opens this report: the address and the carriers picked", run: () => share()},
    tiles: {label: "⚙ Tiles", title: "Pick and order what each tower shows (and the report's columns)", run: () => { T.picker = true; showViewer(); }},
  };
  function showViewer(){
    const map = T.map, d = T.data; if (!map || !window.RFResults) return;
    if (!d) { RFResults.show(map, {key: `tw:wait:${T.key}`, title: "Towers", sub: esc(T.place || ""), html: T.err ? `<p class="status err">${esc(T.err)}</p>` : '<p class="status">Finding the towers…</p>',
      zoom: S.center}, S.center); return; }
    if (T.picker) {
      const v = RFResults.show(map, {key: "tw:pick", label: "Tiles", title: "⚙ Tiles", sub: "What each tower shows, in this order", html: pickerHtml(),
        actions: [{label: "Done", primary: true, run: () => { T.picker = false; showViewer(); }}, {label: "Reset", title: "Back to Type, Carriers, Bands, Tech, Distance and bearing, Confidence", run: () => saveTiles(null)}],
        onClose: () => { T.picker = false; showViewer(); }}, S.center);
      return wire(v?.body);
    }
    specFor(d);
    const t = T.sel && findTower(d, T.sel);
    if (t && !t._full && names(t).length) askFull(t);
    if (t) {
      const [sym, word] = kindOf(t), u = t.kind === "estimated" && t.uncertainty_m;
      const v = RFResults.show(map, {key: `tw:t:${t.id}`, label: `Tower ${far(t)}`, title: `${sym} ${esc(t.type || word)}`,
        sub: `${esc(far(t))} from the site · ${esc(word)}${u ? `, give or take ${num(u, 0)} m` : ""}${names(t).length ? ` · ${names(t).map(esc).join(", ")}` : " · no carrier known"}`,
        html: towerHtml(d, t),
        zoom: u ? () => { const b = L.latLng(t.lat, t.lon).toBounds(u * 2.2); return [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]]; } : [t.lat, t.lon], zoomLevel: 16,
        onClose: () => { T.sel = null; T.closed = true; T.more = false; if (T.map && T.data) drawMap(T.map, T.data); }}, [t.lat, t.lon]);
      return wire(v?.body);
    }
    const v = RFResults.show(map, {key: `tw:sum:${T.key}`, label: "Towers near the site", title: `Towers near ${esc(placeTxt(d))}`,
      sub: `${esc(coverTxt(d, shown(d)))} · click a tower for what's on it`,
      html: summaryHtml(d), actions: [ACT.print, ACT.csv, {label: T.moreSum ? "Less ▴" : "More ▾", title: "More: Link, Tiles", run: () => { T.moreSum = !T.moreSum; showViewer(); }},
        ...(T.moreSum ? [ACT.share, ACT.tiles] : [])],
      zoom: () => { const p = fitPts(d); return p.length > 1 ? p : siteOf(d); }, onClose: () => { T.closed = true; }}, siteOf(d));
    wire(v?.body);
  }
  // one tower in the viewer, or (null) the summary: the map stays where it is
  // Back on a phone closes an open tower first, as Esc does: a tower opened is one history step (the same address), and Back
  // takes it off (it left the Towers tab for the Map tab, or left DAStastic when it was opened from a link)
  const narrow = () => innerWidth < 700;
  window.addEventListener("popstate", () => { if (S.tab === "towers" && T.sel && !history.state?.twTower) { T.sel = null; T.more = false; if (T.map && T.data) drawMap(T.map, T.data); showViewer(); } });
  function pick(id){
    if (narrow() && id && !history.state?.twTower) history.pushState({twTower: true}, "", location.href);
    else if (!id && history.state?.twTower) history.back();  // closed here: the step it added goes
    T.sel = id || null; T.closed = false; T.picker = false; T.more = false; T.msg = "";
    if (T.map && T.data) drawMap(T.map, T.data);
    showViewer();
  }

  /* ---------- one click each ---------- */
  function hunt(t){
    const e = entries(t, T.carriers.size === 1 ? [...T.carriers][0] : null).find(x => (x.bands?.heard || []).length) || null, b = e && e.bands.heard[0];
    const mhz = b && (b.dl_mhz || [])[0];
    S.hunt = {...(S.hunt || {}), freq: mhz ? String(mhz) : "", tol: 5000, open: true};
    setTab("mission");
    $("#status").className = "status";
    $("#status").textContent = (S.missionId ? "Find a signal is open" : "Find a signal keeps its stops in a mission: open or make one here and it opens")
      + (mhz ? ` on ${num(mhz, 1)} MHz (${e.carrier} ${b.band} downlink, matched within 5 MHz).` : ": type the downlink MHz your test phone shows for this tower.");
  }
  // where Save keeps a tower, and where the Towers map's Draw (✎) looks: the open DAS job, else the open mission, else this copy's
  // own drawings. One answer for both (map._rfScope, markup.js): Save went to the job while Draw listed the mission's or this copy's
  function towerScope(){
    const job = S.das && S.das.job, jn = job && (S.das.jobs || []).find(j => j.id === job)?.name;
    return job ? {scope: "job", id: job, name: jn ? `the DAS job “${jn}”` : "the open DAS job"} : S.missionId ? {scope: "mission", id: S.missionId, name: `the mission “${S.mission?.name || S.missionId}”`}
      : {scope: "scratch", id: 0, name: "this copy's drawings (no mission or job open)"};
  }
  async function saveTower(t, btn){
    const to = towerScope();
    const label = `${names(t).join(", ") || "Tower"} · ${t.type || kindOf(t)[1]} · ${far(t)}`.slice(0, 120);
    const note = [`Tower report ${today()}, from ${T.data ? placeTxt(T.data) : T.place}`,
      ...TILES.map(([id, l]) => `${l}: ${TILE[id].cols.map(c => c[1](t, null)).filter(x => x !== "" && x != null).join(" · ")}`)].join("\n").slice(0, 2000);
    if (btn) btn.disabled = true;
    try{
      await post("/api/markup", {scope: to.scope, scope_id: to.id, kind: "point", geometry: {type: "Point", coordinates: [+(+t.lon).toFixed(7), +(+t.lat).toFixed(7)]}, label, color: "#ff7a1a", note});
      say(`Saved to ${to.name}: a point with this tower's details. Draw (✎ on this map) lists it.`);
      if (T.map && T.map._rfDraw) T.map._rfDraw.load();
    }catch(err){ say(`Not saved: ${err.message}`); }
    finally{ if (btn && btn.isConnected) btn.disabled = false; }
  }
  async function topup(btn){
    if (!canPost()) return say("A view-only login can't top up: ask whoever runs this copy.");
    const d = T.data, k = T.key; if (!d) return; const [lat, lon] = siteOf(d); btn.disabled = true; btn.textContent = "Topping up…";
    const part = (n, x) => !x ? "" : x.error ? `${n}: ${x.error}` : x.skipped ? `${n}: ${x.skipped}` : `${n}: ${num(x.rows ?? x.kept ?? 0, 0)} ${n === "OpenCelliD" ? "cells" : "towers"} kept${x.stopped ? ` (${x.stopped})` : ""}`;
    try{
      const r = await post("/api/towers/topup", {lat, lon});
      const words = `${[part("OpenCelliD", r.opencellid), part("OpenStreetMap", r.osm)].filter(Boolean).map(x => x.replace(/\.+$/, "")).join(". ")}.`;
      // this address's report is asked again whichever address is on screen now, and what the top-up did is kept for it: moving on
      // while it ran left the old answer cached (a print from it, the top-up offered again) and the words were lost
      const fresh = load(lat, lon, true); fresh.catch(() => {});
      T.msgFor[k] = words;
      if (T.key !== k) return;
      const nd = await fresh; if (T.key !== k) return;
      T.data = nd; T.msg = words; delete T.msgFor[k];
      if (T.map) drawMap(T.map, T.data);
      showViewer();
    }catch(err){ if (T.key === k) say(`Top-up: ${err.message}`); else T.msgFor[k] = `Top-up: ${err.message}`; }
    // a top-up that failed or finished leaves its button ready again (it stayed disabled at "Topping up…")
    finally{ if (btn.isConnected) { btn.disabled = false; btn.textContent = "Top up this area"; } }
  }
  // the link to the report on screen: its site, its address and the carriers picked, never the address box (which may already hold
  // the next address, or nothing: the link was "#tab=towers")
  function share(){
    const d = T.data, h = new URLSearchParams(); h.set("tab", "towers");
    const ll = d ? siteOf(d) : S.center; if (ll) { h.set("lat", ll[0]); h.set("lon", ll[1]); }
    if (T.place) h.set("place", T.place);
    linkParams(h);
    const url = `${location.origin}${location.pathname}#${h}`;
    const done = ok => say(ok ? `Link copied: ${url}` : `The link: ${url}`);
    if (navigator.share && matchMedia("(pointer:coarse)").matches) navigator.share({title: "Tower report", url}).then(() => done(true)).catch(() => done(false));
    else if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(() => done(true), () => done(false));
    else done(false);
    return url;
  }

  /* ---------- the CSV: the chosen tiles' columns first, then every other column ---------- */
  function csv(d = T.data, ids = chosen(), o = {}){
    if (!d) return "";
    const rest = TILES.map(x => x[0]).filter(i => !ids.includes(i));
    const row0 = [["Carrier", (t, c) => c], ["Rank", (t, c, r) => r], ["Verdict", (t, c, r, v) => v], ["Latitude", t => t.lat], ["Longitude", t => t.lon], ["Distance (km)", t => t.dist_km ?? ""], ["Tower ID", t => t.id]];
    const cols = [...ids.flatMap(i => TILE[i].cols), ...row0, ...rest.flatMap(i => TILE[i].cols)];
    // a text cell that starts like a formula (=, +, -, @, a tab or CR) is kept as text: an FCC owner name filed as =HYPERLINK(...)
    // would run in Excel. Numbers (the positions, distances, bearings) go in as numbers
    const q = v => { let s = v == null ? "" : String(v); if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const out = (d.attribution_lines || []).map(x => q(`# ${x}`));
    const decl = declOf(d);
    out.push(q(`# DAStastic tower report ${today()}: ${o.place ?? T.place ?? ""} (${d.lat}, ${d.lon}). Estimated towers are estimates; a roof reading decides.`
      + `${decl != null ? ` Bearings from the site: true (a map's north) and magnetic (a compass's: declination ${declTxt(decl)} here, NOAA WMM2025).` : ""}`));
    out.push(cols.map(c => q(c[0])).join(","));
    for (const c of shown(d, o.carriers)) {
      const rows = [...(c.towers || []).map((t, i) => [t, String(i + 1)]), ...(c.stale_towers || []).map(t => [t, "stale"])];
      for (const [t, r] of rows) out.push(cols.map(col => q(col[1]({...t, _full: true, _decl: decl}, c.carrier, r, c.verdict?.text || ""))).join(","));
      // a carrier with no tower still has its line: its verdict ("Not known yet", "None found") is part of the answer
      if (!rows.length) out.push(cols.map(col => col[0] === "Carrier" ? q(c.carrier) : col[0] === "Rank" ? q((LEVEL[c.verdict?.level] || [c.verdict?.level || "no tower"])[0])
        : col[0] === "Verdict" ? q(c.verdict?.text || "") : "").join(","));
    }
    return out.join("\r\n") + "\r\n";
  }
  function downloadCsv(){
    const name = `DAStastic tower report ${(T.place || T.key || "").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60)} ${today()}.csv`;
    // the file starts with a UTF-8 BOM, so Excel on Windows reads °, − and © as written (a file without one it reads as cp1252);
    // csv() itself has none, for any other caller
    if (typeof dasDl === "function") dasDl(name, "\uFEFF" + csv(), "text/csv;charset=utf-8"); else say("The CSV needs the DAS module (das.js).");
  }

  /* ---------- the printed report ---------- */
  // what to look for on a tower: each channel heard now with its PCIs (a PCTEL scan reports PCIs per channel; two lists lost which
  // PCI is on which channel, and LTE from NR), the bands the carrier holds in the county but wasn't heard on, those it holds
  // nationwide or leased in the engine's words, and apart, cells last heard over 3 years ago: "check it's still on the air"
  function verifyOf(t, c, d){
    const e = entries(t, c)[0]; if (!e) return {look: [], old: ""};
    const g = cellsOf(e, d), cur = [...g.cur.values()], now = new Set(cur.map(x => x.band));
    const rng = x => { const r = bandRange(x.band); return `${x.band}${r ? ` ${num(r[0], 0)}–${num(r[1], 0)} MHz` : ""}`; };
    const lic = (e.bands?.licensed || []).filter(x => !now.has(x.band)), county = lic.filter(countyLic), wide = lic.filter(x => !countyLic(x));
    const look = [...cur.map(chanTxt), county.length ? `also licensed in the county: ${county.map(rng).join("; ")}` : "",
      wide.length ? `also ${wide.map(x => `${rng(x)} (${x.note || x.how || "by licence"})`).join("; ")}` : ""].filter(Boolean);
    const old = g.old.size ? `Check it's still on the air${e.ex_sprint ? " (ex-Sprint cells)" : ""}, last heard ${g.oldLast.slice(0, 10)}: ${[...g.old.values()].map(chanTxt).join("; ")}` : "";
    return {look, old};
  }
  // a carrier's stale tower its verdict names ("A nearer T-Mobile site ... check it's still on the air"): nearer than its closest
  // current one, or the only kind it has
  const namedStale = c => { const s = (c.stale_towers || [])[0], t0 = (c.towers || [])[0]; return s && (!t0 || s.dist_mi < t0.dist_mi) ? [s] : []; };
  function reportHtml(d = T.data, o = {}){
    if (!d) return "";
    const ids = o.tiles || chosen(), cs = shown(d, o.carriers), place = o.place ?? T.place ?? "", who = o.who ?? (S.remote?.user || S.me?.user || "");
    const cols = ids.map(id => `<th>${esc(tileLabel(id))}</th>`).join("");
    const decl = declOf(d), mark = t => `${kindOf(t)[0]}${t.kind === "estimated" && t.uncertainty_m ? `<br><small>est. ±${num(t.uncertainty_m, 0)} m</small>` : ""}`;
    const cell = (id, t, c) => TILE[id].html({...t, _full: true, _decl: decl}, c).replace(/<div class="tw-bandinfo[^>]*><\/div>/g, "")
      .replace(/<button type="button" class="tw-band([^"]*)"[^>]*>([^<]*)<\/button>/g, (m, cls, b) => `<span class="twr-b${/lic/.test(cls) ? " lic" : ""}">${b}${/old/.test(cls) ? " (old)" : ""}</span>`);
    const vrows = cs.flatMap(c => [...(c.towers || []).map((t, i) => [c, t, i + 1]), ...namedStale(c).map(t => [c, t, "old"])]);
    const printedTowers = [...new Map([...nearest(d, 3, o.carriers), ...cs.flatMap(c => c.stale_towers || [])].map(t => [t.id, t])).values()];
    return `<div class="twr"><style>.twr{font:11.5px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#000;background:#fff}.twr h1{font-size:20px;margin:0 0 2px}.twr h2{font-size:14px;margin:14px 0 4px}
      .twr table{border-collapse:collapse;width:100%;margin:2px 0 6px}.twr th,.twr td{border:1px solid #aaa;padding:3px 5px;vertical-align:top;text-align:left}.twr th{background:#eee}
      .twr a{color:#0645ad}.twr .hint{color:#444}.twr-head{display:flex;justify-content:space-between;gap:12px;border-bottom:2px solid #000;padding-bottom:6px;margin-bottom:8px}
      .twr-verdicts{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px}.twr-verdicts>div{border:1px solid #888;border-left:6px solid var(--c);border-radius:6px;padding:5px 8px}
      .twr-verdicts b{font-size:13px}.twr img{width:100%;border:1px solid #888;border-radius:4px}.twr-b{display:inline-block;border:1px solid #888;border-radius:4px;padding:0 4px;margin:1px}.twr-b.lic{color:#555;border-style:dashed}
      .tw-cc{display:inline-block;border:1px solid var(--c);border-left:6px solid var(--c);border-radius:4px;padding:0 4px;margin:1px}.tw-k,.twr small{color:#444}.tw-src{margin:0;padding-left:14px}
      .tw-sec{display:inline-block;margin-right:4px}.tw-sec.face{font-weight:700}.twr .box{display:inline-block;min-width:54px;border-bottom:1px solid #000;height:14px}
      .twr-sec{break-inside:avoid}.twr-carrier tr,.twr-verify tr{break-inside:avoid}.tw-who{font-weight:600}.twr-old{margin-top:3px;color:#6b4400}
      @media print{body.print-das #dasPrint .twr td,body.print-das #dasPrint .twr th{overflow-wrap:break-word}}</style>
      <div class="twr-head"><div><h1>Tower report</h1><div><b>Site:</b> ${esc(place || "the pin")}</div><div><b>Address / position:</b> ${esc(place ? `${place} · ` : "")}<span class="mono">${(+d.lat).toFixed(5)}, ${(+d.lon).toFixed(5)}</span></div></div>
        <div style="text-align:right"><div><b>Date:</b> ${esc(o.date || today())}</div><div><b>Prepared by:</b> ${who ? esc(who) : '<span class="box" style="min-width:140px"></span>'}</div>${S.mission?.name ? `<div><b>Mission:</b> ${esc(S.mission.name)}</div>` : ""}
          <div class="hint twr-cover">${esc(coverTxt(d, cs))}</div></div></div>
      <div class="twr-sec"><div class="twr-verdicts">${cs.map(c => `<div style="--c:${cColor(c.carrier)}"><b>${esc(c.carrier)}</b>: ${esc((LEVEL[c.verdict?.level] || [c.verdict?.level || ""])[0])}<br>${esc(c.verdict?.text || "")}</div>`).join("")}</div></div>
      ${o.img ? `<div class="twr-sec" style="margin-top:8px"><img src="${o.img}" alt="Map: the site, the towers and the bearing to each"><div class="hint">The site (pin), the towers (■ registered, ▲ mapped, ◆ licensed site, ○ estimated with its uncertainty bubble) and a bearing line from the site to each carrier's 3 closest. ${(d.attribution_lines || []).map(esc).join(" ")}</div></div>` : o.imgWhy ? `<p class="hint">No map image this time: ${esc(o.imgWhy)}.</p>` : ""}
      ${cs.map(c => `<div class="twr-sec"><h2 data-carrier="${esc(c.carrier)}">${esc(c.carrier)}: ${esc(headOf(c, d)[0])} <span class="hint">${esc(headOf(c, d)[1])}</span></h2>
        ${(c.towers || []).length || (c.stale_towers || []).length ? `<table class="twr-carrier" data-carrier="${esc(c.carrier)}"><thead><tr><th>#</th>${cols}</tr></thead><tbody>
          ${[...(c.towers || []).map((t, i) => [t, i + 1]), ...(c.stale_towers || []).map(t => [t, "old"])].map(([t, r]) => `<tr><td>${r} ${mark(t)}</td>${ids.map(id => `<td>${cell(id, t, c.carrier)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
          : `<p class="hint">${esc(c.verdict?.text || "")}</p>`}</div>`).join("")}
      <div class="twr-sec twr-verify"><h2>Verify on site</h2>
        <p class="hint" style="margin:0 0 4px">With the test phones and the PCTEL: look for these channels and their PCIs, point the donor antenna on the ${decl != null ? `magnetic bearing with a hand compass (declination here ${esc(declTxt(decl))}, NOAA WMM2025; the true bearing is for a map)` : "bearing (true north: this copy can't work out the magnetic one here)"}, and write down what you read. ${esc((cs[0]?.verdict?.text || "").match(/A roof reading decides[^.]*\./)?.[0] || "A roof reading decides.")} Estimated towers are estimates: their bubble shows how far off they may be.</p>
        <table><thead><tr><th>Carrier</th><th>#</th><th>Tower</th><th>Look for: channel and PCIs</th><th>Donor bearing</th><th>Test phone RSRP / SINR</th><th>PCTEL RSRP / SINR</th><th>Seen</th></tr></thead><tbody>
        ${vrows.map(([c, t, r]) => { const v = verifyOf(t, c.carrier, d), m = magOf(t.bearing, decl);
          return `<tr data-carrier="${esc(c.carrier)}" data-tw="${esc(t.id)}"><td>${esc(c.carrier)}</td><td>${r}</td><td>${esc(t.type || kindOf(t)[1])}${t.registration ? `, FCC ${esc(t.registration.number)}` : ""}<br>${esc(far(t))}</td>
            <td class="twr-look">${v.look.map(esc).join("<br>") || (v.old ? "" : '<span class="hint">nothing in the crowd data</span>')}${v.old ? `<div class="twr-old">⚠ ${esc(v.old)}</div>` : ""}</td>
            <td class="twr-brg">${m != null ? `<b>${esc(m)}° magnetic</b><br>${esc(t.bearing ?? "")}° true · ${esc(t.compass || "")}` : `<b>${esc(t.bearing ?? "")}° true</b> ${esc(t.compass || "")}`}</td>
            <td><span style="white-space:nowrap"><span class="box"></span> dBm</span><br><span style="white-space:nowrap"><span class="box"></span> dB</span></td><td><span style="white-space:nowrap"><span class="box"></span> dBm</span><br><span style="white-space:nowrap"><span class="box"></span> dB</span></td><td>☐</td></tr>`; }).join("")}</tbody></table></div>
      <div class="twr-sec twr-credits"><h2>Sources and credits</h2>${(d.attribution_lines || []).map(x => `<p style="margin:2px 0">${esc(x)}</p>`).join("")}
        <ul style="margin:4px 0;padding-left:16px">${printedTowers.flatMap(t => (t.sources || []).map(s => [t, s])).map(([t, s]) => `<li>${esc(far(t))}: ${link(s.url, esc(s.name))}${s.date ? `, ${esc(String(s.date).slice(0, 10))}` : ""}${s.what ? ` <span class="hint">(${esc(s.what)})</span>` : ""}</li>`).join("")}</ul>
        <p class="hint">DAStastic's tower engine ${esc(d.params_version || "")}. Crowd positions are where phones were, not the tower: DAStastic matches each carrier's site to the FCC registered or mapped structure it most likely sits on, or estimates it. ${esc(d.licensed_note || "")}</p></div></div>`;
  }
  // the site in the report's map image: a pin drawn as SVG, so the image has it sharp and its tip where the bearing lines start
  const sitePin = () => L.divIcon({className: "tw-mk", iconSize: [22, 30], iconAnchor: [11, 29],
    html: '<svg width="22" height="30" viewBox="0 0 22 30"><path d="M11 1C5.5 1 1 5.4 1 10.9 1 18.3 11 29 11 29s10-10.7 10-18.1C21 5.4 16.5 1 11 1z" fill="#1f6feb" stroke="#fff" stroke-width="2"/><circle cx="11" cy="11" r="3.6" fill="#fff"/></svg>'});
  // the map image for the report: its own map, off screen at the report's size, fitted to the site and each carrier's closest
  // with a bearing line to each; the map on screen isn't touched. Canvas, not SVG: mapexport.js draws an SVG overlay shifted
  // by the renderer's padding (its copy of the <svg> keeps Leaflet's translate), so lines and bubbles landed off their towers
  // the report's map image gets a scale bar of its own and a footer that says the site: mapexport.js draws the map's panes, not
  // its controls, so the paper map had no bar while its footer said "scale bar 2 km", and the footer's position was the image's
  // centre (1.5 km off the site at Newburgh). k: the image's scale; returns what it stamped (for the checks)
  function stampImage(map, cv, k, site){
    const g = cv.getContext("2d"), W = map.getSize().x, H = map.getSize().y, y = H - 30;
    const mpp = map.distance(map.containerPointToLatLng([20, y]), map.containerPointToLatLng([120, y])) / 100;  // metres a pixel
    const nice = v => { const e = Math.pow(10, Math.floor(Math.log10(v))); return [1, 2, 5, 10].map(x => x * e).filter(x => x <= v).pop(); };
    const m = nice(mpp * 140), ft = mpp * 140 * 3.28084, imp = ft >= 5280 ? {v: nice(ft / 5280), u: "mi", f: 1609.344} : {v: nice(ft), u: "ft", f: 0.3048};
    const bars = [[m >= 1000 ? `${m / 1000} km` : `${m} m`, m / mpp], [`${imp.v} ${imp.u}`, imp.v * imp.f / mpp]];
    g.save(); g.scale(k, k); g.font = "11px system-ui, sans-serif"; g.textBaseline = "middle"; g.textAlign = "left";  // compose leaves it right
    bars.forEach(([txt, px], i) => { const yy = H - 40 + i * 17; g.fillStyle = "rgba(255,255,255,.85)"; g.fillRect(10, yy, px, 15); g.strokeStyle = "#222"; g.lineWidth = 1.5;
      g.strokeRect(10, yy, px, 15); g.fillStyle = "#111"; g.fillText(txt, 14, yy + 8); });
    // the footer again: the site's own position, the date and this scale; the credits as mapexport.js reads them
    const credit = (map.getContainer().querySelector(".leaflet-control-attribution")?.innerText || "").replace(/\s+/g, " ").trim();
    const left = `DAStastic · site ${(+site[0]).toFixed(5)}, ${(+site[1]).toFixed(5)} · ${today()} · scale bar ${bars[0][0]} / ${bars[1][0]}`;
    g.fillStyle = "#14130f"; g.fillRect(0, H, W, 26); g.fillStyle = "#fff"; g.textAlign = "left"; g.fillText(left, 8, H + 13);
    g.fillStyle = "#cfcfcf"; g.textAlign = "right"; g.fillText(credit, W - 8, H + 13, Math.max(60, W - g.measureText(left).width - 24));
    g.restore();
    return {footer: left, scale: bars.map(b => b[0]), width: cv.width};
  }
  async function mapImage(d, cars = T.carriers){
    if (typeof L === "undefined" || !window.RFMapExport) { mapImage.why = "no map library on this page"; return null; }
    mapImage.why = "";
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:-12000px;top:0;width:960px;height:560px";
    document.body.appendChild(box);
    let map = null;
    try{
      map = L.map(box, {preferCanvas: true, zoomControl: false, fadeAnimation: false, zoomAnimation: false, markerZoomAnimation: false, inertia: false});
      const pref = mapPrefs(), cfg = BASEMAPS[pref.base] || BASEMAPS["Street (OpenStreetMap)"];
      const bl = (cfg ? baseLayer(cfg) : L.tileLayer("/tiles/osm/{z}/{x}/{y}.png", {attribution: "© OpenStreetMap contributors"})).addTo(map);
      L.control.scale({imperial: true, metric: true}).addTo(map);
      const ts = nearest(d, 3, cars), site = siteOf(d);
      map.fitBounds(L.latLngBounds([site, ...ts.map(t => [t.lat, t.lon])]).pad(0.15), {maxZoom: 16, animate: false});
      for (const c of shown(d, cars)) for (const t of (c.towers || []).slice(0, 3)) L.polyline([site, [t.lat, t.lon]], {color: cColor(c.carrier), weight: 2.5, opacity: .8, dashArray: "8 6"}).addTo(map);
      for (const t of ts) { if (t.kind === "estimated" && t.uncertainty_m) L.circle([t.lat, t.lon], {radius: t.uncertainty_m, color: "#57606a", weight: 1, dashArray: "4 4", fillOpacity: .08}).addTo(map);
        L.marker([t.lat, t.lon], {icon: markIcon(t, false)}).addTo(map); const ic = chipsIcon(t); if (ic) L.marker([t.lat, t.lon], {icon: ic}).addTo(map); }
      L.marker(site, {icon: sitePin(), zIndexOffset: 1000}).addTo(map);
      const cr = mapCredit(d); if (cr) map.attributionControl.addAttribution(cr);
      // the map's own tiles first (up to 10 s), then the sharp 2x image with what's left of WAIT.image (15 s); a copy too busy for
      // that (a sold copy's USGS Topo comes through it, and the 45 s wait ran out under load) gets the map's own tiles scaled up,
      // which needs no fetch: the report prints with its map well inside the old 45 s
      const t0 = Date.now();
      await new Promise(r2 => { const fin = () => { clearTimeout(tm); r2(); }, tm = setTimeout(fin, Math.min(10000, WAIT.image)); bl.once("load", fin);
        setTimeout(() => { if (!bl.isLoading()) fin(); }, 150); });
      const left = Math.max(3000, WAIT.image - (Date.now() - t0));
      let r = await Promise.race([RFMapExport.compose(map, 2), new Promise(r2 => setTimeout(() => r2(null), left))]).catch(() => null), sharp = !!(r && r.cv);
      if (!sharp) r = await RFMapExport.compose(map, 2, {fromMap: true}).catch(() => null);
      if (!r || !r.cv) { mapImage.why = "its map tiles didn't arrive"; return null; }
      mapImage.last = {...stampImage(map, r.cv, 2, site), sharp, ms: Date.now() - t0};
      return r.cv.toDataURL("image/jpeg", .88);
    }catch(err){ mapImage.why = err.message || String(err); return null; }
    finally{ try{ if (map) map.remove(); }catch(e){ /* already gone */ } box.remove(); }
  }
  // the report as it is when the button is pressed: its answer, address, carriers and tiles are taken now, so a next address picked
  // while the map image draws (up to 45 s on a slow connection) never puts its name over this site's towers
  async function print(btn){
    const d = T.data; if (!d) return;
    const o = {place: T.place, carriers: new Set(T.carriers), tiles: chosen(), who: S.remote?.user || S.me?.user || ""};
    const was = btn && btn.innerHTML; if (btn) { btn.disabled = true; btn.textContent = "Making the report…"; }
    try{
      const img = await mapImage(d, o.carriers);
      if (!img) say(`The map image didn't draw (${mapImage.why}): the report printed without it. Print again for the map.`);
      const box = document.createElement("div"); box.className = "panel"; box.innerHTML = reportHtml(d, {...o, img, imgWhy: img ? "" : mapImage.why});
      if (typeof dasPrintCopy === "function") dasPrintCopy(box); else { document.body.appendChild(box); window.print(); box.remove(); }
    } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = was; } }
  }

  /* ---------- the tab ---------- */
  document.head.insertAdjacentHTML("beforeend", `<style>
#twMap{height:calc(100vh - 230px);min-height:440px;border-radius:var(--radius,10px);border:1px solid var(--g-border,var(--line));box-shadow:var(--g-shadow,none);isolation:isolate}
#twMap .leaflet-control-attribution{display:none}
.tw-credit{display:flex;align-items:baseline;background:rgba(255,255,255,.88);color:#333;font:11px/1.6 system-ui,sans-serif;padding:0 6px;border-radius:4px;white-space:nowrap;overflow:hidden;margin-bottom:4px!important}
.tw-credit a{color:#0645ad}.tw-credit>a,.tw-credit .tw-cr-l{flex:none}.tw-credit .tw-cr-base{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.tw-credit.open{display:block;white-space:normal;max-height:45vh;overflow:auto;padding:4px 8px}.tw-credit.open p{margin:2px 0;overflow-wrap:anywhere}
@media (max-width:699px){#twMap{height:72vh;min-height:420px}}
.tw-bar{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin-bottom:8px}.tw-bar .chips{margin:0}
.tw-bar .chip[data-twc]:not([data-twc=""]){box-shadow:inset 0 0 0 1px var(--c)}.tw-bar .chip.on[data-twc]:not([data-twc=""]){background:var(--c);color:#fff}
.tw-legend{margin:6px 2px 0}.tw-mk,.tw-lbm{background:none;border:0}.tw-mk{cursor:pointer}
.tw-lbl{background:rgba(20,20,20,.85);color:#fff;border:0;border-radius:6px;padding:1px 6px;font:11px/1.3 system-ui,sans-serif;box-shadow:none;white-space:nowrap;max-width:min(260px,60vw);overflow:hidden;text-overflow:ellipsis}.tw-lbl::before{display:none}
.tw-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;margin:6px 0}
.tw-tile{border:1px solid var(--line);border-radius:10px;padding:5px 8px;min-width:0;overflow-wrap:anywhere}
.tw-tl{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2,var(--muted))}
.tw-cc{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:0 8px;margin:1px;font-size:12px;border:1px solid var(--c);background:color-mix(in srgb,var(--c) 18%,transparent)}
.tw-cc small{opacity:.8}.tw-who{font-weight:600;color:var(--c)}.tw-k{font-size:12px;color:var(--ink-2,var(--muted))}
.tw-band{padding:0 7px;margin:1px;font-size:12px;border-radius:6px;min-height:24px}.tw-band.lic{opacity:.7;border-style:dashed}.tw-band.old{opacity:.6}.tw-band.old::after{content:" old";font-size:10px}.tw-bandinfo{margin-top:4px}
.tw-sec.face{font-weight:700}.tw-src{margin:0;padding-left:16px}.tw-conf.high{color:var(--good-ink,#1a7f37)}.tw-conf.low{color:var(--warn)}
.tw-card{border:1px solid var(--line);border-radius:12px;padding:6px 8px 2px;margin:6px 0;cursor:pointer}.tw-card:hover,.tw-card:focus{border-color:var(--accent);outline:0}
.tw-card.stale{opacity:.7;padding-bottom:6px}.tw-rank{font-weight:600}.tw-h{margin:12px 0 2px;font-size:13px}
/* a phone: what a thumb taps is at least 40 px (review 11/11: band buttons 24 px in rows 2 px apart) */
@media (pointer:coarse){.tw-band{min-height:40px;min-width:44px}.tw-cells summary{min-height:40px;display:flex;align-items:center}.tw-card.stale{min-height:40px}
  .tw-pick li{min-height:40px}.tw-bar label.inl{min-height:40px}}
#twMap .tw-acts:not(.tw-more) button{font-size:11.5px;padding:4px 5px}  /* the four fit one line in a 360 px panel and a phone's sheet */
.tw-v{border:1px solid var(--line);border-left:5px solid var(--c);border-radius:10px;padding:5px 9px;margin:4px 0}.tw-vt{font-size:12px}
.tw-lv{font-weight:700}.tw-lv.reach{color:var(--good-ink,#1a7f37)}.tw-lv.marginal{color:var(--warn)}.tw-lv.far,.tw-lv.none{color:var(--bad-ink,#cf222e)}.tw-lv.unknown{color:var(--ink-2)}
.tw-topup{margin:8px 0;padding:6px 9px;border:1px dashed var(--line);border-radius:10px}.tw-credits{margin-top:12px;font-size:11px}.tw-credits p{margin:2px 0}
.tw-pick{list-style:none;margin:0;padding:0}.tw-pick li{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:3px 0;border-top:1px solid var(--line)}
.tw-pick label.inl{gap:8px;flex:1;min-width:0}.tw-ci{margin:1px 0}.tw-ci small{font-size:11px}.tw-arrows{display:flex;gap:4px}.tw-arrows button{padding:2px 9px}
.tw-cells summary{cursor:pointer;margin:4px 0}.tw-msg{margin:4px 0}
.tw-acts{display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 6px}.tw-acts[hidden]{display:none}.tw-acts button{padding:4px 8px;font-size:12px;white-space:nowrap}
.tw-acts:not(.tw-more){flex-wrap:nowrap}.tw-acts:not(.tw-more) button{flex:1 1 auto;min-width:0;white-space:normal;line-height:1.2;padding:4px 6px}  /* one row, a label on two lines if it must */
@media (pointer:coarse){.tw-acts button{min-height:40px}}
</style>`);
  // on a phone a new address's report is put on screen at once: the address box lets go (its keyboard goes) and the page scrolls so
  // the map sits under the sticky header and tabs (the Map tab's search toolbar above it filled the first screen, review 11/11)
  // Once per search (the same address picked again too), then the page is the user's to scroll
  function bringIntoView(){
    const gen = S.searchGen || 0; if (T.shownGen === gen || innerWidth >= 700) return; T.shownGen = gen;
    const loc = $("#loc"); if (loc && document.activeElement === loc) loc.blur();
    const m = $("#twMap"); if (!m || !m.isConnected) return;
    const top = Math.max(0, ...["header", "#tabs"].map(q => document.querySelector(q)).filter(e => e && /sticky|fixed/.test(getComputedStyle(e).position)).map(e => e.getBoundingClientRect().bottom));
    const y = m.getBoundingClientRect().top - top - 6; if (Math.abs(y) > 4) window.scrollBy(0, y);
  }
  S.views.towers = v => {
    if (S.mode && S.mode !== "point" && typeof setMode === "function") setMode("point");  // its one search is the address box
    if (!S.center) { v.innerHTML = '<p class="status">The tower report needs one spot: type an address (or coordinates) in the Pin box and pick it.</p>'; return; }
    const k = keyOf(S.center[0], S.center[1]);
    if (T.key !== k) { T.key = k; T.full = {}; T.fullAsk = {}; T.place = S.placeLabel || ""; T.data = null; T.err = null; T.sel = null; T.msg = T.msgFor[k] || ""; delete T.msgFor[k]; T.closed = false; T.picker = false; T.moved = false; }
    // the copy's own default for the crowd readings (Data & updates); off unless its owner says so
    if (T.crowd == null) T.crowd = false;
    const nCrowd = (S.rows || []).filter(r => CROWD.includes(r.layer) && r.lat != null).length;
    const kinds = T.data ? new Set(towersOf(T.data).filter(onMap).map(t => t.kind)) : new Set();
    v.innerHTML = `<div class="tw-bar no-print">
        <div class="chips" role="group" aria-label="Carriers">${[["", "All"], ...BIG3.map(c => [c, c])].map(([c, l]) => `<button type="button" class="chip ${(c ? T.carriers.has(c) : !T.carriers.size) ? "on" : ""}" data-twc="${esc(c)}" style="--c:${cColor(c)}" aria-pressed="${(c ? T.carriers.has(c) : !T.carriers.size)}">${esc(l)}</button>`).join("")}</div>
        <label class="inl" title="The crowd's and your surveys' readings (OpenCelliD, WiGLE where this copy has it, your captures): where phones were, not towers"><input type="checkbox" id="twCrowd" ${T.crowd ? "checked" : ""}> Show crowd readings${nCrowd ? ` <span class="hint">(${nCrowd.toLocaleString()})</span>` : ""}</label>
        <span class="inl">Labels <span class="seg" role="group" aria-label="Labels on the map">${[["off", "Off"], ["carriers", "Carriers"], ["tiles", "My tiles"]].map(([k2, l]) => `<button type="button" data-twl="${k2}" class="${T.labels === k2 ? "on" : ""}">${l}</button>`).join("")}</span></span>
        <button type="button" id="twSum" title="The summary in the viewer: verdicts and each carrier's 3 closest">Summary</button></div>
      <div id="twMap"></div>
      <p class="hint tw-legend">${[["registered", "■ registered (FCC)"], ["mapped", "▲ mapped (OpenStreetMap)"], ["licensed", "◆ licensed site"], ["estimated", "○ estimated, with its uncertainty bubble"]]
        .filter(([kk]) => T.data ? kinds.has(kk) || (kk === "licensed" && kinds.has("cluster")) : !(kk === "mapped" && S.build?.left_out?.osm_towers)).map(x => x[1]).join(" · ")}${T.data && T.data.other_structures?.length && !T.carriers.size ? " · grey: no carrier known" : ""}.
        Click a tower for what's on it; the map stays where it is (Zoom to in the viewer moves it).</p>`;
    v.querySelectorAll("[data-twc]").forEach(b => b.onclick = () => { const c = b.dataset.twc;
      if (!c) T.carriers.clear(); else if (T.carriers.has(c)) T.carriers.delete(c); else T.carriers.add(c);
      if (T.carriers.size === BIG3.length) T.carriers.clear();
      const open = T.sel && T.data && findTower(T.data, T.sel); if (open && !onMap(open)) { T.sel = null; T.more = false; }
      render(); });
    $("#twCrowd").onchange = e => { T.crowd = e.target.checked; T.crowdSet = true; if (T.map) drawMap(T.map, T.data); };
    v.querySelectorAll("[data-twl]").forEach(b => b.onclick = () => { T.labels = b.dataset.twl; store.set("rfr.towerLabels", T.labels);
      v.querySelectorAll("[data-twl]").forEach(x => x.classList.toggle("on", x === b)); if (T.map) drawMap(T.map, T.data); });
    $("#twSum").onclick = () => pick(null);
    const map = T.map = ensureMap();
    if (!map) { $("#twMap").innerHTML = '<p class="status" style="padding:12px">Map library missing.</p>'; return; }
    if (T.data) { drawMap(map, T.data); RFMaps.first(map, T.key, () => fit(map, T.data)); if (!T.closed) showViewer(); bringIntoView(); return; }
    drawMap(map, null);
    // a new address whose report is still coming (or failed): the map goes to its pin, which may be far off the old view; the first
    // fit once it answers (RFMaps.first) is still to come
    if (!T.moved && map._loaded && !map.getBounds().contains(S.center)) map.setView(S.center, Math.min(map.getZoom(), 13), {animate: false});
    T.moved = true;
    showViewer(); bringIntoView();
    const want = T.key;
    load(S.center[0], S.center[1]).then(d => { if (T.key !== want) return; T.data = d;
      // the copy's default for the crowd readings (Data & updates), with the answer so every login has it; read once, and the
      // box ticked or unticked on this visit wins
      if (!T.crowdRead && d.crowd_default != null) { T.crowdRead = true; if (!T.crowdSet) T.crowd = !!d.crowd_default; }
      if (S.tab === "towers") render(); })
      .catch(err => { if (T.key !== want) return; T.err = /runs on the PC only/.test(err.message) ? "The tower report needs a DAStastic copy with crowd cells (the PC app or the server): the web version has none." : `Towers: ${err.message}`;
        if (S.tab === "towers") showViewer(); });
  };
  // the link (#tab=towers&lat&lon&place&carriers): which carriers are picked
  const linkParams = h => { if (T.carriers.size) h.set("carriers", BIG3.filter(c => T.carriers.has(c)).join(",")); };
  const fromLink = v => { T.carriers = new Set(String(v || "").split(",").map(x => x.trim()).filter(x => BIG3.includes(x))); if (T.carriers.size === BIG3.length) T.carriers.clear(); };
  window.RFTowers = {wait: WAIT, load, prefetch, reportHtml, csv, print, share, layer: drawMap, towersOf, tiles: {list: TILES, chosen, pref: tilePref, save: saveTiles, DEFAULT: DEFAULT_TILES}, pick, linkParams, fromLink, mapImage};
})();
