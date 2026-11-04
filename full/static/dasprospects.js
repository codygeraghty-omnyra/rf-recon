"use strict";
/* RF Recon — DAS Prospects (Cody 11/3: "a tool for DAS to help locate / research data / reach out to potential
   customers (common customer lists: schools, malls, stadiums, public, any high-traffic areas) automatically").
   Buildings that often must have emergency responder radio coverage, near a spot, from public US government lists
   (prospects.py: NCES schools, IPEDS colleges, CMS hospitals; refreshed monthly by the "DAS prospect lists" update),
   ranked by the market research's priority (das_market.json prospect_types), with who to approach and why.
   Each one has a status in the firm's pipeline. Outreach is a first email the person sends from their own mail:
   RF Recon never sends it. The email follows CAN-SPAM (who it's from, the firm's mailing address, an opt-out), and
   "Do not contact" is honoured: no email button. "Make a DAS job" puts the building on the board as a Lead.
   Needs core.js (api, post, esc, $, S, parseLoc, num), das.js (dasSay). */

// two groups: the government lists (NCES, IPEDS, CMS) and Overture Maps (places; high-rises from its buildings, per area)
const PR_GROUPS = [["Schools and hospitals", [["school_k12", "Public schools"], ["school_private", "Private schools"], ["college", "Colleges"], ["hospital", "Hospitals"], ["nursing_home", "Nursing homes"]]],
  ["Large and high-traffic", [["high_rise", "High-rises"], ["mall", "Malls"], ["stadium", "Stadiums and arenas"], ["hotel", "Hotels"], ["venue", "Convention centres and venues"],
    ["casino", "Casinos"], ["airport", "Airports"], ["transit", "Transit stations"], ["government", "Government buildings"], ["warehouse", "Warehouses"], ["parking", "Parking garages"]]]];
const PR_KINDS = PR_GROUPS.flatMap(g => g[1]);
const PR_STATUS = ["new", "contacted", "replied", "meeting", "won", "not interested", "do not contact"];
const PR_KIND = Object.fromEntries(PR_KINDS);

