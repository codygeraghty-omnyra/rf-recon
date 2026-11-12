"use strict";
/* DAStastic: survey mapping's core (11/10). Cody: a drive or walk survey whose readings paint colour-coded grid tiles "like
   the tiles of the heat map", part of the tower tool and Andy's demo. No map here and no page: pure functions on
   window.RFSurvey, for the map layer the next step adds (one canvas pane under the tower dots) and for tests/survey_check.mjs,
   which runs this file in node.
   - Readings: one shape whatever they came from. The phone's own (DAStastic for Android's window.RFRadio snapshot, the
     shape daswalk.js wkPhoneReadings reads, widened: every serving cell, carrier-aggregation and 5G NSA legs, and the
     neighbours too, each with the snapshot's GPS fix), the server's (/api/survey/readings: columns and rows), or anything
     else. The same checks as survey.py's clean: no position, a fix worse than 50 m, an RSRP outside -156 to -31 dBm, or a
     technology other than LTE and NR is left out; a role it doesn't know is a neighbour, never the primary.
   - Tiles: squares on one grid for the whole world, so a tile is the same tile on every map, run and phone. 25 m at zoom 17
     and in, 50 m at 15-16, 100 m at 13-14, 200 m further out. Rows count from latitude 0 (size / 111 320 degrees tall);
     columns from longitude 0, each size / (111 320 cos phi) degrees wide, phi the middle of the reading's 1-degree band of
     latitude, so a tile stays square to within 2% as far north as 60 degrees; a row that crosses a whole degree is cut there.
   - A tile holds its serving readings (primary cells, and carrier-aggregation and NSA legs) per carrier and frequency layer
     (below 3.3 GHz, or 3.3 GHz and up: C-band, CBRS; a 5G leg with no band or channel is a layer not known, never judged as
     either): the count, the median of the metric shown (RSRP, RSRQ or SINR), the best and worst RSRP; detail() adds the rest
     for a tile's click (per band: medians, PCIs, servers, time span).
     With several carriers on, the tile shows the weakest carrier: the one a DAS would have to fix, judged against each
     carrier's own pass line (RFScale). Best-server mode colours a tile by the site whose primary cell has most readings in
     it (a leg is its primary's carrier aggregation, not a server of its own). Shown from fewer than three moments of
     measurement (the group behind the colour, or the best server's), it's drawn faint. The colours are RFScale's
     (static/rfscale.js), the same scale as the walk test.
   - For the map layer (static/surveymap.js, 11/12): the readings as the server's CSV writes them and as KML (csv, kml), which
     towers a run's serving readings came from ("Seen on site": seenIndex, seenOf), and the made-up sample run (sample). */
