"use strict";
/* DAStastic (beta), full web version: what differs from the PC app. Loaded after the PC app's own scripts
   (app/static): the Data & updates tab becomes Packs (the PC's own panels for keys, crowd data, imports and FCC IDs,
   with the packs on top), exports and files come through the page, and newer packs on the site are offered as the
   data updates. Everything else is the PC's code, run here by shim.js and the engine (pyworker.js, webhost.py). */
(() => {
window.welcome = null;  // the PC's first run downloads FCC files; here the first run is loading a pack (Packs tab)
delete LAYERS.repeaterbook; S.layerOn.delete("repeaterbook");  // off on the PC too (its policy discourages multi-source tools)
delete LAYERS.boosters; S.layerOn.delete("boosters");  // the FCC's booster registrations load on the PC and the server, not into packs
const chip = document.createElement("button");
chip.className = "hbtn"; chip.id = "packChip"; chip.title = "Data pack"; chip.textContent = "▣ Pack";
$("#missionChip").after(chip);
chip.onclick = () => setTab("data");
$('#tabs [data-t="data"]').textContent = "Packs";
// Packs reads the pin: a first visit types its place in the pin bar there and the state's pack comes for it. So the bar
// stays on it here, where the PC's Data & updates hides it (core.js NO_PIN_TABS, UX review 11/8 #1)
NO_PIN_TABS.delete("data");
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
const updateNote = s => `Newer FCC data for ${s.name} is on the DAStastic site (made ${s.made_at}${s.fcc_built_at ? `, FCC files of ${s.fcc_built_at}` : ""}).`;

// replaces mission.js's start-up (connection checks and kit updates stay on the PC): runs once the page has its data
window.missionBoot = async () => {
  await RFPack.ready;
  const p = RFPack.info();
  chip.textContent = p ? `▣ ${p.name}` : "▣ No data pack";
  const nw = $('#modeSeg [data-m="nationwide"]');
  if (nw) { nw.textContent = "Whole pack"; nw.title = "Search licences anywhere in the pack by call sign, licensee, service or frequency"; }
  if (p) $("#meta").textContent = `Pack ${p.name} · ${$("#meta").textContent}`;
  else {
    $("#meta").textContent = "No data pack loaded yet: open Packs.";
    // a link with a pin keeps its pin and tab: jumping to Packs rewrote the address before boot read it (web_tabs_check 11/7)
    const h = new URLSearchParams(location.hash.slice(1));
    if (!(h.get("lat") && h.get("lon"))) setTimeout(() => setTab("data"), 0);
  }
  RFPack.packUpdate().then(s => {  // the web version's data updates: a newer pack of the same area on the site
    if (!s) return;
    chip.innerHTML = `<span class="led busy"></span>${esc(p.name)} · update`;
    chip.title = updateNote(s) + " Open Packs to load it.";
  }).catch(() => {});
  try { const r = await api("/api/missions"); if (r.active) { await loadMission(r.active, true); if (parseLoc($("#loc").value)) runSearch(); } } catch (e) {}
};

const area = a => a?.areas ? a.areas.map(area).join(" + ") : a?.states ? a.states.join(", ") : a?.center ? (a.label || `${a.radius_mi} mi around ${a.center[0]}, ${a.center[1]}`) : "";
const pcData = S.views.data;  // the PC's Data & updates (mission.js): its keys, crowd, import and FCC ID panels serve here too
const PC_ONLY = ["Connection", "Automatic updates", "Ways in", "This copy of DAStastic", "Phone app: field packs", "Remote access", "Push to ATAK", "Data sources"];
const NOT_HERE = ["aisstream_key", "fcc_bdc_username"];  // live ships: aisstream allows server-side use only; carrier coverage: PC import
// Packs: the packs at once, then the PC's panels below them when the engine answers (with work kept here it may still be
// starting). The PC's panels redraw themselves through S.views.data(their own box): that box gets only them again.
S.views.data = async v => {
  if (v.id === "pcPanels") return pcPanels(v);
  v.innerHTML = '<div id="packPanels"></div><div id="pcPanels"><p class="status">Loading your keys and crowd data…</p></div>';
  await packPanels($("#packPanels"));
  if ($("#pcPanels")) await pcPanels($("#pcPanels"));
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
  say(".panel p.hint", "Free accounts of your own, sealed for your Windows account on this PC, outside every database file, so no copy, kit or backup carries them.","Free accounts of your own, kept only in this browser (never sent anywhere but to the service they're for).");
  say(".panel h3", "Crowd / imported layers on this computer", "Crowd / imported layers in this browser");
  // the PC's map note (mission.js) as the web version has it: USGS maps only, kept in this browser (11/11 follow-up review:
  // e813ff3 changed the text looked for, so nothing matched and the PC's Street and Esri note showed)
  say(".panel p.hint", "The USGS maps and county lines you view are kept on this PC, so areas you looked at before a trip keep working with no signal. Street (OpenStreetMap) and Esri's hi-res satellite are for use with signal only (their terms don't allow keeping them for offline use): with no signal the map shows USGS Topo instead.", "The web version shows the USGS maps only, and keeps the ones you view in this browser, so areas you looked at before a trip keep working with no signal. SatNOGS stations come from a copy on the DAStastic site (SatNOGS Network, CC BY-SA 4.0), refreshed with the packs.");
  say("#fiMsg", "On the PC.", "The maker shows from the FCC's grantee list, and the grants open in your browser.");
}
async function packPanels(v) {
  const packs = await RFPack.list(), p = RFPack.info(), other = packs.filter(x => x.id !== p?.id), upd = await RFPack.packUpdate().catch(() => null);
  if (!v.isConnected) return;  // left already (a first visit opens Packs, then the map once the state's pack arrives)
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
        : `<p class="hint" style="margin:10px 0 0">Data updates: when the DAStastic site has newer FCC data for this area, it's offered here and on the pack's button at the top.</p>`}
      <div class="row" style="margin-top:10px"><button id="pkRemove" data-id="${esc(p.id)}">Remove from this browser</button></div>`
      : '<p class="status">No pack loaded yet. Load one below to start.</p>'}</div>
    <div class="panel"><h3>Load a pack</h3>
      <p class="hint" style="margin-top:0">A pack made on Cody's PC is in the DAStastic folder in Google Drive, under <b>field packs</b> (only people the
        folder is shared with see it); one made on the server is downloaded there by the admin. Pick the .rfpack file here.</p>
      <div class="row"><input type="file" id="pkFile" accept=".rfpack"><span class="hint" id="pkMsg"></span></div>
      <h3 style="margin-top:14px">Or a state from this site</h3>
      <p class="hint" style="margin-top:0">Every state's FCC data is kept on the DAStastic site. Search anywhere and its state loads by itself; or pick one here.</p>
      <div class="row"><select id="spSel" style="flex:1"><option value="">Getting the list…</option></select><button id="spLoad" class="primary">Load</button><span class="hint" id="spMsg"></span></div>
      ${other.length ? `<h3 style="margin-top:14px">Also in this browser</h3>${other.map(o => `<div class="row" style="justify-content:space-between">
        <span><b>${esc(o.name)}</b> <span class="hint">${esc(area(o.area))} · made ${esc(o.made_at)} · ${(o.size / 1e6).toFixed(1)} MB</span></span>
        <span><button data-use="${esc(o.id)}">Use</button> <button data-rm="${esc(o.id)}">Remove</button></span></div>`).join("")}` : ""}</div>
  </div>
  <div class="panel"><h3>With no signal</h3><p style="margin-top:0" id="offMsg">${esc(offlineNote())}</p>
    <div class="row"><button id="offKeep">Keep it again</button><span class="hint">The page, its research, DAStastic's own code and the engine stay in this browser, so DAS jobs open, change and save in a basement. Your work is kept here either way.</span></div></div>
  <div class="panel" id="updPanel"><h3>Updates</h3>
    <label class="row" style="gap:10px;align-items:center;cursor:pointer"><input type="checkbox" id="wuAuto" ${WebUpdate.auto() ? "checked" : ""}>
      <span><b>Update by itself</b> <span class="hint">On: a new version takes over as soon as it's downloaded. Off: it waits until you press Update now, so nothing changes mid-job. The same choice covers DAStastic lite in this browser.</span></span></label>
    <div class="row" style="margin-top:8px">${WebUpdate.waiting() ? '<button class="primary" id="wuNow">Update now</button>' : ""}<button id="wuCheck">Check for updates</button><span class="hint" id="wuMsg">${WebUpdate.waiting() ? "A new version is downloaded and waiting." : ""}</span></div></div>
  <div class="panel"><h3>About the web version</h3>
    <p class="hint" style="margin-top:0">This is DAStastic in your browser, run by the PC app's own code: every tab, from search and the map's layers to
      missions, captures, the field log, labels, DAS jobs, talk groups, your own layers and crowd data with your own keys. The first time you keep
      something here, DAStastic's engine loads in this browser (about 15 MB, once). A pack and everything you do here stay in this browser.
      Signal ID Wiki matches aren't here: the web version is the sold build, which leaves the wiki out until its terms are settled.
      Only these stay on the PC: live ships (aisstream allows its keys on a server only), Artemis (its database is for
      internal use only), FCC ID grant lists (the FCC refuses web pages; the maker still shows and the grants open in your browser), live
      Push to ATAK over your network (here it hands the package to ATAK instead), and in DAS Materials, fetching a spec sheet from a maker's
      page or re-reading a supplier's price list link (most of their sites don't let a web page read their files: save the file and upload it
      here), sending email from your own mailbox and filing the replies (DAS Mail; here each email button opens your mail app), and the
      national building inventory lookup (NSI). DAS Prospects' schools, colleges and hospitals come in the pack (packs made since 11/4), not the PC's monthly download. Online
      part prices from Mouser and Digi-Key work here with your own keys. It works on a phone too; for one state kept on the phone with no
      signal at all, use <a href="../">DAStastic lite (beta)</a>, the phone app.</p></div>`);
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
  $("#wuAuto").onchange = async e => { await WebUpdate.setAuto(e.target.checked); $("#wuMsg").textContent = e.target.checked ? "It updates by itself." : "New versions wait for Update now."; };
  $("#wuCheck").onclick = async () => { $("#wuMsg").textContent = "Checking…"; $("#wuMsg").textContent = await WebUpdate.check(); };
  if ($("#wuNow")) $("#wuNow").onclick = () => WebUpdate.now();
  $("#offKeep").onclick = async e => { e.currentTarget.disabled = true; $("#offMsg").textContent = "Keeping it…";
    await RFOffline.keep().catch(() => {}); if ($("#offMsg")) { $("#offMsg").textContent = offlineNote(); $("#offKeep").disabled = false; } };
  $("#pkRemove") && ($("#pkRemove").onclick = async e => { await RFPack.remove(e.target.dataset.id); location.reload(); });
  v.querySelectorAll("[data-use]").forEach(b => b.onclick = async () => { await RFPack.use(b.dataset.use); reload(); });
  v.querySelectorAll("[data-rm]").forEach(b => b.onclick = async () => { await RFPack.remove(b.dataset.rm); packPanels(v); });
};

