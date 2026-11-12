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
  // ＋ Mark: what's typed in the Pin box becomes a marker, and the pin stays (Cody 11/11). In the box's own label: inside its
  // right end while it has the focus on the one-line bar (beside it, the bar ran to a second line at 1366 and 1700 px and
  // the map moved down), beside it on a phone (index.html)
  wrap.insertAdjacentHTML("beforeend", '<button id="locMark" type="button" title="Mark what\'s typed in the Pin box (an address, place or lat, lon) with a marker; the pin stays where it is. Shift+Enter does it from the box.">＋ Mark</button>');
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
// q: the text the list answers; picked: an item moved to with the arrows since (review 11/11: a list from an earlier
// prefix, still on screen while the next answer was on its way, was taken for the typed text)
const sug = { items: [], active: -1, timer: null, seq: 0, q: "", picked: false, enters: 0, marking: false };
function closeSuggest() { const b = $("#suggest"); b.hidden = true; b.innerHTML = ""; sug.items = []; sug.active = -1; sug.q = ""; sug.picked = false; }
// the list's pick for what's in the box now: the one moved to with the arrows, or the first when the list answers this text
const listPick = q => !$("#suggest").hidden && sug.items.length && (sug.picked || sug.q === q) ? sug.items[Math.max(0, sug.active)] : null;
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
    sug.items = r.results; sug.active = sug.items.length ? 0 : -1; sug.q = q; sug.picked = false; paintSuggest(r.online);
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
  $("#locLabel").textContent = ""; S.placeLabel = null; sug.picked = false;
  // ＋ Mark shows in the box once its text is something new (index.html): on the focus a click gives, it sat where a second
  // click or a double-click on the coordinates landed, and marked the pin (review 11/11)
  $("#locWrap").classList.toggle("typed", !!q && $("#loc").value !== S.locSearched?.v);
  clearTimeout(sug.timer);
  if (q.length < 3 || parseLoc(q) || /^https?:/i.test(q)) { closeSuggest(); return; }
  sug.timer = setTimeout(() => lookup(q), 250);
});
// a Tab to ＋ Mark keeps the list and its pick (it was gone by the time Enter pressed ＋ Mark: review 11/11); leaving both goes
$("#loc").addEventListener("blur", e => { if (e.relatedTarget?.id !== "locMark") setTimeout(closeSuggest, 150); });
$("#locMark").addEventListener("blur", e => { if (e.relatedTarget?.id !== "loc") setTimeout(closeSuggest, 150); });
// capture phase on the wrapper, so Enter on a suggestion doesn't also fire the plain search
$("#locWrap").addEventListener("keydown", async e => {
  if (e.target.id === "locMark") return;  // Enter or Space on ＋ Mark presses it, not the box's Enter (which searches)
  const open = !$("#suggest").hidden && sug.items.length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!open) return;
    e.preventDefault();
    sug.active = (sug.active + (e.key === "ArrowDown" ? 1 : -1) + sug.items.length) % sug.items.length; sug.picked = true;
    paintSuggest();
  } else if (e.key === "Escape") closeSuggest();
  else if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); e.stopPropagation(); markTyped(); }  // ＋ Mark: a marker there, the pin stays
  else if (e.key === "Enter") {
    const q = $("#loc").value.trim();
    if (parseLoc(q) || !q) return;  // coordinates: the normal search runs
    e.preventDefault(); e.stopPropagation();
    const pick = listPick(q); if (pick) return choosePlace(pick);
    clearTimeout(sug.timer);  // typed fast and hit Enter: the best match for this text (the box's own lookup would void this one)
    // and only if nothing newer has happened since: a slow answer moved the pin over a search typed after it (follow-up review 11/11)
    const n = ++sug.enters, gen = S.searchGen;
    const best = await geocodeBest(q);
    if (best && n === sug.enters && gen === S.searchGen && $("#loc").value.trim() === q) choosePlace(best);
  }
}, true);

/* ---------- ＋ Mark: a marker where the Pin box says, the pin left where it is (Cody 11/11) ----------
   Coordinates or a Maps link as typed; an address or place: the suggestion picked with the arrows, else the best match. The
   marker is kept with the Search map's drawings (markup.js RFMarkup.markAt). The box goes back to the spot the pin searched,
   the status line says where the marker went, and Zoom to is offered only when it's off the map's view. */
