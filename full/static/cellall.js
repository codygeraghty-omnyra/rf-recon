"use strict";
/* DAStastic — the area's cell sites on every main tab (Cody 11/6: "have cell be shown in each tab showing all the data", the
   main tabs, mock-up picked). Search, Area report, Analyzer, Dashboard, Site profile and Agencies list each cell site in the
   area (carrier, technology, tower, bands licensed here, cells, PCI heard, last seen), and each opens to its full public record
   (the FCC licence at the site, every band and channel each way, everything on its tower: emitter.js emCellLicensed). Spectrum
   shows the carriers' licensed blocks by frequency; Topology shows each tower with its carriers and cells (cells.js towersHtml).
   Read only: it asks /api/cells for what's already kept and never fetches new cells (the Cell sites tab does that, once per
   area, under OpenCelliD's daily limit). Loads last, so every tab's view is already registered. */
(() => {
  const TABS = {find: "list", report: "list", analyzer: "list", dashboard: "list", profile: "list", agencies: "list", spectrum: "spectrum", topology: "topology"};
  const cache = new Map();
  let obs = null, box = null;
  const key = () => `${S.center[0].toFixed(5)},${S.center[1].toFixed(5)},${S.radius},${S.missionId || ""}`;
  const getCells = async () => { const k = key(), hit = cache.get(k);
    if (hit && Date.now() - hit.at < 60000) return hit.r;
    const r = await api(`/api/cells?lat=${S.center[0]}&lon=${S.center[1]}&radius=${S.radius}${S.missionId ? `&mission=${S.missionId}` : ""}`);
    cache.set(k, {at: Date.now(), r}); if (cache.size > 20) cache.delete(cache.keys().next().value); return r; };
  const off = () => { if (obs) { obs.disconnect(); obs = null; } if (box) { box.remove(); box = null; } };
  const mhz = a => a ? `${num(a[0], 1)}–${num(a[1], 1)}` : "";
  const head = (r, sites) => { const cells = sites.reduce((n, s) => n + s.cells.length, 0), towers = new Set(sites.map(s => (s.tower || {}).reg).filter(Boolean)).size;
    return `<h3>Cell sites in this area <span class="hint">· ${sites.length.toLocaleString()} site${sites.length === 1 ? "" : "s"}, ${cells.toLocaleString()} cell${cells === 1 ? "" : "s"}, ${towers} FCC tower${towers === 1 ? "" : "s"} within ${esc(S.radius)} mi</span>
      <button class="sm" data-cellgo style="margin-left:6px">Open Cell sites</button></h3>`; };
  const note = r => `<p class="hint" style="margin:6px 0 0">${esc(r.licensed_note || "")}${Object.values(r.sources || {}).length ? ` Sources: ${Object.values(r.sources).map(esc).join("; ")}.` : ""}</p>`;
  // one row per site, opening to its full record
  // a header press sorts every site by that column, then the first 400 show (rfsort.js)
  const listSorted = sites => rfSort.data("cellAllList", sites, [s => s.operator || "", s => s.radio || "", s => `${String(s.site_kind || "").split(" ")[0]} ${s.site_id}`,
    s => (s.tower || {}).reg || "", s => s.dist_mi, s => (s.bands || []).join(", "), s => s.cells.length, s => (s.heard || []).join(", "), s => s.last || ""]);
  const listHtml = (r, sites) => `${head(r, sites)}<div class="tw"><table id="cellAllList"><thead><tr><th>Carrier</th><th>Technology</th><th>Site</th><th>Tower</th><th class="n">Distance</th><th>Bands licensed here</th><th class="n">Cells</th><th>PCI / PSC heard</th><th>Last seen</th></tr></thead><tbody>
      ${listSorted(sites).slice(0, 400).map((s, i) => `<tr data-cs="${i}" style="cursor:pointer" title="Open its full record"><td><b>${esc(s.operator || "")}</b></td><td>${esc(s.radio || "")}</td><td class="mono">${esc(String(s.site_kind || "").split(" ")[0])} ${esc(String(s.site_id))}</td>
        <td class="mono">${esc((s.tower || {}).reg || "")}</td><td class="n">${num(s.dist_mi, 2)} mi</td><td>${esc((s.bands || []).join(", ") || "none on file")}</td><td class="n">${s.cells.length}</td>
        <td class="mono">${esc((s.heard || []).slice(0, 8).join(", "))}</td><td>${esc(s.last || "")}</td></tr>
        <tr data-csrec="${i}" hidden><td colspan="9" style="white-space:normal">${typeof emCellLicensed === "function" ? emCellLicensed(s) : ""}</td></tr>`).join("")}</tbody></table></div>
    ${sites.length > 400 ? `<p class="hint">The ${rfSort.get("cellAllList") ? "first" : "nearest"} 400 of ${sites.length.toLocaleString()} sites: narrow the radius for the rest, or open Cell sites.</p>` : ""}${note(r)}`;
  // Spectrum: each carrier's licensed blocks here, by frequency, with a bar on one shared scale
  const specHtml = (r, sites) => { const seen = new Map();
    for (const s of sites) for (const b of s.licensed || []) { const k = `${s.operator}|${b.band}|${b.block}`; if (!seen.has(k)) seen.set(k, {op: s.operator, ...b, rf: (b.channels || []).map(c => c.band).join(", "), sites: 0}); seen.get(k).sites++; }
    const L = [...seen.values()].filter(x => x.dl_mhz).sort((a, b) => a.dl_mhz[0] - b.dl_mhz[0]);
    if (!L.length) return `${head(r, sites)}<p class="hint">No licensed carrier blocks on file for these sites (carrier spectrum may not be loaded on this copy).</p>${note(r)}`;
    const lo = Math.log(Math.min(...L.map(x => x.dl_mhz[0]))), hi = Math.log(Math.max(...L.map(x => x.dl_mhz[1]))), pos = f => ((Math.log(f) - lo) / Math.max(hi - lo, 1e-6)) * 100;
    return `${head(r, sites)}<div class="tw"><table id="cellAllSpec"><thead><tr><th>Carrier</th><th>Band</th><th>Block</th><th>Downlink MHz</th><th>Uplink MHz</th><th>3GPP band</th><th>Sites here</th><th style="min-width:220px">Where on the dial (downlink)</th></tr></thead><tbody>
      ${L.map(x => `<tr><td><b>${esc(x.op)}</b></td><td>${esc(x.band || "")}</td><td>${esc(x.block || "")}</td><td class="mono">${mhz(x.dl_mhz)}</td><td class="mono">${x.tdd ? "same (TDD)" : x.ul_mhz ? mhz(x.ul_mhz) : "none"}</td><td>${esc(x.rf)}</td><td class="n">${x.sites}</td>
        <td data-v="${x.dl_mhz[0]}"><div style="position:relative;height:10px;background:var(--line);border-radius:5px"><span style="position:absolute;left:${pos(x.dl_mhz[0]).toFixed(1)}%;width:${Math.max(pos(x.dl_mhz[1]) - pos(x.dl_mhz[0]), 1).toFixed(1)}%;top:0;bottom:0;background:var(--accent);border-radius:5px"></span></div></td></tr>`).join("")}</tbody></table></div>
      <p class="hint" style="margin:6px 0 0">Licensed, not measured: what each carrier may use in this county. Which block a site has on the air only a scan says.</p>`; };
  const topoHtml = (r, sites) => `${head(r, sites)}${typeof towersHtml === "function" ? towersHtml(r.towers || [], sites) : ""}${note(r)}`;
  async function mount(v, tab) {
    off();
    if (!TABS[tab] || !S.center) return;
    box = document.createElement("div"); box.className = "panel"; box.id = "cellAll"; box.innerHTML = '<p class="hint" style="margin:0">Finding the cell sites in this area…</p>';
    if (window.RFPack) box.style.display = "none";  // the web version shows it only once there are cells to show, so nothing flashes and goes
    v.appendChild(box);
    obs = new MutationObserver(() => { if (box && !v.contains(box)) v.appendChild(box); }); obs.observe(v, {childList: true});
    const me = box, gen = S.viewGen;
    // a 404 (a copy that keeps no cells) or the web version (window.RFPack), where a field pack with no towers answers "no
    // such table: tower" (seen on the published site 11/7): the panel steps aside; the Cell sites tab says why
    let r; try { r = await getCells(); } catch (e) { if (me !== box) return; if (e.status === 404 || window.RFPack) { off(); return; } me.innerHTML = `<p class="hint" style="margin:0">Cell sites: ${esc(e.message)}</p>`; return; }
    if (me !== box || gen !== S.viewGen) return;
    const sites = r.sites || [];
    if (window.RFPack && !sites.length) { off(); return; }
    box.style.display = "";
    if (!sites.length) { box.innerHTML = `<h3>Cell sites in this area</h3><p class="hint" style="margin:0">None kept here yet. <button class="sm" data-cellgo>Open Cell sites</button> finds them for this area once (OpenCelliD's daily limit applies).</p>`; }
    else box.innerHTML = TABS[tab] === "spectrum" ? specHtml(r, sites) : TABS[tab] === "topology" ? topoHtml(r, sites) : listHtml(r, sites);
    if (sites.length && TABS[tab] === "list") rfSort.own("cellAllList", () => { if (box !== me) return; box.innerHTML = listHtml(r, sites); wire(sites); });
    wire(sites);
  }
  function wire(sites) {  // the panel's presses: Open Cell sites, a site's full record, a tower
    box.querySelectorAll("[data-cellgo]").forEach(b => b.onclick = () => setTab("cells"));
    box.querySelectorAll("tr[data-cs]").forEach(tr => tr.onclick = () => { const rec = box.querySelector(`tr[data-csrec="${tr.dataset.cs}"]`); if (rec) rec.hidden = !rec.hidden; });
    // Topology's tower table says "Click one for its sites, cells and channel numbers": a tower opens as it does on Cell sites,
    // in the results viewer on this tab (cells.js, emitter.js emCellView; 11/10: it jumped to the Map tab)
    box.querySelectorAll("tr[data-tw]").forEach(tr => tr.onclick = () => { const s = sites.find(x => x.tower?.reg === tr.dataset.tw);
      if (s && typeof emCellView === "function") emCellView($("#view"), s); });
  }
  for (const t of Object.keys(S.views)) { const orig = S.views[t];
    const w = function (v, rows) { off(); const out = orig.call(this, v, rows); Promise.resolve(out).then(() => { if (S.tab === t) mount(v, t); }, () => {}); return out; };
    Object.defineProperty(w, "length", {value: orig.length});  // rail.js reads a view's arity to know whether it takes the rows
    S.views[t] = w; }
  window.cellAllRefresh = () => cache.clear();
})();
