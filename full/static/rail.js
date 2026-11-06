"use strict";
/* RF Recon — the filter rail. Cody 11/4: "study how the filter tabs should be - sdr sharp, etc and copy their layouts",
   then "best one wins". SDR#, SDR++, GQRX, SDRangel, SDR Console, the scanner programs, ATAK, QGIS, Google Earth and WiGLE
   were studied; the docked layer rail won (SDR++'s menu, SDR#'s side panels, QGIS's and Google Earth's layer trees), as a
   bottom sheet on a phone (ATAK upright). RF Recon's own glass, skins and colours; the layout is borrowed.
   - 1,100 px and up: a 288 px rail left of the tab's content, sticky under the tab bar with its own scroll. ‹ or L folds it
     to a 44 px strip with an "n on" badge (remembered as rfr.railFolded, which replaces rfr.filtersFolded). Until someone
     chooses, it starts open from 1,600 px and folded below.
     700-1,099 px: the strip; a click (never a hover) opens the rail over the content. Under 700 px: a bar under the tab
     bar opens a bottom sheet at 60% height (drag it to 92%); "Show N items" closes it.
   - Only on the tabs whose view takes the filtered rows (S.views[tab] is fn(v, rows)); elsewhere the content gets the width.
   - On top: the count, Export (CSV, KML, ATAK package, Prep sheet), Push to ATAK, Clear (n), a pill per change from the
     defaults, and a box that finds a filter by name.
   - A switch on top sets the order and one group's ticks: Everything (Sources first), Public safety (Band first, its
     agencies picked), Cellular (Carrier first, the rows that name a carrier picked). It adds a filter; nothing is removed.
   - Sections, each folding (remembered in rfr.railOpen, per side): Sources in three groups (licensed and registered, crowd and
     networks, mine; the empty ones folded into "+ n with nothing here"), then Signal type, Band, Carrier, Category, Station type.
     A head has a summary and an all / none box. A row: its box (the map colour, ticked when on), label, count and "only"
     (again: back to before). Every group is "all on, untick to hide"; "only" is the other state (core.js passes()).
     Rows keep their order for a search and their count when off.
   - Keys (RFKeys scope "filters"): L the rail, / the filter box, ↑ ↓ rows, Space on / off, O only, A all on in the
     section, ← → fold / open, Esc leave. N, ?, F1 and Ctrl+K stay theirs. */
(() => {
const el = document.getElementById("filters"), body = document.getElementById("railBody"), panel = document.getElementById("railPanel");
const q = document.getElementById("railQ"), menu = document.getElementById("railMenu"), menuBtn = document.getElementById("railExportBtn");
const ORDER = ["type", "band", "cat", "cls", "carrier", "agency"];
const TITLE = {src: "Sources", type: "Signal type", band: "Band", cat: "Category", cls: "Station type", carrier: "Carrier", agency: "Agency / licensee"};
const PILL = {src: "Sources", type: "Signal", band: "Band", cat: "Category", cls: "Station type", carrier: "Carrier", agency: "Agency"};
const BODY_ID = {type: "fType", band: "fBand", cat: "fCat", cls: "fClass", carrier: "fCarrier", agency: "fAgency"};  // the old chip lists' ids, kept on their sections
const OPEN0 = {src: true, type: true, band: true, cat: false, cls: false, carrier: false, agency: false};
const AGENCY_ROWS = 40;  // the most frequencies first; the filter box finds the rest (a 15 mi search has 606 names)
// the switch at the top (Cody 11/5): it sets the order and one group's ticks, and hides nothing that can't be ticked back
const SAFETY = ["Public Safety (Gov)", "Public Safety (Other)", "Law Enforcement", "Fire / EMS", "Emergency Mgmt / 911", "911 call centre (PSAP)"];
const SIDES = {
  all: {label: "Everything", order: ["src", "type", "band", "carrier", "agency", "cat", "cls"], open: OPEN0},
  ps: {label: "Public safety", order: ["band", "type", "agency", "cat", "cls", "carrier", "src"], open: {band: true, type: true, agency: true}, owns: "cat"},
  cell: {label: "Cellular", order: ["carrier", "band", "type", "cls", "agency", "cat", "src"], open: {carrier: true, band: true}, owns: "carrier"}};
const NO_CARRIER = "No carrier", NO_AGENCY = "No agency";
const lastWords = new Set([NO_CARRIER, NO_AGENCY]);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; /* storage blocked (a private window): the default */ } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked (a private window): not remembered, nothing else lost */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage blocked: nothing kept to remove */ } }};
const RAIL_OPEN_FROM = 1600;  // under this the rail starts folded: it takes 23% of a laptop's map (Cody 11/5). A choice made is kept.
let openState = {};
try { openState = JSON.parse(store.get("rfr.railOpen") || "{}") || {}; } catch (e) { openState = {}; /* an unreadable saved state: the defaults */ }
const zeroOpen = {};  // the "+ n with nothing here" folds opened this visit
let navKey = null;    // the row or head the keyboard is on, kept across redraws
S.railSolo = S.railSolo || {};
S.railQ = "";