// the best match for this text, asked for now and kept whatever the box's own lookups do (their newer one voided it, and
// a typist's Shift+Enter said "Nothing found": review 11/11)
async function geocodeBest(q) {
  const near = S.center ? `&lat=${S.center[0]}&lon=${S.center[1]}` : "";
  try { return (await api(`/api/geocode?q=${encodeURIComponent(q)}${near}`)).results?.[0] || null; } catch (e) { return null; }
}
// one at a time: while it looks the place up and saves, the status line says so and another press waits for it (a second
// press made a second marker); the box goes back to the pin only if it still says what was marked (text typed meanwhile was
// wiped: follow-up review 11/11)
async function markTyped(ev) {
  if (ev && ev.detail > 1) return;  // the second click of a double-click: one press, one marker
  if (sug.marking) return;
  sug.marking = true;
  try { await markNow(); } finally { sug.marking = false; }
}
async function markNow() {
  const st = $("#status"), q = $("#loc").value.trim();
  st.className = "status";
  if (!window.RFMarkup) return;
  if (!RFMarkup.canEdit(S.map)) { st.textContent = "View only: markers are added by a full login."; return; }
  if (!q) { st.textContent = "Type an address, place or lat, lon in the Pin box, then press ＋ Mark."; return; }
  let at = parseLoc(q), name = "";
  if (!at) {
    let r = listPick(q);
    if (!r) { clearTimeout(sug.timer); st.textContent = `Finding “${q}”…`; r = await geocodeBest(q); }
    if (!r || r.lat == null) { closeSuggest(); st.textContent = `Nothing found for “${q}”: try the street, town and state, or lat, lon.`; st.className = "status err"; return; }
    at = [+r.lat, +r.lon]; name = r.label;
  }
  if ($("#loc").value.trim() === q) closeSuggest();
  let it;
  try { it = await RFMarkup.markAt(at, name); }
  catch (e) { st.textContent = `Not marked: ${e.message}`; st.className = "status err"; return; }
  if (!it) { st.textContent = "Not marked: the map couldn't keep it (its message says why)."; st.className = "status err"; return; }
  const k = S.locSearched;  // the box shows the pin's own spot again, as its search had it, unless something new was typed
  if ($("#loc").value.trim() === q) { $("#loc").value = k ? k.v : ""; $("#locLabel").textContent = k ? k.label : ""; S.placeLabel = k ? k.place : null; $("#locWrap").classList.remove("typed"); }
  const ll = L.latLng(at), map = S.map, seen = S.tab === "map" && !!map && map.getContainer().isConnected && map.getBounds().contains(ll);
  const mi = S.center ? L.latLng(S.center).distanceTo(ll) / 1609.344 : null, label = it.label.length > 60 ? `${it.label.slice(0, 58)}…` : it.label;
  // one line, and Zoom to a link in it: a button is taller than the line (44 px on a touch screen), and the map under the
  // status line moved down when it came
  st.innerHTML = `Marked “${esc(label)}” at <span class="mono">${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}</span>${mi != null ? `, ${mi < 0.1 ? `${Math.round(mi * 5280)} ft` : `${mi.toFixed(mi < 10 ? 2 : 1)} mi`} from the pin` : ""}.${seen ? "" : ' <a href="#" id="markZoom" role="button" class="hint" style="color:var(--accent);font-weight:600" title="Show the marker on the map (the pin stays where it is)">Zoom to</a>'}`;
  const z = $("#markZoom");
  if (z) z.onclick = e => { e.preventDefault(); if (S.tab !== "map") setTab("map"); const m = S.map; if (m) m.setView(ll, Math.max(m.getZoom(), 16)); z.remove(); };
}
// a press on ＋ Mark keeps the focus in the box, so a suggestion moved to with the arrows is still there to mark
$("#locMark").addEventListener("mousedown", e => e.preventDefault());
$("#locMark").addEventListener("click", markTyped);

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
  if (S.tab === "towers" && window.RFTowers) RFTowers.linkParams(h);  // the carriers picked on the Towers tab (towers.js)
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
  if (h.has("carriers") && window.RFTowers) RFTowers.fromLink(h.get("carriers"));  // the Towers tab's carriers (towers.js)
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
