"use strict";
/* RF Recon — first run. A new copy (the install kit) has no data: pick the states to keep and what to download.
   The files come straight from the FCC (and NOAA, FAA) to this PC through the updater; progress shows here until
   the map has data. The FCC publishes whole-country files only, so the download is the same for any states. */

const WELCOME_SETS = [
  {key: "lic", ids: ["uls:LMpriv", "uls:LMcomm", "uls:LMbcast", "uls:paging", "uls:coast"], label: "FCC licences",
   what: "public safety, business, commercial, broadcast auxiliary, paging, marine and aviation ground", mb: 530, must: true},
  {key: "asr", ids: ["asr"], label: "Towers", what: "FCC antenna structures and their heights", mb: 38, on: true},
  {key: "bcast", ids: ["bcast"], label: "Broadcast stations", what: "AM, FM and TV", mb: 34, on: true},
  {key: "ref", ids: ["nwr", "faa", "psap", "grantee"], label: "NOAA Weather Radio, FAA aviation, 911 call centres, FCC equipment makers",
   what: "reference sets", mb: 17, on: true},
  {key: "mw", ids: ["uls:micro"], label: "Microwave backhaul", what: "point-to-point links with both ends", mb: 210},
];
const wcSize = mb => mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;

window.welcome = () => {
  const el = $("#welcome"); el.hidden = false;
  el.innerHTML = `<h3 style="margin:0 0 4px">Welcome to RF Recon (beta)</h3>
    <p class="hint" style="margin:0 0 12px">This copy has no data yet. Pick the states to keep and what to download: it comes straight from the FCC to this PC.
      The FCC only publishes whole-country files, so the download is the same for any states; only the states you pick are kept.</p>
    <label>States to keep (blank keeps the whole US: about 10 GB on disk)<input id="wcStates" placeholder="e.g. VA,MD,DC" style="max-width:280px" autocomplete="off"></label>
    <div id="wcSets" style="margin-top:12px">${WELCOME_SETS.map(s => `<label class="inl" style="display:flex;gap:10px;align-items:baseline;margin:6px 0">
      <input type="checkbox" data-wc="${s.key}" ${s.must || s.on ? "checked" : ""} ${s.must ? "disabled" : ""}>
      <span><b>${esc(s.label)}</b> <span class="hint">· ${esc(s.what)} · ${s.mb >= 10 ? wcSize(s.mb) : "a few MB"}</span></span></label>`).join("")}</div>
    <div class="row" style="margin-top:12px;align-items:center;gap:12px"><button class="primary" id="wcGo">Download</button><span class="hint" id="wcTotal"></span></div>
    <div id="wcProg" style="margin-top:10px"></div>
    <p class="hint" style="margin:12px 0 0">Wi-Fi, cell tower and ship layers, and carriers' coverage maps, come from free accounts of your own: add their keys any time in Data &amp; updates, Your API keys.</p>`;
  const chosen = () => WELCOME_SETS.filter(s => s.must || $(`[data-wc="${s.key}"]`).checked);
  const total = () => { $("#wcTotal").textContent = `About ${wcSize(chosen().reduce((a, s) => a + s.mb, 0))} to download.`; };
  $("#wcSets").onchange = total; total();
  $("#wcGo").onclick = async () => {
    const states = $("#wcStates").value.toUpperCase().replace(/[^A-Z,]/g, "").replace(/,+/g, ",").replace(/^,|,$/g, "");
    const pick = chosen(), ids = pick.flatMap(s => s.ids);
    $("#wcGo").disabled = true; $("#wcProg").innerHTML = '<p class="hint">Starting…</p>';
    try {
      await post("/api/settings", {states});
      await post("/api/update/config", {sources: Object.fromEntries(WELCOME_SETS.flatMap(s => s.ids.map(id => [id, {enabled: pick.includes(s)}])))});
      await post("/api/update/run", {ids, force: true});
      watch(ids);
    } catch (e) { $("#wcProg").innerHTML = `<p class="status err">${esc(e.message)}</p>`; $("#wcGo").disabled = false; }
  };
  // progress, one line per source, until nothing is running; then the page reloads with its data
  const watch = async ids => {
    let u; try { u = await api("/api/update/status"); } catch (e) { setTimeout(() => watch(ids), 4000); return; }
    const rows = ids.map(id => u.sources[id]).filter(Boolean), busy = rows.some(s => s.running), failed = rows.filter(s => !s.running && s.state === "error");
    $("#wcProg").innerHTML = `<div class="tw"><table><tbody>${rows.map(s => `<tr><td>${esc(s.label)}</td>
      <td>${s.running ? '<span class="led busy"></span> working' : s.state === "error" ? "✕ failed" : "✓ done"}</td><td class="hint">${esc(s.message || "")}</td></tr>`).join("")}</tbody></table></div>`;
    if (busy) { setTimeout(() => watch(ids), 3000); return; }
    if (failed.length) {  // try again only what failed: what finished is kept, and the big files aren't fetched twice
      const again = ids.filter(id => u.sources[id] && !u.sources[id].running && u.sources[id].state === "error");
      $("#wcProg").insertAdjacentHTML("beforeend", `<p class="status err">${failed.length} didn't finish. What finished is kept; check the connection and try again.</p>`);
      const b = $("#wcGo"); b.textContent = `Try ${again.length === 1 ? "it" : `those ${again.length}`} again`; b.disabled = false;
      b.onclick = async () => { b.disabled = true;
        try { await post("/api/update/run", {ids: again, force: true}); watch(again); } catch (e) { $("#wcProg").innerHTML = `<p class="status err">${esc(e.message)}</p>`; b.disabled = false; } };
      return;
    }
    $("#wcProg").insertAdjacentHTML("beforeend", '<p class="status">Done. Opening the map…</p>');
    setTimeout(() => location.reload(), 1500);
  };
};