const mqPhone = matchMedia("(max-width:699px)"), mqMid = matchMedia("(min-width:700px) and (max-width:1099px)");
const mode = () => mqPhone.matches ? "phone" : mqMid.matches ? "mid" : "desk";
const viewTakesRows = t => (S.views[t]?.length || 0) >= 2;
const avail = () => viewTakesRows(S.tab);
const fmt = n => Number(n || 0).toLocaleString();
const plural = (n, w) => `${fmt(n)} ${w}${n === 1 ? "" : "s"}`;
const typeColour = t => S.lib[t]?.color || (t === "Tower / structure" ? "#57606a" : "#8c959f");
const tickInk = hex => { const m = /^#([\da-f]{6})$/i.exec(hex || ""); if (!m) return "#fff";
  const n = parseInt(m[1], 16); return 0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255) > 165 ? "#111" : "#fff"; };
const shortLabel = l => LAYERS[l].label.replace(/\s*\(.*\)\s*$/, "");

/* ---------- what's listed ---------- */
// the three source groups, with only what this build allows (the sold build leaves out WiGLE, RepeaterBook and WSPR)
function groups() {
  const out = S.build?.left_out || {}, known = new Set(SOURCE_GROUPS.flatMap(g => g[2]));
  const gs = SOURCE_GROUPS.map(([id, label, ls]) => [id, label, ls.filter(l => LAYERS[l] && !out[l])]);
  for (const l of Object.keys(LAYERS)) if (!known.has(l) && !out[l]) gs[1][2].push(l);  // a source added later: with the crowd ones
  return gs;
}
const sources = () => groups().flatMap(g => g[2]);
const srcScope = id => id === "src" ? sources() : (groups().find(g => "src." + g[0] === id) || [0, 0, []])[2];
// a group's values: every value in this search, most first, in an order kept until the next search (never per click);
// then what "only" or "hidden" still names from an earlier one, so it can be switched back
let ord = {rows: null};
function values(k) {
  if (ord.rows !== S.rows) { ord = {rows: S.rows};
    for (const g of ORDER) { const m = new Map(); for (const r of S.rows) { const v = FACETS[g](r); m.set(v, (m.get(v) || 0) + 1); }
      ord[g] = [...m].sort((a, b) => lastWords.has(a[0]) - lastWords.has(b[0]) || b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(x => x[0]); }
    ord.name = new Map(); for (const r of S.rows) if (r.licensee && !ord.name.has(agencyOf(r))) ord.name.set(agencyOf(r), r.licensee); }
  const vals = ord[k].slice();
  for (const v of [...S.chips[k], ...S.hide[k]]) if (!vals.includes(v)) vals.push(v);
  return vals;
}

/* ---------- the state: on, off, only, all / none ---------- */
const valOn = (k, v) => S.chips[k].size ? S.chips[k].has(v) : !S.hide[k].has(v);
function valToggle(k, v) {
  const only = S.chips[k];
  if (only.size) {
    if (only.has(v)) { only.delete(v); if (!only.size) S.hide[k] = new Set(values(k)); }  // the last one off: none on
    else only.add(v);
    if (only.size && values(k).every(x => only.has(x))) { only.clear(); S.hide[k].clear(); }  // every one on: all on
  } else if (S.hide[k].has(v)) S.hide[k].delete(v); else S.hide[k].add(v);
  delete S.railSolo[k];
}
// only this one; the same again puts back what was on before (a scanner's Hold)
function valOnly(k, v) {
  const solo = S.railSolo[k], only = S.chips[k];
  if (solo && solo.v === v && only.size === 1 && only.has(v)) { S.chips[k] = new Set(solo.only); S.hide[k] = new Set(solo.hide); delete S.railSolo[k]; return; }
  if (!solo && only.size === 1 && only.has(v)) { only.clear(); S.hide[k].clear(); return; }  // already the only one: all on
  const prev = solo || {only: [...only], hide: [...S.hide[k]]};
  S.chips[k] = new Set([v]); S.hide[k] = new Set(); S.railSolo[k] = {v, only: prev.only, hide: prev.hide};
}
function srcToggle(l) { if (S.layerOn.has(l)) S.layerOn.delete(l); else S.layerOn.add(l); S.layerSolo = S.layerPrev = null; }
// the same solo the Dashboard's Sources bars use (views.js), so either one puts the other's back
function srcOnly(l) {
  if (S.layerSolo === l && S.layerPrev) { S.layerOn = new Set(S.layerPrev); S.layerSolo = S.layerPrev = null; return; }
  if (!S.layerSolo) { if (S.layerOn.size === 1 && S.layerOn.has(l)) { S.layerOn = layerDefaults(); return; } S.layerPrev = new Set(S.layerOn); }
  S.layerOn = new Set([l]); S.layerSolo = l;
}
const isSrc = id => id === "src" || id.startsWith("src.");
function counted(id) {
  if (isSrc(id)) { const ls = srcScope(id); return [ls.filter(l => S.layerOn.has(l)).length, ls.length]; }
  const vals = values(id); return [vals.filter(v => valOn(id, v)).length, vals.length];
}
const tri = ([on, n]) => n && on === n ? "true" : on ? "mixed" : "false";
// the head's box: everything on, a press turns it all off; otherwise a press turns it all on
function allNone(id) {
  const [on, n] = counted(id), full = n > 0 && on === n;
  if (isSrc(id)) { for (const l of srcScope(id)) if (full) S.layerOn.delete(l); else S.layerOn.add(l); S.layerSolo = S.layerPrev = null; }
  else { S.chips[id] = new Set(); S.hide[id] = full ? new Set(values(id)) : new Set(); delete S.railSolo[id]; }
}
function allOn(id) {
  if (isSrc(id)) { for (const l of srcScope(id)) S.layerOn.add(l); S.layerSolo = S.layerPrev = null; }
  else { S.chips[id] = new Set(); S.hide[id] = new Set(); delete S.railSolo[id]; }
}
// a pill per change from the defaults; ✕ (the pill) puts that group back
function pills() {
  const out = [], ls = sources();
  const off = ls.filter(l => S.layerDef.has(l) && !S.layerOn.has(l)), on = ls.filter(l => !S.layerDef.has(l) && S.layerOn.has(l));
  if (off.length || on.length) {
    const t = S.layerSolo && S.layerOn.size === 1 && LAYERS[S.layerSolo] ? `only ${shortLabel(S.layerSolo)}`
      : [off.length === 1 ? `${shortLabel(off[0])} off` : off.length ? `${off.length} off` : "", on.length === 1 ? `${shortLabel(on[0])} on` : on.length ? `${on.length} on` : ""].filter(Boolean).join(", ");
    out.push(["src", `Sources: ${t}`]);
  }
  for (const k of ORDER) {
    const only = S.chips[k], hide = S.hide[k]; if (!only.size && !hide.size) continue;
    if (SIDES[S.side].owns === k) { out.push([k, SIDES[S.side].label]); continue; }
    const vals = values(k);
    const t = only.size ? (only.size === 1 ? `only ${[...only][0]}` : `only ${only.size}`)
      : vals.every(v => hide.has(v)) ? "none" : hide.size === 1 ? `${[...hide][0]} hidden` : `${hide.size} hidden`;
    out.push([k, `${PILL[k]}: ${t}`]);
  }
  const ex = (S.filterExpr || "").trim();
  if (ex) out.push(["expr", `Analyzer: ${ex.length > 28 ? ex.slice(0, 27) + "…" : ex}`]);
  return out;
}
window.railSetSide = id => setSide(id);
function setSide(id) {
  const was = SIDES[S.side].owns;
  if (was) { S.chips[was] = new Set(); S.hide[was] = new Set(); delete S.railSolo[was]; }
  S.side = id;
  if (id === "ps") setOnly("cat", SAFETY);
  if (id === "cell") { S.hide.carrier = new Set([NO_CARRIER]);
    for (const l of ["towers", "opencellid"]) if (LAYERS[l] && !S.build?.left_out?.[l]) S.layerOn.add(l); }
}
function clearPill(id) {
  if (SIDES[S.side].owns === id) S.side = "all";
  if (id === "src") { S.layerOn = layerDefaults(); S.layerSolo = S.layerPrev = null; }
  else if (id === "expr") S.filterExpr = "";
  else { S.chips[id] = new Set(); S.hide[id] = new Set(); delete S.railSolo[id]; }
}
window.railPills = pills;  // the sweep reads the changes the way the rail shows them

/* ---------- drawing ---------- */
// each side remembers its own folds; Everything keeps the keys it always had
const sideKey = id => S.side === "all" ? id : `${S.side}:${id}`;
const isOpen = (id, dflt) => sideKey(id) in openState ? !!openState[sideKey(id)] : dflt;
function setOpen(id, v) { openState[sideKey(id)] = v ? 1 : 0; store.set("rfr.railOpen", JSON.stringify(openState)); }
function head(id, title, sum, sumOn, state, cls, open) {
  return `<div class="${cls}"><button class="rchev" tabindex="-1" data-fold="${id}" aria-expanded="${open}">${esc(title)}</button>`
    + `<span class="rsum${sumOn ? " on" : ""}">${esc(sum)}</span>`
    + `<span class="rbox" role="checkbox" aria-checked="${state}" tabindex="-1" data-nav data-nk="h:${id}" data-all="${id}" aria-label="${esc(title)}: ${state === "true" ? "all on (press for none)" : "press for all on"}"></span></div>`;
}
function row(g, v, label, n, on, colour, solo) {
  return `<div class="rrow${on ? "" : " off"}${solo ? " solo" : ""}" data-g="${g}" data-v="${esc(v)}">`
    + `<span class="rbox" role="checkbox" aria-checked="${on}" tabindex="-1" data-nav data-nk="${esc(`r:${g}:${v}`)}" aria-label="${esc(label)}"${colour ? ` style="--c:${colour};--tk:${tickInk(colour)}"` : ""}></span>`
    + `<span class="rlab">${esc(label)}</span><span class="rnum">${fmt(n)}</span>`
    + `<button class="ronly" tabindex="-1" aria-label="Only ${esc(label)}${solo ? ": press again to put the rest back" : ""}"><span>only</span></button></div>`;
}
function bodyHtml() {
  const qq = (S.railQ || "").trim().toLowerCase(), hit = s => !qq || String(s).toLowerCase().includes(qq);
  const lc = new Map(); for (const r of S.rows) lc.set(r.layer, (lc.get(r.layer) || 0) + 1);
  const gs = groups(), ls = gs.flatMap(g => g[2]);
  const matchWord = n => n === 1 ? "1 match" : `${fmt(n)} matches`;
  // Sources
  const srcHits = ls.filter(l => hit(LAYERS[l].label)).length, offN = ls.filter(l => !S.layerOn.has(l)).length;
  const srcOpen = qq ? srcHits > 0 : isOpen("src", !!SIDES[S.side].open.src), secs = {};
  let h = `<section class="rsec" data-sec="src" aria-label="Sources">`
    + head("src", TITLE.src, qq ? matchWord(srcHits) : offN ? `${offN} off` : fmt(ls.length), !qq && offN > 0, tri(counted("src")), "rsec-h", srcOpen)
    + `<div class="rsec-b" id="fLayer" data-body${srcOpen ? "" : " hidden"}>`;
  for (const [gid, label, gl] of gs) {
    if (!gl.length) continue;
    const id = "src." + gid, items = gl.reduce((a, l) => a + (lc.get(l) || 0), 0), ghit = gl.filter(l => hit(LAYERS[l].label));
    if (qq && !ghit.length) continue;
    const open = qq ? true : isOpen(id, gid === "licensed" || items > 0);
    h += `<div class="rsub" data-sub="${gid}" role="group" aria-label="${esc(label)}">`
      + head(id, label, fmt(items), false, tri(counted(id)), "rsub-h", open) + `<div class="rsub-b" data-body${open ? "" : " hidden"}>`;
    const live = ghit.filter(l => lc.get(l) > 0), zero = ghit.filter(l => !(lc.get(l) > 0)), zo = !!qq || !!zeroOpen[gid];
    for (const l of live) h += row("src", l, LAYERS[l].label, lc.get(l), S.layerOn.has(l), LAYERS[l].color, S.layerSolo === l);
    if (zero.length && zo) for (const l of zero) h += row("src", l, LAYERS[l].label, 0, S.layerOn.has(l), LAYERS[l].color, S.layerSolo === l);
    if (zero.length && !qq) h += `<button class="rzero" tabindex="-1" data-nav data-nk="z:${gid}" data-zero="${gid}" aria-expanded="${zo}">${zo ? `− Fold the ${zero.length} with nothing here` : `+ ${zero.length} with nothing here`}</button>`;
    h += `</div></div>`;
  }
  h += `</div></section>`;
  secs.src = h;
  // Signal type, Band, Category, Station type, Carrier
  for (const k of ORDER) {
    h = "";
    const vals = values(k), counts = new Map();
    for (const r of S.rows) if (passes(r, k)) { const v = FACETS[k](r); counts.set(v, (counts.get(v) || 0) + 1); }
    const shown = vals.filter(v => hit(v)), only = S.chips[k], hidden = vals.filter(v => S.hide[k].has(v)).length;
    const sum = qq ? matchWord(shown.length) : only.size ? `only ${vals.filter(v => only.has(v)).length}/${vals.length}`
      : hidden ? (hidden === vals.length ? "none" : `${hidden} hidden`) : fmt(vals.length);
    if (qq && !shown.length) { secs[k] = `<section class="rsec" data-sec="${k}" aria-label="${TITLE[k]}">` + head(k, TITLE[k], sum, false, tri(counted(k)), "rsec-h", false)
      + `<div class="rsec-b" id="${BODY_ID[k]}" data-body hidden></div></section>`; continue; }
    const open = qq ? true : isOpen(k, !!SIDES[S.side].open[k]);
    h += `<section class="rsec" data-sec="${k}" aria-label="${TITLE[k]}">` + head(k, TITLE[k], sum, !qq && facetChanged(k), tri(counted(k)), "rsec-h", open)
      + `<div class="rsec-b" id="${BODY_ID[k]}" data-body${open ? "" : " hidden"}>`;
    if (!vals.length) h += `<div class="rnone">${S.rows.length ? "None in this search." : "Search an area: what it finds is listed here."}</div>`;
    else if (k === "carrier") h += `<div class="rnone">Read from a tower's owner, a licensee or a cell ID. A tower's owner isn't who's on it.</div>`;
    // agencies with rows under the other filters first: a cap of zeros would hide the names that matter. Its own ticks don't
    // count (passes skips this group), so a click doesn't move the rows.
    if (k === "agency") shown.sort((a, b) => lastWords.has(a) - lastWords.has(b) || (counts.get(b) || 0) - (counts.get(a) || 0));
    const cap = k === "agency" && !qq ? AGENCY_ROWS : Infinity;
    for (const v of shown.slice(0, cap)) h += row(k, v, k === "agency" ? ord.name.get(v) || v : v, counts.get(v) || 0, valOn(k, v), k === "type" ? typeColour(v) : null, S.railSolo[k]?.v === v && only.size === 1);
    if (shown.length > cap) h += `<div class="rnone">${fmt(shown.length - cap)} more. Press / and type a name to find one.</div>`;
    h += `</div></section>`;
    secs[k] = h;
  }
  return SIDES[S.side].order.map(k => secs[k]).join("");
}
function drawBody() {
  const a = document.activeElement, had = body.contains(a) ? a.dataset.nk : null, top = body.scrollTop;
  body.innerHTML = bodyHtml();
  body.scrollTop = top;
  const key = had || navKey, t = (key && body.querySelector(`[data-nk="${CSS.escape(key)}"]`)) || body.querySelector("[data-nav]");
  if (t) { t.tabIndex = 0; if (had) t.focus({preventScroll: true}); }
}
let last = 0;
const WHY_NAME = {psap: ["911 centre", "911 centres"]};
const whyName = (l, n) => WHY_NAME[l]?.[n === 1 ? 0 : 1] || (/s$/.test(shortLabel(l)) ? shortLabel(l) : `${shortLabel(l)} row${n === 1 ? "" : "s"}`);
// a frequency filter leaves off rows with no frequency: say how many, and offer them back. An empty search says why.
function why() {
  const lo = $("#fmin").value, hi = $("#fmax").value, typed = $("#rf").value.trim();
  const range = typed ? (/[a-z]/i.test(typed) ? typed : `${typed} MHz`) : lo && hi ? `${lo}-${hi} MHz` : lo ? `from ${lo} MHz` : hi ? `up to ${hi} MHz` : "";
  const aside = Object.entries(S.setAside || {}), nofreq = aside.map(([l, n]) => `${fmt(n)} ${whyName(l, n)}`).join(", ");
  const parts = [];
  if (range && !S.rows.length && S.center) parts.push(`No rows in ${range} here. Cellular is licensed by market, not by site: open a job's Cellular panel to see who holds it.`);
  if (S.side === "cell" && S.searched && !S.rows.some(r => r.carrier && S.layerOn.has(r.layer))) parts.push("No row here names a carrier. Cellular blocks are licensed by market: the Cell sites tab can fetch this area's sites, and a job's Cellular panel shows who holds what.");
  if (S.rfPaired) parts.push(`That's an uplink: its paired downlink, ${S.rfPaired} MHz, is in the search too.`);
  if (aside.length) parts.push(`Left off: ${nofreq}. They list no frequency.`);
  return parts.join(" ");
}
window.railWhy = why;
function drawWhy() {
  const b = document.getElementById("railWhy"), t = why(), keep = !!S.keepNoFreq && !!($("#fmin").value || $("#fmax").value || S.franges);
  b.hidden = !t && !keep;
  b.innerHTML = esc(t || "Rows with no frequency are showing.") + (Object.keys(S.setAside || {}).length ? ` <button id="railKeep">Show them</button>` : keep ? ` <button id="railKeep">Hide them</button>` : "");
}
/* ---------- the line over the map: what's on, in words, and one way back ---------- */
let undoLink = null;
function linePills() {
  const out = [], q0 = $("#q").value.trim(), lo = $("#fmin").value, hi = $("#fmax").value, rf = $("#rf").value.trim();
  if (q0) out.push(["q", `"${q0}"`]);
  if (rf || lo || hi) out.push(["rf", rf ? (/[a-z]/i.test(rf) ? rf : `${rf} MHz`) : lo ? `from ${lo} MHz` : `up to ${hi} MHz`]);
  if (!$("#hideMobile").checked) out.push(["fixed", "Mobiles on"]);
  const fcc = window.searchFieldCount ? searchFieldCount() : 0;
  if (fcc) out.push(["fcc", plural(fcc, "FCC field")]);
  return out.concat(pills());
}
function drawLine() {
  const on = S.rows.filter(r => S.layerOn.has(r.layer)).length, ps = linePills(), where = S.center ? ` within ${$("#radius").value} mi` : "";
  document.getElementById("flCount").textContent = S.rows.length || S.searched ? `${fmt(last)} of ${fmt(on)}${where}${$("#hideMobile").checked ? ", fixed sites" : ""}` : "";
  document.getElementById("flPills").innerHTML = ps.map(([id, t]) => `<button class="rpill" data-line="${id}" aria-label="Clear ${esc(t)}">${esc(t)} <span aria-hidden="true">✕</span></button>`).join("");
  document.getElementById("flClear").hidden = !ps.length;
  document.getElementById("flUndo").hidden = !undoLink || !!ps.length;
}
function clearLine(id) {
  if (id === "q") $("#q").value = "";
  else if (id === "rf") { $("#rf").value = ""; rfRead(); $("#fmin").value = ""; $("#fmax").value = ""; }
  else if (id === "fixed") $("#hideMobile").checked = true;
  else if (id === "fcc") searchFieldsClear();
  else { clearPill(id); return changed(); }
  runSearch();
}
document.getElementById("filterLine").addEventListener("click", e => {
  const p = e.target.closest("[data-line]"), t = e.target;
  if (p) { undoLink = null; return clearLine(p.dataset.line); }
  if (t.closest("#flClear")) {
    undoLink = location.hash; filtersReset(); $("#q").value = ""; $("#rf").value = ""; rfRead(); $("#fmin").value = ""; $("#fmax").value = "";
    $("#hideMobile").checked = true; searchFieldsClear(); S.keepNoFreq = false; return runSearch();
  }
  if (t.closest("#flUndo")) { const l = undoLink; undoLink = null; if (l) { history.replaceState(null, "", l); applyUrlState(); runSearch(); } }
});
function drawHead() {
  drawWhy();
  drawLine();
  const ps = pills(), n = ps.length;
  document.getElementById("railPills").innerHTML = ps.map(([id, t]) => `<button class="rpill" data-pill="${id}" aria-label="Clear ${esc(t)}">${esc(t)} <span aria-hidden="true">✕</span></button>`).join("");
  const c = document.getElementById("clearChips"); c.textContent = n ? `Clear ${n}` : "Clear"; c.disabled = !n;
  document.getElementById("railSide").hidden = false;
  for (const b of document.querySelectorAll("#railSide [data-side]")) { const on = b.dataset.side === S.side; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); }
  document.getElementById("railBadge").textContent = n ? `${n} on` : "";
  document.getElementById("railBarOn").textContent = n ? ` · ${n} on` : "";
  document.getElementById("railBarCount").textContent = plural(last, "item");
  document.getElementById("railShow").textContent = `Show ${plural(last, "item")}`;
}
// the rail on its tabs, and away (the content full width) on the others; called by render() before the view draws
window.railRender = rows => {
  if (rows) last = rows.length;
  const on = avail();
  document.body.classList.toggle("rail-none", !on);
  drawHead();
  if (!on) { setOverlay(false); setSheet(false); return; }
  measureTop();
  drawBody();
};