// DAS Prospects (dasprospects.js): here the lists come in the pack (fieldpack.py, webhost.py), not the PC's monthly
// download. Its own words are swapped as it writes them (each is gone once swapped, so this never loops).
const prSay = () => {
  const src = $("#prSrc"), p = RFPack.info();
  if (src?.textContent.includes("aren't downloaded on this computer yet"))
    src.innerHTML = `The pack in use (${esc(p?.name || "none")}) has no prospect lists: it was made before they went into packs (11/4). Load a newer pack of this area (Packs), or use DAStastic on the PC or server, which downloads the lists itself.`;
  else if (src?.textContent.includes("refreshes them monthly"))
    src.innerHTML = src.innerHTML.replace(/; the "DAS prospect lists" update refreshes them monthly\./, `; they came with the pack in use (${esc(p?.name || "")}, made ${esc(p?.made_at || "")}), so a newer pack brings newer lists.`);
  const none = [...document.querySelectorAll("#prBody p.hint")].find(x => x.textContent.includes("(the lists aren't downloaded yet)"));
  if (none) none.textContent = none.textContent.replace("(the lists aren't downloaded yet)", "(this pack has no prospect lists)");
};
new MutationObserver(() => { if ($("#prSrc")) prSay(); }).observe(document.body, {childList: true, subtree: true});

