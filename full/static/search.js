"use strict";
/* DAStastic — search: address autocomplete, nationwide licence search, FCC licence search fields,
   and the view as a link (pin, radius, tab and filters in the address bar). */

/* ---------- FCC licence search fields (like the ULS advanced / geographic search) ---------- */
const SVC_PRESETS = {
  aviation: ["AA", "AF", "AR", "CA", "CG", "CJ", "WA"],
  public: ["PW", "YW", "SG", "SY", "SL", "GE", "YE", "GF", "YF", "GP", "YP", "PA", "QM", "MW"],
  business: ["IG", "YG", "IK", "YK", "GB", "YB", "GJ", "YJ", "GO", "YO", "GU", "YU", "GI", "YI"],
  marine: ["MA", "MC", "MK", "MR", "PC", "WM"],
  paging: ["CD", "CZ", "CP", "GC"],
  bcastaux: ["RP", "LP", "LV", "AS", "AI", "AB", "TS", "TI", "TP", "TB", "TT"],
};
const ADV = [["#a_svc", "svc"], ["#a_tech", "tech"], ["#a_em", "emission"], ["#a_gf", "granted_from"], ["#a_gt", "granted_to"],
  ["#a_ef", "expires_from"], ["#a_et", "expires_to"]];

(function buildSearchUi() {
  $("#modeSeg").insertAdjacentHTML("beforeend", '<button data-m="nationwide" title="Search licences anywhere in the US by call sign, licensee, service or frequency">Nationwide</button>');
  const panel = $("#searchPanel");
  panel.insertAdjacentHTML("beforeend", `
    <details id="advSearch" style="margin-top:8px"><summary title="FCC licence search fields, and the From and To frequency boxes">FCC fields <span class="hint" id="advCount"></span></summary>
      <div class="row" id="advRow" style="margin-top:6px;align-items:flex-end">
        <label>Preset<select id="a_preset"><option value="">—</option><option value="aviation">Aviation (airports, air-ground, navaids)</option>
          <option value="public">Public safety</option><option value="business">Business / industrial</option><option value="marine">Marine</option>
          <option value="paging">Paging</option><option value="bcastaux">Broadcast auxiliary</option></select></label>
        <label>Radio services<input id="a_svc" placeholder="codes, e.g. PW, YW" list="svcList" style="width:160px"></label>
        <label>Technology<select id="a_tech"><option value="">Any</option>${["P25", "P25 Phase 2", "DMR", "NXDN", "Analog FM", "Data", "AM", "SSB", "Radar"].map(t => `<option>${t}</option>`).join("")}</select></label>
        <label>Emission contains<input id="a_em" placeholder="8K10F1E" style="width:110px"></label>
        <label>Granted from<input id="a_gf" type="date"></label><label>to<input id="a_gt" type="date"></label>
        <label>Expires from<input id="a_ef" type="date"></label><label>to<input id="a_et" type="date"></label>
        <button id="a_clear">Clear fields</button>
      </div><datalist id="svcList"></datalist>
      <p class="hint" id="advSvcNames" style="margin:4px 2px 0"></p></details>`);
  $("#advRow").prepend($("#rfFields"));  // From and To sit with the other typed fields; the box above writes them
  api("/api/services").then(s => { S.services = s; $("#svcList").innerHTML = Object.entries(s).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join(""); advNote(); }).catch(() => {});
  $("#a_preset").onchange = e => { $("#a_svc").value = (SVC_PRESETS[e.target.value] || []).join(", "); advNote(); searchDirty(); };
  $("#a_clear").onclick = () => { for (const [id] of ADV) $(id).value = ""; $("#a_preset").value = ""; advNote(); searchDirty(); };
  for (const [id] of ADV) { $(id).addEventListener("change", () => { advNote(); searchDirty(); }); $(id).addEventListener("keydown", e => { if (e.key === "Enter") runSearch(); }); }

  // the pin box takes addresses, places and counties too
  const wrap = $("#locWrap"), loc = $("#loc");
  wrap.firstChild.textContent = "Pin: address, place, county, lat/lon or Maps link (or 📍 Move pin on the map)";
  loc.placeholder = "e.g. 1600 Pennsylvania Ave, Fairfax County VA, 38.8895, -77.0353";
  loc.setAttribute("autocomplete", "off");
  wrap.style.position = "relative";
  wrap.insertAdjacentHTML("beforeend", '<div id="suggest" class="panel" hidden style="position:absolute;left:0;right:0;top:100%;z-index:2000;padding:4px;max-height:340px;overflow:auto"></div><span class="hint" id="locLabel"></span>');
})();