/* ---------- fold, overlay and sheet ---------- */
let folded = (() => { let f = store.get("rfr.railFolded");
  if (f === null) { f = store.get("rfr.filtersFolded"); if (f !== null) { store.set("rfr.railFolded", f === "1" ? "1" : ""); store.del("rfr.filtersFolded"); } }
  return f === null ? innerWidth < RAIL_OPEN_FROM : f === "1"; })();
// the content's width changed: the map, the spectrum and the graph redraw at it (now, and once the slide has ended)
const relayout = () => { dispatchEvent(new Event("resize")); setTimeout(() => dispatchEvent(new Event("resize")), 560); };
function paintButtons() {
  const m = mode(), b = document.getElementById("railFold"), open = m === "desk" ? !folded : m === "mid" ? el.classList.contains("open") : el.classList.contains("sheet");
  b.textContent = m === "phone" ? "✕" : "‹";
  const what = m === "desk" ? "Fold the filters (L)" : "Close the filters (L or Esc)";
  b.title = what; b.setAttribute("aria-label", what);
  for (const id of ["railOpen", "railBar"]) document.getElementById(id).setAttribute("aria-expanded", String(open));
}
function setFold(f) {
  if (folded === f) return;
  folded = f; store.set("rfr.railFolded", f ? "1" : "");
  document.body.classList.toggle("rail-folded", f); paintButtons(); relayout();
}
function setOverlay(o) {
  if (el.classList.contains("open") === o) return;
  el.classList.toggle("open", o); paintButtons();
  // a short screen (a phone on its side) whose header hasn't scrolled away yet: bring the rail up to where it sticks, so
  // the whole of it is in view
  if (o) { const t = el.getBoundingClientRect().top, stick = parseFloat(getComputedStyle(el).top) || 0; if (t > stick + 1) scrollBy(0, t - stick); }
}
function setSheet(o) {
  if (el.classList.contains("sheet") === o) return;
  el.classList.toggle("sheet", o); if (o) panel.style.height = ""; paintButtons();
}
function setMenu(o) { menu.hidden = !o; menuBtn.setAttribute("aria-expanded", String(o)); }
const isShown = () => { const m = mode(); return m === "desk" ? !folded : m === "mid" ? el.classList.contains("open") : el.classList.contains("sheet"); };
function openRail() { const m = mode(); if (m === "desk") setFold(false); else if (m === "mid") setOverlay(true); else setSheet(true); }
function closeRail() { const m = mode(); if (m === "desk") setFold(true); else if (m === "mid") setOverlay(false); else setSheet(false); }
const toggleRail = () => isShown() ? closeRail() : openRail();
// leave the rail (Esc): an overlay or sheet closes, and the keys go back to the page
function leave() {
  const m = mode(); setMenu(false);
  if (m === "mid" && el.classList.contains("open")) { setOverlay(false); document.getElementById("railOpen").focus(); return; }
  if (m === "phone" && el.classList.contains("sheet")) { setSheet(false); document.getElementById("railBar").focus(); return; }
  if (el.contains(document.activeElement)) document.activeElement.blur();
}
function measureTop() {
  const tb = document.querySelector(".tabbar"); if (!tb) return;
  const cs = getComputedStyle(tb), top = cs.position === "sticky" ? parseFloat(cs.top) || 0 : 0;
  const v = Math.round(top + tb.offsetHeight + 6) + "px", root = document.documentElement;
  if (root.style.getPropertyValue("--rail-top") !== v) root.style.setProperty("--rail-top", v);
}
document.body.classList.toggle("rail-folded", folded);
addEventListener("resize", measureTop);
const onMode = () => { setOverlay(false); setSheet(false); setMenu(false); paintButtons(); measureTop(); };
mqPhone.addEventListener("change", onMode); mqMid.addEventListener("change", onMode);
// before the first search the tab in the link decides (every view's script has loaded by now)
document.addEventListener("DOMContentLoaded", () => {
  document.body.classList.toggle("rail-none", !viewTakesRows(new URLSearchParams(location.hash.slice(1)).get("tab") || S.tab));
  paintButtons(); measureTop(); drawHead();
});

