"use strict";
/* The review page (11/4): what an AHJ reviewer (an "ahj" login) or a read-only share link sees of a DAS job. The jobs
   shared with the login; for one job, the building, what it was tested to (the AHJ profile, with its source), who
   tested it and with which calibrated instruments, each floor's grid result scored by the same rules as the report
   (das.js floorStats), every reading, the files picked for review, and the review thread with Accept / Return. A share
   link shows the same without the thread and with no buttons. Nothing here changes the job except a review or a
   comment, which the server checks against the job's access list. */
(function () {
  const share = location.pathname.match(/^\/share\/([A-Za-z0-9_-]{32,64})$/);
  const base = share ? `/share/${share[1]}` : "";
  const main = document.getElementById("rvMain"), whoEl = document.getElementById("rvWho");
  const h = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const get = async url => { const r = await fetch(url, {credentials: "same-origin"});
    if (r.status === 401) { location.href = "/remote/login"; throw new Error("Signed out."); }
    const j = await r.json().catch(() => ({error: r.statusText})); if (!r.ok || j.error) throw new Error(j.error || r.statusText); return j; };
  const send = async (url, body) => { const r = await fetch(url, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
    if (r.status === 401) { location.href = "/remote/login"; throw new Error("Signed out."); }
    const j = await r.json().catch(() => ({error: r.statusText})); if (!r.ok || j.error) throw new Error(j.error || r.statusText); return j; };
  const STATUS = {waiting: "Waiting for review", accepted: "Accepted", returned: "Returned"};
  const chip = st => `<span class="chip ${h(st)}">${h(STATUS[st] || st)}</span>`;
  const fileUrl = (id, name) => share ? `${base}/file?name=${encodeURIComponent(name)}` : `/api/das/jobs/${id}/file?name=${encodeURIComponent(name)}`;
  const say = (t, bad) => { main.innerHTML = `<div class="panel"><p class="${bad ? "err" : "hint"}" style="margin:0">${h(t)}</p></div>`; };
  const scoring = () => typeof floorStats === "function" && typeof dasProfile === "function";

  async function me() {
    if (share) { whoEl.textContent = "Read-only link"; return; }
    try { const m = await get("/api/me"); if (m.user) whoEl.innerHTML = `<span>${h(m.user)}${m.role === "ahj" ? " · reviewer" : ""}</span><a class="btn" href="/remote/logout">Sign out</a>`; } catch (e) { /* the PC's own window */ }
  }

  async function list() {
    let r; try { r = await get("/api/das/jobs"); } catch (e) { return say(e.message, true); }
    const jobs = r.jobs || [];
    document.title = "Reports to review";
    main.innerHTML = `<div class="panel"><h2>Reports to review</h2>${jobs.length ? `<div class="list">${jobs.map(j =>
      `<a class="job" href="/review?job=${j.id}"><span><b>${h(j.name)}</b><br><span class="hint">${h([j.address, j.ahj].filter(Boolean).join(" · ") || j.stage)}</span></span>${chip(j.review || "waiting")}</a>`).join("")}</div>`
      : '<p class="hint" style="margin:0">Nothing has been shared with you yet. The firm shares each job with your login when its report is ready.</p>'}</div>`;
  }

  // the readings of one square: a square holds one reading, or several (one per channel or system)
  const readings = r => !r ? [] : Array.isArray(r.readings) ? r.readings : [r];
  const instOf = (v, k) => { const i = ((v.testing || {}).instruments || []).find(x => `${x.model}|${x.serial || ""}` === k); return i ? [i.model, i.serial].filter(Boolean).join(" ") : k === "uncal" ? "not calibrated" : (k || "").replace("|", " "); };

  function floorBlock(v, f) {
    const res = (v.grid || {}).results || {}, n = f.grids || 20;
    let stats = null;
    if (scoring()) try { DASJ = dasProfile(v.profile); stats = floorStats({...v, grid: v.grid || {}, testing: v.testing || {}}, f); } catch (e) { stats = null; }
    const rows = [];
    for (let g = 1; g <= n; g++) for (const x of readings(res[`${f.name}|${g}`])) rows.push({g, x, crit: (f.critical || []).includes(g), skip: (f.skip || []).includes(g)});
    for (const [k, r] of Object.entries(res)) { const [fl, g] = k.split("|"); if (fl === f.name && +g > n) for (const x of readings(r)) rows.push({g: +g, x}); }
    const pass = stats ? stats.fails.length === 0 && stats.untested === 0 && stats.tested > 0 : null;
    return `<div class="panel"><h2>Floor ${h(f.name)} ${stats ? (pass ? '<span class="chip pass">Pass</span>' : stats.tested ? '<span class="chip fail">Not passing</span>' : '<span class="chip waiting">Not tested</span>') : ""}</h2>
      ${stats ? `<div class="stats"><div><b>${stats.pct}%</b><span class="hint">of ${stats.counted} squares pass</span></div>
        <div><b>${stats.genPct}%</b><span class="hint">general (${stats.gen})</span></div><div><b>${stats.critPct}%</b><span class="hint">critical (${stats.crit})</span></div>
        <div><b>${stats.untested}</b><span class="hint">not tested</span></div>${stats.notCounted ? `<div><b>${stats.notCounted}</b><span class="hint">not counted (no calibrated instrument)</span></div>` : ""}</div>
        ${stats.fails.length ? `<p class="hint" style="margin:0 0 8px">Squares that fail: ${stats.fails.join(", ")}</p>` : ""}` : `<p class="hint">${rows.length} readings.</p>`}
      ${f.plan && (v.files || []).includes(f.plan) ? `<p style="margin:0 0 8px"><a href="${fileUrl(v.id, f.plan)}" target="_blank" rel="noopener">Floor plan: ${h(f.plan)}</a></p>` : ""}
      ${rows.length ? `<details${rows.length <= 40 ? " open" : ""}><summary>Readings (${rows.length})</summary><div class="tw"><table><thead><tr><th>Square</th><th>Channel / system</th><th class="n">Downlink dBm</th><th class="n">Uplink dBm</th><th class="n">DAQ</th><th class="n">SINR dB</th><th class="n">BER %</th><th>Taken with</th></tr></thead><tbody>
        ${rows.map(({g, x, crit}) => `<tr><td>${g}${crit ? " (critical)" : ""}</td><td>${h([x.ch || x.channel, x.freq, x.tech, x.carrier, x.system].filter(v => v != null && v !== "").join(" · "))}</td>
          <td class="n">${h(x.dl ?? "")}</td><td class="n">${h(x.ul ?? "")}</td><td class="n">${h(x.daq ?? "")}</td><td class="n">${h(x.sinr ?? "")}</td><td class="n">${h(x.ber ?? "")}</td><td>${h(instOf(v, x.inst))}</td></tr>`).join("")}
        </tbody></table></div></details>` : ""}</div>`;
  }

  function profileBlock(v) {
    let P = v.profile || {};
    if (scoring()) try { P = dasProfile(v.profile); } catch (e) { /* the job's own numbers */ }
    const preset = typeof DAS_PROFILES === "object" && P.profile_name ? DAS_PROFILES[P.profile_name] : null;
    const src = P.source || (preset && preset.source);
    const rule = P.grid_rule === "pct" ? "percentages only" : P.grid_rule === "ifc" ? "IFC 510.5.4 failed-area rule" : "";
    return `<div class="panel"><h2>Tested to</h2><dl class="kv">
      ${P.profile_name ? `<dt>AHJ profile</dt><dd>${h(P.profile_name)}</dd>` : ""}
      <dt>Signal</dt><dd>${P.threshold == null ? "no dBm figure (DAQ only)" : `${h(P.threshold)} dBm or better`}</dd>
      ${P.daq != null ? `<dt>DAQ</dt><dd>${h(P.daq)} or better, downlink and uplink</dd>` : ""}
      ${P.general_pct != null ? `<dt>Coverage</dt><dd>${h(P.general_pct)}% of general areas, ${h(P.critical_pct)}% of critical areas</dd>` : ""}
      ${rule ? `<dt>Grid rule</dt><dd>${h(rule)}</dd>` : ""}
      ${v.code ? `<dt>Code basis</dt><dd>${h(v.code)}</dd>` : ""}
      <dt>Source</dt><dd>${src ? `<a href="${h(src)}" target="_blank" rel="noopener noreferrer">${h(src.replace(/^https?:\/\//, "").slice(0, 70))}</a>`
        : 'IFC 510 and <a href="https://oci.georgia.gov/document/document/nfpa-1225-chapter-18/download" target="_blank" rel="noopener noreferrer">NFPA 1225-2022 ch. 18</a> defaults'}</dd></dl></div>`;
  }

  function reviewBlock(v) {
    const R = v.review || {}, t = R.thread || [], lv = v.level;
    const decide = lv === "review", comment = ["review", "edit", "owner"].includes(lv);
    return `<div class="panel" id="rvReview"><h2>Review ${chip(R.status || "waiting")}</h2>
      ${t.length ? `<ul class="thread">${t.map(x => `<li><b>${h(x.who)}</b> <span class="hint">${h(x.ts)}${x.role === "ahj" ? " · reviewer" : ""}</span>
        ${x.decision !== "comment" ? ` ${chip(x.decision === "accept" ? "accepted" : "returned")}` : ""}${x.comment ? `<div style="white-space:pre-wrap">${h(x.comment)}</div>` : ""}</li>`).join("")}</ul>`
        : `<p class="hint">${share ? "" : "No review yet."}</p>`}
      ${decide || comment ? `<div class="no-print" style="margin-top:10px"><label class="hint" for="rvText">${decide ? "Comment (needed to return the report)" : "Comment for the reviewer"}</label>
        <textarea id="rvText" maxlength="4000"></textarea><div class="row" style="margin-top:8px">
        ${decide ? '<button class="primary" data-d="accept">Accept the report</button><button class="bad" data-d="return">Return for changes</button>' : ""}
        <button data-d="comment">Add comment</button><span class="hint" id="rvMsg" role="status"></span></div></div>` : ""}</div>`;
  }

  async function job(id) {
    let v; try { v = await get(share ? `${base}/data` : `/api/das/jobs/${id}/review`); } catch (e) { return say(e.message, true); }
    document.title = `${v.name} · review`;
    document.getElementById("rvTitle").textContent = v.name;
    const T = v.testing || {}, ins = T.instruments || [];
    main.innerHTML = `${share ? "" : '<p class="no-print" style="margin:0 0 12px"><a class="btn" href="/review">← All reports</a></p>'}
      <div class="grid"><div class="panel"><h2>Building</h2><dl class="kv">
        ${v.address ? `<dt>Address</dt><dd>${h(v.address)}</dd>` : ""}${v.ahj ? `<dt>AHJ</dt><dd>${h(v.ahj)}</dd>` : ""}
        ${v.client ? `<dt>Owner / client</dt><dd>${h(v.client)}</dd>` : ""}${v.booster_class ? `<dt>Booster</dt><dd>${h(v.booster_class)}</dd>` : ""}
        <dt>Stage</dt><dd>${h(v.stage)}</dd>${v.accepted_on ? `<dt>Accepted on</dt><dd>${h(v.accepted_on)}</dd>` : ""}${v.retest_due ? `<dt>Annual retest due</dt><dd>${h(v.retest_due)}</dd>` : ""}
        <dt>Last changed</dt><dd class="mono">${h(v.updated_at || "")}</dd></dl>${share ? `<p class="hint" style="margin:10px 0 0">Review: ${chip(v.review.status)}</p>` : ""}</div>
      ${profileBlock(v)}
      <div class="panel"><h2>Tester</h2><dl class="kv">
        <dt>Tester</dt><dd>${h(T.tester || "not given")}</dd>${T.grol ? `<dt>FCC GROL</dt><dd>${h(T.grol)}</dd>` : ""}${T.nicet ? `<dt>NICET</dt><dd>${h(T.nicet)}</dd>` : ""}
        ${T.date ? `<dt>Tested</dt><dd>${h(T.date)}${T.date2 ? ` to ${h(T.date2)}` : ""}</dd>` : ""}</dl>
        ${ins.length ? `<h3>Instruments</h3><div class="tw"><table><thead><tr><th>Model</th><th>Serial</th><th>Calibrated</th></tr></thead><tbody>${ins.map(i => `<tr><td>${h(i.model)}</td><td class="mono">${h(i.serial)}</td><td class="mono">${h(i.cal)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="hint">No instruments listed.</p>'}</div></div>
      ${(v.floors || []).map(f => floorBlock(v, f)).join("") || '<div class="panel"><p class="hint" style="margin:0">No floors on this job yet.</p></div>'}
      <div class="panel"><h2>Files</h2>${(v.files || []).length ? `<div class="list">${v.files.map(n => `<a class="job" href="${fileUrl(v.id, n)}" target="_blank" rel="noopener"><b>${h(n)}</b><span class="hint">Open</span></a>`).join("")}</div>`
        : '<p class="hint" style="margin:0">No files shared for review.</p>'}</div>
      ${share ? "" : reviewBlock(v)}
      ${!scoring() ? '<p class="hint">Pass / fail is in the filed report: this page couldn\'t load the scoring.</p>' : ""}
      <p class="hint">${share ? "A read-only copy of the test record. The link stops working when it expires or the firm turns it off." : "Scored by the same rules as the printed report. Your decision and comment are kept in the job's record."}</p>`;
    main.querySelectorAll("[data-d]").forEach(b => b.onclick = async () => {
      const msg = document.getElementById("rvMsg"), text = document.getElementById("rvText").value.trim(), d = b.dataset.d;
      if (d === "accept" && !confirm("Accept this report?")) return;
      main.querySelectorAll("[data-d]").forEach(x => x.disabled = true); msg.textContent = "Saving…";
      try { await send(`/api/das/jobs/${v.id}/review`, {decision: d, comment: text}); await job(v.id); }
      catch (e) { msg.textContent = e.message; main.querySelectorAll("[data-d]").forEach(x => x.disabled = false); }
    });
  }

  me();
  const id = new URLSearchParams(location.search).get("job");
  if (share) job(null); else if (id && /^\d+$/.test(id)) job(+id); else list();
})();