window.dasProspects = async el => {
  const P = S.dasProspects = S.dasProspects || { radius: 10, kinds: PR_KINDS.map(k => k[0]), q: "", status: "", where: null, label: "", rows: null, gen: 0 };
  if (!P.where && S.center) { P.where = [S.center[0], S.center[1]]; P.label = "the search pin"; }
  const [M, firm, jl] = await Promise.all([fetch("static/research/das_market.json").then(r => r.json()).catch(() => ({})),
    api("/api/das/firm").catch(() => ({})), api("/api/das/jobs").catch(() => ({ jobs: [] }))]);
  if (!el.isConnected) return;
  const jobs = (jl.jobs || []).filter(j => j.lat != null || j.data?.lat != null);
  const types = M.prospect_types || [];
  el.innerHTML = `<div class="panel pr-head">
      <div class="row" style="flex-wrap:wrap;gap:8px;align-items:end">
        <label>Where<input id="prWhere" placeholder="A town, an address, or lat, lon" value="${esc(P.label && P.label !== "the search pin" ? P.label : "")}" style="min-width:240px"></label>
        <button id="prGo" class="primary">Find buildings</button>
        ${S.center ? `<button id="prPin" title="Use the pin on the Search map">Use the search pin</button>` : ""}
        ${jobs.length ? `<label>or near a job<select id="prJob"><option value="">Pick a job…</option>${jobs.map(j => `<option value="${j.id}">${esc(j.name)}</option>`).join("")}</select></label>` : ""}
        <label>Within<select id="prRadius">${[2, 5, 10, 25, 50].map(r => `<option value="${r}" ${+P.radius === r ? "selected" : ""}>${r} mi</option>`).join("")}</select></label>
      </div>
      <div id="prKinds">${PR_GROUPS.map(([g, ks]) => `<div class="row" style="flex-wrap:wrap;gap:4px 14px;margin-top:8px;align-items:center"><b style="min-width:160px">${g}</b>${ks.map(([k, l]) => `<label style="display:inline-flex;gap:6px;align-items:center;flex-direction:row"><input type="checkbox" style="width:auto;margin:0" data-k="${k}" ${P.kinds.includes(k) ? "checked" : ""}> ${l} <span class="hint" data-n="${k}"></span></label>`).join("")}</div>`).join("")}
        <div class="row" style="gap:8px;margin-top:6px;align-items:center"><button id="prHigh" title="Overture Maps buildings 75 ft or 7 floors and up, within the radius (at most 10 mi)">Find high-rises here</button><span class="hint" id="prHighMsg">High-rises come from building heights near a spot: kept for each mission area, or found here on a press.</span></div></div>
      <p class="hint" id="prSrc" style="margin:8px 0 0"></p>
    </div>
    ${firm.address ? "" : `<p class="status pr-warn" id="prNoAddr">Add your firm's mailing address before emailing anyone: US law (CAN-SPAM) requires it in every commercial email. <a href="#" id="prFirm">Firm details</a></p>`}
    <div id="prBody"></div>
    <details class="panel" style="margin-top:12px"><summary>Why these buildings, and who to approach</summary>
      <div class="pitch-cards" style="margin-top:8px">${types.map(t => `<div><b>${esc(t.type)}</b> <span class="tag">${esc(t.priority || "")}</span><p>${esc(t.why || "")}</p><p class="hint">Approach: ${esc(t.decision_maker || "")}</p></div>`).join("")}</div>
      <p class="hint">Malls, venues, hotels and the rest are Overture Maps places (CDLA-Permissive-2.0, Apache-2.0 or CC0; attribution: Overture Maps Foundation). High-rises are Overture buildings (© OpenStreetMap contributors, Overture Maps Foundation, ODbL). A building's own name is used when it has one; otherwise it's named by the business inside it.</p>
    </details>`;
  const body = $("#prBody");
  const where = async () => {
    const t = $("#prWhere").value.trim();
    if (!t) return P.where;
    const ll = parseLoc(t);
    if (ll) { P.label = t; return ll; }
    const g = await api(`/api/geocode?q=${encodeURIComponent(t)}`);
    const r = (g.results || [])[0];
    if (!r) throw new Error(`Couldn't find "${t}". Try a town and state, or lat, lon.`);
    P.label = t; $("#prWhere").value = r.label; return [r.lat, r.lon];
  };
  const load = async () => {
    const gen = ++P.gen;
    if (!P.where) { body.innerHTML = `<p class="hint">Type a town or address, use the search pin, or pick a job, then Find buildings.</p>`; return; }
    body.innerHTML = `<p class="hint">Looking within ${P.radius} mi…</p>`;
    let r;
    try { r = await api(`/api/das/prospects?lat=${P.where[0]}&lon=${P.where[1]}&radius=${P.radius}&kinds=${P.kinds.join(",")}&limit=1000`); }
    catch (e) { if (gen === P.gen) body.innerHTML = `<p class="status err">Prospects: ${esc(e.message)}</p>`; return; }
    if (gen !== P.gen || !el.isConnected) return;
    P.rows = r.prospects; P.counts = r.counts; P.sources = r.sources;
    for (const [k] of PR_KINDS) { const n = el.querySelector(`[data-n="${k}"]`); if (n) n.textContent = r.counts[k] ? `(${r.counts[k].toLocaleString()} ${k === "high_rise" ? "found so far" : "in the US"})` : ""; }
    const up = r.counts.updated;
    $("#prSrc").innerHTML = up ? `Public lists: ${Object.values(r.sources).map(s => esc(s.name)).join(", ")}. Updated ${esc(String(up).slice(0, 10))}; the "DAS prospect lists" update refreshes them monthly.`
      : `The prospect lists aren't downloaded on this computer yet. <button id="prFetch">Download them now</button> <span class="hint">(the US Department of Education, CMS and Overture Maps: a few minutes, once; then monthly)</span>`;
    $("#prFetch") && ($("#prFetch").onclick = async e => { e.target.disabled = true; e.target.textContent = "Downloading… (Updates tab shows progress)";
      try { await post("/api/update/run", { ids: ["das_prospects"] }); dasSay("Downloading the prospect lists. Press Find buildings again when the Updates tab says it's done."); } catch (x) { dasSay(x.message); e.target.disabled = false; } });
    paint();
  };
  const paint = () => {
    const rows = (P.rows || []).filter(x => (!P.status || x.status === P.status) && (!P.q || `${x.name} ${x.city} ${x.detail || ""}`.toLowerCase().includes(P.q.toLowerCase())));
    const by = s => (P.rows || []).filter(x => x.status === s).length;
    if (!P.rows) return;
    if (!P.rows.length) { body.innerHTML = `<p class="hint">No ${P.kinds.map(k => PR_KIND[k].toLowerCase()).join(", ")} within ${P.radius} mi${P.counts?.updated ? "" : " (the lists aren't downloaded yet)"}. Try a wider radius.</p>`; return; }
    body.innerHTML = `<div class="row" style="flex-wrap:wrap;gap:8px;align-items:end;margin:10px 0">
        <b>${P.rows.length.toLocaleString()} building${P.rows.length === 1 ? "" : "s"} within ${P.radius} mi${P.label ? ` of ${esc(P.label)}` : ""}</b>
        <input id="prQ" placeholder="Filter by name or town" value="${esc(P.q)}" style="min-width:180px">
        <select id="prStatus"><option value="">Every status</option>${PR_STATUS.map(s => `<option value="${s}" ${P.status === s ? "selected" : ""}>${s} (${by(s)})</option>`).join("")}</select>
        <button id="prCsv" title="The rows shown, as a call list">⇩ Call list (CSV)</button>
      </div>
      <div id="prMap" style="height:340px;border-radius:12px;margin-bottom:10px"></div>
      <div class="tw" style="max-height:560px;overflow:auto"><table class="pr-tab"><thead><tr><th>Building</th><th>Kind</th><th>mi</th><th>Contact</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.slice(0, 400).map(x => `<tr data-pid="${esc(x.id)}" class="${x.status === "do not contact" ? "pr-dnc" : ""}">
        <td><b>${esc(x.name)}</b><div class="hint">${esc([x.address, x.city, x.state].filter(Boolean).join(", "))}${x.precision === "zip" ? " (placed at its ZIP)" : ""}</div>${x.detail ? `<div class="hint">${esc(x.detail)}</div>` : ""}</td>
        <td>${esc(PR_KIND[x.kind] || x.kind)}${x.priority ? `<div><span class="tag" title="${esc(x.why)}">${esc(x.priority)}</span></div>` : ""}${x.size_label ? `<div class="hint">${esc(x.size_label)}</div>` : ""}</td>
        <td>${x.dist_mi < 10 ? x.dist_mi.toFixed(1) : Math.round(x.dist_mi)}</td>
        <td>${x.phone ? `<a href="tel:${esc(x.phone.replace(/[^\d+]/g, ""))}">${esc(x.phone)}</a>` : ""}${x.website ? `<div><a href="${esc(/^https?:/i.test(x.website) ? x.website : "https://" + x.website)}" target="_blank" rel="noopener">website</a></div>` : ""}
          ${x.email ? `<div><a href="mailto:${esc(x.email)}">${esc(x.email)}</a>${x.email_source ? ` <span class="hint" title="${esc(x.email_source)}">(from their site)</span>` : ""}</div>`
            : x.status !== "do not contact" && x.website ? `<div><button data-fe title="Reads their own website's home and contact pages for the address they publish">Find email</button></div>`
            : x.status !== "do not contact" ? `<div class="hint">No website or email listed: call first.</div>` : ""}
          <div class="hint" title="Who the research says to approach">${esc(x.approach || "")}</div></td>
        <td><select data-st>${PR_STATUS.map(s => `<option ${x.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>${x.contacted_at ? `<div class="hint">contacted ${esc(x.contacted_at.slice(0, 10))}</div>` : ""}</td>
        <td style="white-space:nowrap">${x.status === "do not contact" ? `<span class="hint">opted out</span>` : `<button data-em title="A first email, opened in your own mail. RF Recon never sends it.">Email</button>`}
          ${x.job_id ? `<button data-open="${x.job_id}">Job</button>` : `<button data-job title="Put it on the DAS board as a Lead">+ Job</button>`}</td></tr>`).join("")}
      </tbody></table>${rows.length > 400 ? `<p class="hint">Showing the first 400 of ${rows.length.toLocaleString()}: filter or narrow the radius.</p>` : ""}</div>
      <div id="prMail"></div>`;
    prMap(rows);
    $("#prQ").oninput = e => { P.q = e.target.value; clearTimeout(P.qt); P.qt = setTimeout(() => { const pos = e.target.selectionStart; paint(); const q = $("#prQ"); q.focus(); q.setSelectionRange(pos, pos); }, 250); };
    $("#prStatus").onchange = e => { P.status = e.target.value; paint(); };
    $("#prCsv").onclick = () => {
      const cols = ["name", "kind", "priority", "address", "city", "state", "zip", "phone", "email", "website", "approach", "dist_mi", "status", "contacted_at"];
      const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const csv = [cols.join(","), ...rows.map(x => cols.map(c => q(c === "kind" ? PR_KIND[x.kind] || x.kind : x[c])).join(","))].join("\r\n");
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
      a.download = `DAS prospects ${(P.label || "here").replace(/[^\w ,.-]/g, "")} ${P.radius} mi.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    body.querySelectorAll("tr[data-pid]").forEach(tr => {
      const pid = tr.dataset.pid, x = P.rows.find(r => r.id === pid);
      tr.querySelector("[data-st]").onchange = async e => {
        const was = x.status;
        try { const r = await post(`/api/das/prospects/${encodeURIComponent(pid)}/status`, { status: e.target.value });
          Object.assign(x, { status: r.status, contacted_at: r.contacted_at, job_id: r.job_id ?? x.job_id }); paint(); }
        catch (err) { e.target.value = was; dasSay(err.message); }
      };
      const fe = tr.querySelector("[data-fe]");
      if (fe) fe.onclick = async () => {
        fe.disabled = true; fe.textContent = "Reading their site…";
        try {
          const r = await post(`/api/das/prospects/${encodeURIComponent(pid)}/find-email`, {});
          if (r.emails.length) { x.email = r.emails[0].email; x.email_source = r.emails[0].page;
            dasSay(`${x.email}${r.emails.length > 1 ? ` (and ${r.emails.length - 1} more on their site: ${r.emails.slice(1, 4).map(e => e.email).join(", ")})` : ""}`); paint(); }
          else { fe.textContent = "None published"; fe.title = `Read ${r.pages.length} page${r.pages.length === 1 ? "" : "s"}${r.skipped.length ? `; their robots.txt keeps ${r.skipped.length} out` : ""}: no address published. Call the number shown.`; }
        } catch (err) { fe.disabled = false; fe.textContent = "Find email"; dasSay(err.message); }
      };
      const em = tr.querySelector("[data-em]");
      if (em) em.onclick = async () => {
        em.disabled = true;
        try { prMailBox(await api(`/api/das/prospects/${encodeURIComponent(pid)}/email`), x); } catch (err) { dasSay(err.message); } finally { em.disabled = false; }
      };
      const jb = tr.querySelector("[data-job]");
      if (jb) jb.onclick = async () => {
        jb.disabled = true;
        try { const j = await post(`/api/das/prospects/${encodeURIComponent(pid)}/job`, {}); x.job_id = j.id; dasSay(`${x.name} is on the board as a Lead.`); paint(); }
        catch (err) { jb.disabled = false; dasSay(err.message); }
      };
      const op = tr.querySelector("[data-open]");
      if (op) op.onclick = () => { S.das.job = +op.dataset.open; S.das.sub = "overview"; S.das.rview = null; S.views.das($("#view")); };
    });
  };
  // the email: in the person's own mail (mailto), with the text to copy when the mail app doesn't open
  const prMailBox = (m, x) => {
    const box = $("#prMail"), href = `mailto:${encodeURIComponent(m.to || "")}?subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(m.body)}`;
    box.innerHTML = `<div class="panel" style="margin-top:12px"><div class="row" style="justify-content:space-between"><b>First email to ${esc(x.name)}</b><button id="prMailX" title="Close">✕</button></div>
      <p class="hint">Opens in your own mail; RF Recon never sends it. ${m.to ? "" : "The public list has no email address for them: call the number above for the right person, then add their address. "}Set the status to contacted once it's sent. If they reply "no thanks", set Do not contact.</p>
      <label>Subject<input id="prMs" value="${esc(m.subject)}"></label><label>Message<textarea id="prMb" rows="12">${esc(m.body)}</textarea></label>
      <div class="row" style="gap:8px">${window.rfMail ? `<button class="primary" id="prMailSend" title="From your own mailbox; their reply sets the status (a no-thanks marks Do not contact)">✉ Send from my mail</button>` : ""}<a class="btn ${window.rfMail ? "" : "primary"}" id="prMailGo" href="${esc(href)}">Open in my mail</a><button id="prMailCopy">Copy the text</button></div>
      <div id="prMailSent"></div></div><div id="prMailThread"></div>`;
    const re = () => { $("#prMailGo").href = `mailto:${encodeURIComponent(m.to || "")}?subject=${encodeURIComponent($("#prMs").value)}&body=${encodeURIComponent($("#prMb").value)}`; };
    $("#prMs").oninput = re; $("#prMb").oninput = re;
    $("#prMailCopy").onclick = async () => { try { await navigator.clipboard.writeText(`Subject: ${$("#prMs").value}\n\n${$("#prMb").value}`); dasSay("Copied."); } catch (e) { $("#prMb").select(); dasSay("Press Ctrl+C to copy."); } };
    $("#prMailX").onclick = () => { box.innerHTML = ""; };
    if (window.rfMail) {
      rfMail.thread($("#prMailThread"), { prospect: x.id });
      $("#prMailSend").onclick = () => rfMail.compose($("#prMailSent"), { kind: "prospect", refs: { prospect_id: x.id }, title: `First email to ${x.name}`,
        to: $("#prMailTo")?.value || m.to || x.email || "", subject: $("#prMs").value, body: $("#prMb").value,
        onSent: () => { if (x.status === "new") x.status = "contacted"; rfMail.thread($("#prMailThread"), { prospect: x.id }); } });
    }
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  const prMap = rows => {
    const m = $("#prMap"); if (!m || !window.L) return;
    P.ro?.disconnect();  // the old map's resize watcher, before that map goes
    if (P.map) { try { P.map.off(); P.map.remove(); } catch (e) { /* already torn down: nothing to show */ } }
    const map = P.map = L.map(m, { zoomControl: true, fadeAnimation: false, zoomAnimation: false }).setView(P.where, 11);
    addMapLayers(map);  // the person's own base map, offline tiles included (core.js)
    const col = { new: "#3b82f6", contacted: "#f59e0b", replied: "#a855f7", meeting: "#a855f7", won: "#16a34a", "not interested": "#888", "do not contact": "#555" };
    L.circle(P.where, { radius: P.radius * 1609.34, color: "#888", weight: 1, fill: false, interactive: false }).addTo(map);
    const pts = [];
    for (const x of rows.slice(0, 1000)) {
      if (x.lat == null) continue;
      pts.push([x.lat, x.lon]);
      L.circleMarker([x.lat, x.lon], { radius: x.priority === "high" ? 6 : 4, color: col[x.status] || "#3b82f6", weight: 1, fillOpacity: .75 })
        .bindTooltip(`${esc(x.name)} · ${esc(PR_KIND[x.kind] || "")} · ${esc(x.status)}`).addTo(map)
        .on("click", () => { const tr = body.querySelector(`tr[data-pid="${CSS.escape(x.id)}"]`); if (tr) { tr.scrollIntoView({ block: "center" }); tr.classList.add("pr-hit"); setTimeout(() => tr.classList.remove("pr-hit"), 1500); } });
    }
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(.1), { animate: false });
    (P.ro = new ResizeObserver(() => { if (P.map === map && m.isConnected) map.invalidateSize(); })).observe(m);
  };
  // the controls
  $("#prGo").onclick = async e => { e.target.disabled = true; try { P.where = await where(); P.q = ""; P.status = ""; await load(); } catch (x) { body.innerHTML = `<p class="status err">${esc(x.message)}</p>`; } finally { e.target.disabled = false; } };
  $("#prWhere").onkeydown = e => { if (e.key === "Enter") $("#prGo").click(); };
  $("#prPin") && ($("#prPin").onclick = () => { P.where = [S.center[0], S.center[1]]; P.label = "the search pin"; $("#prWhere").value = ""; load(); });
  $("#prJob") && ($("#prJob").onchange = e => { const j = jobs.find(x => x.id === +e.target.value); if (!j) return; P.where = [j.lat ?? j.data?.lat, j.lon ?? j.data?.lon]; P.label = j.name; $("#prWhere").value = ""; load(); });
  $("#prRadius").onchange = e => { P.radius = +e.target.value; load(); };
  $("#prHigh").onclick = async e => {
    if (!P.where) { dasSay("Pick where to look first."); return; }
    const r = Math.min(10, P.radius), msg = $("#prHighMsg");
    e.target.disabled = true; msg.textContent = `Reading Overture building heights within ${r} mi (about half a minute)…`;
    try { const got = await post("/api/das/prospects/highrises", { lat: P.where[0], lon: P.where[1], radius: r });
      msg.textContent = `${got.highrises.toLocaleString()} building${got.highrises === 1 ? "" : "s"} 75 ft or 7 floors and up within ${r} mi.`;
      if (!P.kinds.includes("high_rise")) { P.kinds.push("high_rise"); const c = el.querySelector('[data-k="high_rise"]'); if (c) c.checked = true; }
      load(); }
    catch (x) { msg.textContent = x.message; } finally { e.target.disabled = false; }
  };
  $("#prKinds").onchange = e => { const k = e.target.dataset.k; if (!k) return; P.kinds = e.target.checked ? [...new Set([...P.kinds, k])] : P.kinds.filter(x => x !== k); if (!P.kinds.length) { P.kinds = [k]; e.target.checked = true; } load(); };
  $("#prFirm") && ($("#prFirm").onclick = e => { e.preventDefault(); S.das.view = "pitch"; S.views.das($("#view")); });
  load();
};