function advNote() {
  const codes = $("#a_svc").value.split(/[\s,]+/).map(c => c.trim().toUpperCase()).filter(Boolean);
  $("#advSvcNames").textContent = codes.length && S.services ? codes.map(c => `${c} ${S.services[c] || "(unknown code)"}`).join(" · ") : "";
  const n = ADV.filter(([id]) => $(id).value).length;
  $("#advCount").textContent = n ? `· ${n} set` : "";
}
window.searchFieldCount = () => ADV.filter(([id]) => $(id).value).length;
window.searchFieldsClear = () => { for (const [id] of ADV) $(id).value = ""; $("#a_preset").value = ""; advNote(); };
window.searchFields = p => { for (const [id, k] of ADV) if ($(id).value) p.set(k, k === "svc" ? $(id).value.split(/[\s,]+/).filter(Boolean).join(",") : $(id).value); };

/* ---------- the frequency box and the band picker (rfparse.js reads what's typed) ---------- */
const RF_HELP = "A channel (852.3625), a range (851-869), a tolerance (852.3625 ±12.5k), a band (B13, n77, VHF, NPSPAC) or a pasted list. Add up, down or both for a paired band.";
const rfBands = () => [...RF_BANDS_LMR, ...rfCellBands(typeof DAS_LTE_BANDS === "undefined" ? [] : DAS_LTE_BANDS)];
function rfRead() {
  const box = $("#rf"), r = parseRF(box.value, rfBands());
  box.classList.toggle("bad", r.bad.length > 0);
  box.title = r.bad.length ? `Didn't read: ${r.bad.join(", ")}. ${RF_HELP}` : RF_HELP;
  const one = r.ranges.length === 1 ? r.ranges[0] : null;
  $("#fmin").value = one ? one[0] : ""; $("#fmax").value = one ? one[1] : "";
  S.franges = r.ranges.length > 1 ? r.ranges.map(x => x.join("-")).join(",") : "";
  S.rfPaired = r.paired ? r.ranges[r.ranges.length - 1].join("-") : "";
}
window.rfRead = rfRead;
$("#rf").title = RF_HELP;
$("#rf").addEventListener("input", () => { rfRead(); searchDirty(); });
for (const id of ["#fmin", "#fmax"]) $(id).addEventListener("input", () => {
  const lo = $("#fmin").value, hi = $("#fmax").value;
  $("#rf").value = lo && hi ? `${lo}-${hi}` : ""; $("#rf").classList.remove("bad"); S.franges = ""; S.rfPaired = "";
});
const rfMenuEl = $("#rfMenu");
function rfDraw() {
  const dir = S.rfDir || "down", span = b => [b[2], b[3]].filter(Boolean).map((x, i) => `${i ? "up" : b[3] ? "down" : ""} ${x[0]}-${x[1]}`.trim()).join(", ");
  const item = b => `<button data-rfkey="${esc(b[0][0])}" title="${esc(b[1])}: ${esc(span(b))} MHz"><b>${esc(b[1].replace(/ \/ n\d+/, ""))}</b><span class="hint">${esc(span(b))}</span></button>`;
  const lmr = RF_BANDS_LMR, cell = rfCellBands(typeof DAS_LTE_BANDS === "undefined" ? [] : DAS_LTE_BANDS);
  rfMenuEl.innerHTML = `<div class="seg" role="group" aria-label="Which side of a paired band">${[["down", "Down"], ["up", "Up"], ["both", "Both"]].map(([d, l]) => `<button data-rfdir="${d}" class="${d === dir ? "on" : ""}">${l}</button>`).join("")}</div>
    <h4>Land mobile</h4><div class="rf-grid">${lmr.map(item).join("")}</div>
    ${cell.length ? `<h4>Cellular</h4><div class="rf-grid">${cell.map(item).join("")}</div>` : ""}`;
}
function rfOpen(o) { rfMenuEl.hidden = !o; $("#rfPick").setAttribute("aria-expanded", String(o)); if (o) rfDraw(); }
$("#rfPick").addEventListener("click", () => rfOpen(rfMenuEl.hidden));
rfMenuEl.addEventListener("click", e => {
  const d = e.target.closest("[data-rfdir]"), k = e.target.closest("[data-rfkey]");
  if (d) {
    S.rfDir = d.dataset.rfdir; rfDraw();
    const v = $("#rf").value.replace(/\s+(up|down|both|ul|dl|uplink|downlink)\b/gi, "").trim();
    if (v) { $("#rf").value = S.rfDir === "down" ? v : `${v} ${S.rfDir}`; rfRead(); searchDirty(); }
  } else if (k) {
    const key = k.dataset.rfkey, name = /^n\d/.test(key) ? key : key.toUpperCase();  // the reader ignores case: B13 reads right in the pills
    $("#rf").value = name + (S.rfDir && S.rfDir !== "down" ? ` ${S.rfDir}` : ""); rfOpen(false); rfRead(); searchDirty();
  }
});
document.addEventListener("pointerdown", e => { if (!rfMenuEl.hidden && !e.target.closest("#rfWrap")) rfOpen(false); }, true);
document.addEventListener("keydown", e => { if (e.key === "Escape" && !rfMenuEl.hidden) { rfOpen(false); e.stopPropagation(); } }, true);