/* ---------- presses ---------- */
const changed = () => { S.shown = 600; render(); };
el.addEventListener("click", e => {
  const t = e.target;
  if (t.closest("#railFold")) return closeRail();
  if (t.closest("#railStrip")) return openRail();
  if (t.closest("#railBar")) return el.classList.contains("sheet") ? setSheet(false) : setSheet(true);
  if (t.closest("#railShow")) { setSheet(false); document.getElementById("railBar").focus({preventScroll: true}); return; }
  if (t.closest("#railExportBtn")) return setMenu(menu.hidden);
  if (t.closest("#railMenu button")) return setMenu(false);  // the button's own job ran first (core.js, tak.js)
  if (t.closest("#railKeep")) { S.keepNoFreq = !S.keepNoFreq; return runSearch(); }
  const sd = t.closest("[data-side]"); if (sd) { setSide(sd.dataset.side); return changed(); }
  const p = t.closest(".rpill"); if (p) { clearPill(p.dataset.pill); return changed(); }
  const all = t.closest("[data-all]"); if (all) { navKey = all.dataset.nk; allNone(all.dataset.all); return changed(); }
  const fo = t.closest("[data-fold]"); if (fo) { setOpen(fo.dataset.fold, fo.getAttribute("aria-expanded") !== "true"); return drawBody(); }
  const z = t.closest("[data-zero]"); if (z) { zeroOpen[z.dataset.zero] = !zeroOpen[z.dataset.zero]; navKey = z.dataset.nk; return drawBody(); }
  const r = t.closest(".rrow"); if (!r) return;
  const g = r.dataset.g, v = r.dataset.v; navKey = `r:${g}:${v}`;
  const solo = !!t.closest(".ronly") || e.altKey;  // "only", or Alt+click on the row
  if (g === "src") (solo ? srcOnly : srcToggle)(v); else (solo ? valOnly : valToggle)(g, v);
  changed();
});
// the overlay (700-1,099 px) and the Export list close on a press outside them, like every other layer
document.addEventListener("pointerdown", e => {
  if (el.classList.contains("open") && !el.contains(e.target)) setOverlay(false);
  if (!menu.hidden && !e.target.closest("#railMenu, #railExportBtn")) setMenu(false);
}, true);
// the filter box: a substring of the labels; sections with a match open, the rest fold to "0 matches"; Esc clears it
q.addEventListener("input", () => { S.railQ = q.value; drawBody(); });
q.addEventListener("keydown", e => {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (q.value) { q.value = ""; S.railQ = ""; drawBody(); } else leave(); }
  else if (e.key === "ArrowDown" || e.key === "Enter") { e.preventDefault();
    const list = navs(), t = (S.railQ && list.find(x => x.closest(".rrow"))) || list[0]; if (t) focusNav(t); }
});
// the sheet's handle: drag up to 92%, down to close; a tap switches between 60% and 92%
const grab = document.getElementById("railGrab");
grab.addEventListener("pointerdown", e => {
  if (mode() !== "phone") return;
  const h0 = panel.getBoundingClientRect().height, y0 = e.clientY; let moved = false;
  panel.classList.add("dragging"); grab.setPointerCapture(e.pointerId);
  const mv = ev => { const dy = ev.clientY - y0; if (Math.abs(dy) > 5) moved = true;
    if (moved) panel.style.height = Math.max(innerHeight * 0.2, Math.min(innerHeight * 0.92, h0 - dy)) + "px"; };
  const up = () => { grab.removeEventListener("pointermove", mv); grab.removeEventListener("pointerup", up); grab.removeEventListener("pointercancel", up);
    panel.classList.remove("dragging");
    const f = panel.getBoundingClientRect().height / innerHeight;
    if (!moved) { panel.style.height = f > 0.75 ? "" : "92dvh"; return; }
    if (f < 0.35) { setSheet(false); document.getElementById("railBar").focus({preventScroll: true}); return; }
    panel.style.height = f > 0.76 ? "92dvh" : ""; };
  grab.addEventListener("pointermove", mv); grab.addEventListener("pointerup", up); grab.addEventListener("pointercancel", up);
});

