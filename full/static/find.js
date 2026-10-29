"use strict";
/* RF Recon — Search: one box over everything RF Recon holds (Ctrl+K from anywhere). Results come grouped by kind,
   nearest to the pin first, the matching words marked, each with a way to go there: the map (and the emitter's
   network or coverage), the DAS job and the field that matched, the mission, the file. The DAS tab's Find box uses
   the same results for its own data (findRender). */

const FIND_SCOPES = [["", "Everything"], ["places", "Places"], ["licences,frequency,labels,talkgroups", "Licences & frequencies"], ["towers", "Towers"],
  ["psap", "911 centres"], ["broadcast,aviation,noaa", "Broadcast, aviation, NOAA"], ["microwave", "Microwave"], ["survey", "Surveys & crowd"],
  ["missions", "Missions"], ["das,das_contacts,das_log,das_files,research", "DAS & research"]];
const FIND_ICON = {place: "⌖", licence: "📻", tower: "🗼", psap: "☎", broadcast: "📡", faa: "✈", noaa: "⛈", mwlink: "↔", talkgroup: "#", capture: "◉",
  crowd: "◌", mission: "⚑", dasjob: "🏢", dascontact: "👤", dasfile: "📄", research: "📚", grantee: "🏭"};

function findMark(text, q){
  let s = esc(text ?? "");
  for(const w of (q || "").split(/\s+/).filter(x => x.length > 1).slice(0, 6)){
    const rx = new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    s = s.replace(/(<[^>]*>)|([^<]+)/g, (m, tag, txt) => tag || txt.replace(rx, "<mark>$1</mark>"));
  }
  return s;
}

// go to a result on the map: the pin there, a small search, then the emitter's dot (or its network / coverage)
async function findGo(it, then){
  if(it.lat == null){ $("#status").textContent = "That result has no location on file."; return; }
  if(S.mode !== "point" && typeof setMode === "function") setMode("point");
  $("#loc").value = `${(+it.lat).toFixed(5)}, ${(+it.lon).toFixed(5)}`;
  if(+$("#radius").value > 3 || !$("#radius").value) $("#radius").value = 2;
  S.tab = "map"; await runSearch();
  const near = S.rows.filter(r => r.lat != null && Math.abs(r.lat - it.lat) < 2e-4 && Math.abs(r.lon - it.lon) < 2e-4);
  const row = (it.call_sign && (near.find(r => r.call_sign === it.call_sign) || S.rows.find(r => r.call_sign === it.call_sign))) || near[0];
  if(then && row) then(row);
  else if(row && window.emitSpot){ selectFeature(row, true); emitSpot(near.length ? near : [row]); }
}

function findActions(it){
  const b = (act, label) => `<button data-act="${act}">${label}</button>`;
  switch(it.kind){
    case "place": return b("go", "Go there");
    case "licence": return b("map", "On the map") + (it.call_sign ? b("net", "Network") : "") + b("cov", "Coverage");
    case "tower": case "psap": case "broadcast": case "faa": case "noaa": case "capture": case "crowd": return b("map", "On the map");
    case "mwlink": return b("mw", "On the map");
    case "talkgroup": return b("sys", "Search this system");
    case "grantee": return b("fccid", "Its FCC IDs");
    case "mission": return b("mission", "Open Mission tab");
    case "dasjob": return b("job", "Open the job");
    case "dascontact": return b("contacts", "Open contacts");
    case "dasfile": return `<a href="${esc(it.url)}" target="_blank" rel="noopener">Open file ↗</a>` + (it.job_id ? b("job", "Open the job") : "");
    default: return "";
  }
}