/* ---------- saved views: a named set of filters that works at any pin. Five to start, and your own, kept in this browser ---------- */
const VIEWS_KEY = "rfr.views";
const ALL_SOURCES = () => Object.keys(LAYERS).filter(l => l !== "uls_hist" && !S.build?.left_out?.[l]).join(",");
const VIEW_STARTERS = [
  ["Public safety discovery", "Band first, the public safety agencies picked", () => "tab=map&side=ps"],
  ["Cellular discovery", "Carrier first, the rows that name a carrier", () => "tab=map&side=cell"],
  ["Donor search", "Carrier towers and cell sites around the pin", () => "tab=map&side=cell&src=towers,opencellid"],
  ["Interference hunt", "Every source on, mobiles included", () => `tab=map&fixed=0&src=${ALL_SOURCES()}`],
  ["Prospect area", "The DAS tab's Prospects for this area", () => "tab=das", () => { if (window.dasOpenView) dasOpenView("prospects"); }]];
const viewsMine = () => { try { return JSON.parse(localStorage.getItem(VIEWS_KEY) || "[]") || []; } catch (e) { return []; /* unreadable or blocked: no views of mine */ } };
const viewsSave = v => { try { localStorage.setItem(VIEWS_KEY, JSON.stringify(v)); } catch (e) { $("#status").textContent = "This browser won't keep saved views."; } };
// what's on now, without where: a view works at any pin
function viewLink() {
  const h = new URLSearchParams(location.hash.slice(1));
  for (const k of ["lat", "lon", "r", "place", "state", "county", "mode", "mv", ...JOB_KEYS]) h.delete(k);  // a view is filters, not a job or a map view
  return h.toString();
}
function viewApply(link, then) {
  const h = new URLSearchParams(location.hash.slice(1)), v = new URLSearchParams(link), keep = new URLSearchParams();
  for (const k of ["lat", "lon", "r", "place", "state", "county", "mode"]) if (h.has(k)) keep.set(k, h.get(k));
  for (const [k, x] of v) if (k !== "mv") keep.set(k, x);  // a view saved before 11/11 kept where the map was: not a filter
  filtersReset(); $("#q").value = ""; $("#rf").value = ""; rfRead(); $("#fmin").value = ""; $("#fmax").value = ""; $("#hideMobile").checked = true; searchFieldsClear();
  history.replaceState(null, "", "#" + keep.toString());
  if (window.applyUrlState()) runSearch(); else render();
  if (then) then();
}
const viewsEl = $("#viewsMenu");
function viewsDraw() {
  const mine = viewsMine();
  viewsEl.innerHTML = VIEW_STARTERS.map((v, i) => `<div class="vrow"><button data-vs="${i}"><b>${esc(v[0])}</b><span class="hint">${esc(v[1])}</span></button></div>`).join("")
    + mine.map((v, i) => `<div class="vrow"><button data-vm="${i}"><b>${esc(v.name)}</b></button><button data-vd="${i}" aria-label="Delete ${esc(v.name)}" title="Delete this view">✕</button></div>`).join("")
    + `<form id="viewForm"><input id="viewName" placeholder="Name this view" aria-label="Name this view" maxlength="60"><button type="submit">Save</button></form>`;
}
function viewsOpen(o) { viewsEl.hidden = !o; $("#viewsBtn").setAttribute("aria-expanded", String(o)); if (o) viewsDraw(); }
$("#viewsBtn").addEventListener("click", () => viewsOpen(viewsEl.hidden));
viewsEl.addEventListener("click", e => {
  const s = e.target.closest("[data-vs]"), m = e.target.closest("[data-vm]"), d = e.target.closest("[data-vd]");
  if (s) { const v = VIEW_STARTERS[+s.dataset.vs]; viewsOpen(false); viewApply(v[2](), v[3]); }
  else if (m) { const v = viewsMine()[+m.dataset.vm]; viewsOpen(false); if (v) viewApply(v.link); }
  else if (d) { const v = viewsMine(); v.splice(+d.dataset.vd, 1); viewsSave(v); viewsDraw(); }
});
viewsEl.addEventListener("submit", e => {
  e.preventDefault();
  const name = $("#viewName").value.trim(); if (!name) return;
  viewsSave([...viewsMine().filter(v => v.name !== name), {name, link: viewLink()}]); viewsDraw();
});
document.addEventListener("pointerdown", e => { if (!viewsEl.hidden && !e.target.closest(".fl-views")) viewsOpen(false); }, true);
document.addEventListener("keydown", e => { if (e.key === "Escape" && !viewsEl.hidden) { viewsOpen(false); e.stopPropagation(); } }, true);

