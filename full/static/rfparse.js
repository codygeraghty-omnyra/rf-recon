"use strict";
/* DAStastic — what the frequency box reads. 852.3625 typed in From alone returned 806 rows starting at 10,935 MHz, and 806-824 on
   the default returned nothing because uplinks sit on mobile rows (filter research, 11/5). One box now takes what an RF person
   types: 852.3625 (that channel), 851-869, 851 to 869, 852.3625 ±12.5k, 2.4G, B13, n77, VHF, NPSPAC, or a pasted list of any of
   them. "up", "down" or "both" picks a paired band's side. A land mobile uplink also brings its paired downlink, because that's
   the side the licence's base rows sit on. Pure functions: tests/rfparse_check.mjs runs them in node. */
const RF_CHANNEL = 0.00625;  // a single number is that channel: half a 12.5 kHz step either side

// land mobile, as [key words, label, down, up]; the spans read the way uls_import.BANDS draws the Band filter
const RF_BANDS_LMR = [
  [["vhf-low", "vhflow"], "VHF Low", [30, 50], null],
  [["vhf", "vhf-high", "vhfhigh"], "VHF High", [137, 174], null],
  [["220", "220mhz"], "220 MHz", [216, 225], null],
  [["uhf"], "UHF", [400, 470], null],
  [["t-band", "tband"], "T-band", [470, 512], null],
  [["700ps", "700-ps"], "700 PS", [769, 775], [799, 805]],
  [["800mhz", "800-ps"], "800", [851, 869], [806, 824]],
  [["npspac"], "NPSPAC", [866, 869], [821, 824]],
  [["900mhz"], "900", [935, 940], [896, 901]],
  [["firstnet", "b14", "n14"], "FirstNet B14", [758, 768], [788, 798]]];

// the cellular bands the job's carrier panel already knows (DAS_LTE_BANDS in dascell.js), in the same shape
function rfCellBands(lte) {
  return (lte || []).filter(b => b.id !== "14").map(b => {
    const n = /^n/.test(b.id) ? b.id : null;
    return [n ? [n, "n77"] : [`b${b.id}`, `n${b.id}`], b.label, b.dl, b.ul && b.ul[0] !== b.dl[0] ? b.ul : null, true];
  });
}

function rfNumber(s) {
  const m = /^(\d*\.?\d+)\s*(k|m|g)?(?:hz)?$/i.exec(s);
  if (!m) return null;
  return parseFloat(m[1]) * ({k: 1e-3, m: 1, g: 1e3}[(m[2] || "m").toLowerCase()]);
}
const rfRound = x => Math.round(x * 1e6) / 1e6;

// {ranges: [[lo, hi], ...], paired: [true when a downlink was added for an uplink], bad: [what didn't read]}
function parseRF(text, bands) {
  const out = {ranges: [], paired: false, bad: []};
  let dir = "down";
  const clean = String(text || "").toLowerCase().replace(/\+\/-/g, "±").replace(/\bto\b/g, "-").replace(/\s*±\s*/g, "±").replace(/\s+-\s+/g, "-");
  const toks = clean.split(/[\s,;]+/).filter(Boolean);
  for (const t of toks) if (/^(up|ul|uplink)$/.test(t)) dir = "up"; else if (/^(down|dl|downlink)$/.test(t)) dir = "down"; else if (t === "both") dir = "both";
  const add = (lo, hi) => out.ranges.push([rfRound(Math.min(lo, hi)), rfRound(Math.max(lo, hi))]);
  for (const t of toks) {
    if (/^(up|ul|uplink|down|dl|downlink|both)$/.test(t)) continue;
    const hit = bands.filter(b => b[0].includes(t));
    if (hit.length) {
      for (const [, , dl, ul] of hit) {
        if (dir !== "up" || !ul) add(dl[0], dl[1]);
        if (ul && dir !== "down") add(ul[0], ul[1]);
      }
      continue;
    }
    let m = /^([^±]+)±(.+)$/.exec(t), a, b;
    if (m) { a = rfNumber(m[1]); b = rfNumber(m[2]); if (a === null || b === null) { out.bad.push(t); continue; } add(a - b, a + b); }
    else if ((m = /^([^-]+)-(.+)$/.exec(t))) { a = rfNumber(m[1]); b = rfNumber(m[2]); if (a === null || b === null) { out.bad.push(t); continue; } add(a, b); }
    else { a = rfNumber(t); if (a === null) { out.bad.push(t); continue; } add(a - RF_CHANNEL, a + RF_CHANNEL); }
    // a typed land mobile uplink: the base rows are on its paired downlink
    const [lo, hi] = out.ranges[out.ranges.length - 1], pair = bands.find(x => !x[4] && x[3] && lo >= x[3][0] && hi <= x[3][1]);
    if (pair) { add(lo + pair[2][0] - pair[3][0], hi + pair[2][0] - pair[3][0]); out.paired = true; }
  }
  return out;
}

if (typeof module !== "undefined") module.exports = {parseRF, rfCellBands, RF_BANDS_LMR, RF_CHANNEL};
