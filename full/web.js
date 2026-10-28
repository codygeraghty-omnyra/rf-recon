"use strict";
/* RF Recon (beta), full web version: what differs from the PC app. Loaded after the PC app's own scripts
   (app/static), so it can swap the Mission and Data & updates tabs for a Packs tab and point exports at the
   browser. Missions, captures, crowd data and data updates stay in RF Recon on the PC. */
(() => {
for (const k of ["uls_hist", "captures", "wigle", "opencellid", "repeaterbook", "custom", "ttn", "satnogs", "wspr", "pskreporter"]) {  // PC-only sources: never in a pack
  delete LAYERS[k]; S.layerOn.delete(k);
}
const chip = document.createElement("button");
chip.className = "hbtn"; chip.id = "packChip"; chip.title = "Data pack"; chip.textContent = "▣ Pack";
$("#missionChip").after(chip);
chip.onclick = () => setTab("data");
$('#tabs [data-t="mission"]').style.display = "none";
const dasTab = $('#tabs [data-t="das"]');  // DAS jobs, contacts and job files live on the PC's server
if (dasTab) dasTab.style.display = "none";
const cellTab = $('#tabs [data-t="cells"]');  // cell sites come from crowd data and captures, which packs never carry
if (cellTab) cellTab.style.display = "none";
$('#tabs [data-t="data"]').textContent = "Packs";
const run = fn => { try { fn(); } catch (e) { $("#status").textContent = e.message; } };
$("#csvBtn").onclick = () => run(() => RFPack.exportFile("csv", exportParams()));
$("#kmlBtn").onclick = () => run(() => RFPack.exportFile("kml", exportParams()));

// replaces mission.js's start-up (missions, connection checks): runs once the page has its data
window.missionBoot = async () => {
  await RFPack.ready;
  const p = RFPack.info();
  chip.textContent = p ? `▣ ${p.name}` : "▣ No data pack";
  const nw = $('#modeSeg [data-m="nationwide"]');
  if (nw) { nw.textContent = "Whole pack"; nw.title = "Search licences anywhere in the pack by call sign, licensee, service or frequency"; }
  if (p) $("#meta").textContent = `Pack ${p.name} · ${$("#meta").textContent}`;
  else { $("#meta").textContent = "No data pack loaded yet: open Packs."; setTimeout(() => setTab("data"), 0); }
};

const area = a => a?.areas ? a.areas.map(area).join(" + ") : a?.states ? a.states.join(", ") : a?.center ? (a.label || `${a.radius_mi} mi around ${a.center[0]}, ${a.center[1]}`) : "";
S.views.mission = v => { v.innerHTML = '<p class="status">Missions and captures are kept in RF Recon on the PC.</p>'; };
S.views.data = async v => {
  const packs = await RFPack.list(), p = RFPack.info(), other = packs.filter(x => x.id !== p?.id);
  v.innerHTML = `
  <div class="grid2" style="margin-top:0">
    <div class="panel"><h3>Data pack in use</h3>${p ? `<p style="font-size:18px;margin:4px 0"><b>${esc(p.name)}</b></p>
      <div class="kvg"><div>Area</div><div>${esc(area(p.area))}</div><div>FCC data</div><div>${esc(p.fcc_built_at || "")}</div>
        <div>Pack made</div><div>${esc(p.made_at)}</div><div>Licences</div><div>${(p.counts?.licences || 0).toLocaleString()}</div>
        <div>Towers</div><div>${(p.counts?.towers || 0).toLocaleString()}</div>
        <div>Broadcast, NOAA, FAA</div><div>${(p.counts?.broadcast || 0).toLocaleString()}, ${p.counts?.noaa || 0}, ${(p.counts?.faa || 0).toLocaleString()}</div>
        <div>Size</div><div>${(p.size / 1e6).toFixed(1)} MB (${Math.round(p.raw / 1e6)} MB open)</div></div>
      <div class="row" style="margin-top:10px"><button id="pkRemove" data-id="${esc(p.id)}">Remove from this browser</button></div>`
      : '<p class="status">No pack loaded yet. Load one below to start.</p>'}</div>
    <div class="panel"><h3>Load a pack</h3>
      <p class="hint" style="margin-top:0">Packs are in the RF Recon folder in Google Drive, under <b>field packs</b>. Download one from Drive,
        or pick it straight from your Google Drive folder, then choose it here. Only people the folder is shared with can see them.</p>
      <div class="row"><input type="file" id="pkFile" accept=".rfpack"><span class="hint" id="pkMsg"></span></div>
      ${other.length ? `<h3 style="margin-top:14px">Also in this browser</h3>${other.map(o => `<div class="row" style="justify-content:space-between">
        <span><b>${esc(o.name)}</b> <span class="hint">${esc(area(o.area))} · made ${esc(o.made_at)} · ${(o.size / 1e6).toFixed(1)} MB</span></span>
        <span><button data-use="${esc(o.id)}">Use</button> <button data-rm="${esc(o.id)}">Remove</button></span></div>`).join("")}` : ""}</div>
  </div>
  <div class="panel"><h3>About the web version</h3>
    <p class="hint" style="margin-top:0">This is RF Recon in your browser, working from one area's pack: search, every map layer, the Area report,
      Analyzer, Dashboard, Topology, Site profile, Agencies, Spectrum, heatmaps and exports, plus any transmitter's coverage (hills counted
      when you're online) and what it's networked with. Missions, captures, crowd data (WiGLE, OpenCelliD, RepeaterBook), cell sites,
      DAS jobs, talk groups, the Signal ID Wiki catalog and data updates stay in RF Recon on the PC. A pack and everything you do here
      stay in this browser; nothing is sent anywhere. On a phone, use <a href="../">the phone version</a>.</p></div>`;
  const reload = () => { location.hash = "tab=map"; location.reload(); };
  $("#pkFile").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    $("#pkMsg").textContent = `Opening ${f.name}…`;
    try { await RFPack.import(f); reload(); } catch (err) { $("#pkMsg").textContent = err.message; }
  };
  $("#pkRemove") && ($("#pkRemove").onclick = async e => { await RFPack.remove(e.target.dataset.id); location.reload(); });
  v.querySelectorAll("[data-use]").forEach(b => b.onclick = async () => { await RFPack.use(b.dataset.use); reload(); });
  v.querySelectorAll("[data-rm]").forEach(b => b.onclick = async () => { await RFPack.remove(b.dataset.rm); S.views.data(v); });
};

if ("serviceWorker" in navigator) navigator.serviceWorker.register("../sw.js").catch(() => {});  // opens with no signal next time
})();