/* ---------- address autocomplete ---------- */
const sug = { items: [], active: -1, timer: null, seq: 0 };
function closeSuggest() { const b = $("#suggest"); b.hidden = true; b.innerHTML = ""; sug.items = []; sug.active = -1; }
function paintSuggest(online) {
  const box = $("#suggest");
  if (!sug.items.length) { box.innerHTML = `<div class="hint" style="padding:6px">${online === false ? "Offline: only towns and counties from the FCC data, and none match." : "No match. Try a town, county or street address."}</div>`; box.hidden = false; return; }
  box.innerHTML = sug.items.map((r, i) => `<div class="item" data-i="${i}" style="cursor:pointer;padding:6px 8px;border-radius:6px;${i === sug.active ? "background:var(--sel)" : ""}">
    <span class="t">${esc(r.label)}</span> <span class="hint">${esc(r.sub || "")}${r.source === "local" ? " · works offline" : ""}</span></div>`).join("")
    + (online === false ? '<div class="hint" style="padding:4px 8px">Offline: street addresses need a connection.</div>' : "");
  box.hidden = false;
  box.querySelectorAll("[data-i]").forEach(el => el.onmousedown = e => { e.preventDefault(); choosePlace(sug.items[+el.dataset.i]); });
}
async function lookup(q) {
  const seq = ++sug.seq;
  const near = S.center ? `&lat=${S.center[0]}&lon=${S.center[1]}` : "";
  try {
    const r = await api(`/api/geocode?q=${encodeURIComponent(q)}${near}`);
    if (seq !== sug.seq || $("#loc").value.trim() !== q) return null;
    sug.items = r.results; sug.active = sug.items.length ? 0 : -1; paintSuggest(r.online);
    return r.results;
  } catch (e) { return null; }
}
async function choosePlace(r) {
  closeSuggest();
  if (!r) return;
  if (r.kind === "county" && r.state && r.county) {  // a county is searched as the county, not a circle round its middle
    setMode("county");
    $("#state").value = r.state;
    await $("#state").onchange();
    $("#county").value = r.county;
    $("#locLabel").textContent = "";
  } else {
    setMode("point");
    $("#loc").value = `${r.lat}, ${r.lon}`;
    $("#locLabel").textContent = "📍 " + r.label;
    S.placeLabel = r.label;
  }
  runSearch();
}
$("#loc").addEventListener("input", () => {
  const q = $("#loc").value.trim();
  $("#locLabel").textContent = ""; S.placeLabel = null;
  clearTimeout(sug.timer);
  if (q.length < 3 || parseLoc(q) || /^https?:/i.test(q)) { closeSuggest(); return; }
  sug.timer = setTimeout(() => lookup(q), 250);
});
$("#loc").addEventListener("blur", () => setTimeout(closeSuggest, 150));
// capture phase on the wrapper, so Enter on a suggestion doesn't also fire the plain search
$("#locWrap").addEventListener("keydown", async e => {
  const open = !$("#suggest").hidden && sug.items.length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!open) return;
    e.preventDefault();
    sug.active = (sug.active + (e.key === "ArrowDown" ? 1 : -1) + sug.items.length) % sug.items.length;
    paintSuggest();
  } else if (e.key === "Escape") closeSuggest();
  else if (e.key === "Enter") {
    const q = $("#loc").value.trim();
    if (parseLoc(q) || !q) return;  // coordinates: the normal search runs
    e.preventDefault(); e.stopPropagation();
    if (open) return choosePlace(sug.items[Math.max(0, sug.active)]);
    const res = await lookup(q);  // typed fast and hit Enter: take the best match
    if (res && res.length) choosePlace(res[0]);
  }
}, true);

