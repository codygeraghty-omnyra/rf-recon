"use strict";
/* RF Recon (beta), full web version: what differs from the PC app. Loaded after the PC app's own scripts
   (app/static): the Data & updates tab becomes Packs (the PC's own panels for keys, crowd data, imports and FCC IDs,
   with the packs on top), exports and files come through the page, and newer packs on the site are offered as the
   data updates. Everything else is the PC's code, run here by shim.js and the engine (pyworker.js, webhost.py). */
(() => {
window.welcome = null;  // the PC's first run downloads FCC files; here the first run is loading a pack (Packs tab)
delete LAYERS.repeaterbook; S.layerOn.delete("repeaterbook");  // off on the PC too (its policy discourages multi-source tools)
const chip = document.createElement("button");
chip.className = "hbtn"; chip.id = "packChip"; chip.title = "Data pack"; chip.textContent = "▣ Pack";
$("#missionChip").after(chip);
chip.onclick = () => setTab("data");
$('#tabs [data-t="data"]').textContent = "Packs";
const run = fn => { try { fn(); } catch (e) { $("#status").textContent = e.message; } };
// with work saved in this browser the PC's own export (captures and labels included); before that, the pack's rows
$("#csvBtn").onclick = () => RFPack.hasWork() ? getFile("/api/export.csv?" + exportParams()) : run(() => RFPack.exportFile("csv", exportParams()));
$("#kmlBtn").onclick = () => RFPack.hasWork() ? getFile("/api/export.kml?" + exportParams()) : run(() => RFPack.exportFile("kml", exportParams()));

// files the PC's code makes (exports, heatmap bundles, DAS job files): fetched through the page and saved or opened here,
// since a plain link to /api/ leaves the site
const fileName = (r, url) => (/filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") || "") || [])[1] || url.split("?")[0].split("/").pop();
window.getFile = async url => {
  $("#status").textContent = "Making the file…";
  const r = await fetch(url);
  if (!r.ok) { $("#status").textContent = (await r.json().catch(() => ({}))).error || `Couldn't make that file (${r.status}).`; return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await r.blob()); a.download = fileName(r, url);
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
  $("#status").textContent = `Saved ${a.download}.`;
};
document.addEventListener("click", async e => {
  const a = e.target.closest?.('a[href^="/api/"]');
  if (!a) return;
  e.preventDefault();
  const w = a.target === "_blank" ? window.open("", "_blank") : null;  // opened now, while the click still counts
  const r = await fetch(a.getAttribute("href"));
  if (!r.ok) { w?.close(); $("#status").textContent = (await r.json().catch(() => ({}))).error || `Couldn't open that file (${r.status}).`; return; }
  const href = URL.createObjectURL(await r.blob());
  if (w) w.location = href; else { const d = document.createElement("a"); d.href = href; d.download = fileName(r, a.href); document.body.append(d); d.click(); d.remove(); }
}, true);

const reload = () => { location.hash = "tab=map"; location.reload(); };
const updateNote = s => `Newer FCC data for ${s.name} is on the RF Recon site (made ${s.made_at}${s.fcc_built_at ? `, FCC files of ${s.fcc_built_at}` : ""}).`;

// replaces mission.js's start-up (connection checks and kit updates stay on the PC): runs once the page has its data
window.missionBoot = async () => {
  await RFPack.ready;
  const p = RFPack.info();
  chip.textContent = p ? `▣ ${p.name}` : "▣ No data pack";
  const nw = $('#modeSeg [data-m="nationwide"]');
  if (nw) { nw.textContent = "Whole pack"; nw.title = "Search licences anywhere in the pack by call sign, licensee, service or frequency"; }
  if (p) $("#meta").textContent = `Pack ${p.name} · ${$("#meta").textContent}`;
  else { $("#meta").textContent = "No data pack loaded yet: open Packs."; setTimeout(() => setTab("data"), 0); }
  RFPack.packUpdate().then(s => {  // the web version's data updates: a newer pack of the same area on the site
    if (!s) return;
    chip.innerHTML = `<span class="led busy"></span>${esc(p.name)} · update`;
    chip.title = updateNote(s) + " Open Packs to load it.";
  }).catch(() => {});
  try { const r = await api("/api/missions"); if (r.active) { await loadMission(r.active, true); if (parseLoc($("#loc").value)) runSearch(); } } catch (e) {}
};

const area = a => a?.areas ? a.areas.map(area).join(" + ") : a?.states ? a.states.join(", ") : a?.center ? (a.label || `${a.radius_mi} mi around ${a.center[0]}, ${a.center[1]}`) : "";
const pcData = S.views.data;  // the PC's Data & updates (mission.js): its keys, crowd, import and FCC ID panels serve here too
const PC_ONLY = ["Connection", "Automatic updates", "This copy of RF Recon", "Phone app: field packs", "Remote access", "Push to ATAK", "Data sources"];
const NOT_HERE = ["aisstream_key", "fcc_bdc_username"];  // live ships: aisstream allows server-side use only; carrier coverage: PC import
// Packs: the packs at once, then the PC's panels below them when the engine answers (with work kept here it may still be
// starting). The PC's panels redraw themselves through S.views.data(their own box): that box gets only them again.
S.views.data = async v => {
  if (v.id === "pcPanels") return pcPanels(v);
  v.innerHTML = '<div id="packPanels"></div><div id="pcPanels"><p class="status">Loading your keys and crowd data…</p></div>';
  await packPanels($("#packPanels"));
  await pcPanels($("#pcPanels"));
};
async function pcPanels(v) {
  try { await pcData(v); }
  catch (e) { if (v.isConnected) throw e; return; }  // the tab was left while the engine was still answering
  if (!v.isConnected) return;
  // hidden, not removed: their own code still fills them in a moment later
  for (const h of [...v.querySelectorAll(".panel > h3")]) if (PC_ONLY.some(t => h.textContent.startsWith(t))) h.parentElement.hidden = true;
  v.querySelectorAll(".grid2").forEach(g => { if ([...g.children].every(c => c.hidden)) g.hidden = true; });
  for (const f of NOT_HERE) v.querySelector(`[data-cred="${f}"]`)?.closest('div[style*="border-top"]')?.remove();
  const say = (sel, from, to) => { const el = [...v.querySelectorAll(sel)].find(x => x.innerHTML.includes(from)); if (el) el.innerHTML = el.innerHTML.replace(from, to); };
  say(".panel p.hint", "Free accounts of your own, kept only in this PC's database.", "Free accounts of your own, kept only in this browser (never sent anywhere but to the service they're for).");
  say(".panel h3", "Crowd / imported layers on this computer", "Crowd / imported layers in this browser");
  say(".panel p.hint", "Map tiles are cached as you view them, so areas you looked at before a trip keep working offline.", "SatNOGS stations come from a copy on the RF Recon site (SatNOGS Network, CC BY-SA 4.0), refreshed with the packs.");
  say("#fiMsg", "On the PC.", "Here the maker shows from the FCC's grantee list; the grants themselves come from the FCC, which answers RF Recon on the PC only.");
}
async function packPanels(v) {
  const packs = await RFPack.list(), p = RFPack.info(), other = packs.filter(x => x.id !== p?.id), upd = await RFPack.packUpdate().catch(() => null);
  v.innerHTML = (`
  <div class="grid2" style="margin-top:0">
    <div class="panel"><h3>Data pack in use</h3>${p ? `<p style="font-size:18px;margin:4px 0"><b>${esc(p.name)}</b></p>
      <div class="kvg"><div>Area</div><div>${esc(area(p.area))}</div><div>FCC data</div><div>${esc(p.fcc_built_at || "")}</div>
        <div>Pack made</div><div>${esc(p.made_at)}</div><div>Licences</div><div>${(p.counts?.licences || 0).toLocaleString()}</div>
        <div>Towers</div><div>${(p.counts?.towers || 0).toLocaleString()}</div>
        <div>Broadcast, NOAA, FAA</div><div>${(p.counts?.broadcast || 0).toLocaleString()}, ${p.counts?.noaa || 0}, ${(p.counts?.faa || 0).toLocaleString()}</div>
        <div>911 centres, microwave links</div><div>${p.counts?.psap == null ? "not in this pack (an older one)" : `${p.counts.psap.toLocaleString()}, ${(p.counts.mw_links || 0).toLocaleString()}`}</div>
        <div>Size</div><div>${(p.size / 1e6).toFixed(1)} MB (${Math.round(p.raw / 1e6)} MB open)</div></div>
      ${upd ? `<p style="margin:10px 0 0"><b>${esc(updateNote(upd))}</b></p><div class="row" style="margin-top:6px"><button class="primary" id="pkUpdate">Load the newer data (${upd.mb.toFixed(1)} MB)</button><span class="hint" id="pkUpdMsg"></span></div>`
        : `<p class="hint" style="margin:10px 0 0">Data updates: when the RF Recon site has newer FCC data for this area, it's offered here and on the pack's button at the top.</p>`}
      <div class="row" style="margin-top:10px"><button id="pkRemove" data-id="${esc(p.id)}">Remove from this browser</button></div>`
      : '<p class="status">No pack loaded yet. Load one below to start.</p>'}</div>
    <div class="panel"><h3>Load a pack</h3>
      <p class="hint" style="margin-top:0">Packs are in the RF Recon folder in Google Drive, under <b>field packs</b>. Download one from Drive,
        or pick it straight from your Google Drive folder, then choose it here. Only people the folder is shared with can see them.</p>
      <div class="row"><input type="file" id="pkFile" accept=".rfpack"><span class="hint" id="pkMsg"></span></div>
      <h3 style="margin-top:14px">Or a state from this site</h3>
      <p class="hint" style="margin-top:0">Every state's FCC data is kept on the RF Recon site. Search anywhere and its state loads by itself; or pick one here.</p>
      <div class="row"><select id="spSel" style="flex:1"><option value="">Getting the list…</option></select><button id="spLoad" class="primary">Load</button><span class="hint" id="spMsg"></span></div>
      ${other.length ? `<h3 style="margin-top:14px">Also in this browser</h3>${other.map(o => `<div class="row" style="justify-content:space-between">
        <span><b>${esc(o.name)}</b> <span class="hint">${esc(area(o.area))} · made ${esc(o.made_at)} · ${(o.size / 1e6).toFixed(1)} MB</span></span>
        <span><button data-use="${esc(o.id)}">Use</button> <button data-rm="${esc(o.id)}">Remove</button></span></div>`).join("")}` : ""}</div>
  </div>
  <div class="panel"><h3>About the web version</h3>
    <p class="hint" style="margin-top:0">This is RF Recon in your browser, run by the PC app's own code: every tab, from search and the map's layers to
      missions, captures, the field log, labels, DAS jobs, talk groups, your own layers and crowd data with your own keys. The first time you keep
      something here, RF Recon's engine loads in this browser (about 15 MB, once). A pack and everything you do here stay in this browser.
      Only these stay on the PC: live ships (aisstream allows its keys on a server only), the Signal ID Wiki and Artemis (their sites refuse web
      pages and their terms don't allow passing them on), FCC ID grant lists (the FCC refuses web pages; the maker still shows), and live Push
      to ATAK over your network (here it hands the package to ATAK instead). It works on a phone too; for one state kept on the phone with no
      signal at all, use <a href="../">RF Recon lite (beta)</a>, the phone app.</p></div>`);
  $("#pkFile").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    $("#pkMsg").textContent = `Opening ${f.name}…`;
    try { await RFPack.import(f); reload(); } catch (err) { $("#pkMsg").textContent = err.message; }
  };
  RFPack.sitePacks().then(list => { $("#spSel").innerHTML = list.length ? list.map(s => `<option value="${esc(s.st)}">${esc(s.name)} · ${s.mb.toFixed(1)} MB</option>`).join("")
    : '<option value="">The list isn\'t reachable: check the connection</option>'; });
  $("#spLoad").onclick = async () => {
    const s = (await RFPack.sitePacks()).find(x => x.st === $("#spSel").value); if (!s) return;
    $("#spMsg").textContent = `Downloading ${s.name}…`;
    try { await RFPack.loadSite(s); reload(); } catch (err) { $("#spMsg").textContent = err.message; }
  };
  if ($("#pkUpdate")) $("#pkUpdate").onclick = async () => {
    $("#pkUpdMsg").textContent = `Downloading ${upd.name}…`;
    try { await RFPack.loadSite(upd); reload(); } catch (err) { $("#pkUpdMsg").textContent = err.message; }
  };
  $("#pkRemove") && ($("#pkRemove").onclick = async e => { await RFPack.remove(e.target.dataset.id); location.reload(); });
  v.querySelectorAll("[data-use]").forEach(b => b.onclick = async () => { await RFPack.use(b.dataset.use); reload(); });
  v.querySelectorAll("[data-rm]").forEach(b => b.onclick = async () => { await RFPack.remove(b.dataset.rm); packPanels(v); });
};

if ("serviceWorker" in navigator) navigator.serviceWorker.register("../sw.js").catch(() => {});  // opens with no signal next time
})();
