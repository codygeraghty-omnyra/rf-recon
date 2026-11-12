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
  // from the 6 decimals a request sends (and an answer echoes), then 5: a job's pin of 38.68426454980722 keyed 38.68426 while its
  // answer's 38.684265 keyed 38.68427, so a top-up made from the answer left the pin's cached report the one from before it (review
  // 11/12, about 1 pin in 10)
  const keyOf = (lat, lon) => `${(+(+lat).toFixed(6)).toFixed(5)},${(+(+lon).toFixed(6)).toFixed(5)}`;
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
    cache.set(k, p); p.then(v => { answered.set(k, {p, v}); if (answered.size > 24) answered.delete(answered.keys().next().value); }, () => { if (cache.get(k) === p) cache.delete(k); });
    if (cache.size > 12) cache.delete(cache.keys().next().value);
    return p;
  }
  // the answer at a spot if it's in already (the cached request answered), else null: a job's block drawn again with its answer in
  // hand is drawn at once, never the stand-in first (jobGhost), so it doesn't change height under someone typing
  const answered = new Map();
  const peek = (lat, lon) => { const k = keyOf(lat, lon), x = answered.get(k); return x && cache.get(k) === x.p ? x.v : null; };
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
  const tilesHtml = (t, c, ids = chosen()) => `<div class="tw-tiles">${ids.map(id => `<div class="tw-tile" data-tile="${id}"><div class="tw-tl">${esc(tileLabel(id))}</div><div class="tw-tv">${TILE[id].html(t, c)}</div></div>`).join("")}${seenTile(t, c)}</div>`;
  // a tile's value for paper (the printed report, a job's tower block): its band buttons as plain marks, "(old)" where heard only
  // in old cells, and no detail box; decl: the site's declination, so a tower's magnetic bearing is the report's, not the tab's
  const plainTile = (id, t, c, decl) => TILE[id].html({...t, _full: true, _decl: decl}, c).replace(/<div class="tw-bandinfo[^>]*><\/div>/g, "")
    .replace(/<button type="button" class="tw-band([^"]*)"[^>]*>([^<]*)<\/button>/g, (m, cls, b) => `<span class="twr-b${/lic/.test(cls) ? " lic" : ""}">${b}${/old/.test(cls) ? " (old)" : ""}</span> `);  // a space: "B2 B12", not "B2B12", as text

  /* ---------- Seen on site (plan section 8; Cody 11/12): the survey run on this map, matched to the tower ---------- */
  // a tower's carriers seen by the run's serving readings (surveymap.js seenFor, survey.js seenOf: carrier + technology + site
  // ID; 3 moments or more verify it), and "Best RSRP here", the best within 100 m of the site. Shown while a run is on the map
  // (never the sample's), as a tile after the chosen ones; the printed report's Site survey section says the same
  const surveyView = () => window.RFSurveyMap && T.map ? RFSurveyMap.view(T.map) : null;
  const seenGot = (t, c) => { const v = window.RFSurveyMap && T.map ? RFSurveyMap.runOf(T.map) : null; if (!v || v.run.sample) return null; const es = entries(t, c); return es.length ? {v, es, got: RFSurveyMap.seenFor(T.map, es) || []} : {v, es, got: []}; };
  const bandW = b => b == null ? "" : /^n/i.test(String(b)) ? String(b) : `B${b}`;
  const dayOf = ms => { const x = new Date(ms), p = n => String(n).padStart(2, "0"); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`; };
  const hmOf = ms => { const x = new Date(ms), p = n => String(n).padStart(2, "0"); return `${dayOf(ms)} ${p(x.getHours())}:${p(x.getMinutes())}`; };
  // what a carrier's line says (survey.js seenOf's state): a carrier the run never measured is "not measured by this run", not
  // "not seen", and one with no LTE or 5G site ID can't be matched (review 11/12)
  const SEEN_WORD = {verified: "✓ Verified on site", seen: "Seen on site", "not seen": "Not seen", "not measured": "Not measured by this run", "no id": "No LTE or 5G site ID to match"};
  const seenWord = s => SEEN_WORD[s.state] || (s.verified ? SEEN_WORD.verified : s.n ? SEEN_WORD.seen : SEEN_WORD["not seen"]);
  const seenAttr = s => ({verified: "verified", seen: "seen", "not measured": "not-measured", "no id": "no-id"})[s.state] || "no";
  // moments (seconds a cell was measured in) and readings told apart: a primary and its carrier-aggregation leg at one moment are
  // two readings (review 11/12)
  const countTxt = s => `${num(s.n, 0)} moment${s.n === 1 ? "" : "s"}${s.readings && s.readings !== s.n ? ` (${num(s.readings, 0)} readings)` : ""}`;
  // who recorded it: the login (not "local", this PC's own window), else the device or what the log came from
  const whoOf = run => (run.created_by && run.created_by !== "local" ? run.created_by : "") || run.device || (window.RFSurveyMap ? RFSurveyMap.srcTxt(run) : run.source) || "";
  const nearTxt = s => s.near ? `${num(s.near.rsrp, 1)} dBm (${bandW(s.near.band)}, ${num(s.near.m, 0)} m from the site)` : "not measured within 100 m of the site";
  function seenTile(t, c){
    const x = seenGot(t, c); if (!x) return "";
    const g = gap(t), who = whoOf(x.v.run);
    const body = g || (!x.es.length ? none("No carrier known here") : per(x.es, c, e => { const s = x.got.find(y => y.carrier === e.carrier) || {n: 0};
      return `<b class="tw-seen-w${s.verified ? " ok" : s.n ? "" : " no"}">${esc(seenWord(s))}</b>${s.n ? `: ${countTxt(s)}, ${esc(dayOf(s.last))}${who ? `, ${esc(who)}` : ""}, best ${num(s.best.rsrp, 1)} dBm on ${esc(bandW(s.best.band))}`
        : s.state === "not seen" ? ` <span class="hint">in “${esc(x.v.run.name)}”</span>` : ""}${s.state === "not measured" || s.state === "no id" ? "" : `<br><span class="hint">Best RSRP here: ${esc(nearTxt(s))}</span>`}`; }));
    return `<div class="tw-tile tw-seen" data-tile="seen"><div class="tw-tl">Seen on site</div><div class="tw-tv">${body}${x.v.kind === "phone" ? '<br><span class="hint">A phone’s readings: indicative.</span>' : ""}</div></div>`;
  }
  // a survey's serving site ("AT&T|LTE|812442") -> the tower it's on in a report (the one on screen, or the one being printed),
  // for the square's viewer and the print; never an ex-Sprint site, as seenOf (a live T-Mobile eNB can share its number)
  function towerOfServer(k, d = T.data){
    if (!d || !k) return ""; const [c0, tech, x] = k.split("|"); if (!x || x.startsWith("pci ")) return "";
    const c = c0 === "FirstNet" ? "AT&T" : c0, id = +x;
    for (const t of towersOf(d)) for (const e of entries(t)) if (e.carrier === c) for (const s of e.sites || []) if (s.radio === tech && +s.site_id === id && !s.ex_sprint) return `the ${kindOf(t)[1]} tower ${far(t)}`;
    return "";
  }
  // the run shown, hidden or filtered: an open tower or summary says what it saw now. Never one opened for it (a square's viewer
  // stays; a closed sheet stays closed: at 412x915 Record put the summary back over the map, its legend and its status line)
  // While recording ("more", every drain) it's drawn again only when what the open tower or summary says has changed: a tower's
  // Seen on site said "Not seen" for the whole site walk, until Stop (review 11/12)
  let seenSig = "";
  function surveyChanged(map, why){
    if (T.map !== map || !T.data || T.closed || S.tab !== "towers") return;
    const v = window.RFResults && RFResults.get(map); if (!v || !/^tw:/.test(v.key)) return;
    const ts = T.sel ? [findTower(T.data, T.sel)].filter(Boolean) : towersOf(T.data).filter(t => t._full);
    const sig = ts.map(t => (RFSurveyMap.seenFor(map, entries(t)) || []).map(s => `${s.state}:${s.n}:${s.near ? s.near.rsrp : ""}:${s.best ? s.best.rsrp : ""}`).join(",")).join(";");
    if (why === "more" && sig === seenSig) return;
    seenSig = sig;
    // an open tower's Seen on site tile changed in place, the rest of its viewer as it is: drawn again whole on every drain (and
    // at Record), it shut the open "cells heard" table and band detail (review 11/12, round 2). The summary shows no Seen on site
    if (!T.sel) { if (why !== "more") showViewer(); return; }
    const t = findTower(T.data, T.sel), tiles = map.getContainer().querySelector(":scope > .rf-res .tw-tiles");
    if (!t || !tiles) return showViewer();
    const el = tiles.querySelector('[data-tile="seen"]'), tmp = document.createElement("div"); tmp.innerHTML = seenTile(t, null); const n = tmp.firstElementChild;
    if (el && n) el.replaceWith(n); else if (el) el.remove(); else if (n) tiles.appendChild(n);
  }
  // the printed report's Site survey section: the run, its squares on the report's map, each carrier's towers seen or not, the
  // bands and PCIs heard, and the serving sites the run heard that aren't on these towers
  // Worked out from the run and the site captured when Print was pressed (sv, d): hiding the squares, loading the sample or the
  // next address while the map image drew printed every tower Not seen, or Best RSRP here from the next site (review 11/12)
  function siteSurveyHtml(d, cs, sv){
    if (!sv || sv.run.sample || !window.RFSurvey) return "";
    const run = sv.run, phone = sv.kind === "phone", rows = [], idx = RFSurvey.seenIndex(sv.all, {site: siteOf(d), near: 100});
    for (const c of cs) for (const [t, r] of [...(c.towers || []).map((t, i) => [t, i + 1]), ...(c.stale_towers || []).map(t => [t, "old"])]) {
      const s = RFSurvey.seenOf(idx, entries(t, c.carrier))[0] || {n: 0, bands: [], pcis: [], state: "not seen"};
      rows.push(`<tr data-carrier="${esc(c.carrier)}" data-tw="${esc(t.id)}" data-seen="${seenAttr(s)}"><td>${esc(c.carrier)}</td><td>${r}</td><td>${esc(t.type || kindOf(t)[1])}<br>${esc(far(t))}</td>
        <td><b>${esc(seenWord(s))}</b>${s.sites && s.sites.length ? `<br><small>${esc(s.sites.join(", "))}</small>` : ""}</td><td>${s.n ? esc(countTxt(s)) : ""}</td>
        <td>${s.best ? `${num(s.best.rsrp, 1)} dBm ${esc(bandW(s.best.band))}` : ""}</td><td>${s.n ? esc(nearTxt(s)) : ""}</td>
        <td>${esc((s.bands || []).map(bandW).join(" "))}</td><td class="mono">${esc((s.pcis || []).join(", "))}</td><td>${s.last ? esc(dayOf(s.last)) : ""}</td></tr>`);
    }
    const onT = new Set(), other = [];
    for (const k of RFSurvey.servers(sv.all.filter(r => r.serving === 1))) { if (/\|pci /.test(k) || onT.has(k)) continue; onT.add(k); if (!towerOfServer(k, d)) other.push(k); }
    // what the squares' image shows: its metric and what the legend's chips or Only this site left out
    const f = sv.f || {}, F = [f.only ? `only ${RFSurveyMap.serverTxt(f.only)}` : "", f.carriers ? [...f.carriers].join(", ") : "", f.bands ? [...f.bands].map(bandW).join(" ") : "",
      f.techs ? [...f.techs].join(", ") : ""].filter(Boolean);
    // a metric with no line under the profile the image was judged by (RSRQ always; SINR on a profile without one, as Cooper's) is
    // coloured lowest to highest: the caption said "against the pass line" for SINR there (review 11/12, round 2)
    const lineless = f.metric === "rsrq" || (f.metric === "sinr" && window.RFScale && RFScale.passLine("sinr", null, "lo", sv.profile || undefined) == null);
    const cap = f.metric === "best" ? "Squares: each one's best server's colour (the site with most readings in it); faint under 3 moments"
      : lineless ? `Squares: each one's weakest carrier's ${f.metric === "sinr" ? "SINR" : "RSRQ"} median, coloured from the run's lowest to its highest (${f.metric === "sinr" ? "no SINR line is set for this job" : "RSRQ has no pass line"}); faint under 3 moments`
      : `Squares: each one's weakest carrier's ${f.metric === "sinr" ? "SINR" : "RSRP"} median against the pass line (red weak, amber on the line, green good; hatched below the line; faint under 3 moments)`;
    const first = run.started_at || (sv.all.length ? sv.all[0].ts : null), last = run.ended_at || (sv.all.length ? sv.all[sv.all.length - 1].ts : null);
    return `<div class="twr-sec twr-survey"><h2>Site survey</h2>
      <p style="margin:0 0 4px"><b>${esc(run.name)}</b>: ${num(sv.all.length, 0)} readings from ${esc(run.device || RFSurveyMap.srcTxt(run))}${run.created_by && run.created_by !== "local" ? `, by ${esc(run.created_by)}` : ""}${first ? `, ${esc(hmOf(first))} to ${esc(dayOf(first) === dayOf(last) ? hmOf(last).slice(11) : hmOf(last))}` : ""}.
        ${phone ? "<b>Phone readings are indicative</b>: a phone isn't calibrated, so they never count toward a public-safety pass." : run.calibrated ? "A calibrated scanner's readings." : "A scanner's readings (not marked calibrated)."}
        A tower is seen on site when the run's serving cells name it (carrier, technology and site ID); three or more moments verify it. Best RSRP here is the best within 100 m of the site.</p>
      ${sv.img ? `<img src="${sv.img}" alt="Map: the survey's squares around the site" class="twr-svimg"><div class="hint">${esc(cap)}; their size is in the image's legend.${F.length ? ` <b>Showing ${esc(F.join(" · "))}</b>: other readings are left out of the image, not unmeasured.` : ""}</div>` : ""}
      <table class="twr-seen"><thead><tr><th>Carrier</th><th>#</th><th>Tower</th><th>Seen on site</th><th>Moments (readings)</th><th>Best RSRP</th><th>Best RSRP here</th><th>Bands</th><th>PCIs</th><th>Last seen</th></tr></thead><tbody>${rows.join("")}</tbody></table>
      ${other.length ? `<p class="hint" style="margin:2px 0">Also serving in the run, not matched to these towers: ${esc(other.slice(0, 10).map(k => RFSurveyMap.serverTxt(k)).join(", "))}${other.length > 10 ? ` and ${other.length - 10} more` : ""}.</p>` : ""}</div>`;
  }
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
      // ▦ Survey (surveymap.js, Cody 11/12): a run's squares under the towers, the carrier chips filter them too, and the run's
      // serving readings mark the towers they came from (Seen on site)
      if (window.RFSurveyMap) RFSurveyMap.add(map, {slot: "towers", carriers: () => T.carriers.size ? [...T.carriers] : null, site: () => T.data ? siteOf(T.data) : S.center,
        towerOf: k => towerOfServer(k), changed: (c, why) => surveyChanged(map, why)});
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
    if (map._rfSurvey) map._rfSurvey.redraw();  // the carrier chips filter the survey's squares too (surveymap.js)
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
  function verdictsHtml(d, cars){
    return `<div class="tw-verdicts">${shown(d, cars).map(c => { const [w, cls] = LEVEL[c.verdict?.level] || [c.verdict?.level || "", ""];
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
    if (T.enb) return showEnb();  // an eNB or gNB looked up: its answer is what the viewer shows
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
  // an eNB looked up is a step the same way (enbLook)
  window.addEventListener("popstate", () => { if (S.tab === "towers" && (T.sel || T.enb) && !history.state?.twTower) { T.sel = null; T.enb = null; T.more = false; if (T.map && T.data) drawMap(T.map, T.data); showViewer(); } });
  function pick(id){
    // a tower opened from a lookup takes the lookup's step (one step, not two)
    const had = !!T.enb, back = !id && !!history.state?.twTower;
    if (narrow() && id && !history.state?.twTower) history.pushState({twTower: true}, "", location.href);
    else if (back) history.back();  // closed here: the step it added goes
    T.sel = id || null; T.enb = null; T.closed = false; T.picker = false; T.more = false; T.msg = "";
    if (T.map && T.data) drawMap(T.map, T.data);
    showViewer();
    if (had && !back && window.writeUrlState) window.writeUrlState();  // the link no longer opens the lookup (going back, the step before has none)
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
  // a top-up at a spot: what it did in words, and (reload) that spot's report asked again. Without reload its cached report is
  // dropped, so the next one asked there is fresh (Cell sites reads /api/cells again, not the report)
  // OpenStreetMap's part only when it kept towers, failed, or says something a person can act on: "off on this copy" and "not in this
  // build" (a sold copy, every team login) are said nowhere (the automatic top-up put them on every job, the printed Discovery report
  // too, review 11/12), but a bad osm_towers.server is a settings error and is said (review 11/10; round 2)
  const QUIET_OSM = /off on this copy|aren't in this build/i;
  const part = (n, x) => !x ? "" : x.error ? `${n}: ${x.error}` : x.skipped ? (n === "OpenStreetMap" && QUIET_OSM.test(x.skipped) ? "" : `${n}: ${x.skipped}`)
    : `${n}: ${num(x.rows ?? x.kept ?? 0, 0)} ${n === "OpenCelliD" ? "cells" : "towers"} kept${x.stopped ? ` (${x.stopped})` : ""}`;
  // a top-up at a spot: what it did in words, and (reload) that spot's report asked again. Without reload its cached report is
  // dropped, so the next one asked there is fresh. Cell sites' and Topology's cached answers there go with it, both together (a
  // fresh area beside the sites from before it gave false reasons, round 2)
  async function runTopup(lat, lon, reload = true){
    const r = await post("/api/towers/topup", {lat, lon});
    enbAns.clear();  // an eNB not found before may be in the fresh cells
    const parts = [part("OpenCelliD", r.opencellid), part("OpenStreetMap", r.osm)].filter(Boolean), words = parts.length ? `${parts.map(x => x.replace(/\.+$/, "")).join(". ")}.` : "";
    for (const k of [...areas.keys()]) if (k.startsWith(`${keyOf(lat, lon)},`)) areas.delete(k);
    if (window.cellAllRefresh) window.cellAllRefresh();
    const fresh = reload ? load(lat, lon, true) : null; if (fresh) fresh.catch(() => {}); else cache.delete(keyOf(lat, lon));
    return {r, words, bad: !!(r.opencellid && r.opencellid.error), fresh};
  }
  // One top-up a spot for the page, whoever starts it: the Towers tab's Top up this area, a DAS job's pre-survey or Discovery report,
  // Cell sites, Run it for me. A run already going is joined, never a second POST. took: the spot is covered after it (the server's
  // own topup.due), so a run that failed or was turned away ("another fetch is running: try again in a minute") didn't take
  const autoRuns = new Map();
  function startRun(lat, lon, reload){
    const k = keyOf(lat, lon), run = {done: false, words: "", bad: false, took: false, data: null};
    run.p = runTopup(+lat, +lon, reload).then(async y => { run.words = y.words; run.bad = y.bad; run.took = !y.bad && !(y.r && y.r.topup && y.r.topup.due);
        run.data = y.fresh ? await y.fresh.catch(() => null) : null; },
      err => { run.words = `Top-up: ${err.message}`; run.bad = true; }).then(() => { run.done = true; landed(k, run); return run; });
    autoRuns.set(k, run);
    return run;
  }
  // A run landed: the Towers tab, when its report is at that spot, takes the report from after it (the map stays where it is), and
  // says what it did; elsewhere the words wait for that address. Cell sites' run at the tab's pin left the tab on the report from
  // before it, still offering a top-up (round 2)
  function landed(k, run){
    if (T.key !== k) { if (run.words) T.msgFor[k] = run.words; return; }
    load(...k.split(",").map(Number)).then(nd => { if (T.key !== k) return; T.data = nd; T.msg = run.words; delete T.msgFor[k];
      if (S.tab !== "towers") return; if (T.map) drawMap(T.map, T.data); showViewer(); }, () => {});
  }
  // A top-up that runs by itself where the engine says one is due (cells.topup_due, in the answer's topup), for a DAS job's
  // pre-survey, its Discovery report and Cell sites: it replaces "fetch when no site is kept here", which never ran once the
  // country file was in. Never for a login that can't POST (view only), nor a copy with no OpenCelliD key; once a spot for this
  // page (the server's own rule then says the spot is covered): x = {lat, lon, topup}. Answers the run ({p, done, words, bad,
  // took, data}) or null. o.retry (Run it for me's press): a finished run that didn't take is tried again where one is still due
  // (it was handed back for good, round 2)
  const dueHere = x => !!(x && x.topup && x.topup.due && x.topup.key !== false && canPost());
  const runAt = (lat, lon) => autoRuns.get(keyOf(lat, lon)) || null;
  function autoTopup(x, reload = true, o = {}){
    const k = x && x.lat != null ? keyOf(x.lat, x.lon) : null; if (!k) return null;
    const had = autoRuns.get(k);
    if (had && (!had.done || had.took || !o.retry)) return had;
    if (!dueHere(x)) return o.retry ? null : had || null;
    return startRun(+x.lat, +x.lon, reload);
  }
  // the report at a spot once its top-up is done, for every caller there: Cell sites' run drops the cached report and a job's reloads
  // it, so load() answers the fresh one either way (a pre-survey drawn while Cell sites' top-up ran kept the report from before it)
  const afterTopup = (run, x) => run.p.then(() => load(x.lat, x.lon));
  // what a job's tower block says of the top-up: running, what it did, or why it can't run where one is due
  function topupNote(x, run){
    if (run) return run.done ? run.words : "Getting fresh cell data (OpenCelliD)…";
    const tp = (x && x.topup) || {}; if (!tp.due) return "";
    return tp.key === false ? "Fresher cell data would help here, but this copy has no OpenCelliD key: its admin adds one in Data & updates."
      : !canPost() ? "Fresher cell data would help here. A view-only login can't top up: ask whoever runs this copy." : "";
  }
  // Top up this area: the spot's run already going is joined; else a new one (pressed, so a finished one that didn't take is tried
  // again). What it did and the report from after it come through landed(), here or when this address is back on the tab
  async function topup(btn){
    if (!canPost()) return say("A view-only login can't top up: ask whoever runs this copy.");
    const d = T.data; if (!d) return; const [lat, lon] = siteOf(d); btn.disabled = true; btn.textContent = "Topping up…";
    const had = runAt(lat, lon), run = had && !had.done ? had : startRun(lat, lon, true);
    try{ await run.p; }
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

  /* ---------- an eNB or gNB by its number (Andy Masur verifies a tower by the eNB his test phone or CellMapper shows; at Monroe NY
     the AT&T rooftop is eNB 812442. Cody 11/12: "eNB 812442", "gNB 1234567" or a bare 6 or 7 digit number in the Towers tab's
     box shows that site). search.js hands what's typed here instead of geocoding it. Per carrier (the chips on, else all three)
     GET /api/towers/enb (towerfuse.site_by_id) gives every site under that number in this copy's crowd data and the tower the
     engine puts it on. The answer is in the viewer and the map holds still; the tower is the map's selection (as a click makes
     it) when it's in the report on screen ---------- */
  const ENB_MAX = (1 << 20) - 1;  // an eNB ID is 20 bits (36.413): a bare number over it can only be a gNB
  // towerfuse.site_by_id's own pattern: "eNB" or "gNB", maybe "#", then one number, maybe in thousands ("812,442", "812 442")
  const ENB_PRE = /^\s*([eg])nb\s*#?\s*(?=\d)/i, ENB_NUM = /^\s*(?:[eg]nb\s*#?\s*)?(\d{1,3}(?:([,. ])\d{3})(?:\2\d{3})*|\d+)\s*$/i;
  // what's typed, as a lookup, or null for an address: "eNB" or "gNB" with a number after it, whatever follows that (the server says
  // what's wrong with a bad number), or a bare 6 or 7 digit number. A bare 5 digits is a ZIP and fewer a house number, and "ENB" or
  // "GNB" with no number after it a place's name (ENB Financial, GNB Bank: review 11/12): those are geocoded as before
  function enbOf(text){
    const s = String(text ?? "").trim(), pre = ENB_PRE.exec(s), m = ENB_NUM.exec(s); if (!pre && !m) return null;
    const digits = m ? m[1].replace(/[,. ]/g, "") : "";
    if (!pre && !/^\d{6,7}$/.test(digits)) return null;
    const id = digits ? +digits : null, nr = pre ? pre[1].toLowerCase() === "g" : id > ENB_MAX, word = nr ? "gNB" : "eNB";
    return {q: pre ? s : digits, id, radio: nr ? "NR" : "LTE", word, label: id != null ? `${word} ${id}` : s, bare: !pre};
  }
  const enbCars = () => T.carriers.size ? BIG3.filter(c => T.carriers.has(c)) : [...BIG3];
  const enbKey = (e, c) => `${e.radio}|${e.id ?? e.q.toLowerCase()}|${c}`;
  const enbAns = new Map();  // enbKey -> {c, v: the answer, err: what went wrong, done}
  // each carrier's answer, asked once per lookup typed (enbLook drops the ones kept; a top-up drops them too: runTopup), kept for the
  // viewer drawn again and a chip turned on
  function enbAsk(e){
    for (const c of enbCars()) {
      const k = enbKey(e, c); if (enbAns.has(k)) continue;
      const x = {c, v: null, err: "", done: false}; enbAns.set(k, x);
      if (enbAns.size > 60) enbAns.delete(enbAns.keys().next().value);
      const ctl = typeof AbortController === "function" ? new AbortController() : null, timer = ctl ? setTimeout(() => ctl.abort(), WAIT.ms) : 0;
      api(`/api/towers/enb?q=${encodeURIComponent(e.q)}&carrier=${encodeURIComponent(c)}${e.radio === "NR" ? "&radio=NR" : ""}`, ctl ? {signal: ctl.signal} : undefined)
        .then(v => { x.v = v; }, err => { x.err = ctl && ctl.signal.aborted ? `no answer in ${Math.round(WAIT.ms / 1000)} s: look it up again`
          : /runs on the PC only/.test(err && err.message || "") ? errTxt(err) : (err && err.message) || String(err); })
        .finally(() => { clearTimeout(timer); x.done = true; if (S.tab === "towers" && T.enb && enbKey(T.enb, c) === k) showViewer(); });
    }
  }
  const enbRows = e => enbCars().map(c => ({c, x: enbAns.get(enbKey(e, c))}));  // each carrier's answer (x: none yet while asked)
  const enbSites = e => enbRows(e).flatMap(({x}) => x && x.v ? x.v.sites || [] : []);
  const posOf = s => s.tower && s.tower.lat != null ? [+s.tower.lat, +s.tower.lon] : [+s.crowd_at.lat, +s.crowd_at.lon];
  // from a to b as the engine says it (geo.py: haversine, bearing from true north, its 16 points)
  const POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  function legOf(a, b){
    const r = Math.PI / 180, p1 = a[0] * r, p2 = b[0] * r, dl = (b[1] - a[1]) * r;
    const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2, km = 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
    const brg = (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / r + 360) % 360;
    return {dist_mi: Math.round(km / 1.609344 * 100) / 100, bearing: Math.round(brg) % 360, compass: POINTS[Math.floor((brg + 11.25) / 22.5) % 16]};
  }
  // where a site's tower is in the report on screen: {rank, txt, id: the tower on its map, t: the report's own entry for it}. By the
  // tower's id, or by the site's key among a tower's sites (an estimate's id is its first site's key, which the area round the pin
  // may make another site's)
  function enbPlace(s, d){
    if (!d) return {txt: !S.center ? "No report yet: type an address to see where it ranks." : T.err ? "No report here to place it in." : "The report here is still coming.", id: null, t: null};
    const c = (d.carriers || []).find(x => x.carrier === s.carrier), tw = s.tower, n = d.n || 3, ts = (c && c.towers) || [];
    const hit = t => (!!tw && t.id === tw.id) || markSites(t).includes(s.key);
    const i = ts.findIndex(hit);
    if (i >= 0) return {rank: i + 1, txt: ts.length > 1 ? `#${i + 1} of ${s.carrier}'s ${ts.length} closest` : `#1: ${s.carrier}'s closest`, id: ts[i].id, t: ts[i]};
    const st = c && (c.stale_towers || []).find(hit);
    if (st) return {txt: `Listed apart as an old ${s.carrier} tower (readings over 3 years old), not one of its ${n} closest`, id: st.id, t: st};
    const m = tw && towersOf(d).find(t => t.id === tw.id);
    if (m) return {txt: `On this report's map, not one of ${s.carrier}'s ${n} closest`, id: m.id, t: m};
    return {txt: `Not in this report: not one of ${s.carrier}'s ${n} closest${c && c.searched_mi ? `, searched to ${fmtR(c.searched_mi)} mi` : ""}`, id: null, t: null};
  }
  // the lookup's tower picked out on the map when it's in the report on screen (the first carrier's that is): true when it changed
  const enbMark = () => { const e = T.enb, d = T.data; if (!e || !d) return false;
    const id = enbSites(e).map(s => enbPlace(s, d).id).find(Boolean) || null; if (T.sel === id) return false; T.sel = id; return true; };
  // CellMapper's map at a spot on a carrier's network, to compare by eye: a link only, DAStastic never reads it
  const MAIN_NET = {"AT&T": "310-410", "Verizon": "311-480", "T-Mobile": "310-260"};
  const cellmapper = (plmn, radio, at) => { const [mcc, mnc] = String(plmn || "").split("-"), p = new URLSearchParams();
    if (mcc && mnc) { p.set("MCC", mcc); p.set("MNC", String(+mnc)); } p.set("type", radio === "NR" ? "NR" : "LTE");
    if (at) { p.set("latitude", (+at[0]).toFixed(6)); p.set("longitude", (+at[1]).toFixed(6)); p.set("zoom", "15"); }
    return `https://www.cellmapper.net/map?${p}`; };
  function enbCard(e, s, d, many, i){
    const tw = s.tower, at = posOf(s), p = enbPlace(s, d), leg = !S.center ? null : p.t && p.t.dist_mi != null ? p.t : legOf(S.center, at);
    const tile = (l, h) => `<div class="tw-tile"><div class="tw-tl">${esc(l)}</div><div class="tw-tv">${h}</div></div>`;
    const btn = (k, l, why) => `<button type="button" data-twe="${k}" data-i="${i}" title="${esc(why)}">${l}</button>`;
    const canMark = many && !!T.map && typeof T.map._rfMark === "function" && (!window.RFMarkup || RFMarkup.canEdit(T.map)), name = `${s.carrier} ${s.site_kind || e.word} ${s.site_id}`;
    return `<div class="tw-enbc" data-carrier="${esc(s.carrier)}" data-tw="${esc(tw ? tw.id : "")}" data-lat="${at[0]}" data-lon="${at[1]}" style="--c:${cColor(s.carrier)}">
      <div class="tw-rank">${chip(s.carrier)} ${esc(s.site_kind || e.word)} ${esc(s.site_id)}${p.rank ? ` <span class="tw-enb-r">#${p.rank}</span>` : ""} <span class="hint mono">${esc((s.plmns || []).join(", "))}</span></div>
      <div class="tw-tiles">${tile("The site", `${num(s.cells, 0)} cell${s.cells === 1 ? "" : "s"} · ${num(s.samples, 0)} samples<br>last heard ${esc(String(s.last || "not on file").slice(0, 10))}<br><span class="hint">where the crowd puts it may be off by about ${num(s.sigma_m, 0)} m</span>`)}
        ${tw ? tile("Type", TILE.type.html(tw)) + tile("Owner", TILE.owner.html(tw)) + tile("Height", TILE.height.html(tw)) : tile("The tower it's on", none("Not placed on a tower: the engine puts this site on no structure"))}
        ${tile("Distance and bearing", leg ? `${TILE.dist.html(leg)}<br><span class="hint">from the pin</span>` : none("No pin yet: Run the report here puts one at it"))}
        ${tile("In this report", `${esc(p.txt)}${p.id ? `<br>${btn("open", "What's on it", "This tower's tiles from the report; the map stays where it is")}` : ""}`)}</div>
      <div class="tw-acts tw-more" role="group" aria-label="${esc(name)}">${many && T.map ? btn("zoom", "Zoom to", "Zoom the map to this one (the only thing here that moves the map)") : ""}${btn("here", "Run the report here", "Move the pin to this tower and run the tower report there")}${btn("street", "Street View ↗", "Google Street View at the tower, in a new tab")}<a href="${esc(cellmapper((s.plmns || [])[0] || MAIN_NET[s.carrier], s.radio || e.radio, at))}" target="_blank" rel="noopener" title="CellMapper at the tower, in a new tab, to compare by eye (DAStastic never reads it)">CellMapper ↗</a>${canMark ? btn("mark", "Mark it", `A marker here, named “${name}”: the pin and the map stay where they are`) : ""}</div></div>`;
  }
  // a lookup with nothing in this copy's crowd data: a top-up near the site may bring its cells in, where this copy can top up (an
  // OpenCelliD key, a login that can POST); the button where one is due at the pin
  function enbTopHtml(d){
    const tp = (d && d.topup) || {}; if (!tp.key || !canPost()) return "";
    return `<p class="hint tw-enb-top">A top-up near the site may bring it in: fresh OpenCelliD cells within about 3 mi of the pin. ${tp.due ? '<button type="button" data-twtop>Top up this area</button>'
      : `${tp.why ? `None is due at this pin now (${esc(tp.why)}): ` : ""}put the pin nearer the site, then Top up this area.`}</p>`;
  }
  function enbHtml(e, d){
    const rows = enbRows(e), many = enbSites(e).length > 1, wait = rows.filter(r => !r.x || !r.x.done).length;
    const errs = rows.filter(r => r.x && r.x.done && r.x.err), same = !!errs.length && errs.length === rows.length && new Set(errs.map(r => r.x.err)).size === 1;
    let i = 0;
    const body = same ? `<p class="status err">${esc(e.label)}: ${esc(errs[0].x.err)}</p>` : rows.map(({c, x}) => {
      if (!x || !x.done) return `<p class="status" data-carrier="${esc(c)}">${esc(c)}: looking it up…</p>`;
      if (x.err) return `<p class="status err" data-carrier="${esc(c)}">${esc(c)}: ${esc(x.err)}</p>`;
      const ss = (x.v && x.v.sites) || [];
      return ss.length ? ss.map(s => enbCard(e, s, d, many, i++)).join("")
        : `<div class="tw-v tw-enb-none" style="--c:${cColor(c)}" data-carrier="${esc(c)}">${esc(e.label)}: no ${esc(c)} cells in this copy's crowd data. ${link(cellmapper(MAIN_NET[c], e.radio, S.center), "CellMapper ↗")}</div>`; }).join("");
    // the credits: every carrier's answer's lines, once each (a carrier's answer names WiGLE only when its own cells came from it)
    const nf = rows.some(r => r.x && r.x.done && r.x.v && !(r.x.v.sites || []).length), lines = [...new Set(rows.flatMap(r => (r.x && r.x.v && r.x.v.attribution_lines) || []))];
    return `<div class="tw-enb" data-pending="${wait}">${msgHtml()}${body}${nf ? enbTopHtml(d) : ""}${e.radio === "NR" ? '<p class="hint">A gNB number is read as a 24-bit gNB ID.</p>' : ""}${lines.length ? creditsHtml({attribution_lines: lines}) : ""}</div>`;
  }
  function showEnb(){
    const e = T.enb, d = T.data, map = T.map, pv = $("#view"); if (!e || !window.RFResults) return;
    const host = map || (S.tab === "towers" ? pv : null); if (!host) return;
    if (map && pv) RFResults.close(pv, false);  // the lookup shown before the pin's map was there
    enbAsk(e);  // a carrier whose chip went on since is asked too
    if (enbMark() && map && d) drawMap(map, d);
    const ss = enbSites(e), one = ss.length === 1 ? ss[0] : null, pts = ss.map(posOf), cs = enbCars();
    const u = one && one.tower && one.tower.kind === "estimated" && one.tower.uncertainty_m;
    const box = () => { const b = L.latLng(pts[0][0], pts[0][1]).toBounds(u * 2.2); return [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]]; };
    const v = RFResults.show(host, {key: `tw:enb:${enbKey(e, cs.join(","))}`, label: e.label, title: esc(e.label), sub: `${esc(andList(cs))} in this copy's crowd data · the map stays where it is`,
      html: enbHtml(e, d), zoom: pts.length ? () => T.enbFocus || (u ? box() : pts.length > 1 ? pts : pts[0]) : null, zoomLevel: 16,
      mark: one ? posOf(one) : false, markName: one ? `${one.carrier} ${one.site_kind || e.word} ${one.site_id}` : undefined,
      actions: [...(d ? [{label: "← All towers", title: "Back to the summary", run: () => pick(null)}] : []), ACT.share], onClose: enbClose}, one ? posOf(one) : S.center || undefined);
    wireEnb(v?.body);
  }
  function wireEnb(body){
    if (!body) return;
    body.onclick = ev => {
      const top = ev.target.closest("[data-twtop]"); if (top) { topup(top); return; }
      const b = ev.target.closest("[data-twe]"), s = b && T.enb && enbSites(T.enb)[+b.dataset.i]; if (!s) return;
      const k = b.dataset.twe, at = posOf(s);
      if (k === "here") reportHere(s);
      else if (k === "street") window.open(street({lat: at[0], lon: at[1]}), "_blank", "noopener");
      else if (k === "open") { const p = enbPlace(s, T.data); if (p.id) pick(p.id); }
      else if (k === "zoom") { const h = T.map && RFResults.get(T.map); if (h) { T.enbFocus = at; try{ h.zoomTo(); } finally { T.enbFocus = null; } } }
      else if (k === "mark") markSite(s, b);
    };
  }
  async function markSite(s, b){
    if (b.disabled || !T.map || typeof T.map._rfMark !== "function") return; b.disabled = true;
    const at = posOf(s);
    try{ if (await T.map._rfMark(L.latLng(at[0], at[1]), `${s.carrier} ${s.site_kind || "eNB"} ${s.site_id}`)) { b.textContent = "✓ Marked"; return; } }
    catch(err){ say(`Not marked: ${err.message}`); }
    if (b.isConnected) b.disabled = false;
  }
  // a lookup typed in the box (search.js), picked from its list, or from a link: in the viewer, the map where it is. A step Back
  // takes off on a phone, as a tower opened is
  function enbLook(text){
    const e = text && typeof text === "object" ? text : enbOf(text); if (!e) return false;
    // asked again when typed: a not-found may be in now (an import, a capture, a country file: not only a top-up here, review 11/12);
    // a chip turned on or the viewer drawn again uses what's kept
    for (const [k, x] of [...enbAns]) if (x.done) enbAns.delete(k);
    if (narrow() && !history.state?.twTower) history.pushState({twTower: true}, "", location.href);
    T.enb = e; T.enbGen = S.searchGen || 0; T.sel = null; T.closed = false; T.picker = false; T.more = false; T.msg = "";
    enbAsk(e);
    if (T.map && T.data) drawMap(T.map, T.data);
    showViewer();
    if (narrow()) toMap();
    if (window.writeUrlState) window.writeUrlState();
    return true;
  }
  // closed (✕, Esc): nothing in the viewer and the tower no longer picked out, as a tower closed
  function enbClose(){
    T.enb = null; T.sel = null; T.closed = true;
    if (T.map && T.data) drawMap(T.map, T.data);
    if (history.state?.twTower) history.back(); else if (window.writeUrlState) window.writeUrlState();
  }
  // Run the report here: the pin to the site's tower (else where the crowd puts the site), a new search location, so its report is
  // fitted as a search's is. On a phone the lookup's Back step goes first, so the search's link isn't written into a step Back leaves
  function reportHere(s){
    const at = posOf(s), tw = s.tower;
    const label = `${s.carrier} ${s.site_kind || "eNB"} ${s.site_id}${tw && tw.registration ? ` (FCC ${tw.registration.number})` : tw && tw.kind === "estimated" ? " (estimated)" : ""}`;
    const go = () => { setMode("point"); $("#loc").value = `${at[0].toFixed(6)}, ${at[1].toFixed(6)}`; $("#locLabel").textContent = `📍 ${label}`; S.placeLabel = label;
      $("#locWrap")?.classList.remove("typed"); runSearch(); };
    T.enb = null; T.sel = null;
    if (!history.state?.twTower) return go();
    let done = false; const fin = () => { if (done) return; done = true; window.removeEventListener("popstate", fin); go(); };
    window.addEventListener("popstate", fin); setTimeout(fin, 500); history.back();
  }
  // a link's enb= (#tab=towers&lat&lon&…&enb=812442): the lookup opens over the report at the link's pin (pin: the link has one, whose
  // search runs next and is the lookup's own); a bare number there is an eNB whatever its length
  function enbFromLink(v, pin){
    const e = enbOf(/^\s*\d+\s*$/.test(String(v ?? "")) ? `eNB ${v}` : v); if (!e) return;
    T.enb = e; T.enbGen = (S.searchGen || 0) + (pin ? 1 : 0); T.closed = false;
  }
  const enbLink = e => e.id == null ? e.q : e.radio === "NR" ? `gNB ${e.id}` : String(e.id);

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
    const cell = (id, t, c) => plainTile(id, t, c, decl);
    // printed from a job: each tower's ✓/✗ from the site visit (cellular.towers_verified), in its row and in Verify on site
    const marks = o.marks || null, seen = t => { const m = markOf(t, marks, d); return m ? esc(seenTxt(m[1])) : ""; };
    const vrows = cs.flatMap(c => [...(c.towers || []).map((t, i) => [c, t, i + 1]), ...namedStale(c).map(t => [c, t, "old"])]);
    const printedTowers = [...new Map([...nearest(d, 3, o.carriers), ...cs.flatMap(c => c.stale_towers || [])].map(t => [t.id, t])).values()];
    return `<div class="twr"><style>.twr{font:11.5px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#000;background:#fff}.twr h1{font-size:20px;margin:0 0 2px}.twr h2{font-size:14px;margin:14px 0 4px}
      .twr table{border-collapse:collapse;width:100%;margin:2px 0 6px}.twr th,.twr td{border:1px solid #aaa;padding:3px 5px;vertical-align:top;text-align:left}.twr th{background:#eee}
      .twr a{color:#0645ad}.twr .hint{color:#444}.twr-head{display:flex;justify-content:space-between;gap:12px;border-bottom:2px solid #000;padding-bottom:6px;margin-bottom:8px}
      .twr-verdicts{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px}.twr-verdicts>div{border:1px solid #888;border-left:6px solid var(--c);border-radius:6px;padding:5px 8px}
      .twr-verdicts b{font-size:13px}.twr img{width:100%;border:1px solid #888;border-radius:4px}.twr-b{display:inline-block;border:1px solid #888;border-radius:4px;padding:0 4px;margin:1px}.twr-b.lic{color:#555;border-style:dashed}
      .tw-cc{display:inline-block;border:1px solid var(--c);border-left:6px solid var(--c);border-radius:4px;padding:0 4px;margin:1px}.tw-k,.twr small{color:#444}.tw-src{margin:0;padding-left:14px}
      .tw-sec{display:inline-block;margin-right:4px}.tw-sec.face{font-weight:700}.twr .box{display:inline-block;min-width:54px;border-bottom:1px solid #000;height:14px}
      .twr-sec{break-inside:avoid}.twr-survey{break-inside:auto}.twr-svimg{width:100%;border:1px solid #888;border-radius:4px;margin:4px 0}.twr-seen tr{break-inside:avoid}.twr-carrier tr,.twr-verify tr{break-inside:avoid}.tw-who{font-weight:600}.twr-old{margin-top:3px;color:#6b4400}
      @media print{body.print-das #dasPrint .twr td,body.print-das #dasPrint .twr th{overflow-wrap:break-word}}</style>
      <div class="twr-head"><div><h1>Tower report</h1><div><b>Site:</b> ${esc(place || "the pin")}</div><div><b>Address / position:</b> ${esc(place ? `${place} · ` : "")}<span class="mono">${(+d.lat).toFixed(5)}, ${(+d.lon).toFixed(5)}</span></div></div>
        <div style="text-align:right"><div><b>Date:</b> ${esc(o.date || today())}</div><div><b>Prepared by:</b> ${who ? esc(who) : '<span class="box" style="min-width:140px"></span>'}</div>${o.job ? `<div><b>DAS job:</b> ${esc(o.job)}</div>` : S.mission?.name ? `<div><b>Mission:</b> ${esc(S.mission.name)}</div>` : ""}
          <div class="hint twr-cover">${esc(coverTxt(d, cs))}</div></div></div>
      <div class="twr-sec"><div class="twr-verdicts">${cs.map(c => `<div style="--c:${cColor(c.carrier)}"><b>${esc(c.carrier)}</b>: ${esc((LEVEL[c.verdict?.level] || [c.verdict?.level || ""])[0])}<br>${esc(c.verdict?.text || "")}</div>`).join("")}</div></div>
      ${o.img ? `<div class="twr-sec" style="margin-top:8px"><img src="${o.img}" alt="Map: the site, the towers and the bearing to each"><div class="hint">The site (pin), the towers (■ registered, ▲ mapped, ◆ licensed site, ○ estimated with its uncertainty bubble) and a bearing line from the site to each carrier's 3 closest. ${(d.attribution_lines || []).map(esc).join(" ")}</div></div>` : o.imgWhy ? `<p class="hint">No map image this time: ${esc(o.imgWhy)}.</p>` : ""}
      ${cs.map(c => `<div class="twr-sec"><h2 data-carrier="${esc(c.carrier)}">${esc(c.carrier)}: ${esc(headOf(c, d)[0])} <span class="hint">${esc(headOf(c, d)[1])}</span></h2>
        ${(c.towers || []).length || (c.stale_towers || []).length ? `<table class="twr-carrier" data-carrier="${esc(c.carrier)}"><thead><tr><th>#</th>${cols}${marks ? "<th>Seen on site</th>" : ""}</tr></thead><tbody>
          ${[...(c.towers || []).map((t, i) => [t, i + 1]), ...(c.stale_towers || []).map(t => [t, "old"])].map(([t, r]) => `<tr><td>${r} ${mark(t)}</td>${ids.map(id => `<td>${cell(id, t, c.carrier)}</td>`).join("")}${marks ? `<td class="twr-seen">${seen(t)}</td>` : ""}</tr>`).join("")}</tbody></table>`
          : `<p class="hint">${esc(c.verdict?.text || "")}</p>`}</div>`).join("")}
      ${siteSurveyHtml(d, cs, o.survey)}
      <div class="twr-sec twr-verify"><h2>Verify on site</h2>
        <p class="hint" style="margin:0 0 4px">With the test phones and the PCTEL: look for these channels and their PCIs, point the donor antenna on the ${decl != null ? `magnetic bearing with a hand compass (declination here ${esc(declTxt(decl))}, NOAA WMM2025; the true bearing is for a map)` : "bearing (true north: this copy can't work out the magnetic one here)"}, and write down what you read. ${esc((cs[0]?.verdict?.text || "").match(/A roof reading decides[^.]*\./)?.[0] || "A roof reading decides.")} Estimated towers are estimates: their bubble shows how far off they may be.</p>
        <table><thead><tr><th>Carrier</th><th>#</th><th>Tower</th><th>Look for: channel and PCIs</th><th>Donor bearing</th><th>Test phone RSRP / SINR</th><th>PCTEL RSRP / SINR</th><th>Seen</th></tr></thead><tbody>
        ${vrows.map(([c, t, r]) => { const v = verifyOf(t, c.carrier, d), m = magOf(t.bearing, decl);
          return `<tr data-carrier="${esc(c.carrier)}" data-tw="${esc(t.id)}"><td>${esc(c.carrier)}</td><td>${r}</td><td>${esc(t.type || kindOf(t)[1])}${t.registration ? `, FCC ${esc(t.registration.number)}` : ""}<br>${esc(far(t))}</td>
            <td class="twr-look">${v.look.map(esc).join("<br>") || (v.old ? "" : '<span class="hint">nothing in the crowd data</span>')}${v.old ? `<div class="twr-old">⚠ ${esc(v.old)}</div>` : ""}</td>
            <td class="twr-brg">${m != null ? `<b>${esc(m)}° magnetic</b><br>${esc(t.bearing ?? "")}° true · ${esc(t.compass || "")}` : `<b>${esc(t.bearing ?? "")}° true</b> ${esc(t.compass || "")}`}</td>
            <td><span style="white-space:nowrap"><span class="box"></span> dBm</span><br><span style="white-space:nowrap"><span class="box"></span> dB</span></td><td><span style="white-space:nowrap"><span class="box"></span> dBm</span><br><span style="white-space:nowrap"><span class="box"></span> dB</span></td><td class="twr-seen">${seen(t) || "☐"}</td></tr>`; }).join("")}</tbody></table></div>
      ${marks ? `<div class="twr-sec">${lostHtml(lostMarks(d, marks), "h2")}</div>` : ""}
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
  // sv: the survey run on the Towers map (RFSurveyMap.view), whose squares get an image of their own on the same map for the
  // Site survey section (mapImage.svImg): drawn from the tiles that map already has, so it costs no fetch
  async function mapImage(d, cars = T.carriers, sv = null){
    if (typeof L === "undefined" || !window.RFMapExport) { mapImage.why = "no map library on this page"; return null; }
    mapImage.why = ""; mapImage.svImg = null;
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:-12000px;top:0;width:960px;height:560px";
    document.body.appendChild(box);
    let map = null;
    try{
      map = L.map(box, {preferCanvas: true, zoomControl: false, fadeAnimation: false, zoomAnimation: false, markerZoomAnimation: false, inertia: false});
      // the base the screen shows (baseShown: a sold copy's stand-in for a saved base it can't show), never the saved one as it
      // is: a sold copy whose saved base was OpenStreetMap's own tiles, which the server refuses it, printed a blank map (11/12)
      const cfg = BASEMAPS[baseShown(mapPrefs().base)] || BASEMAPS[baseDefault()];
      const bl = baseLayer(cfg).addTo(map);
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
      const out = r.cv.toDataURL("image/jpeg", .88);
      // the squares' image: the same map fitted to the site and the run's readings within 2 mi of it (the towers' view made them
      // specks), its own tiles given up to 6 s, then drawn from them as the map shows them (no fetch)
      if (sv && window.RFSurveyMap) try{
        const k = Math.cos(site[0] * Math.PI / 180), near = sv.rs.filter(r => r.serving >= 1 && Math.hypot(r.lat - site[0], (r.lon - site[1]) * k) * 111320 <= 3219);
        if (near.length) { const b = L.latLngBounds([site, site]); for (const r of near) b.extend([r.lat, r.lon]);
          map.fitBounds(b.pad(0.12), {maxZoom: 17, animate: false});
          await new Promise(r2 => { const fin = () => { clearTimeout(tm); r2(); }, tm = setTimeout(fin, 6000); bl.once("load", fin); setTimeout(() => { if (!bl.isLoading()) fin(); }, 150); }); }
        const undo = RFSurveyMap.draw(map, {...sv, carriers: () => cars.size ? [...cars] : null, site: () => site});
        const r2 = await RFMapExport.compose(map, 2, {fromMap: true}); undo(); if (r2 && r2.cv) { stampImage(map, r2.cv, 2, site); mapImage.svImg = r2.cv.toDataURL("image/jpeg", .88); } }
        catch(err){ mapImage.svImg = null; /* the section prints without its map */ }
      return out;
    }catch(err){ mapImage.why = err.message || String(err); return null; }
    finally{ try{ if (map) map.remove(); }catch(e){ /* already gone */ } box.remove(); }
  }
  // the report as it is when the button is pressed: its answer, address, carriers and tiles are taken now, so a next address picked
  // while the map image draws (up to 45 s on a slow connection) never puts its name over this site's towers
  // A caller with its own answer (a DAS job's pre-survey) gives it: job.data, the answer at the job's pin; job.place, its address;
  // job.marks, its towers' ✓/✗ (cellular.towers_verified); job.name; job.say, where a problem is said. Every carrier, the tiles chosen
  async function print(btn, job){
    const d = job ? job.data : T.data; if (!d) return;
    const o = job ? {place: job.place || "", carriers: new Set(), tiles: chosen(), who: S.remote?.user || S.me?.user || "", marks: job.marks || {}, job: job.name || ""}
      : {place: T.place, carriers: new Set(T.carriers), tiles: chosen(), who: S.remote?.user || S.me?.user || ""};
    const tell = (job && job.say) || say;
    const was = btn && btn.innerHTML; if (btn) { btn.disabled = true; btn.textContent = "Making the report…"; }
    try{
      // the run as it is now, its readings copied: a recording goes on adding to the map's while the image draws. A DAS job's
      // pre-survey prints its own answer at its own pin: the Towers map's run isn't that site's survey
      const sv0 = job ? null : surveyView(), sv = sv0 && !sv0.run.sample ? {...sv0, all: sv0.all.slice(), rs: sv0.rs.slice()} : null, img = await mapImage(d, o.carriers, sv);
      if (!img) tell(`The map image didn't draw (${mapImage.why}): the report printed without it. Print again for the map.`);
      const box = document.createElement("div"); box.className = "panel"; box.innerHTML = reportHtml(d, {...o, img, imgWhy: img ? "" : mapImage.why, survey: sv ? {...sv, img: mapImage.svImg} : null});
      if (typeof dasPrintCopy === "function") dasPrintCopy(box); else { document.body.appendChild(box); window.print(); box.remove(); }
    } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = was; } }
  }

  /* ---------- a DAS job's towers: its pre-survey and its Discovery report (plan 11/10 section 2 item 4, section 7 point 5) ---------- */
  // Andy Masur (11/9): on every job, the 3 closest towers per carrier, to decide whether an off-air BDA works. They showed one crowd
  // site per carrier. Each tower here: its distance and compass bearing (true, and magnetic for a hand compass), its type (an
  // estimate with its bubble), height and the carrier's bands, the Towers tab's own tiles; each carrier's verdict above; and a ✓/✗
  // from the site visit, kept on the job (cellular.towers_verified: tower id -> {ok, by, at, note})
  const JOB_TILES = ["type", "height", "bands"];
  const farMag = (t, decl) => { const m = magOf(t.bearing, decl);
    return t.dist_mi == null ? "" : `${fmtMi(t.dist_mi)} mi ${t.compass || ""} (${t.bearing ?? "?"}° true${m != null ? `, ${m}° magnetic` : ""})`; };
  // a mark's words; by is the login that made it (none on a copy with no login: "✓ seen, 2026-11-12", not "by this PC")
  const seenTxt = v => `${v.ok ? "✓ seen" : "✗ not seen"}${v.by ? ` by ${v.by}` : ""}${v.at ? `, ${v.at}` : ""}${v.note ? `: ${v.note}` : ""}`;
  // A mark is kept under the tower's id with the tower's site keys (the engine's: network|radio|site id) and its words (label). An
  // estimate's id is its first site's key, which changes as the crowd's data does (two sites' sample counts trade places after a
  // top-up), and one that snaps to a newly mapped mast becomes osm:…; the mark then dropped out of the block and the print (review
  // 11/12). markMap places the job's marks on an answer once: a mark on its own tower; a mark whose key is no tower's id in the
  // answer (carriers' lists, the map's, the structures with no carrier) on the one tower that shares the most of its site keys, none
  // on a tie. Any shared key put a mark on a second tower that shared one, and a press there wiped the first tower's (round 2)
  const markSites = t => [...new Set((Array.isArray(t.carriers) ? t.carriers : []).flatMap(e => (e.sites || []).map(s => s.key)).filter(Boolean))].sort();
  const fullTowers = d => [...new Map(((d && d.carriers) || []).flatMap(c => [...(c.towers || []), ...(c.stale_towers || [])]).map(t => [t.id, t])).values()];
  // every tower id the answer names, the map's and the structures with no carrier too
  const answerIds = d => new Set([...fullTowers(d).map(t => t.id), ...((d && d.towers) || []).map(t => t.id), ...((d && d.other_structures) || []).map(t => t.id)]);
  const maps = new WeakMap();
  function markMap(d, marks){
    const memo = d && marks && maps.get(d); if (memo && memo.marks === marks) return memo.map;
    const out = new Map(), ts = fullTowers(d), ids = answerIds(d);
    for (const t of ts) if (marks && marks[t.id]) out.set(t.id, [t.id, marks[t.id]]);
    for (const [k, v] of Object.entries(marks || {})) {
      if (ids.has(k) || !(v.sites || []).length) continue;
      let best = null, most = 0, tie = false;
      for (const t of ts) { if (out.has(t.id)) continue; const n = markSites(t).filter(s => v.sites.includes(s)).length;
        if (n > most) { best = t; most = n; tie = false; } else if (n && n === most) tie = true; }
      if (best && !tie) out.set(best.id, [k, v]);
    }
    if (d && marks) maps.set(d, {marks, map: out});
    return out;
  }
  const markOf = (t, marks, d) => (t && marks ? markMap(d || {carriers: [{towers: [t]}]}, marks).get(t.id) : null) || null;
  // what's kept with a new mark: the tower's site keys and its words, so a mark whose tower is gone from the answer still says what it was
  function markInfo(d, id){
    for (const c of (d && d.carriers) || []) for (const t of [...(c.towers || []), ...(c.stale_towers || [])]) if (t.id === id)
      return {sites: markSites(t), label: `${kindOf(t)[1]} ${farMag(t, declOf(d))}${t.registration ? `, FCC ${t.registration.number}` : ""} (${names(t).join(", ") || c.carrier})`};
    return {sites: [], label: ""};
  }
  // the marks no card carries, listed apart, never dropped (the job's record of the site visit): those whose tower the answer still has
  // but not among any carrier's 3 closest (a nearer one came in), and those it doesn't place now. It called both "not in today's answer:
  // the tower engine doesn't place these now", on paper too (round 2)
  function lostMarks(d, marks){
    const used = new Set([...markMap(d, marks).values()].map(m => m[0])), far = new Map([...((d && d.towers) || []), ...((d && d.other_structures) || [])].map(t => [t.id, t]));
    const left = Object.entries(marks || {}).filter(([k]) => !used.has(k));
    return {out: left.filter(([k]) => far.has(k)).map(([k, v]) => [k, v, far.get(k)]), gone: left.filter(([k]) => !far.has(k))};
  }
  const lostHtml = (lost, h) => `${lost.out.length ? `<div class="twj-lost" data-twlost-out><${h} class="tw-h">Marked on site, not among the 3 closest today</${h}><ul>${lost.out.map(([k, v, t]) =>
      `<li data-twlost="${esc(k)}">${esc(v.label || k)}: <b>${esc(seenTxt(v))}</b> <span class="hint">(still placed, ${esc(far(t))}; nearer towers came in)</span></li>`).join("")}</ul></div>` : ""}${lost.gone.length
    ? `<div class="twj-lost"><${h} class="tw-h">Marked on site, not in today's answer</${h}><ul>${lost.gone.map(([k, v]) =>
      `<li data-twlost="${esc(k)}">${esc(v.label || k)}: <b>${esc(seenTxt(v))}</b></li>`).join("")}</ul><p class="hint">The tower engine doesn't place these towers now (new crowd data, or a tower taken down): the marks are kept as they were made.</p></div>` : ""}`;
  function seenHtml(t, m, can){
    const [key, v] = m || [t.id, null], at = `data-twv="${esc(t.id)}" data-twkey="${esc(key)}"`;
    if (!can) return `<div class="twj-seen" ${at}>${v ? `<b>${esc(seenTxt(v))}</b>` : '<span class="hint">Seen on site: not checked yet</span>'}</div>`;
    const b = (ok, w, why) => `<button type="button" data-twok="${ok ? 1 : 0}" class="${v && v.ok === ok ? "on" : ""}" aria-pressed="${!!v && v.ok === ok}" title="${why}">${w}</button>`;
    return `<div class="twj-seen" ${at}><span class="hint">Seen on site</span><span class="seg">${b(true, "✓ Seen", "Its channels or PCIs were heard on site (press again to clear)")}${b(false, "✗ Not seen", "Looked for on site and not heard (press again to clear)")}</span>${v
      ? `<span class="hint twj-by">${esc([v.by && `by ${v.by}`, v.at].filter(Boolean).join(", "))}</span><input data-twnote value="${esc(v.note || "")}" placeholder="What you saw: PCI, dBm" aria-label="Note on this tower">` : ""}</div>`;
  }
  // o.marks: the job's towers_verified; o.canMark: ✓/✗ buttons (a login that can save), else the marks as words; o.msg: a line
  // above (the top-up's: on screen only, never on paper)
  function jobHtml(d, o = {}){
    if (!d) return "";
    const all = new Set(), cs = shown(d, all), decl = declOf(d), marks = o.marks || {};
    return `<div class="twj"><p class="tw-msg status twj-msg no-print" role="status"${o.msg ? "" : " hidden"}>${esc(o.msg || "")}</p>
      ${verdictsHtml(d, all)}<p class="hint twj-cover">${esc(coverTxt(d, cs))}.${decl != null ? ` Bearings from the site: true for a map, magnetic for a hand compass (declination ${esc(declTxt(decl))}).` : ""}</p>
      ${cs.map(c => { const [h, w] = headOf(c, d); return `<h5 class="tw-h" data-carrier="${esc(c.carrier)}">${chip(c.carrier)} ${esc(h)} <span class="hint">${esc(w)}</span></h5>
        <div class="twj-row">${(c.towers || []).map((t, i) => `<div class="tw-card twj-t" data-tw="${esc(t.id)}" data-carrier="${esc(c.carrier)}" data-kind="${esc(t.kind || "")}"><div class="tw-rank">#${i + 1} ${kindOf(t)[0]} ${esc(farMag(t, decl))}</div>
          <div class="tw-tiles">${JOB_TILES.map(id => `<div class="tw-tile" data-tile="${id}"><div class="tw-tl">${esc(tileLabel(id))}</div><div class="tw-tv">${plainTile(id, t, c.carrier, decl)}</div></div>`).join("")}</div>
          ${seenHtml(t, markOf(t, marks, d), !!o.canMark)}</div>`).join("")}</div>
        ${(c.stale_towers || []).length ? `<p class="hint twj-stale">Known only from readings over 3 years old (check they're still on the air): ${c.stale_towers.map(t => { const m = markOf(t, marks, d);
          return `${kindOf(t)[0]} ${esc(farMag(t, decl))}, last heard ${esc(String(entries(t, c.carrier)[0]?.last || "").slice(0, 10))}${m ? ` (${esc(seenTxt(m[1]))})` : ""}`; }).join("; ")}.</p>` : ""}
        ${(c.heard_only || []).length ? `<p class="hint">Heard only in your own readings, so not placed: ${c.heard_only.map(x => `${esc(x.site_kind)} ${esc(x.site_id)} (${num(x.readings, 0)} readings)`).join(", ")}.</p>` : ""}`; }).join("")}
      ${lostHtml(lostMarks(d, marks), "h5")}
      ${creditsHtml(d)}</div>`;
  }
  // the presses in a job's tower block: h.onMark(id, true | false | null to clear, button, key the mark is kept under), h.onNote(id,
  // text, input, key). One handler each (the block is drawn again into the same box)
  function wireJob(el, h = {}){
    if (!el) return;
    el.onclick = e => { const b = e.target.closest("[data-twok]"); if (!b || !h.onMark) return; const v = b.closest("[data-twv]");
      h.onMark(v.dataset.twv, b.getAttribute("aria-pressed") === "true" ? null : b.dataset.twok === "1", b, v.dataset.twkey || v.dataset.twv); };
    el.onchange = e => { const i = e.target.closest("[data-twnote]"); if (!i || !h.onNote) return; const v = i.closest("[data-twv]");
      h.onNote(v.dataset.twv, i.value.trim(), i, v.dataset.twkey || v.dataset.twv); };
  }
  // A stand-in for a job's tower block while its answer comes (Cody 11/12: the towers first in the pre-survey, and nothing jumps): the
  // block itself drawn from a made-up answer of the usual shape (a verdict row, then each carrier's 3 cards: a row of them where
  // there's room, stacked on a phone), its words and buttons hidden, so it takes the room the answer will at the width the page has.
  // The answer is drawn in its place; if it's a little shorter or longer, keepPlace holds what's below
  const GHOST_LINES = ["Cell tower data from OpenCellID, licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/), from opencellid.org. Changes: DAStastic groups the cells into sites, estimates each site's position and matches it to the registered or mapped structure it most likely sits on.",
    "FCC antenna structure registrations and licences (US government public data)."];
  function jobGhost(o = {}){
    // a carrier's usual three: two registered towers (one with a band held nationwide, a second bands line) and an estimate (its
    // "give or take" line), so a row is as tall as the answer's at most widths and the stacked cards on a phone average out
    const tower = (c, i) => ({id: `ghost:${c}:${i}`, ...(i === 2 ? {kind: "estimated", uncertainty_m: 400, type: "unknown: estimated from crowd cells", height_ft: null}
      : {kind: "registered", type: "monopole", height_ft: 150}), dist_mi: 1.2 + i, compass: "NE", bearing: 45,
      carrier_names: [c], carriers: [{carrier: c, sites: [], techs: ["LTE"], bands: {heard: ["B2", "B12", "B66"].map(b => ({band: b, channels: [], dl_mhz: []})),
        licensed: i === 1 ? [{band: "B14", how: "nationwide or leased"}] : []}}]});
    const d = {lat: o.lat ?? 40, lon: o.lon ?? -75, n: 3, radius_mi: 5, attribution_lines: GHOST_LINES,
      carriers: BIG3.map(c => ({carrier: c, searched_mi: 5, verdict: {level: "in reach", text: `Closest ${c} 0.20 mi: in reach. A roof reading decides (−95/−85 dBm).`},
        towers: [0, 1, 2].map(i => tower(c, i)), stale_towers: [], heard_only: []}))};
    return `<div class="twj-wait"><p class="status twj-waitmsg">${esc(o.msg || "Finding the towers…")}</p><div class="twj-ghost" aria-hidden="true">${jobHtml(d, {canMark: !!o.canMark})}</div></div>`;
  }
  // box drawn again (fn) where the page may be in use: what has the focus keeps its place on screen (a box in the block it's in, the
  // block being drawn again around it), else what's just below the block does, so nothing below moves under someone typing or once
  // the page has settled (Cody 11/12). Not when all of it is below the screen: nothing in view moves then
  function keepPlace(box, fn){
    if (!box || !box.isConnected) return fn();
    const a = document.activeElement, inside = !!(a && a !== document.body && box.contains(a)), out = a && a !== document.body && !inside && a.isConnected ? a : null;
    const near = el => (el && el.closest && el.closest("[data-twv]")) || el;
    const ref0 = inside ? near(a) : out || box.nextElementSibling, y0 = ref0 ? ref0.getBoundingClientRect().top : null;
    fn();
    if (y0 == null || y0 > innerHeight) return;
    const b = document.activeElement, ref1 = inside ? (b && box.contains(b) ? near(b) : null) : ref0;
    if (!ref1 || !ref1.isConnected) return;
    const dy = ref1.getBoundingClientRect().top - y0; if (Math.abs(dy) >= 1) window.scrollBy(0, dy);
  }
  // the words the tab says when the report can't be had here (the web version has no crowd cells)
  const errTxt = err => /runs on the PC only/.test(err && err.message || "") ? "The tower report needs a DAStastic copy with crowd cells (the PC app or the server): the web version has none."
    : `Towers: ${err && err.message || err}`;
  // every tower the engine places round a spot, each with its crowd sites under Cell sites' keys (GET /api/towers/area): Cell
  // sites' By tower and Topology. Kept a minute, as cellall.js keeps /api/cells; a top-up here drops it
  const areas = new Map();
  // the area answers kept, dropped when the sites they're read beside change (Cell sites' Import, beside cellAllRefresh)
  const dropArea = () => areas.clear();
  // f: Cell sites' Operator and Technology picks ({op, radio}), applied by the server before its cut to the nearest 500
  function area(lat, lon, radius, mission, f = {}){
    const k = `${keyOf(lat, lon)},${radius},${mission || ""},${f.op || ""},${f.radio || ""}`, hit = areas.get(k);
    if (hit && Date.now() - hit.at < 60000) return hit.p;
    const p = api(`/api/towers/area?lat=${(+lat).toFixed(6)}&lon=${(+lon).toFixed(6)}&radius=${radius}${mission ? `&mission=${mission}` : ""}`
      + `${f.op ? `&op=${encodeURIComponent(f.op)}` : ""}${f.radio ? `&radio=${encodeURIComponent(f.radio)}` : ""}`);
    areas.set(k, {at: Date.now(), p}); p.catch(() => { if (areas.get(k)?.p === p) areas.delete(k); });
    if (areas.size > 12) areas.delete(areas.keys().next().value);
    return p;
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
.tw-seen{border-style:dashed}.tw-seen-w.ok{color:var(--good-ink,#1a7f37)}.tw-seen-w.no{color:var(--ink-2,var(--muted))}
.tw-acts{display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 6px}.tw-acts[hidden]{display:none}.tw-acts button{padding:4px 8px;font-size:12px;white-space:nowrap}
.tw-acts:not(.tw-more){flex-wrap:nowrap}.tw-acts:not(.tw-more) button{flex:1 1 auto;min-width:0;white-space:normal;line-height:1.2;padding:4px 6px}  /* one row, a label on two lines if it must */
@media (pointer:coarse){.tw-acts button{min-height:40px}}
/* an eNB looked up (enbHtml): a card per site found, with its actions; a line per carrier with none */
.tw-enbc{border:1px solid var(--line);border-left:5px solid var(--c);border-radius:12px;padding:6px 8px 4px;margin:6px 0}
.tw-enb-r{display:inline-block;padding:0 7px;border-radius:999px;background:var(--c);color:#fff;font-size:12px}
.tw-enbc .tw-acts a{display:inline-flex;align-items:center;padding:4px 8px;font-size:12px;border:1px solid var(--line);border-radius:8px;text-decoration:none;white-space:nowrap}
.tw-enb-none{font-size:12.5px}.tw-enb-top{margin:8px 0}.tw-enb-top button{padding:3px 10px;font-size:12px}
@media (pointer:coarse){.tw-enbc .tw-acts a,.tw-enb-top button,.tw-enbc .tw-tv button{min-height:40px}}
/* a DAS job's tower block (jobHtml): cards that open nothing, bands as marks, the ✓/✗ row */
.twj-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr));gap:8px}.twj-row .tw-card{margin:0}  /* a carrier's 3 side by side where there's room */
.twj .tw-verdicts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:6px}.twj .tw-v{margin:0}
.twj .tw-card.twj-t{cursor:auto;padding-bottom:4px}.twj .tw-card.twj-t:hover{border-color:var(--line)}.twj .tw-h{margin:12px 0 2px}
.twj .twr-b{display:inline-block;border:1px solid var(--line);border-radius:6px;padding:0 6px;margin:1px;font-size:12px}.twj .twr-b.lic{opacity:.75;border-style:dashed}
.twj-seen{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;margin:2px 0}.twj-seen .seg button{padding:3px 10px}.twj-seen input{flex:1 1 180px;min-width:0}
.twj-cover{margin:4px 0 0}
/* the stand-in while the answer comes (jobGhost): the block's own boxes, empty; one line on top says it's coming */
.twj-wait{position:relative}.twj-waitmsg{position:absolute;top:0;left:0;margin:0;z-index:1}
.twj-ghost{pointer-events:none;user-select:none}.twj-ghost *{color:transparent!important}.twj-ghost .tw-v,.twj-ghost .tw-cc{border-color:var(--line)!important;background:none!important}
.twj-ghost button,.twj-ghost input,.twj-ghost .twr-b,.twj-ghost .tw-k{visibility:hidden}
@media (pointer:coarse){.twj-seen button,.twj-seen input{min-height:40px}}
@media print{.twj-seen .seg,.twj-seen input{display:none}}
</style>`);
  // on a phone a new address's report is put on screen at once: the address box lets go (its keyboard goes) and the page scrolls so
  // the map sits under the sticky header and tabs (the Map tab's search toolbar above it filled the first screen, review 11/11)
  // Once per search (the same address picked again too), then the page is the user's to scroll; an eNB looked up the same (enbLook)
  function bringIntoView(){
    const gen = S.searchGen || 0; if (T.shownGen === gen || innerWidth >= 700) return; T.shownGen = gen;
    toMap();
  }
  function toMap(){
    const loc = $("#loc"); if (loc && document.activeElement === loc) loc.blur();
    const m = $("#twMap"); if (!m || !m.isConnected) return;
    // where each sticky band will stick once the page has scrolled (its top: and its height), not where it is now: on a phone the
    // header scrolls away and .tabbar (the band the tabs sit in, index.html) is the one that sticks; read where it sat under the
    // header at the top of the page, the map landed 210 px low and the sheet ran off the screen (review 11/12)
    const top = Math.max(0, ...["header", "#tabs", ".tabbar"].map(q => document.querySelector(q)).filter(e => e && /sticky|fixed/.test(getComputedStyle(e).position))
      .map(e => (parseFloat(getComputedStyle(e).top) || 0) + e.offsetHeight));
    const y = m.getBoundingClientRect().top - top - 6; if (Math.abs(y) > 4) window.scrollBy(0, y);
  }
  S.views.towers = v => {
    if (S.mode && S.mode !== "point" && typeof setMode === "function") setMode("point");  // its one search is the address box
    // with no pin an eNB looked up shows in the viewer on the page (Run the report here puts the pin at it), unless a search for a
    // pin is on its way (a link's): it shows on that pin's map
    if (!S.center) { v.innerHTML = '<p class="status">The tower report needs one spot: type an address (or coordinates) in the Pin box and pick it, or an eNB number.</p>';
      if (T.enb && !parseLoc($("#loc").value)) showEnb(); return; }
    const k = keyOf(S.center[0], S.center[1]);
    if (T.key !== k) { T.key = k; T.full = {}; T.fullAsk = {}; T.place = S.placeLabel || ""; T.data = null; T.err = null; T.sel = null; T.msg = T.msgFor[k] || ""; delete T.msgFor[k]; T.closed = false; T.picker = false; T.moved = false; }
    // a search since the lookup (an address picked, the same one too, Run the report here): the report, not the lookup. A link's
    // lookup belongs to the link's own search (enbFromLink)
    if (T.enb && T.enbGen !== (S.searchGen || 0)) { T.enb = null; T.sel = null; }
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
    { const pv = $("#view"); if (pv && window.RFResults) RFResults.close(pv, false); }  // a lookup shown on the page before there was a pin: the map's viewer now
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
  // the link (#tab=towers&lat&lon&place&carriers&enb): which carriers are picked, and the eNB or gNB looked up (its carriers are the
  // chips': carrier= is the Map tab's carrier filter)
  const linkParams = h => { if (T.carriers.size) h.set("carriers", BIG3.filter(c => T.carriers.has(c)).join(",")); if (T.enb) h.set("enb", enbLink(T.enb)); };
  const fromLink = v => { T.carriers = new Set(String(v || "").split(",").map(x => x.trim()).filter(x => BIG3.includes(x))); if (T.carriers.size === BIG3.length) T.carriers.clear(); };
  window.RFTowers = {wait: WAIT, load, prefetch, reportHtml, csv, print, share, layer: drawMap, towersOf, tiles: {list: TILES, chosen, pref: tilePref, save: saveTiles, DEFAULT: DEFAULT_TILES}, pick, linkParams, fromLink, mapImage,
    // an eNB or gNB by its number: what's typed read as one (search.js), the lookup, a link's, and the carriers it asks
    enbOf, enb: enbLook, enbFromLink, enbCarsTxt: () => andList(enbCars()),
    // a DAS job's tower block, its top-up and its marks; Cell sites' and Topology's towers (cells.js, cellall.js)
    jobHtml, jobGhost, keepPlace, peek, wireJob, seenTxt, markOf, markSites, markInfo, answerIds, autoTopup, afterTopup, runAt, topupNote, canPost, errTxt, area, dropArea,
    kind: kindOf, far, typeHtml: t => TILE.type.html(t)};
})();