/* ---------- keys ---------- */
const navs = () => [...body.querySelectorAll("[data-nav]")].filter(x => x.offsetParent !== null);
function focusNav(t) {
  for (const x of body.querySelectorAll('[data-nav][tabindex="0"]')) x.tabIndex = -1;
  t.tabIndex = 0; navKey = t.dataset.nk; t.focus({preventScroll: true}); t.scrollIntoView({block: "nearest"});
}
const inRail = () => el.contains(document.activeElement) && document.activeElement !== document.body;
const cur = () => body.contains(document.activeElement) && document.activeElement.matches("[data-nav]") ? document.activeElement : null;
const scopeOf = x => { const sub = x.closest("[data-sub]"); return sub ? "src." + sub.dataset.sub : x.closest("[data-sec]")?.dataset.sec; };
function move(d) {
  const list = navs(), c = cur(), i = list.indexOf(c);
  if (d < 0 && i === 0) { q.focus(); return; }  // up from the first row: the filter box
  const t = list[i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + d))]; if (t) focusNav(t);
}
function press(c) {
  if (c.matches("[data-all]")) { navKey = c.dataset.nk; allNone(c.dataset.all); return changed(); }
  if (c.matches("[data-zero]")) { zeroOpen[c.dataset.zero] = !zeroOpen[c.dataset.zero]; navKey = c.dataset.nk; return drawBody(); }
  const r = c.closest(".rrow"); if (!r) return;
  navKey = c.dataset.nk; if (r.dataset.g === "src") srcToggle(r.dataset.v); else valToggle(r.dataset.g, r.dataset.v);
  changed();
}
function fold(c, open) {
  const id = c.matches("[data-all]") ? c.dataset.all : scopeOf(c); if (!id) return;
  setOpen(id, open);
  if (!open) navKey = `h:${id}`;  // folding from a row: the keys land on its section's head
  drawBody();
  const t = body.querySelector(`[data-nk="${CSS.escape(navKey || "")}"]`); if (t) focusNav(t);
}
const onRail = fn => () => { const c = cur(); if (!c) return false; fn(c); };
RFKeys.scope("filters", {active: avail, keys: {
  l: () => toggleRail(),
  "/": () => { openRail(); q.focus(); q.select(); },
  arrowdown: () => { if (!inRail()) return false; move(1); },
  arrowup: () => { if (!inRail()) return false; move(-1); },
  space: onRail(press), enter: onRail(press),
  o: onRail(c => { const r = c.closest(".rrow"); if (!r) return; navKey = c.dataset.nk;
    if (r.dataset.g === "src") srcOnly(r.dataset.v); else valOnly(r.dataset.g, r.dataset.v); changed(); }),
  a: onRail(c => { const id = c.matches("[data-all]") ? c.dataset.all : scopeOf(c); if (!id) return; navKey = c.dataset.nk; allOn(id); changed(); }),
  arrowleft: onRail(c => fold(c, false)),
  arrowright: onRail(c => fold(c, true)),
  escape: () => { if (!menu.hidden) { setMenu(false); return; }
    if (inRail() || el.classList.contains("open") || el.classList.contains("sheet")) { leave(); return; }
    return false; }}});
document.getElementById("railFoot").innerHTML = RFKeys.legend([["L", "rail"], ["/", "find"], ["↑↓", "move"], ["Space", "on / off"],
  ["O", "only"], ["A", "all on"], ["←→", "fold"], ["Esc", "leave"]]);
})();
