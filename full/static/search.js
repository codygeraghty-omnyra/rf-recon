"use strict";
/* RF Recon — search: address autocomplete, nationwide licence search, FCC licence search fields,
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
    <details id="advSearch" style="margin-top:8px"><summary>FCC licence search fields <span class="hint" id="advCount"></span></summary>
      <div class="row" style="margin-top:6px;align-items:flex-end">
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
  api("/api/services").then(s => { S.services = s; $("#svcList").innerHTML = Object.entries(s).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join(""); advNote(); }).catch(() => {});
  $("#a_preset").onchange = e => { $("#a_svc").value = (SVC_PRESETS[e.target.value] || []).join(", "); advNote(); };
  $("#a_clear").onclick = () => { for (const [id] of ADV) $(id).value = ""; $("#a_preset").value = ""; advNote(); };
  for (const [id] of ADV) { $(id).addEventListener("change", advNote); $(id).addEventListener("keydown", e => { if (e.key === "Enter") runSearch(); }); }

  // the pin box takes addresses, places and counties too
  const wrap = $("#locWrap"), loc = $("#loc");
  wrap.firstChild.textContent = "Pin: address, place, county, lat/lon or Maps link (or click the map)";
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
window.searchFields = p => { for (const [id, k] of ADV) if ($(id).value) p.set(k, k === "svc" ? $(id).value.split(/[\s,]+/).filter(Boolean).join(",") : $(id).value); };

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
window.writeUrlState = () => {
  const h = new URLSearchParams();
  h.set("tab", S.tab);
  if (S.mode === "point") { const ll = parseLoc($("#loc").value); if (ll) { h.set("lat", ll[0]); h.set("lon", ll[1]); h.set("r", $("#radius").value); } }
  else if (S.mode === "county") { if ($("#state").value) h.set("state", $("#state").value); if ($("#county").value) h.set("county", $("#county").value); }
  else h.set("mode", "nationwide");
  for (const [id, k] of [["#q", "q"], ["#fmin", "fmin"], ["#fmax", "fmax"], ...ADV]) if ($(id).value) h.set(k, $(id).value);
  for (const k of ["type", "band", "cat", "cls"]) if (S.chips[k].size) h.set(k, [...S.chips[k]].join("|"));
  if (S.placeLabel) h.set("place", S.placeLabel);
  const next = "#" + h.toString();
  if (location.hash !== next) history.replaceState(null, "", next);
};
window.applyUrlState = () => {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.toString()) return false;
  if (h.get("tab")) S.tab = h.get("tab");
  for (const [id, k] of [["#q", "q"], ["#fmin", "fmin"], ["#fmax", "fmax"], ...ADV]) if (h.has(k)) $(id).value = h.get(k);
  for (const k of ["type", "band", "cat", "cls"]) if (h.get(k)) S.chips[k] = new Set(h.get(k).split("|"));
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