(() => {
  const M_PER_DEG = 111320;
  // the builtins the tile loops use, held here: a global looked up per reading is slow wherever the page's globals are proxied
  const floor = Math.floor, max = Math.max, min = Math.min, cos = Math.cos, RAD = Math.PI / 180, INF = Infinity;
  const MAX_ACC_M = 50, RSRP_LO = -156, RSRP_HI = -31;
  const COLS = ["ts", "lat", "lon", "acc", "speed", "plmn", "carrier", "tech", "band", "chan", "pci", "tac", "cid", "site", "serving", "rsrp", "rsrq", "sinr", "ta"];
  const num = v => { if (v == null || v === "" || typeof v === "boolean") return null; const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^\d.eE+\-]/g, "")); return isFinite(n) ? n : null; };
  // a measured value with a decimal comma read as a point ("-95,5" from Excel in a comma-decimal locale), as survey.py _dec
  const dec = v => num(typeof v === "string" && !v.includes(".") ? v.replace(/(\d),(\d)/, "$1.$2") : v);
  const int = (v, lo, hi) => { const n = num(v); return n != null && Number.isInteger(n) && n >= lo && n <= hi ? n : null; };
  const within = (v, lo, hi) => { const n = dec(v); return n != null && n >= lo && n <= hi ? n : null; };
  const techOf = v => { const t = String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, ""); return !t ? null : /^(nr|5g)/.test(t) ? "NR" : /^(lte|4g|eutra)/.test(t) ? "LTE" : null; };
  const bandName = (tech, v) => { const m = String(v ?? "").match(/(\d{1,3})/); return m ? (tech === "NR" ? `n${+m[1]}` : String(+m[1])) : null; };
  // the band a channel sits in, as survey.py band_of (its shim on cellspec.LTE and cellspec.NR; tests/test_survey.py checks the
  // two give one answer): an LTE EARFCN in its band's own numbers; an NR-ARFCN where only one band holds its MHz. clean takes it
  // over the band named, as the server does: a band-less live NR cell on 650000 had no band here and n77 there, so a C-band
  // filter dropped it until the page reloaded (review 11/10, round 3)
  const LTE_CH = [["2", 600, 600], ["4", 1950, 450], ["5", 2400, 250], ["12", 5010, 170], ["13", 5180, 100], ["14", 5280, 100], ["17", 5730, 120],
    ["25", 8040, 650], ["26", 8690, 350], ["29", 9660, 110], ["30", 9770, 100], ["41", 39650, 1940], ["48", 55240, 1500], ["66", 66436, 900],
    ["70", 68336, 250], ["71", 68586, 350], ["85", 70366, 180]];
  const NR_MHZ = [["n2", 1930, 1990], ["n5", 869, 894], ["n12", 729, 746], ["n14", 758, 768], ["n25", 1930, 1995], ["n26", 859, 894], ["n29", 717, 728],
    ["n30", 2350, 2360], ["n41", 2496, 2690], ["n48", 3550, 3700], ["n66", 2110, 2200], ["n70", 1995, 2020], ["n71", 617, 652], ["n77", 3300, 4200],
    ["n258", 24250, 27500], ["n260", 37000, 40000], ["n261", 27500, 28350]];
  function bandOf(tech, chan) {
    if (chan == null) return null;
    if (tech === "LTE") { for (const [b, o, n] of LTE_CH) if (chan >= o && chan < o + n) return b; return null; }
    if (tech !== "NR") return null;
    const mhz = chan < 600000 ? 0.005 * chan : chan < 2016667 ? 3000 + 0.015 * (chan - 600000) : 24250.08 + 0.06 * (chan - 2016667);
    const hits = NR_MHZ.filter(([, lo, hi]) => lo <= mhz && mhz <= hi);
    return hits.length === 1 ? hits[0][0] : null;
  }
  // a latitude (axis "NS") or longitude ("EW") as survey.py _coord reads it (11/10): a decimal comma, a hemisphere letter before
  // or after (S and W negative), degrees with minutes and seconds; anything else is no position, never its first number
  function coord(v, axis) {
    if (v == null || v === "" || typeof v === "boolean") return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    const m = String(v).match(/^\s*([NSEW])?\s*(.*?)\s*([NSEW])?\s*$/i), h = ((m[1] || "") + (m[3] || "")).toUpperCase();
    if (h.length > 1 || (h && !axis.includes(h))) return null;
    const body = m[2].replace(/[°º′″'":]/g, " "), nums = body.match(/[-+]?\d+(?:[.,]\d+)?/g);
    if (!nums || nums.length > 3 || body.replace(/[-+]?\d+(?:[.,]\d+)?/g, "").trim()) return null;
    const x = nums.map(n => parseFloat(n.replace(",", ".")));
    if (!x.slice(1).every(y => y >= 0 && y < 60)) return null;
    const deg = Math.abs(x[0]) + x.slice(1).reduce((s, y, i) => s + y / 60 ** (i + 1), 0);
    return nums[0].startsWith("-") || h === "S" || h === "W" ? -deg : deg;
  }
  // the carrier's one name: DAStastic's network-code list (daswalk.js WK_PLMN) and carrier rule (dascell.js carrierName)
  // when the page has them, else as the phone or file named it (the server names it again on upload: survey.py carrier_of)
  function carrierOf(name, plmn) {
    const code = String(plmn || "").replace("-", "");
    const known = typeof WK_PLMN !== "undefined" && code ? WK_PLMN[code] : null;
    const n = known || (name && !/^[\d\s.,+-]+$/.test(String(name)) ? String(name) : null);  // a number is never a name (survey.py carrier_of)
    if (!n) return code ? `MCC ${code.slice(0, 3)} MNC ${code.slice(3)}` : "Unknown carrier";
    return typeof carrierName === "function" ? carrierName(n) : n;
  }
  const plmnOf = (r) => { const p = r.plmn ?? null;
    if (p != null && p !== "") { const m = String(p).match(/^\s*(\d{3})\s*[-_/ ]?\s*(\d{2,3})\s*$/); return m ? `${m[1]}-${m[2]}` : null; }
    const mcc = String(r.mcc ?? "").trim(), mnc = String(r.mnc ?? "").trim(); return /^\d{3}$/.test(mcc) && /^\d{2,3}$/.test(mnc) ? `${mcc}-${mnc}` : null; };

  // a reading in any of the shapes above -> the canonical reading, or null when survey.py would drop it
  function clean(r) {
    if (!r || typeof r !== "object") return null;
    let ts = typeof r.ts === "string" && !/^\s*\d+(\.\d+)?\s*$/.test(r.ts) ? Date.parse(r.ts) : num(r.ts);
    if (!isFinite(ts) || ts <= 0) return null; if (ts < 1e11) ts *= 1000;
    const lat = coord(r.lat, "NS"), lon = coord(r.lon, "EW"), acc = dec(r.acc);
    if (lat == null || lon == null || lat < -90 || lat > 90 || lon < -180 || lon > 180 || (lat === 0 && lon === 0)) return null;
    if (acc != null && acc > MAX_ACC_M) return null;
    const tech = techOf(r.tech), rsrp = dec(r.rsrp);
    if (!tech || rsrp == null || rsrp < RSRP_LO || rsrp > RSRP_HI) return null;
    const lte = tech === "LTE", plmn = plmnOf(r), cid = int(r.cid, 0, lte ? 2 ** 28 - 1 : 2 ** 36 - 1), chan = int(r.chan, 0, lte ? 262143 : 3279165);
    let site = int(r.site, 0, 2 ** 32 - 1); if (site == null && lte && cid != null) site = Math.floor(cid / 256);
    // no role given is the primary; a role it can't read is a neighbour, never the primary (survey.py clean, 11/10)
    const sv = r.serving == null || r.serving === "" || r.serving === true ? 1 : r.serving === false ? 0 : (int(typeof r.serving === "string" ? dec(r.serving) : r.serving, 0, 2) ?? 0);
    return {ts: Math.round(ts), lat, lon, acc: acc != null && acc >= 0 ? acc : null, speed: within(r.speed, 0, 150), plmn, carrier: carrierOf(r.carrier, plmn), tech,
      band: bandOf(tech, chan) ?? bandName(tech, r.band), chan, pci: int(r.pci, 0, lte ? 503 : 1007), tac: int(r.tac, 0, 2 ** 24 - 1), cid, site,
      serving: sv, rsrp, rsrq: within(r.rsrq, -43, 20), sinr: within(r.sinr, -23, 40), ta: int(r.ta, 0, 4000)};
  }

  // DAStastic for Android's snapshot -> readings: every serving cell (primary 1; a carrier-aggregation leg or 5G NSA leg 2) and
  // every neighbour (0), each at the snapshot's GPS fix (Android 1.3 puts it there) or the fix given (the page's own position,
  // for an older app). The fields wkPhoneReadings gives (tech, carrier, band, pci, freq, rsrp, rsrq, sinr) plus where, when
  // and which cell. Legs as phones report them (review 11/10):
  //  - a leg Android lists with the neighbours (conn secondary, not registered) comes with no network code: it takes its
  //    primary's, so it counts for its carrier, not as an "Unknown carrier" that could be the tile's weakest;
  //  - some modems mark every neighbour secondary (netmonster-core issue 53: thirteen on one Galaxy S22 Ultra), so a listed leg
  //    must be on a channel of its own (never its primary's: a component carrier is another frequency), one a channel (its
  //    strongest), and when more are marked than a phone aggregates (4 LTE, 8 NR) none of them is taken for a leg;
  //  - the 5G NSA leg comes from SignalStrength with no band, channel or PCI; when the snapshot also lists that NR cell as a
  //    leg, the two are one leg (the signal from SignalStrength, the identity from the list), as netmonster-core merges them;
  //  - an NR cell Android marks primary beside an LTE primary of its own network is that LTE cell's NSA leg (EN-DC: the LTE
  //    cell is the anchor).
  const MAX_LEGS = {LTE: 4, NR: 8};
  function fromSnapshot(snap, fix) {
    const f = (snap && snap.fix) || fix || null, out = [];
    if (!snap || !f) return out;
    const sv = snap.serving || [], nb = snap.neighbours || [];
    const techC = c => /NR|5G/i.test(String(c.tech || "")) ? "NR" : "LTE", chOf = c => c.earfcn ?? c.nrarfcn ?? c.chan;
    // an anchor's network and an NR cell's: their network codes when both have one, else their carriers' names; an NR cell
    // naming no network at all is its anchor's. In NSA the phone reads no SIB1, so Android gives the NR cell no MCC or MNC
    // and RadioBridge only the operator's name: a network code against a name never matched, and the NR cell stayed a
    // primary, the tile's best server (round 2, C7 and C14 again)
    const sameNet = (a, c) => { const pa = plmnOf(a), pc = plmnOf(c);
      if (pa && pc) return pa === pc;
      if (!pc && !c.carrier) return true;
      return carrierOf(a.carrier, pa) === carrierOf(c.carrier, pc); };
    const listedPrim = sv.filter(c => !c.nsa && c.conn !== "secondary");
    const anchors = listedPrim.filter(c => techC(c) === "LTE");
    const enDc = c => techC(c) === "NR" && anchors.some(a => sameNet(a, c));
    const prim = listedPrim.filter(c => !enDc(c)), P = prim[0] || null;
    const role = new Map();
    for (const c of sv) role.set(c, c.nsa || c.conn === "secondary" || enDc(c) ? 2 : 1);
    for (const t of ["LTE", "NR"]) {
      const marked = nb.filter(c => c.conn === "secondary" && techC(c) === t);
      if (!marked.length || marked.length > MAX_LEGS[t]) continue;
      const best = new Map();
      for (const c of marked) {
        const ch = chOf(c);
        if (ch == null || prim.some(p => techC(p) === t && chOf(p) === ch)) continue;
        const was = best.get(ch);
        if (!was || (num(c.rsrp) ?? -INF) > (num(was.rsrp) ?? -INF)) best.set(ch, c);
      }
      for (const c of best.values()) role.set(c, 2);
    }
    // the NSA leg and the NR leg Android lists are one leg: the listed one nearest its RSRP lends its identity
    const nsa = sv.find(c => c.nsa), nrLegs = [...role].filter(([c, k]) => k === 2 && !c.nsa && techC(c) === "NR").map(([c]) => c);
    let twin = null;
    if (nsa && nrLegs.length) {
      const s = num(nsa.rsrp), gap = c => { const v = num(c.rsrp); return v == null || s == null ? INF : Math.abs(v - s); };
      twin = nrLegs.reduce((a, b) => gap(b) < gap(a) ? b : a);
    }
    const cell = (c0, serving) => {
      let c = c0;
      if (c === nsa && twin) c = {...twin, ...c, pci: twin.pci, nrarfcn: chOf(twin), band: c.band ?? twin.band, nci: twin.nci, tac: twin.tac};
      if (serving === 2 && P && c.mcc == null && c.mnc == null && !c.carrier && !c.plmn) c = {...c, mcc: P.mcc, mnc: P.mnc, plmn: P.plmn, carrier: P.carrier};
      const tech = techC(c), ch = chOf(c);
      const r = clean({ts: c.ts || snap.ts, lat: f.lat, lon: f.lon, acc: f.acc, speed: f.speed, mcc: c.mcc, mnc: c.mnc, plmn: c.plmn, carrier: c.carrier, tech, band: c.band,
        chan: ch, pci: c.pci, tac: c.tac, cid: (tech === "NR" ? c.nci : c.ci) ?? c.cid, site: c.site, serving, rsrp: c.rsrp, rsrq: c.rsrq, sinr: c.sinr, ta: c.ta});
      if (r) { if (ch != null) r.freq = String(ch); out.push(r); } };
    for (const c of sv) if (c !== twin) cell(c, role.get(c));
    for (const c of nb) if (c !== twin) cell(c, role.get(c) || 0);
    return out;
  }
  // /api/survey/readings' answer {cols, rows} -> readings
  const fromRows = (cols, rows) => (rows || []).map(x => { const o = {}; cols.forEach((c, i) => { o[c] = x[i]; }); return o; });

  /* ---------- the grid ---------- */
  const tileSize = (zoom, override) => override || (zoom >= 17 ? 25 : zoom >= 15 ? 50 : zoom >= 13 ? 100 : 200);
  // the tile a point is in: its key and its edges (degrees). Rows from latitude 0; columns from longitude 0, as wide as the
  // middle of the point's 1-degree band needs for size metres; a row crossing a whole degree is cut at it
  function tileOf(lat, lon, size) {
    const band = floor(lat), dLat = size / M_PER_DEG, dLon = size / (M_PER_DEG * cos((band + 0.5) * RAD));
    const row = floor(lat / dLat), col = floor(lon / dLon);
    return {key: size + "|" + band + "|" + row + "|" + col, size, band, row, col, s: max(row * dLat, band), n: min((row + 1) * dLat, band + 1), w: col * dLon, e: (col + 1) * dLon};
  }
  const tileKey = (lat, lon, size) => tileOf(lat, lon, size).key;

  /* ---------- a tile's numbers ---------- */
  const up = (a, b) => a - b;
  const midOf = v => { const n = v.length; return !n ? null : n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2; };
  const median = a => midOf([...a].sort(up));
  // a reading's frequency layer (dascell.js layerOf): 3.3 GHz and up (bands 77, 78, 48, and 46, LAA's 5 GHz: filed below, its
  // weak legs were pooled into the carrier's licensed low band, round 3; or its NR-ARFCN at 3.3 GHz and up) or below. A 5G reading with neither band nor channel (the NSA leg Android builds from SignalStrength) is a layer not known:
  // filed below 3.3 GHz it was judged on the wrong line and pooled into the LTE median, flipping tiles both ways (11/10)
  const UNKNOWN = "unknown";
  const HI = new Set(["77", "78", "48", "46", "n77", "n78", "n48", "n46", "N77", "N78", "N48", "N46", "B48", "b48", "B46", "b46"]);
  const layerOf = r => { const b = r.band; if (b != null && HI.has(typeof b === "string" ? b : "" + b)) return "hi";
    const c = r.chan; if (c == null) return r.tech === "NR" && b == null ? UNKNOWN : "lo"; if (r.tech === "NR") return (c < 600000 ? c * 0.005 : 3000 + 0.015 * (c - 600000)) >= 3300 ? "hi" : "lo";
    return (c >= 55240 && c <= 56739) || (c >= 46790 && c <= 54539) ? "hi" : "lo"; };
  // C-band (n77, n78, or an NR-ARFCN at 3.3-4.2 GHz outside CBRS's 3.55-3.7): the 3.3 GHz-and-up layer a profile's C-band line
  // asks for. LAA (B46) and CBRS (B48, n48) are in that layer too but are capacity, never required (round 6)
  const CBAND = new Set(["77", "78", "n77", "n78", "N77", "N78"]);
  const cband = r => { const b = r.band; if (b != null && b !== "") return CBAND.has(typeof b === "string" ? b : "" + b);
    if (r.tech !== "NR" || r.chan == null || r.chan < 600000) return false; const f = 3000 + 0.015 * (r.chan - 600000); return f >= 3300 && f <= 4200 && !(f >= 3550 && f <= 3700); };
  // a layer's pass line. A layer not known (a 5G leg with no band or channel) has one where both layers' lines agree (SINR's),
  // else where its value settles it: below both it fails on either (judged on the lower), at or above both it passes on either
  // (on the higher), and only between the two is it not judged (11/10 round 2: a C-band NSA leg at -106, under both -95 and
  // -100, was never judged, and its tile passed on the LTE cells' -91.5)
  const lineOf = (scale, metric, carrier, layer, profile, v) => { if (layer !== UNKNOWN) return scale.passLine(metric, carrier, layer, profile);
    const a = scale.passLine(metric, carrier, "lo", profile), b = scale.passLine(metric, carrier, "hi", profile);
    if (a === b) return a;
    if (a == null || b == null || v == null) return null;
    return v < min(a, b) ? min(a, b) : v >= max(a, b) ? max(a, b) : null; };
  // the server a reading came from: its site (eNB, or a gNB the source named) under its carrier; a cell with no site, its PCI
  // on its channel (or band). Neither site nor PCI: no server (the NSA leg "pci ?@?" was one, and took the first colour, 11/10)
  const serverOf = r => r.site != null ? r.carrier + "|" + r.tech + "|" + r.site
    : r.pci != null ? r.carrier + "|" + r.tech + "|pci " + r.pci + "@" + (r.chan ?? r.band ?? "?") : null;
  const sameServer = (q, r) => q.carrier === r.carrier && q.tech === r.tech && (r.site != null ? q.site === r.site
    : q.site == null && q.pci === r.pci && (q.chan ?? q.band) === (r.chan ?? r.band));

  // readings (as clean gives them) -> tiles. o: {zoom or size, metric ("rsrp", "rsrq", "sinr"), carriers, techs, bands (arrays
  // or Sets; none: all), primaryOnly (serving 1 alone), profile (the job's dascell.js cellProfile; none: Common), kind ("scanner"
  // when the run's survey_run.source is "scanner"; anything else, the default, a phone's), heard (the run's summary, heard(),
  // when the readings given are a part of it)}. Every serving
  // reading counts unless primaryOnly; neighbours never do. One pass puts each reading in its tile, then each tile is summed up
  // on its own with as little made per tile as drawing needs (detail() works out the rest for one tile, on a click), which keeps
  // 50 000 readings under 150 ms. -> Map key -> tile
  //   tile: {key, s, n, w, e, count, faint, moments, readings (its own), groups: {"carrier|layer": {carrier, layer, n, med (the
  //          metric's median), best and worst (RSRP), v (the metric's values, sorted)}}, weakest ("carrier|layer"), value (its
  //          median), thr (its pass line), server (the best server), serverN (its readings here), serverMoments (their moments),
  //          missing (a dead spot: "Verizon", a carrier the device measures all along with no reading here, or "Verizon|hi", a
  //          scanner's C-band the profile asks for: the tile fails, weakest "Verizon|none" or "Verizon|hi|none", value null),
  //          unmeasured (the required carriers the run never measures as a serving cell: no pass, no fail)}
  //   the Map's unmeasured: the same, for the legend
  function aggregate(readings, o = {}) {
    const size = tileSize(o.zoom ?? 17, o.size), metric = o.metric || "rsrp", only1 = !!o.primaryOnly;
    const set = x => x == null ? null : x instanceof Set ? x : new Set(x);
    const C = set(o.carriers), T = set(o.techs), B = set(o.bands), byNum = new Map(), dLat = size / M_PER_DEG, dLons = new Map();
    const scale = typeof RFScale !== "undefined" ? RFScale : null;
    // what the run measures (runAcc: heard() gives the same for the whole run); and, under a filter, the readings it hides that
    // still say a carrier was there (a phone's primaries, a scanner's readings of any role): a leg shown alone is never a dead spot
    const P = o.profile, acc = o.heard ? null : runAcc(o), filt = !!(C || T || B || only1), hidden = filt ? new Map() : null;
    const scanner = (o.heard ? o.heard.kind : o.kind) === "scanner";
    // a drive's readings come in order, so the tile just used is usually the next one's too
    let lr = NaN, lc = NaN, lo = -1, last = null;
    for (let i = 0; i < readings.length; i++) {
      const r = readings[i];
      if (!r || !(r.serving >= 1)) continue;
      const ctb = !((C && !C.has(r.carrier)) || (T && !T.has(r.tech)) || (B && !B.has(r.band)));
      if (acc) acc.add(r, ctb);
      if (!ctb || (only1 && r.serving !== 1)) {
        if (hidden && (scanner ? ctb : r.serving === 1)) {
          const band = floor(r.lat), dLon = size / (M_PER_DEG * cos((band + 0.5) * RAD)), row = floor(r.lat / dLat);
          const nk = (row * 2 + band - floor(row * dLat)) * 67108864 + floor(r.lon / dLon) + 33554432;
          let h = hidden.get(nk); if (!h) hidden.set(nk, h = []); h.push(r);
        }
        continue;
      }
      const band = floor(r.lat);
      let dLon = dLons.get(band);
      if (dLon === void 0) { dLon = size / (M_PER_DEG * cos((band + 0.5) * RAD)); dLons.set(band, dLon); }
      const row = floor(r.lat / dLat), col = floor(r.lon / dLon), off = band - floor(row * dLat);
      let t = last;
      if (row !== lr || col !== lc || off !== lo) {
        // a number for the map's key (row, the side of a whole degree the row is cut at, column), not a string per reading
        const nk = (row * 2 + off) * 67108864 + col + 33554432;
        t = byNum.get(nk);
        if (t === void 0) { t = {key: size + "|" + band + "|" + row + "|" + col, s: max(row * dLat, band), n: min((row + 1) * dLat, band + 1), w: col * dLon, e: (col + 1) * dLon, count: 0, readings: [], nk}; byNum.set(nk, t); }
        lr = row; lc = col; lo = off; last = t;
      }
      t.count++; t.readings.push(r);
    }
    // which carriers are judged, and where a missing one is a dead spot (review 11/10, rounds 5-7, the coordinator's rule):
    // - measured: a scanner's carriers with any serving reading the carrier, technology and band filters leave (its fold makes
    //   only each carrier's strongest cell a primary, so a band whose cells are never strongest is still measured: round 7); a
    //   phone's home networks (runAcc: the carrier with most primaries, and any whose primaries share moments with it, a
    //   second SIM), where the view has a reading of them. A few roaming primaries are no home network, so they never take
    //   the judging over (round 7) nor make a tile fail.
    // - judged: the profile's required carriers measured, or, with none ticked (Common, the default), every carrier measured
    //   that is a carrier (an undecoded cell, "MCC 315 MNC 010" a private CBRS network, is not: round 7); with none of the
    //   required measured, the carriers measured. A required carrier not measured is unmeasured, the legend's own line,
    //   neither a pass nor a fail. A tile where nothing judged was heard (a phone roaming) is judged on what it heard.
    // - missing, a dead spot: a judged carrier the device measures all along with no reading in a tile: a scanner's (any
    //   role, even in primary-only mode: round 7), or a dual-SIM phone's SIMs (a primary, even one a band or 5G filter hides:
    //   its legs come and go with its data, round 7). A single-SIM phone has none: roaming isn't a dead spot. A layer only for a
    //   scanner, only C-band (LAA's B46 and CBRS's B48 are capacity) and only where the profile sets that carrier a C-band line
    //   (hi_by, or rsrp_hi apart from rsrp).
    // - a tile with nothing judged in it and nothing missing is not judged (not drawn).
    const R0 = o.heard || acc.done();
    const real = c => typeof carrierOfName === "function" ? carrierOfName(c) != null : !(c === "Unknown carrier" || /^MCC \d+ MNC \d+$/.test(c));
    const view = R0.view || {}, measured = (R0.home || []).filter(c => view[c] > 0);
    const req = P && Array.isArray(P.carriers) && P.carriers.length ? P.carriers : null;
    const unmeasured = req ? req.filter(c => !measured.includes(c)) : [];
    let judged = req ? req.filter(c => measured.includes(c)) : [];
    if (!judged.length) judged = measured.filter(real);
    const all = scanner ? measured.filter(real) : (R0.sims || []).filter(c => view[c] > 0);
    const PP = P || (scale && scale.COMMON) || {}, cbandLine = c => (PP.hi_by && PP.hi_by[c] != null) || (PP.rsrp_hi != null && PP.rsrp_hi !== PP.rsrp);
    const ctx = {judged: judged.length ? judged : null, scanner, unmeasured, carriers: judged.filter(c => all.includes(c)),
      cband: scanner ? judged.filter(c => all.includes(c) && (R0.cband || []).includes(c) && cbandLine(c)) : []};
    const tiles = new Map();
    for (const t of byNum.values()) { if (hidden) t.hidden = hidden.get(t.nk) || []; tiles.set(t.key, summarise(t, metric, P, scale, ctx)); }
    tiles.unmeasured = unmeasured;
    return tiles;
  }
  // what a run measures, reading by reading (aggregate's, and heard()'s): view, its serving readings per carrier that the
  // carrier, technology and band filters leave; for a scanner, home: every carrier in the view, and cband: those on C-band; for
  // a phone, from its primaries unfiltered: home, the carrier with the most and any whose primaries share 3 moments (seconds)
  // with it, or half of its own (a dual-SIM's second network: one SIM never reads two networks' primaries at once, so roaming
  // never does), and
  // sims, home when it has two or more SIMs (the networks it measures all along), else none
  function runAcc(o) {
    const scanner = o.kind === "scanner", vc = [], vn = [], uc = [], un = [], us = [], cbs = new Set();  // us: each carrier's seconds
    let lv = null, lvi = -1, lu = null, lui = -1, ls = null;
    return {
      add(r, ctb) {
        const c = r.carrier;
        if (!scanner && r.serving === 1) {
          if (c !== lu || ls === null) { lu = c; lui = uc.indexOf(c); if (lui < 0) { lui = uc.length; uc.push(c); un.push(0); us.push([]); } ls = us[lui]; }
          un[lui]++;
          const s = floor(r.ts / 1000);
          if (ls[ls.length - 1] !== s) ls.push(s);
        }
        if (ctb) {
          if (c !== lv) { lv = c; lvi = vc.indexOf(c); if (lvi < 0) { lvi = vc.length; vc.push(c); vn.push(0); } }
          vn[lvi]++;
          if (scanner && cband(r)) cbs.add(c);
        }
      },
      done() {
        const view = Object.fromEntries(vc.map((c, i) => [c, vn[i]]));
        if (scanner) return {kind: "scanner", view, home: vc.slice().sort(), sims: [], cband: [...cbs].sort()};
        let D = -1, dn = -1;
        un.forEach((n, i) => { if (n > dn) { dn = n; D = i; } });
        const main = D >= 0 && uc.length > 1 ? new Set(us[D]) : null;  // the seconds each other carrier shares with the main one
        const shared = us.map((ss, i) => { if (!main || i === D) return 0; let n = 0; for (const x of new Set(ss)) if (main.has(x)) n++; return n; });
        const S = D < 0 ? [] : uc.filter((c, i) => i !== D && (shared[i] >= 3 || (shared[i] > 0 && 2 * shared[i] >= un[i])));
        const home = D < 0 ? [] : [uc[D], ...S].sort();
        return {kind: "phone", view, home, sims: S.length ? home : [], cband: []};
      }
    };
  }
  // a run's summary (runAcc) under aggregate's filters, o.kind as aggregate's: aggregate's o.heard, for a view of part of a run
  // judged as the whole run measures
  function heard(readings, o = {}) {
    const set = x => x == null ? null : x instanceof Set ? x : new Set(x), C = set(o.carriers), T = set(o.techs), B = set(o.bands), acc = runAcc(o);
    for (const r of readings) if (r && r.serving >= 1) acc.add(r, !((C && !C.has(r.carrier)) || (T && !T.has(r.tech)) || (B && !B.has(r.band))));
    return acc.done();
  }
  // a tile summed up: per carrier and layer, the weakest carrier against its own pass line, the best server. A tile holds a
  // handful of readings, two or three carriers and servers, so each is found by a short search, with no key made per reading
  // moments counted as readings come: a time unlike the last is a new moment, exact while the times never go back (readings come
  // in time order: the server's pages, a phone's snapshots); m.back says to count again with every time seen (distinct)
  const tick = (m, ts) => { if (m.m === 0 || ts !== m.last) { if (m.m && ts < m.last) m.back = true; m.m++; m.last = ts; } };
  // how many distinct times the readings that pass keep have: a short list while it's short, then a Set (one spot logged for
  // hours holds thousands: a list searched per reading took 50 000 of them from 12 to 813 ms, round 2)
  function distinct(rs, keep) {
    let a = [], s = null;
    for (let i = 0; i < rs.length; i++) { if (!keep(rs[i], i)) continue; const ts = rs[i].ts;
      if (s) s.add(ts); else if (!a.includes(ts)) { a.push(ts); if (a.length > 16) s = new Set(a); } }
    return s ? s.size : a.length;
  }
  function summarise(t, metric, profile, scale, ctx = {}) {
    const gl = [], s1 = [], s2 = [], rs0 = t.readings, isRsrp = metric === "rsrp", gi = new Array(rs0.length);
    // present here, for a dead spot (aggregate's rule): a group's p1, a primary serving reading in it, and cb, a scanner's C-band
    // one; and t.hidden, the readings a filter hid that still say so
    const look = (ctx.carriers && ctx.carriers.length) || (ctx.cband && ctx.cband.length), sc = !!ctx.scanner, cbOn = sc && ctx.cband && ctx.cband.length;
    for (let i = 0; i < rs0.length; i++) {
      const r = rs0[i], layer = layerOf(r), c = r.carrier, p = r.rsrp, x = isRsrp ? p : r[metric];
      let g = -1;
      for (let j = 0; j < gl.length; j++) if (gl[j].carrier === c && gl[j].layer === layer) { g = j; break; }
      if (g < 0) { g = gl.length; gl.push({carrier: c, layer, n: 0, med: null, best: p, worst: p, v: [], m: 0, last: 0, back: false, p1: false, cb: false}); }
      const G = gl[g]; gi[i] = g;
      if (r.serving === 1) G.p1 = true;
      if (cbOn && !G.cb && cband(r)) G.cb = true;
      G.n++; if (p > G.best) G.best = p; if (p < G.worst) G.worst = p; if (x != null) { G.v.push(x); tick(G, r.ts); }
      // best server: from the primary cells; a leg is its primary's carrier aggregation, so legs count only in a tile that
      // has no primary reading at all (a band filter on C-band), and a reading with no site or PCI is no server (11/10)
      if (r.site == null && r.pci == null) continue;
      const sl = r.serving === 1 ? s1 : s2;
      let s = null;
      for (let j = 0; j < sl.length; j++) if (sameServer(sl[j].r, r)) { s = sl[j]; break; }
      if (s === null) { s = {r, n: 0, m: 0, last: 0, back: false}; sl.push(s); }
      s.n++; tick(s, r.ts);
    }
    const gs = {};
    // the weakest: with a pass line, the furthest below (or least above) its own line; a group with no line (RSRQ, a layer not
    // known) counts only when none has one, then the lowest value: a margin and a level can't be compared. Only the judged
    // carriers (ctx.judged: aggregate), as the walk test judges a square: under Providence's normal mode (Verizon only) a
    // T-Mobile reading failed a tile the walk test passes (review 11/10, round 3). A carrier the device measures all along
    // with no reading here, and for a scanner a C-band the profile asks for, fails the tile (missing, aggregate's rule): judged
    // on what it did hear, a Verizon dead spot with T-Mobile at -70 was drawn a solid pass, better than a tile with Verizon at
    // -120 (round 4). Present: a phone's primary serving reading (its legs come and go with its data), any of a scanner's
    for (let i = 0; i < gl.length; i++) { const g = gl[i]; g.med = midOf(g.v.length > 1 ? g.v.sort(up) : g.v); gs[g.carrier + "|" + g.layer] = g; }
    const missing = [], req = ctx.judged;
    if (look) {  // a phone's carrier present with a primary serving reading (its legs come and go with its data), a scanner's with any
      const hid = t.hidden || [];
      const here = c => gl.some(g => g.carrier === c && (sc || g.p1)) || hid.some(r => r.carrier === c);
      for (const c of ctx.carriers || []) if (!here(c)) missing.push(c);
      for (const c of ctx.cband || []) if (here(c) && !gl.some(g => g.carrier === c && g.cb) && !hid.some(r => r.carrier === c && cband(r))) missing.push(c + "|hi");
    }
    let weakest = null, wi = -1, value = null, thr = null, margin = INF, lowK = null, lowI = -1, low = INF;
    for (let pass = 0; pass < 2; pass++) {  // the second, with no judged carrier heard here and none missing: what it heard
      const only = pass === 0 ? req : null;
      for (let i = 0; i < gl.length; i++) {
        const g = gl[i], k = g.carrier + "|" + g.layer, v = g.med;
        if (v == null || (only && !only.includes(g.carrier))) continue;
        const line = scale ? lineOf(scale, metric, g.carrier, g.layer, profile, v) : null;
        if (line != null) { const m = v - line; if (m < margin || (m === margin && k < weakest)) { margin = m; weakest = k; wi = i; value = v; thr = line; } }
        else if (v < low || (v === low && k < lowK)) { low = v; lowK = k; lowI = i; }
      }
      if (weakest !== null || lowK !== null || !req || missing.length || !gl.some(g => g.med != null && !req.includes(g.carrier))) break;
    }
    if (weakest === null && lowK !== null) { weakest = lowK; wi = lowI; value = low; thr = null; }
    // the moments behind the colour shown: one snapshot's primary and legs are one measurement, not three (11/10: a tile one
    // snapshot passed through was never faint, and two carriers' readings made one carrier's single reading look solid), and
    // only those with a value for the metric (round 2: in SINR mode five snapshots, one with a SINR, were solid)
    const W = wi >= 0 ? gl[wi] : null;
    // a carrier not heard rests on every moment the tile was measured at
    const moments = missing.length ? distinct(rs0, () => true) : !W ? 0 : !W.back ? W.m : distinct(rs0, (r, i) => gi[i] === wi && (isRsrp || r[metric] != null));
    if (missing.length) { weakest = missing[0] + "|none"; value = null; thr = null; }  // "Verizon|none", "Verizon|hi|none"
    // the best server: the most readings here; a tie goes to the stronger median RSRP, then to the lower key (so it never
    // flickers). Medians are worked out only for a tie
    const sl = s1.length ? s1 : s2, role = s1.length ? 1 : 2;
    let best = null, tied = null;
    for (let i = 0; i < sl.length; i++) { const s = sl[i]; if (!best || s.n > best.n) { best = s; tied = null; } else if (s.n === best.n) (tied ||= [best]).push(s); }
    let server = best ? serverOf(best.r) : null;
    if (tied) {
      let smed = -INF;
      for (const k of tied.map(s => serverOf(s.r)).sort()) { const md = midOf(rs0.filter(r => r.serving === role && serverOf(r) === k).map(r => r.rsrp).sort(up)); if (md > smed) { smed = md; server = k; } }
      best = tied.find(s => serverOf(s.r) === server);
    }
    // the best server's moments, for best-server mode's faint: a site's legs on three channels in one snapshot are one
    // moment, not three (round 2: under a band filter that leaves only legs, two snapshots were drawn solid)
    const serverMoments = !best ? 0 : !best.back ? best.m : distinct(rs0, r => r.serving === role && sameServer(best.r, r));
    t.groups = gs; t.weakest = weakest; t.value = value; t.thr = thr; t.server = server; t.serverN = best ? best.n : 0; t.serverMoments = serverMoments;
    t.moments = moments; t.faint = moments < 3; t.missing = missing; t.unmeasured = ctx.unmeasured || [];
    return t;
  }
  // one tile in full, for its click: per carrier, technology and band, the count, the median, best and worst RSRP, the median
  // RSRQ and SINR, the PCIs and servers heard, and the time span
  function detail(t) {
    const by = new Map();
    for (const r of t.readings) {
      const k = `${r.carrier}|${r.tech}|${r.band ?? "?"}`;
      let d = by.get(k);
      if (!d) { d = {carrier: r.carrier, tech: r.tech, band: r.band, rsrp: [], rsrq: [], sinr: [], pcis: new Set(), servers: new Map(), from: r.ts, to: r.ts}; by.set(k, d); }
      d.rsrp.push(r.rsrp); if (r.rsrq != null) d.rsrq.push(r.rsrq); if (r.sinr != null) d.sinr.push(r.sinr);
      if (r.pci != null) d.pcis.add(r.pci);
      const s = serverOf(r); if (s != null) d.servers.set(s, (d.servers.get(s) || 0) + 1);
      if (r.ts < d.from) d.from = r.ts; if (r.ts > d.to) d.to = r.ts;
    }
    return [...by.values()].map(d => { const rs = d.rsrp.sort(up);
      return {carrier: d.carrier, tech: d.tech, band: d.band, n: rs.length, rsrp: {med: midOf(rs), best: rs[rs.length - 1], worst: rs[0]}, rsrq: median(d.rsrq), sinr: median(d.sinr),
        pcis: [...d.pcis].sort(up), servers: [...d.servers].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({server: k, n})), from: d.from, to: d.to}; })
      .sort((a, b) => a.carrier.localeCompare(b.carrier) || a.tech.localeCompare(b.tech) || String(a.band).localeCompare(String(b.band), undefined, {numeric: true}));
  }
  // every server in a run, most primary readings first, then any seen only as a leg: the order best-server colours follow
  // (RFScale.bestColours), the whole run's and never the screen's, so a site keeps its colour as the map moves or a filter
  // changes. A leg never takes a colour ahead of a site (11/10: the NSA bucket took the first, real sites went grey)
  function servers(readings) {
    const one = new Map(), two = new Map();
    for (const r of readings) {
      if (!r || !(r.serving >= 1)) continue;
      const k = serverOf(r); if (k == null) continue;
      const m = r.serving === 1 ? one : two; m.set(k, (m.get(k) || 0) + 1);
    }
    const order = m => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(x => x[0]);
    return [...order(one), ...order(two).filter(k => !one.has(k))];
  }
  // the best-server colours for a view of the run: servers()'s order, each of the first six keeping its colour wherever it's
  // shown, and a colour whose server the view's filter hides going to the next server the view shows, so the filter never
  // moves a shown site's colour. o: aggregate's filter (carriers, techs, bands, primaryOnly). With none it's bestColours of
  // servers(). Round 2: under a C-band filter every server is a leg, ranked after the run's sites, so with six sites every
  // tile was grey, in the view the legs' fallback was made for. -> Map key -> colour
  function colours(readings, o = {}) {
    const order = servers(readings), shown = new Set(), set = x => x == null ? null : x instanceof Set ? x : new Set(x);
    const C = set(o.carriers), T = set(o.techs), B = set(o.bands), only1 = !!o.primaryOnly, best = RFScale.BEST;
    for (const r of readings) {
      if (!r || !(r.serving >= 1) || (only1 && r.serving !== 1)) continue;
      if ((C && !C.has(r.carrier)) || (T && !T.has(r.tech)) || (B && !B.has(r.band))) continue;
      const k = serverOf(r); if (k != null) shown.add(k);
    }
    const free = order.slice(0, best.length).map((k, i) => shown.has(k) ? -1 : i).filter(i => i >= 0), out = new Map();
    order.forEach((k, i) => out.set(k, i < best.length ? best[i] : shown.has(k) && free.length ? best[free.shift()] : RFScale.OTHER));
    return out;
  }
  // how a tile is drawn: its colour against its pass line (or the run's lowest to highest when the metric has none), hatched
  // when it fails; faint when what it shows rests on fewer than three moments (the group behind the colour, or in best-server
  // mode its server's moments); best-server mode, its server's colour (o.colours: colours(), or RFScale.bestColours(servers()))
  function look(t, o = {}) {
    const a = (o.mode === "best" ? (t.serverMoments ?? t.serverN) < 3 : t.faint) ? 0.35 : 0.7;
    if (o.mode === "best") { const c = (o.colours && o.colours.get(t.server)) || RFScale.OTHER; return {fill: c, alpha: a, hatch: false}; }
    if (t.missing && t.missing.length) return {fill: RFScale.INK.fail, alpha: a, hatch: true, missing: t.missing};  // a required carrier not heard: a fail
    if (t.value == null) return null;
    const sc = t.thr != null ? {thr: t.thr, span: (RFScale.METRICS[o.metric || "rsrp"] || RFScale.METRICS.rsrp).span} : (o.range || {thr: null, lo: t.value, hi: t.value});
    return {fill: RFScale.css(RFScale.rgb(t.value, sc)), alpha: a, hatch: RFScale.pass(t.value, sc) === false};
  }

  /* ---------- exports: the readings as the server writes them, and as KML ---------- */
  // survey.py CSV_COLUMNS and csv_text, written the same way (tests/test_survey.py compares the two on one set of readings), so a
  // file saved from the map imports back as it was, a scanner's run as a scanner's (its source, the last column)
  const CSV_COLUMNS = ["time_utc", "lat", "lon", "acc_m", "speed_mps", "plmn", "carrier", "tech", "band", "chan", "pci", "tac", "cid", "site", "serving", "rsrp", "rsrq", "sinr", "ta"];
  const csvCell = v => { const s = v == null ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  // o.sample: the made-up sample's file, its first line saying so (survey.py SAMPLE_MARK: the import refuses it). Saved and
  // imported back it was kept as a real scanner run (review 11/12)
  const SAMPLE_MARK = "SAMPLE: made-up data";
  function csv(readings, source, o = {}){
    const out = [...(o.sample ? [`# ${SAMPLE_MARK}, not a real site (DAStastic's sample survey). It is never imported as real readings.`] : []),
      [...CSV_COLUMNS, ...(source ? ["source"] : [])].join(",")];
    for (const r of readings || []) out.push([...COLS.map(c => csvCell(c === "ts" ? new Date(r.ts).toISOString() : r[c])), ...(source ? [csvCell(source)] : [])].join(","));
    return out.join("\n") + "\n";
  }
  // the serving readings as KML points (Google Earth, ATAK): a folder per carrier and band, each point coloured as its tile would
  // be against its own pass line (RFScale; RSRQ has none: grey), its name the level and its description the cell. o: {name,
  // metric, profile}. Neighbours are left out: they're what else was heard, not the signal there
  function kml(readings, o = {}){
    const x = s => String(s ?? "").replace(/[<>&'"]/g, c => ({"<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;"}[c]));
    const metric = o.metric || "rsrp", sc = typeof RFScale !== "undefined" ? RFScale : null, M = sc ? sc.METRICS[metric] || sc.METRICS.rsrp : {span: 15, unit: " dBm"};
    const abgr = rgb => "ff" + rgb.slice().reverse().map(v => v.toString(16).padStart(2, "0")).join("");
    const styles = new Map(), folders = new Map();
    for (const r of readings || []) {
      if (!r || !(r.serving >= 1)) continue;
      const v = metric === "rsrp" ? r.rsrp : r[metric], line = v == null || !sc ? null : lineOf(sc, metric, r.carrier, layerOf(r), o.profile, v);
      const rgb = v == null ? [140, 149, 159] : line == null ? [140, 149, 159] : sc.rgb(v, {thr: line, span: M.span});
      const id = "c" + rgb.map(c => c.toString(16).padStart(2, "0")).join("");
      if (!styles.has(id)) styles.set(id, `<Style id="${id}"><IconStyle><color>${abgr(rgb)}</color><scale>0.5</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/shaded_dot.png</href></Icon></IconStyle><LabelStyle><scale>0</scale></LabelStyle></Style>`);
      const fk = `${r.carrier} ${r.tech === "NR" ? "5G NR" : "LTE"}${r.band != null ? ` band ${r.band}` : ""}`;
      if (!folders.has(fk)) folders.set(fk, []);
      const desc = [new Date(r.ts).toISOString(), `${r.carrier} ${r.tech}${r.band != null ? ` band ${r.band}` : ""}${r.chan != null ? `, channel ${r.chan}` : ""}`,
        r.pci != null ? `PCI ${r.pci}` : "", r.site != null ? `${r.tech === "NR" ? "gNB" : "eNB"} ${r.site}` : "", r.serving === 2 ? "a carrier-aggregation or 5G NSA leg" : "the serving cell",
        `RSRP ${r.rsrp} dBm`, r.rsrq != null ? `RSRQ ${r.rsrq} dB` : "", r.sinr != null ? `SINR ${r.sinr} dB` : "", r.acc != null ? `GPS within ${r.acc} m` : ""].filter(Boolean).join(" · ");
      folders.get(fk).push(`<Placemark><name>${x(v == null ? "" : `${v}${M.unit}`)}</name><description>${x(desc)}</description><styleUrl>#${id}</styleUrl><Point><coordinates>${r.lon},${r.lat},0</coordinates></Point></Placemark>`);
    }
    return ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>', `<name>${x(`${o.sample ? `${SAMPLE_MARK}: ` : ""}${o.name || "DAStastic survey"}`)}</name>`,
      `<description>${x(`${o.sample ? `${SAMPLE_MARK}, not a real site. ` : ""}${o.note || "Serving readings, coloured against the pass line (red weak, amber on the line, green good)."}`)}</description>`, ...styles.values(),
      ...[...folders].sort((a, b) => a[0].localeCompare(b[0], undefined, {numeric: true})).map(([k, ps]) => `<Folder><name>${x(k)}</name>${ps.join("")}</Folder>`), "</Document></kml>"].join("\n");
  }

  /* ---------- Seen on site: which towers a run's serving readings came from ---------- */
  // Plan 11/10 section 8: a reading served by eNB X marks tower X "Seen on site", matched on carrier + technology + site ID, and
  // three or more moments of it make the tower "verified on site". One pass over the run (seenIndex) keeps each cell heard as a
  // serving cell; seenOf asks it for a tower's carrier entries (towerfuse.py: {carrier, sites: [{radio, site_id, site_kind}]}).
  // - LTE: the reading's site (its eNB: ECI >> 8), a primary or a carrier-aggregation leg (a leg's ECI names its own eNB).
  // - 5G NR: a primary only. Its site, when the source named the gNB, or its NCI cut where the tower's site was (towerfuse.py:
  //   24 bits unless the site says "gNB (N-bit split)"). An NSA leg never matches a gNB: Android gives it no cell of its own.
  // - FirstNet is AT&T's (Band 14 on AT&T's towers, as the tower report shows it).
  // - Where the reading's network code and the site's are both known they must agree (FirstNet's 313-100 counts for AT&T's
  //   sites), and an ex-Sprint site is never matched: Sprint's LTE has been off since 6/2022, so a live T-Mobile eNB with the
  //   same number was a collision, not that tower (review 11/12).
  // - A carrier the run never measured (no serving reading of it anywhere) is "not measured by this run", never "not seen"; a
  //   carrier on a tower with no LTE or NR site ID (a licence, old 3G cells) can't be matched and says so (review 11/12).
  // o.site: the report's site [lat, lon]; o.near: metres from it for "Best RSRP here" (100)
  const carrierFold = c => c === "FirstNet" ? "AT&T" : c;
  const gnbBits = kind => { const m = /(\d+)-bit/.exec(String(kind || "")); return m ? +m[1] : 24; };
  function seenIndex(readings, o = {}){
    const cells = new Map(), measured = new Set(), near = o.near ?? 100, site = o.site || null, cosL = site ? cos(site[0] * RAD) : 1;
    const metres = r => site ? Math.hypot((r.lat - site[0]) * M_PER_DEG, (r.lon - site[1]) * M_PER_DEG * cosL) : INF;
    for (const r of readings || []) {
      if (!r || !(r.serving >= 1) || r.rsrp == null) continue;
      measured.add(carrierFold(r.carrier));
      const nr = r.tech === "NR";
      if (nr ? r.serving !== 1 || (r.site == null && r.cid == null) : r.tech !== "LTE" || r.site == null) continue;
      const c = carrierFold(r.carrier), k = `${c}|${r.tech}|${r.site != null ? "s" + r.site : "c" + r.cid}`;
      let a = cells.get(k);
      if (!a) { a = {carrier: c, tech: r.tech, site: r.site, cid: r.cid, ts: new Set(), rs: 0, plmns: new Set(), first: r.ts, last: r.ts, best: null, near: null, bands: new Set(), pcis: new Set()}; cells.set(k, a); }
      a.ts.add(r.ts); a.rs++; if (r.plmn) a.plmns.add(r.plmn); if (r.ts < a.first) a.first = r.ts; if (r.ts > a.last) a.last = r.ts;
      if (r.band != null) a.bands.add(String(r.band)); if (r.pci != null) a.pcis.add(r.pci);
      if (!a.best || r.rsrp > a.best.rsrp) a.best = {rsrp: r.rsrp, band: r.band, ts: r.ts};
      if (site && (!a.near || r.rsrp > a.near.rsrp)) { const m = metres(r); if (m <= near) a.near = {rsrp: r.rsrp, band: r.band, m: Math.round(m)}; }
    }
    return {cells, near, measured};
  }
  // a tower's carrier entries -> [{carrier, state ("verified", "seen", "not seen", "not measured": the run never measured the
  // carrier, "no id": no LTE or NR site to match), sites (matched, as "eNB 812442"), n (moments), readings, verified, first,
  // last, best, near, bands, pcis, ids (the sites it could match)}], one per carrier on the tower
  function seenOf(index, entries){
    const out = [];
    const plmnOk = (a, s, c) => { const sp = Array.isArray(s.plmns) ? s.plmns : []; if (!sp.length || !a.plmns.size) return true;
      for (const p of a.plmns) if (sp.includes(p) || (p === "313-100" && c === "AT&T")) return true; return false; };
    for (const e of entries || []) {
      const c = carrierFold(e.carrier), hit = [], got = {ts: new Set(), rs: 0, first: INF, last: -INF, best: null, near: null, bands: new Set(), pcis: new Set()};
      let ids = 0;
      for (const s of e.sites || []) {
        const tech = s.radio === "NR" ? "NR" : s.radio === "LTE" ? "LTE" : null, id = +s.site_id; if (!tech || !isFinite(id) || s.ex_sprint) continue;
        ids++;
        const bits = gnbBits(s.site_kind), cut = 2 ** (36 - bits);
        for (const a of index.cells.values()) {
          if (a.carrier !== c || a.tech !== tech || !plmnOk(a, s, c)) continue;
          if (!(a.site === id || (tech === "NR" && a.site == null && a.cid != null && floor(a.cid / cut) === id))) continue;
          const name = `${s.site_kind || (tech === "NR" ? "gNB" : "eNB")} ${s.site_id}`; if (!hit.includes(name)) hit.push(name);
          for (const t of a.ts) got.ts.add(t); got.rs += a.rs; got.first = min(got.first, a.first); got.last = max(got.last, a.last);
          if (a.best && (!got.best || a.best.rsrp > got.best.rsrp)) got.best = a.best;
          if (a.near && (!got.near || a.near.rsrp > got.near.rsrp)) got.near = a.near;
          for (const b of a.bands) got.bands.add(b); for (const p of a.pcis) got.pcis.add(p);
        }
      }
      const n = got.ts.size, byNum = (a, b) => String(a).localeCompare(String(b), undefined, {numeric: true});
      const state = n >= 3 ? "verified" : n ? "seen" : !(index.measured || new Set()).has(c) ? "not measured" : !ids ? "no id" : "not seen";
      out.push({carrier: e.carrier, state, sites: hit, n, readings: got.rs, ids, verified: n >= 3, first: n ? got.first : null, last: n ? got.last : null, best: got.best, near: got.near,
        bands: [...got.bands].sort(byNum), pcis: [...got.pcis].sort(up)});
    }
    return out;
  }

  /* ---------- the sample survey: made up, for a demo on any copy ---------- */
  // Cody 11/12: a small realistic sample, clearly named, that loads on any copy and is never mixed with real runs: the page keeps
  // it (nothing is stored), it's drawn where the map is (the map doesn't move for it), and its sites are numbered past the
  // 20-bit eNB range, so no real tower is ever "seen" by it. A scanner's drive at walking pace round a block, 900 by 700 m with
  // a street across the middle, a reading a second: AT&T, Verizon and T-Mobile, two made-up sites each, a low band, a mid band
  // and C-band (T-Mobile: 2.5 GHz), signal falling with distance and shadowed by made-up buildings, and an underpass where
  // Verizon drops out. The same readings every time for the same point.
  const SAMPLE_NAME = "Sample survey (not a real site)";
  const SAMPLE_NETS = [
    {carrier: "AT&T", plmn: "310-410", sites: [[-1100, 650], [1500, -900]], cells: [["LTE", "14", 5330, 0], ["LTE", "66", 66986, -5], ["NR", "n77", 650000, -13]]},
    {carrier: "Verizon", plmn: "311-480", sites: [[900, 1200], [-1400, -1000]], cells: [["LTE", "13", 5230, -1], ["LTE", "66", 67086, -6], ["NR", "n77", 653333, -12]]},
    {carrier: "T-Mobile", plmn: "310-260", sites: [[-300, -1500], [1700, 800]], cells: [["LTE", "71", 68661, 1], ["LTE", "2", 900, -6], ["NR", "n41", 520110, -9]]}];
  function sample(lat, lon){
    let seed = 20261112; const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    // smooth made-up shadowing: a few bumps of buildings and trees, fixed by the seed, up to about 9 dB either way
    const bumps = Array.from({length: 26}, () => [(rnd() - 0.5) * 1400, (rnd() - 0.5) * 1100, 60 + rnd() * 140, (rnd() - 0.5) * 18]);
    const shade = (x, y) => bumps.reduce((s, [bx, by, r, d]) => s + d * Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (2 * r * r)), 0);
    const kx = M_PER_DEG * cos(lat * RAD), ky = M_PER_DEG, T0 = Date.UTC(2026, 10, 10, 15, 0, 0);
    // the block at 6 m/s, then away east at 22 m/s (a reading every 22 m: its squares rest on one or two moments, so they're faint)
    const legs = [[-450, -350, 6], [450, -350, 6], [450, 350, 6], [-450, 350, 6], [-450, 0, 6], [450, 0, 6], [1100, 0, 22]], path = [];
    for (let i = 1; i < legs.length; i++) { const [x0, y0] = legs[i - 1], [x1, y1, v] = legs[i], n = Math.round(Math.hypot(x1 - x0, y1 - y0) / v);
      for (let k = 0; k < n; k++) path.push([x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n]); }
    const out = [];
    path.forEach(([x, y], i) => {
      const ts = T0 + i * 1000, gx = x + (rnd() - 0.5) * 4, gy = y + (rnd() - 0.5) * 4, at = {ts, lat: +(lat + gy / ky).toFixed(7), lon: +(lon + gx / kx).toFixed(7), acc: 4 + Math.round(rnd() * 6), speed: x > 450 && y === 0 ? 22 : 6};
      const under = Math.hypot(x - 450, y - 150) < 70;  // the underpass, on the east street
      SAMPLE_NETS.forEach((net, ni) => {
        const ds = net.sites.map(([sx, sy]) => max(60, Math.hypot(x - sx, y - sy)));
        const lv = ds.map((d, si) => 25 - 35 * Math.log10(d) + shade(x + si * 90, y - ni * 70) - (under && net.carrier === "Verizon" ? 24 : 0));
        const best = lv[0] >= lv[1] ? 0 : 1, other = 1 - best, site = 2 ** 20 + 100 * (ni + 1) + best;
        net.cells.forEach(([tech, band, chan, off], ci) => {
          // C-band and 2.5 GHz fall off faster with distance than the low band
          const v = Math.round((lv[best] + off - (tech === "NR" ? 9 * Math.log10(ds[best] / 600) : 0) + (rnd() - 0.5) * 4) * 10) / 10, gap = lv[best] - lv[other];
          if (v < -140) return;
          out.push({...at, plmn: net.plmn, carrier: net.carrier, tech, band, chan, pci: 3 * (ni * 40 + best * 7 + ci) + 1, tac: 4000 + ni,
            site: tech === "LTE" ? site : null, serving: ci === 0 ? 1 : 2, rsrp: v, rsrq: Math.round(max(-20, min(-4, -7 - 6 / (1 + Math.exp(gap / 4)) - (v < -110 ? 4 : 0))) * 10) / 10,
            sinr: Math.round(max(-6, min(30, gap * 0.9 + (v + 120) * 0.08 + (rnd() - 0.5) * 3)) * 10) / 10, ta: null});
        });
        // the other site's low band, as a neighbour
        out.push({...at, plmn: net.plmn, carrier: net.carrier, tech: "LTE", band: net.cells[0][1], chan: net.cells[0][2], pci: 3 * (ni * 40 + other * 7) + 1, tac: 4000 + ni,
          site: 2 ** 20 + 100 * (ni + 1) + other, serving: 0, rsrp: Math.round((lv[other] + (rnd() - 0.5) * 4) * 10) / 10, rsrq: null, sinr: null, ta: null});
      });
    });
    const readings = out.map(clean).filter(Boolean);
    return {run: {id: "sample", sample: true, name: SAMPLE_NAME, source: "scanner", device: "Made-up sample (no instrument)", calibrated: false, readings: readings.length,
      started_at: readings[0]?.ts ?? null, ended_at: readings[readings.length - 1]?.ts ?? null, created_by: "DAStastic (a made-up sample)"}, readings};
  }

  window.RFSurvey = Object.freeze({COLS, CSV_COLUMNS, MAX_ACC_M, UNKNOWN, SAMPLE_NAME, SAMPLE_MARK, clean, coord, bandOf, fromSnapshot, fromRows, tileSize, tileOf, tileKey, median, layerOf, serverOf,
    aggregate, heard, detail, servers, colours, look, csv, kml, seenIndex, seenOf, sample});
})();
