"use strict";
/* RF Recon — DAS job revisions, save conflicts, history and access (11/4; the server side is dashist.py).
   Every save of a job says which revision the page's copy came from (core.js api() hands /api/das/jobs saves here), and
   one job's saves go one at a time. The revision is the one the page was drawn from, never a later save's answer. When someone else changed the same thing since, the server says what, and the page
   asks: keep theirs, keep yours, or see both first; the rest of the save goes through either way. The job's Log tab
   gets History (every change, who and when, Undo or Restore to that point, written as a new revision) and Sharing (who
   can open the job, an AHJ reviewer's login, the files they see, the review thread, read-only share links). */

const DASREV = {rev: {}, q: {}, client: (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 36)};
const dasRevSeen = (j, full) => { if(j && j.id != null && j.rev != null && (full || DASREV.rev[j.id] == null)) DASREV.rev[j.id] = j.rev; };
const dasWho = w => !w || w === "local" ? "this PC" : w;

window.dasJobApi = async (path, opts) => {
  const m = path.match(/^\/api\/das\/jobs(?:\/(\d+))?$/), post = (opts?.method || "GET").toUpperCase() === "POST";
  if(!(post && m[1])){
    const r = await api(path, {...(opts || {}), dasRaw: true});
    if(Array.isArray(r?.jobs)) r.jobs.forEach(x => dasRevSeen(x, false)); else dasRevSeen(r, true);
    return r; }
  const id = m[1], body = JSON.parse(opts.body || "{}");
  const run = (DASREV.q[id] || Promise.resolve()).catch(() => {}).then(() => dasRevSave(path, id, body));
  DASREV.q[id] = run;
  return run;
};