function findItem(it, q){
  const facts = (it.facts || []).map(f => `<span class="tag">${findMark(f, q)}</span>`).join(" ");
  const matches = it.matches ? `<div style="margin-top:4px">${it.matches.map(m => `<div class="hint"><b>${esc(m.field)}</b> · ${findMark(m.text, q)}</div>`).join("")}${it.match_count > it.matches.length ? `<div class="hint">+${it.match_count - it.matches.length} more matches in this job</div>` : ""}</div>` : "";
  const fields = it.fields ? `<div class="kvg" style="margin-top:4px">${Object.entries(it.fields).map(([k, v]) => `<div>${esc(k.replace(/_/g, " "))}</div><div>${findMark(v, q)}</div>`).join("")}</div>` : "";
  const links = it.links?.length ? `<div class="hint" style="margin-top:4px">Sources: ${it.links.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)} ↗</a>`).join(" · ")}</div>` : "";
  return `<div class="fd-item" style="display:grid;grid-template-columns:28px 1fr auto;gap:10px;align-items:start;padding:9px 4px;border-top:1px solid var(--line)">
    <div style="font-size:18px;line-height:1.2;text-align:center">${FIND_ICON[it.kind] || "•"}</div>
    <div style="min-width:0"><div style="font-weight:600">${findMark(it.title, q)}</div><div class="hint">${findMark(it.sub, q)}</div>
      ${facts ? `<div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap">${facts}</div>` : ""}${matches}${fields}${links}</div>
    <div style="text-align:right;white-space:nowrap">${it.dist_mi != null ? `<div class="mono hint" style="margin-bottom:4px">${num(it.dist_mi, 1)} mi</div>` : ""}<div class="row" style="gap:4px;justify-content:flex-end">${findActions(it)}</div></div></div>`;
}

// grouped results into `el`; used by the Search tab and the DAS tab's Find
window.findRender = (el, res, q) => {
  const gs = res.groups || [];
  if(!gs.length){ el.innerHTML = `<p class="status">Nothing matches “${esc(q)}”.${(res.notes || []).map(n => ` ${esc(n)}`).join("")}</p>`; return; }
  const total = gs.reduce((a, g) => a + g.count, 0);
  el.innerHTML = `<div class="row" style="gap:6px;flex-wrap:wrap;margin:6px 2px 10px"><b style="margin-right:6px">${total.toLocaleString()} result${total === 1 ? "" : "s"}</b>
      ${gs.map(g => `<a href="#" class="chip" data-jump="${esc(g.key)}">${esc(g.label)} <b>${g.count}${g.more ? "+" : ""}</b></a>`).join("")}
      ${res.took_ms != null ? `<span class="hint" style="margin-left:auto">${res.took_ms} ms</span>` : ""}</div>
    ${(res.notes || []).map(n => `<p class="hint">${esc(n)}</p>`).join("")}
    ${gs.map(g => `<div class="panel" id="fd-${esc(g.key)}" style="margin-top:10px"><h3 style="margin:0 0 2px">${esc(g.label)} <span class="hint">· ${g.count}${g.more ? "+" : ""}${g.items.length < g.count ? `, showing ${g.items.length}` : ""}</span></h3>
      ${g.items.map((it, i) => `<div data-g="${esc(g.key)}" data-i="${i}">${findItem(it, q)}</div>`).join("")}</div>`).join("")}`;
  el.querySelectorAll("[data-jump]").forEach(a => a.onclick = e => { e.preventDefault(); document.getElementById("fd-" + a.dataset.jump)?.scrollIntoView({behavior: "smooth", block: "start"}); });
  el.querySelectorAll("[data-act]").forEach(b => b.onclick = async () => {
    const box = b.closest("[data-g]"), it = gs.find(g => g.key === box.dataset.g).items[+box.dataset.i], act = b.dataset.act;
    if(act === "go" || act === "map") await findGo(it);
    else if(act === "net") await findGo(it, row => emitOpen(row, "network"));
    else if(act === "cov") await findGo(it, row => emitOpen(row, "coverage"));
    else if(act === "mw"){ const p = mapPrefs(); if(!p.overlays.includes("Microwave backhaul (FCC)")) p.overlays.push("Microwave backhaul (FCC)"); await findGo(it); }
    else if(act === "sys"){ S.find.q = it.system; setTab("find"); }
    else if(act === "fccid"){ S.pendingFccid = it.code; setTab("data"); }  // Data & updates looks it up
    else if(act === "mission") setTab("mission");
    else if(act === "job"){ S.das = S.das || {view: "board", q: ""}; Object.assign(S.das, {job: it.job_id, sub: it.open_sub || "overview"}); setTab("das"); }
    else if(act === "contacts"){ S.das = S.das || {q: ""}; Object.assign(S.das, {job: null, view: "contacts"}); setTab("das"); }
  });
};

S.views.find = v => {
  const F = S.find = S.find || {q: "", scope: "", res: null};
  v.innerHTML = `<div class="panel" style="margin-top:0">
      <div class="row" style="gap:10px;align-items:center;flex-wrap:wrap">
        <input id="fdQ" value="${esc(F.q)}" autocomplete="off" placeholder="Search everything: call sign, licensee, 851.7125, town, tower owner or ASR number, 911 centre, talk group, DAS job, code rule…"
          style="flex:1;min-width:260px;font-size:16px;padding:10px 14px"><span class="hint">Ctrl+K from anywhere</span></div>
      <div class="seg" id="fdScope" style="margin-top:8px;flex-wrap:wrap">${FIND_SCOPES.map(([k, l]) => `<button data-sc="${k}" class="${F.scope === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <p class="hint" id="fdMsg" style="margin:8px 0 0">${S.center ? `Nearest to the pin first.` : "Drop a pin to sort results by distance."}</p></div>
    <div id="fdOut"></div>`;
  const out = $("#fdOut"), inp = $("#fdQ");
  const run = async () => {
    const q = inp.value.trim(); F.q = q;
    if(q.length < 2){ out.innerHTML = ""; return; }
    $("#fdMsg").textContent = "Searching…";
    const gen = F.gen = (F.gen || 0) + 1;
    try{
      const p = new URLSearchParams({q}); if(F.scope) p.set("scope", F.scope); if(S.center){ p.set("lat", S.center[0]); p.set("lon", S.center[1]); }
      const res = await api("/api/find?" + p); if(gen !== F.gen) return;
      F.res = res; findRender(out, res, q);
      $("#fdMsg").textContent = S.center ? "Nearest to the pin first." : "Drop a pin to sort results by distance.";
      if(res.index === "building") setTimeout(() => { if(S.tab === "find" && F.q === q) run(); }, 15000);
    }catch(e){ if(gen === F.gen) $("#fdMsg").textContent = e.message; }
  };
  let t; inp.oninput = () => { clearTimeout(t); t = setTimeout(run, 350); };
  inp.onkeydown = e => { if(e.key === "Enter"){ clearTimeout(t); run(); } };
  $("#fdScope").onclick = e => { const b = e.target.closest("[data-sc]"); if(!b) return; F.scope = b.dataset.sc;
    $$("#fdScope button").forEach(x => x.classList.toggle("on", x === b)); run(); };
  inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
  if(F.q) { if(F.res && F.res.query === F.q) findRender(out, F.res, F.q); else run(); }
};

// Ctrl+K (or ⌘K) opens Search from anywhere
document.addEventListener("keydown", e => {
  if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k"){ e.preventDefault(); if(S.tab !== "find") setTab("find"); else $("#fdQ")?.focus(); }
});