/* ---------- the view as a link ---------- */
// the open DAS job and its section, and the Start job and its step (UX review 11/8 #2: a reload or a phone dropping the tab put
// Andy back on the board; Back left the DAS tab from a job's section)
const JOB_KEYS = ["job", "sec", "sjob", "step"];
// a link's job onto the DAS tab's and Start's own state: true when it changed what's open
function urlJob(h) {
  let moved = false;
  if (h.get("tab") === "das") {
    const D = S.das = S.das || {view: "board", q: "", job: null, sub: "overview"}, id = +h.get("job") || null, sec = id ? h.get("sec") || "overview" : D.sub;
    if (D.job !== id || D.sub !== sec) { if (D.job !== id) D.rview = null; D.job = id; D.sub = sec; moved = true; }
  }
  if (h.get("tab") === "start" && S.start) {
    const G = S.start, id = +h.get("sjob") || null, step = id ? window.startStepId?.(+h.get("step")) || null : null;
    if (G.job !== id || (step && G.step !== step)) { G.job = id; G.step = step; G.sig = null; moved = true; }
  }
  return moved;
}
// the search's own part of the link: where it looked and what it asked. The link carries the search on the map (S.linkSearch,
// kept as each search lands, or a link's own while it loads), never what the boxes say before it's run: County or Nationwide
// pressed, a county or call sign picked and not searched, then any redraw, paired that unrun search with the last one's map
// view, and a reload opened its results off screen; a county link lost county= while its county list loaded (review 11/11)
const LINK_SEARCH = ["lat", "lon", "r", "state", "county", "mode", "place", "fixed", "q", "rf", "fmin", "fmax", ...ADV.map(a => a[1])];
window.searchLink = () => {
  const h = new URLSearchParams();
  if (S.mode === "point") { const ll = parseLoc($("#loc").value); if (ll) { h.set("lat", ll[0]); h.set("lon", ll[1]); h.set("r", $("#radius").value); } }
  else if (S.mode === "county") { if ($("#state").value) h.set("state", $("#state").value); if ($("#county").value) h.set("county", $("#county").value); }
  else h.set("mode", "nationwide");
  for (const [id, k] of [["#q", "q"], ["#rf", "rf"], ["#fmin", "fmin"], ["#fmax", "fmax"], ...ADV]) if ($(id).value) h.set(k, $(id).value);
  if (S.placeLabel) h.set("place", S.placeLabel);
  if (!$("#hideMobile").checked) h.set("fixed", "0");
  return h;
};
window.writeUrlState = replace => {
  const h = new URLSearchParams();
  h.set("tab", S.tab);
  if (S.tab === "das" && S.das && S.das.job) { h.set("job", S.das.job); h.set("sec", S.das.sub || "overview"); }
  if (S.tab === "start" && S.start && S.start.job) { h.set("sjob", S.start.job); const n = window.startStepNo?.(S.start.step); if (n) h.set("step", n); }
  const sk = S.linkSearch || searchLink();
  for (const [k, v] of sk) if (k !== "place") h.set(k, v);
  // filters: "type=" is "only these" (as every link has carried it), "xtype=" the hidden ones; "src=" the sources on,
  // when they differ from the defaults
  for (const k of ["type", "band", "cat", "cls", "carrier", "agency"]) {
    if (S.chips[k].size) h.set(k, [...S.chips[k]].join("|"));
    else if (S.hide[k].size) h.set("x" + k, [...S.hide[k]].join("|"));
  }
  if (S.side !== "all") h.set("side", S.side);
  if (S.filterExpr) h.set("expr", S.filterExpr);
  if (S.heat.kind !== "off") h.set("heat", S.heat.kind);
  const def = layerDefaults(), on = [...S.layerOn].filter(l => LAYERS[l]);
  if (on.length !== def.size || on.some(l => !def.has(l))) h.set("src", on.join(","));
  if (sk.get("place")) h.set("place", sk.get("place"));
  // the Map tab's view, so a link opens where it was looked at (Cody 11/10). It only ever replaces the history entry: panning
  // and zooming never add a Back step
  // and only once a search has drawn: before one the map shows the placeholder US, and a reload kept it for the next search
  // (review 11/11). While the link's own search runs, its view stays in the link as it came
  if (S.tab === "map") {
    if (S.mvWant) h.set("mv", S.mvWant.v.join(","));
    else if (S.searched && S.map && S.map._loaded) { const c = S.map.getCenter(); h.set("mv", `${c.lat.toFixed(6)},${c.lng.toFixed(6)},${S.map.getZoom()}`); }
  }
  const next = "#" + h.toString();
  if (location.hash === next) return;
  // a new tab, job, section or Start step is a step Back can return to; a new pin or filter replaces the step it's on. (11/3:
  // every change replaced it, so Back left DAStastic, and in the app window it stayed greyed out.) A step first written once the
  // job has loaded fills in the step it's on
  const was = new URLSearchParams(location.hash.slice(1)), moved = k => (was.get(k) || "") !== (h.get(k) || "");
  const step = moved("tab") || moved("job") || moved("sjob") || (was.has("sec") && moved("sec")) || (was.has("step") && moved("step"));
  if (!replace && was.get("tab") && step) { history.pushState(null, "", next); window.dispatchEvent(new Event("hashchange")); }  // the kit's Back button rechecks on hashchange
  else history.replaceState(null, "", next);
};
// Back and Forward move between tabs, a DAS job's sections and Start's steps
window.addEventListener("popstate", () => {
  const h = new URLSearchParams(location.hash.slice(1)), t = h.get("tab");
  let moved = false;
  if (t && t !== S.tab) { S.tab = t; moved = true; }
  if (urlJob(h)) moved = true;
  if (moved) render();
});
window.applyUrlState = boot => {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.toString()) return false;
  if (h.get("tab")) S.tab = h.get("tab");
  urlJob(h);
  for (const [id, k] of [["#q", "q"], ["#fmin", "fmin"], ["#fmax", "fmax"], ...ADV]) if (h.has(k)) $(id).value = h.get(k);
  if (h.get("rf")) { $("#rf").value = h.get("rf"); rfRead(); }  // older links carry only fmin and fmax
  else if (h.get("fmin") && h.get("fmax")) $("#rf").value = `${h.get("fmin")}-${h.get("fmax")}`;
  // an older link's include set reads as "only" (it always meant that); a newer one may carry the hidden values instead
  for (const k of ["type", "band", "cat", "cls", "carrier", "agency"]) {
    if (h.get(k)) setOnly(k, h.get(k).split("|"));
    else if (h.get("x" + k)) { S.chips[k] = new Set(); S.hide[k] = new Set(h.get("x" + k).split("|")); }
  }
  if (["ps", "cell"].includes(h.get("side"))) railSetSide(h.get("side"));
  if (h.get("fixed") === "0") $("#hideMobile").checked = false;
  if (h.has("expr")) S.filterExpr = h.get("expr");
  if (h.get("heat")) S.heat.kind = h.get("heat");
  if (h.has("src")) { S.layerOn = new Set(h.get("src").split(",").filter(l => LAYERS[l])); S.layerSolo = S.layerPrev = null; }
  // a link's map view (mv=lat,lon,zoom): the Map tab restores it instead of fitting the link's own search (core.js
  // drawLayers). Read only as DAStastic opens (boot), and only when the link carries a search: an mv left on a page with no
  // search took over the next one (review 11/11). key: that search (searchKeyOf), so no other search takes it; a nationwide
  // link's is its first search. In range only: a huge longitude froze the tab (Leaflet's tile loop never ends)
  // the link's own search stays in the link as it came until it lands (a county link's county list loads first)
  if (boot && (h.get("lat") && h.get("lon") || h.get("state") || h.get("mode") === "nationwide")) S.linkSearch = new URLSearchParams([...h].filter(([k]) => LINK_SEARCH.includes(k)));
  if (boot && h.get("mv") && (h.get("lat") && h.get("lon") || h.get("state") || h.get("mode") === "nationwide")) {
    const v = h.get("mv").split(",").map(Number);
    if (v.length === 3 && v.every(Number.isFinite) && Math.abs(v[0]) <= 90 && Math.abs(v[1]) <= 180 && v[2] >= 0 && v[2] <= 22)
      S.mvWant = {v, key: h.get("lat") && h.get("lon") ? `p:${+h.get("lat")},${+h.get("lon")}` : h.get("state") ? `c:${h.get("state")}|${h.get("county") || ""}` : null};
  }
  advNote();
  if (h.get("lat") && h.get("lon")) {
    setMode("point"); $("#loc").value = `${h.get("lat")}, ${h.get("lon")}`;
    if (h.get("r")) { $("#radius").value = h.get("r"); $("#radiusSlider").value = h.get("r"); }
    if (h.get("place")) { S.placeLabel = h.get("place"); $("#locLabel").textContent = "📍 " + S.placeLabel; }
    return true;
  }
  if (h.get("state")) {
    setMode("county"); $("#state").value = h.get("state");
    $("#state").onchange().then(() => { if (h.get("county")) $("#county").value = h.get("county"); runSearch(); });
    return false;  // searched once the county list is in
  }
  if (h.get("mode") === "nationwide") { setMode("nationwide"); return true; }
  return false;
};