// kept for use with no signal (11/4): every visit asks the service worker (../sw.js) to keep what full/offline.json
// lists and isn't kept yet: the page, its research, the app's Python and the engine (about 16 MB, once; it outlives
// builds). Data Saver on: only when asked (Packs, With no signal). What was kept is said in Packs.
const OFF_KEY = "rfr.offline";
function offlineNote() {
  let s = null; try { s = JSON.parse(localStorage.getItem(OFF_KEY) || "null"); } catch (e) {}
  if (!("serviceWorker" in navigator)) return "This browser can't keep the web version for use with no signal.";
  if (!s) return navigator.connection?.saveData ? "Not kept for use with no signal: Data Saver is on. Keep it here when you're on Wi-Fi." : "Being kept for use with no signal…";
  if (s.error) return `Not kept for use with no signal: ${s.error}.`;
  const mb = n => (n / 1e6).toFixed(1);
  return s.files < s.of ? `${s.files} of ${s.of} files kept for use with no signal; ${s.of - s.files} weren't reachable (${s.failed.join(", ")}). Keep it again with signal.`
    : `Kept for use with no signal: ${s.files} files, ${mb(s.bytes)} MB, the engine ${mb(s.engine_bytes)} MB of it (checked ${s.at.slice(0, 16).replace("T", " ")}).`;
}
async function keepOffline() {
  const reg = await navigator.serviceWorker.ready, ch = new MessageChannel();
  const got = new Promise(ok => { ch.port1.onmessage = e => ok(e.data); });
  reg.active.postMessage({kind: "keep-full", list: new URL("offline.json", location.href).href}, [ch.port2]);
  const s = await got;
  let was = null; try { was = JSON.parse(localStorage.getItem(OFF_KEY) || "null"); } catch (e) {}
  if (!(s.error && was && !was.error)) try { localStorage.setItem(OFF_KEY, JSON.stringify(s)); } catch (e) {}  // offline: the last good word stays
  return s;
}
window.RFOffline = {keep: keepOffline, note: offlineNote, ready: null};
// Updates (Cody 11/7 item 7): the same worker and the same choice as DAStastic lite on this site (../sw.js reads it from Cache
// Storage, rfr-prefs). Auto-update on: a new version takes over by itself and a line says so; off: it waits for Update now.
const WU = {reg: null, reloading: false, said: ""};
const WebUpdate = {
  auto: () => { try { return localStorage.getItem("rfr.autoUpdate") !== "0"; } catch (e) { return true; } },
  async tellWorker() { try { await (await caches.open("rfr-prefs")).put("__prefs.json", new Response(JSON.stringify({auto: WebUpdate.auto()}))); } catch (e) { /* the worker keeps its default (auto) */ } },
  async setAuto(on) { try { localStorage.setItem("rfr.autoUpdate", on ? "1" : "0"); } catch (e) {} await WebUpdate.tellWorker(); if (on && WU.reg?.waiting) WebUpdate.now(); },
  waiting: () => !!WU.reg?.waiting,
  async check() {
    if (!WU.reg) return "This browser doesn't keep the web version, so there's nothing to update: reload for the newest.";
    try { await WU.reg.update(); } catch (e) { return "Couldn't reach the DAStastic site: try again with signal."; }
    return WU.reg.installing || WU.reg.waiting ? "A new version is downloading…" : "You have the newest version.";
  },
  now() { const w = WU.reg?.waiting; if (!w) { location.reload(); return; } WU.reloading = true; w.postMessage({kind: "update-now"}); },
};
function wuBanner(text, label, act) {  // one line at the foot of the page, with its button; it goes when pressed or closed
  let b = document.getElementById("wuBanner");
  if (!b) { b = document.createElement("div"); b.id = "wuBanner"; b.setAttribute("role", "status");
    b.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9999;display:flex;gap:10px;align-items:center;padding:10px 14px;border-radius:14px;background:var(--panel,#1e1a16);color:var(--ink,#eee);border:1px solid var(--line,#555);box-shadow:0 8px 30px rgba(0,0,0,.35);max-width:calc(100% - 24px);font-size:14px";
    document.body.append(b); }
  b.innerHTML = `<span>${esc(text)}</span><button type="button" class="primary" id="wuAct">${esc(label)}</button><button type="button" id="wuX" aria-label="Close">✕</button>`;
  b.querySelector("#wuAct").onclick = () => { b.remove(); act(); };
  b.querySelector("#wuX").onclick = () => b.remove();
}
if ("serviceWorker" in navigator) {
  const hadWorker = !!navigator.serviceWorker.controller;
  WebUpdate.tellWorker();
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (WU.reloading) location.reload(); });
  navigator.serviceWorker.register("../sw.js").then(reg => {  // opens with no signal next time
    WU.reg = reg;
    const ready = () => { if (WU.said) return; WU.said = "ready"; wuBanner("A new version of DAStastic is ready.", "Update now", () => WebUpdate.now()); };
    if (reg.waiting && hadWorker) ready();
    reg.addEventListener("updatefound", () => {
      const nw = reg.installing;
      nw?.addEventListener("statechange", () => {
        if (nw.state === "installed" && reg.waiting && hadWorker && !WebUpdate.auto()) ready();
        if (nw.state === "activated" && hadWorker && !WU.reloading) wuBanner("DAStastic was updated.", "Reload", () => location.reload());
      });
    });
  }).catch(() => {});
  if (!navigator.connection?.saveData) RFOffline.ready = (document.readyState === "complete" ? Promise.resolve() : new Promise(ok => addEventListener("load", ok))).then(keepOffline)
    .then(() => { if ($("#offMsg")) $("#offMsg").textContent = offlineNote(); }).catch(e => console.warn("DAStastic: not kept for offline use", e));
}
})();