async function dasRevSave(path, id, body){
  if(body.rev == null && DASREV.rev[id] != null) body.rev = DASREV.rev[id];
  body.client = DASREV.client;
  for(let i = 0; i < 4; i++){
    const r = await fetch(path, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
    if(r.status === 401){ location.href = "/remote/login"; throw new Error("Signed out."); }
    const t = await r.text(); let j; try{ j = JSON.parse(t); }catch(e){ throw new Error(t.slice(0, 200) || r.statusText); }
    if(r.status === 409 && j.conflict){
      const how = await dasRevAsk(j);
      body.resolve = {...(body.resolve || {}), ...Object.fromEntries(j.sections.map(s => [s.key, how]))};
      continue; }  // the same save, from the same revision: the server merges again with the choice for what clashed
    if(!r.ok || j.error) throw new Error(j.error || r.statusText);
    // a page keeps the revision it was drawn from (a GET), so a later answer's merged-in changes still count as
    // someone else's; after a clash was settled, the page is drawn again to show both people's changes
    if(body.resolve && S.tab === "das") setTimeout(() => render(), 0);
    return j; }
  throw new Error("The job kept changing while this saved. Reload it and make the change again.");
}

// "Someone else changed <section> just now": one choice for what clashed; everything else in the save is kept
function dasRevAsk(c){
  return new Promise(ok => {
    const d = document.createElement("dialog"); d.className = "dasrev-dlg"; d.setAttribute("aria-labelledby", "drvH");
    const names = c.sections.map(s => s.label), by = [...new Set(c.sections.map(s => dasWho(s.by)))].join(" and ");
    const at = c.sections.map(s => s.at).filter(Boolean).sort().pop() || "";
    d.innerHTML = `<div class="dasrev-b"><h3 id="drvH" style="margin:0 0 6px">Someone else changed ${esc(names.join(", "))} just now</h3>
      <p class="hint" style="margin:0 0 12px">${esc(by)} saved ${names.length === 1 ? "it" : "them"}${at ? ` at ${esc(at.slice(11, 16))}` : ""}. Your other changes save either way.</p>
      <div class="row" style="gap:8px;flex-wrap:wrap"><button data-c="theirs">Keep theirs</button><button class="primary" data-c="mine">Keep yours</button><button data-c="both" aria-expanded="false">See both</button></div>
      <div id="drvBoth" hidden style="margin-top:12px"><div class="tw" style="max-height:46vh"><table><thead><tr><th>What</th><th>Theirs (${esc(by)})</th><th>Yours</th></tr></thead><tbody>
        ${c.sections.flatMap(s => s.paths).map(p => `<tr><td>${esc(p.path)}</td><td>${esc(p.theirs)}</td><td>${esc(p.mine)}</td></tr>`).join("")}</tbody></table></div></div></div>`;
    d.addEventListener("cancel", e => e.preventDefault());  // a choice is needed: Escape doesn't drop the save
    d.querySelectorAll("[data-c]").forEach(b => b.onclick = () => {
      if(b.dataset.c === "both"){ const x = d.querySelector("#drvBoth"); x.hidden = !x.hidden; b.setAttribute("aria-expanded", String(!x.hidden)); b.textContent = x.hidden ? "See both" : "Hide"; return; }
      d.close(); d.remove(); ok(b.dataset.c); });
    document.body.append(d); d.showModal(); d.querySelector("[data-c=mine]").focus();
  });
}

/* ---------- History: every change, newest first ---------- */
window.dasHistory = async function(el, j){
  el.innerHTML = '<div class="panel"><p class="hint" style="margin:0">Loading the history…</p></div>';
  let H; try{ H = await api(`/api/das/jobs/${j.id}/history?limit=40`); }catch(e){ el.innerHTML = `<div class="panel"><p class="status err">${esc(e.message)}</p></div>`; return; }
  const items = [...H.items], canEdit = !S.remote || S.remote.role === "full";
  const kb = n => n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`;
  const when = it => it.saves > 1 && it.ts_lo && it.ts_lo !== it.ts ? `${it.ts_lo.slice(0, 16)}–${it.ts.slice(11, 16)}` : it.ts.slice(0, 16);
  const row = it => `<li class="dasrev-it" data-rev="${it.rev}"><div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:baseline">
      <span><b>${esc(dasWho(it.who))}</b> <span class="hint mono">${esc(when(it))}${it.saves > 1 ? ` · ${it.saves} saves` : ""} · revision ${it.rev_lo !== it.rev ? `${it.rev_lo}–` : ""}${it.rev}</span>
        ${it.note ? `<span class="tag">${esc(it.note)}</span>` : ""}</span>
      ${!canEdit ? "" : `<span class="row" style="gap:6px">${it.note === "new job" ? "" : `<button class="sm" data-undo="${it.rev}" title="Put ${esc(it.sections.map(s => s.label).join(", "))} back as before this change; later changes stay in the history">Undo</button>`}${it.rev !== H.rev ? `<button class="sm" data-to="${it.rev}" title="The whole job as it was right after this change, as a new revision">Restore to here</button>` : ""}</span>`}</div>
    ${it.sections.map(s => `<div class="dasrev-sec"><span class="dasrev-lab">${esc(s.label)}</span><span>${s.lines.map(esc).join("<br>")}</span></div>`).join("")}</li>`;
  const draw = () => {
    el.innerHTML = `<div class="panel"><h3>History <span class="hint">· ${H.kept.revisions} revision${H.kept.revisions === 1 ? "" : "s"} kept, ${kb(H.kept.bytes)}; the newest ${H.kept.keep_min} always stay</span></h3>
      ${items.length ? `<ol class="dasrev-list">${items.map(row).join("")}</ol>` : '<p class="hint">No changes saved since history began on this job.</p>'}
      <div class="row" style="margin-top:8px;gap:8px;align-items:center">${H.more ? '<button id="dhMore">Older changes</button>' : ""}<span class="hint" id="dhMsg" role="status"></span></div>
      <p class="hint" style="margin:8px 0 0">Undo and Restore save a new revision: nothing is taken out of the history. Saves by one person on one page within 90 seconds show as one change.</p></div>`;
    el.querySelector("#dhMore")?.addEventListener("click", async () => {
      try{ const r = await api(`/api/das/jobs/${j.id}/history?limit=40&before=${items[items.length - 1].rev}`); items.push(...r.items); H.more = r.more; draw(); }
      catch(e){ el.querySelector("#dhMsg").textContent = e.message; } });
    el.querySelectorAll("[data-undo],[data-to]").forEach(b => b.onclick = async () => {
      const undo = b.dataset.undo != null, rev = +(b.dataset.undo ?? b.dataset.to), it = items.find(x => x.rev === rev);
      if(!confirm(undo ? `Undo this change (${it.sections.map(s => s.label).join(", ")})? It saves as a new revision.` : `Put the whole job back as it was after revision ${rev}? It saves as a new revision; nothing is lost from the history.`)) return;
      el.querySelector("#dhMsg").textContent = "Saving…";
      try{ const r = await post(`/api/das/jobs/${j.id}/restore`, {rev, mode: undo ? "undo" : "to"}); dasRevSeen(r, true); dasSay(undo ? "Undone. The history has it as a new change." : `Restored to revision ${rev}.`); render(); }
      catch(e){ el.querySelector("#dhMsg").textContent = e.message; } });
  };
  draw();
};

/* ---------- Sharing: who can open the job, the AHJ's review, read-only links ---------- */
const DAS_LEVELS = [["view", "View"], ["review", "Review (AHJ)"], ["edit", "Edit"]];
const DAS_ROLE_NAME = {view: "View only login", full: "Full login", admin: "Admin", ahj: "AHJ reviewer login", gone: "login removed"};
window.dasAccess = async function(el, j){
  el.innerHTML = '<div class="panel"><p class="hint" style="margin:0">Loading…</p></div>';
  let A; try{ A = await api(`/api/das/jobs/${j.id}/access`); }catch(e){ el.innerHTML = `<div class="panel"><p class="status err">${esc(e.message)}</p></div>`; return; }
  const M = A.can_manage, team = A.list.find(x => x.who === "*"), named = A.list.filter(x => x.who !== "*");
  const on = new Set(named.map(x => x.who)), addable = A.people.filter(p => p.role !== "admin" && !on.has(p.name.toLowerCase()));
  const sel = (who, cur, opts) => `<select data-lv="${esc(who)}" ${M ? "" : "disabled"} aria-label="Access for ${esc(who === "*" ? "the whole team" : who)}">${opts.map(([k, l]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${l}</option>`).join("")}</select>`;
  const st = A.review.status, chip = `<span class="tag dasrev-${esc(st)}">${esc({waiting: "Waiting for review", accepted: "Accepted", returned: "Returned"}[st] || st)}</span>`;
  const sh = A.share;
  el.innerHTML = `<div class="grid2" style="margin-top:0">
    <div class="panel"><h3>Who can open this job</h3>
      <div class="tw"><table><tbody>
        <tr><td><b>Whole team</b><br><span class="hint">every View only and Full login, at their login's level</span></td><td style="text-align:right">${sel("*", team ? team.level : "none", [["edit", "On"], ["view", "View only"], ["none", "Off"]])}</td></tr>
        ${named.map(x => `<tr><td><b>${esc(x.name)}</b><br><span class="hint">${esc(DAS_ROLE_NAME[x.role] || x.role)} · added by ${esc(dasWho(x.added_by))} ${esc((x.added_at || "").slice(0, 10))}</span></td>
          <td style="text-align:right;white-space:nowrap">${sel(x.who, x.level, x.role === "ahj" ? DAS_LEVELS.slice(0, 2) : DAS_LEVELS)}${M ? ` <button class="sm" data-rm="${esc(x.who)}" aria-label="Take ${esc(x.name)} off this job">Remove</button>` : ""}</td></tr>`).join("")}
        <tr><td colspan="2" class="hint">The admin always sees every job.</td></tr></tbody></table></div>
      ${M ? (addable.length ? `<div class="row" style="margin-top:8px;gap:8px;flex-wrap:wrap"><select id="daWho" aria-label="Login to add">${addable.map(p => `<option value="${esc(p.name)}" data-role="${esc(p.role)}">${esc(p.name)} · ${esc(DAS_ROLE_NAME[p.role] || p.role)}</option>`).join("")}</select>
          <select id="daLv" aria-label="Their access">${DAS_LEVELS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select><button class="primary" id="daAdd">Add</button></div>`
        : `<p class="hint" style="margin:8px 0 0">${A.people.length ? "Every login is on this job." : "No logins on this copy. The admin adds people (and AHJ reviewer logins) in Data & updates, Remote access."}</p>`) : ""}
      <p class="hint" style="margin:8px 0 0">An AHJ reviewer login sees only the jobs shared with it, on its own review page, and can Accept or Return the report.</p>
      <p class="hint" id="daMsg" role="status" style="margin:4px 0 0"></p></div>
    <div class="panel"><h3>AHJ review ${chip}</h3>
      ${A.review.thread.length ? `<ol class="dasrev-list">${A.review.thread.map(t => `<li class="dasrev-it"><b>${esc(dasWho(t.who))}</b> <span class="hint mono">${esc(t.ts.slice(0, 16))}</span>
        ${t.decision !== "comment" ? `<span class="tag">${t.decision === "accept" ? "Accepted" : "Returned"}</span>` : ""}${t.comment ? `<div style="white-space:pre-wrap">${esc(t.comment)}</div>` : ""}</li>`).join("")}</ol>` : '<p class="hint">No review yet.</p>'}
      ${A.level !== "view" ? `<label class="hint" style="display:block;margin-top:6px">Reply to the reviewer<textarea id="daRe" rows="2" style="width:100%"></textarea></label><div class="row" style="gap:8px;margin-top:6px"><button id="daSay">Add comment</button>
        <button id="daSee" title="The review page an AHJ reviewer login gets, for this job">See what the reviewer sees ↗</button></div>` : ""}
      <h3 style="margin-top:14px">Files the reviewer sees</h3>
      ${A.files.length ? `<div class="dasrev-files">${A.files.map(n => `<label class="inl"><input type="checkbox" data-rf="${esc(n)}" ${A.review_files.includes(n) ? "checked" : ""} ${M ? "" : "disabled"}> ${esc(n)}</label>`).join("")}</div>
        <p class="hint" style="margin:6px 0 0">${A.picked ? "Picked by hand." : "Until you pick, the floor plans and any PDF with “report” in its name."}</p>` : '<p class="hint">No files on the job yet (Files tab).</p>'}</div>
    <div class="panel"><h3>Read-only links</h3>
      ${!sh.on ? `<p style="margin:0 0 6px"><b>Share links are off.</b></p><p class="hint" style="margin:0">When on, a job's editors can make a link that opens a read-only copy of the test record (no sign-in) for an owner or a radio shop, for ${sh.days[0]} to ${sh.days[1]} days.</p>
          ${A.admin ? '<button id="daOn" style="margin-top:8px">Turn share links on</button>' : '<p class="hint" style="margin:6px 0 0">The admin turns them on.</p>'}`
        : `${M ? `<div class="row" style="gap:8px;flex-wrap:wrap"><input id="daLab" placeholder="Who it's for (owner, radio shop)" maxlength="80" style="min-width:200px">
            <select id="daDays" aria-label="How long the link works">${[1, 7, 30, 90].map(n => `<option value="${n}" ${n === 7 ? "selected" : ""}>${n} day${n === 1 ? "" : "s"}</option>`).join("")}</select><button class="primary" id="daMake">Make a link</button></div><div id="daNew"></div>` : ""}
          ${sh.links.length ? `<div class="tw" style="margin-top:8px"><table><thead><tr><th>For</th><th>Until</th><th class="n">Opened</th><th></th></tr></thead><tbody>${sh.links.map(l => `<tr><td>${esc(l.label || "—")}<br><span class="hint">by ${esc(dasWho(l.made_by))}</span></td>
            <td class="mono">${esc(l.expires.slice(0, 16))}<br><span class="hint">${esc(l.state)}</span></td><td class="n">${l.uses}</td><td>${l.state === "live" && M ? `<button class="sm" data-revoke="${l.id}">Turn off</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : ""}
          ${A.admin ? '<button id="daOff" style="margin-top:8px">Turn share links off (every link stops)</button>' : ""}`}</div></div>`;
  const msg = t => { const x = el.querySelector("#daMsg"); if(x) x.textContent = t; };
  const again = () => window.dasAccess(el, j);
  const put = async (who, level) => { try{ await post(`/api/das/jobs/${j.id}/access`, {who, level}); again(); }catch(e){ msg(e.message); } };
  el.querySelectorAll("[data-lv]").forEach(s => s.onchange = () => put(s.dataset.lv, s.value));
  el.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => put(b.dataset.rm, "none"));
  const who = el.querySelector("#daWho");
  if(who){ const fit = () => { const ahj = who.selectedOptions[0]?.dataset.role === "ahj", lv = el.querySelector("#daLv");
      [...lv.options].forEach(o => o.disabled = ahj && o.value === "edit"); if(ahj) lv.value = "review"; }; who.onchange = fit; fit(); }
  el.querySelector("#daAdd")?.addEventListener("click", () => put(who.value, el.querySelector("#daLv").value));
  el.querySelectorAll("[data-rf]").forEach(c => c.onchange = async () => {
    try{ await post(`/api/das/jobs/${j.id}/access`, {review_files: [...el.querySelectorAll("[data-rf]:checked")].map(x => x.dataset.rf)}); again(); }catch(e){ msg(e.message); } });
  el.querySelector("#daSay")?.addEventListener("click", async () => { const t = el.querySelector("#daRe").value.trim(); if(!t) return;
    try{ await post(`/api/das/jobs/${j.id}/review`, {decision: "comment", comment: t}); again(); }catch(e){ msg(e.message); } });
  el.querySelector("#daSee")?.addEventListener("click", () => window.open(`/review?job=${j.id}`, "_blank", "noopener"));
  const toggle = async v => { try{ await post("/api/das/share-links", {on: v}); again(); }catch(e){ msg(e.message); } };
  el.querySelector("#daOn")?.addEventListener("click", () => { if(confirm("Turn share links on? Anyone with a link can open that job's read-only record until it expires or you turn it off.")) toggle(true); });
  el.querySelector("#daOff")?.addEventListener("click", () => toggle(false));
  el.querySelector("#daMake")?.addEventListener("click", async () => {
    try{ const r = await post(`/api/das/jobs/${j.id}/share`, {days: +el.querySelector("#daDays").value, label: el.querySelector("#daLab").value});
      const url = location.origin + r.path; await again();
      el.querySelector("#daNew")?.insertAdjacentHTML("beforeend", `<p style="margin:8px 0 0"><span class="mono" style="user-select:all;word-break:break-all">${esc(url)}</span> <button class="sm" id="daCopy">Copy</button></p>
        <p class="hint" style="margin:2px 0 0">Shown only now. It works until ${esc(r.expires.slice(0, 16))}.</p>`);
      el.querySelector("#daCopy")?.addEventListener("click", async e => { try{ await navigator.clipboard.writeText(url); e.target.textContent = "Copied"; }catch(err){ /* select it by hand */ } }); }
    catch(e){ msg(e.message); } });
  el.querySelectorAll("[data-revoke]").forEach(b => b.onclick = async () => { try{ await post(`/api/das/jobs/${j.id}/share/revoke`, {id: +b.dataset.revoke}); again(); }catch(e){ msg(e.message); } });
};

document.head.insertAdjacentHTML("beforeend", `<style>
.dasrev-dlg{max-width:640px}.dasrev-b{padding:18px 20px}
.dasrev-list{list-style:none;margin:0;padding:0}.dasrev-it{padding:9px 0;border-top:1px solid var(--line)}.dasrev-it:first-child{border-top:0}
.dasrev-sec{display:grid;grid-template-columns:minmax(110px,max-content) 1fr;gap:2px 12px;margin-top:4px;font-size:13px;overflow-wrap:anywhere}
.dasrev-lab{color:var(--muted,var(--dim,#999));font-weight:600}
.dasrev-files{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto}
.dasrev-accepted{color:var(--good,#2da44e)}.dasrev-returned{color:var(--bad,#cf222e)}
@media (max-width:600px){.dasrev-sec{grid-template-columns:1fr}.dasrev-b{padding:14px}}
</style>`);
