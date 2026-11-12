"use strict";
/* DAStastic: Walk me through (Cody 11/5: "walk you through the whole thing, even moving to the location in the DAS tab, in auto mode or
   hit Next or Done, even if you already started without it, and pick up where you are and check where you've been so far").
   One job, start to finish, on the fault chart's own steps (dasfi_data.js): nothing here is a second copy of them. Before it starts it
   reads the job and says, stage by stage, what's on file and what's missing, so it works on a job begun without it. It picks up at the
   first step the record and the saved answers can't get past. The panel stays on screen as the DAS tab moves under it.
   Step: it waits for Next or Done. Auto: it opens each place itself and moves on when the record shows the step done. Only what DAStastic
   can see can be seen: a physical check (is the head-end powered on?) always waits for a person, in either mode.
   Answers are kept on the job (data.guide), so anyone can carry on from any browser. A stage's end goes through the same gate as the DAS
   tab (dasMoveStage). Needs core.js, das.js, dasfi.js, dascode.js. */
(() => {
  const P = () => window.dasFiParts, FI = () => window.DAS_FI, LS = "rfr.guide";
  const G = S.dasGuide = S.dasGuide || { job: null, j: null, tree: null, step: null, stack: [], path: [], auto: false, fold: false, view: "where" };
  const POLL_MS = 4000;

  // what the record can say about a step comes from the server, on every job (nextstep.py record_checks, standing.checks): true on file,
  // false not on file, null it can't tell. The chart's steps are physical as often as not, and those have no entry. Where a job picks up
  // comes from there too (standing.walk), so the board and the guide stop at one step: the walk below is the same one, and it carries on
  // from that step as answers come in (tests/guide_walk_check.mjs runs it beside the server's)
  const rec = (j, key) => { const v = ((j.standing || {}).checks || {})[key]; return v == null ? undefined : v; };
  // the guide's own reads of the job leave the page's revision alone (dasRaw): the views drawn on the DAS tab stay what the page's
  // saves go as of, so a change someone made since is asked about, not overwritten (review 11/10: a read here moved it to the
  // latest copy). A page that hasn't drawn the job takes its first read's revision, so a stage move from here still names one
  const fetchJob = async id => { const j = await api(`/api/das/jobs/${id}`, { dasRaw: true }); if (typeof dasRevSeen === "function") dasRevSeen(j, false); return j; };

  const FACT = new Set(["R5e.b"]);  // what kind of job this is: a No here isn't something missing
  const stageNo = j => Math.max(1, P().STAGES.indexOf(j.stage) + 1);
  const trees = (n, d) => { const s = dasScope(d); return FI().trees.filter(t => t.kind === "run" && t.stage === n && (t.scope === "both" || (t.scope === "e" && s.ps) || (t.scope === "c" && s.cell))); };
  const tree = () => P().TREES().get(G.tree), node = () => { const t = tree(); return t && (t.nodes.find(n => n.id === G.step) || t.nodes.find(n => n.id === t.start)); };
  const answers = d => (d.guide || {}).answers || {};
  const said = (t, n, j) => { const key = `${t.id}.${n.id}`, v = rec(j, key);
    if (v !== undefined) return { v, from: "record" };
    const a = answers(j.data || {})[key]; return a ? { v: a.a, from: "answer", at: a.at, by: a.by } : null; };
  const after = (n, v) => { if (n.opts) return n.opts.find(o => o.l === v)?.to || null;
    if (n.k === "test") return v === true || v === "Yes" ? n.yes : v === false || v === "No" ? n.no : null;
    return v === false ? null : n.next || null; };
  // from a chart's first step, as far as the record and the saved answers can say. It stops at a step nobody can answer yet, at a
  // failed check (that's where the fault chart comes in), and at the chart's end
  function walk(t, j) {
    const by = new Map(t.nodes.map(n => [n.id, n])), seenIds = new Set(), rows = []; let id = t.start;
    while (id && by.has(id) && !seenIds.has(id)) { seenIds.add(id); const n = by.get(id);
      if (n.k === "done") return { rows, at: n, end: true };
      const s = said(t, n, j); if (!s) return { rows, at: n };
      const to = after(n, s.v); if (!to || P().isTree(to)) return { rows, at: n };
      rows.push({ n, s }); id = to; }
    return { rows, at: by.get(id) || by.get(t.start) };
  }
  // where the job stands, stage by stage up to its own: what the record shows on file and missing, and where the walk stops
  function stands(j) {
    const d = j.data || {}, out = [];
    for (let s = 1; s <= stageNo(j); s++) for (const t of trees(s, d)) { const on = [], miss = [];
      for (const n of t.nodes) { const v = rec(j, `${t.id}.${n.id}`); if (v === true) on.push(n); else if (v === false && !FACT.has(`${t.id}.${n.id}`)) miss.push(n); }
      const w = walk(t, j); out.push({ s, t, on, miss, w, told: t.nodes.filter(n => answers(d)[`${t.id}.${n.id}`]).length }); }
    return out;
  }
  const pickUp = j => { const now = stands(j).filter(r => r.s === stageNo(j)), w = (j.standing || {}).walk, hit = w && now.find(r => r.t.id === w.tree), n = hit && hit.t.nodes.find(x => x.id === w.step);
    return n ? { ...hit, w: { ...hit.w, at: n, end: !!w.end } } : now.find(r => !r.w.end) || now[now.length - 1]; };

  /* ---------- moving the DAS tab ---------- */
  function placeOf(n) {
    const at = n.at || "", m = at.match(/^Job > ([A-Za-z -]+?)(?:,\s*(.+))?$/), SUB = P().SUB;
    if (m && SUB[m[1]]) return { sub: SUB[m[1]], mark: m[2], label: m[1] };
    if (/^PIM/.test(at)) return { tab: "pim", label: "PIM" };
    if (/^Parts, job Materials/.test(at)) return { sub: "materials", label: "Materials" };
    if (/^Top of this page/.test(at)) return { sub: "overview", label: "Overview" };
    if (/^DAS > Board/.test(at)) return { board: true, label: "the job board" };
    return null;
  }
  // the section it named, when the page has a heading with those words: the eye goes there, and a page that has none just stays put
  function mark(words) {
    const w = String(words || "").toLowerCase().replace(/^step (\d).*/, "step $1").trim(); if (!w) return;
    const hit = [...document.querySelectorAll("#djBody h3,#djBody h4,#djBody summary,#djBody legend,#djBody b")].find(e => e.textContent.toLowerCase().includes(w));
    if (!hit) return false; hit.scrollIntoView({ block: "center", behavior: "smooth" }); hit.classList.add("dg-here"); setTimeout(() => hit.classList.remove("dg-here"), 2600);
    return true;
  }
  // already there, a person's press says so: on 11/9 a press on the page already open changed nothing you could see ("We were just
  // there"). Auto mode calls take() by itself on every step and poll, so it stays quiet then
  function take(n, pressed) {
    const p = placeOf(n); if (!p) return;
    const there = () => { if (pressed) dasSay(`You're on ${p.label} already.`, true); };
    if (p.tab) { if (S.tab !== p.tab) setTab(p.tab); else there(); return; }
    S.das = S.das || { view: "board", q: "", job: null, sub: "overview" };
    if (p.board) { S.das.view = "board"; S.das.job = null; if (S.tab === "das") render(); else setTab("das"); return; }
    const here = S.tab === "das" && S.das.job === G.job && S.das.sub === p.sub;
    if (!here) { S.das.view = "board"; S.das.job = G.job; S.das.sub = p.sub; if (S.tab === "das") render(); else setTab("das"); }
    // a section the page has no heading for: a press on the page already open still says where you are (review 11/11: it did nothing)
    if (p.mark) setTimeout(() => { if (!mark(p.mark) && here) there(); }, here ? 0 : 800);
    else if (here) there();
  }

  /* ---------- the walk ---------- */
  // steps whose record waits on a fact Run it for me chose (nextstep.py record_checks: opened(); tests/test_nextstep.py keeps the two
  // lists the same). The record reads "not on file" until a person looks, and a person answering the step there has looked: the
  // answer confirms it, as Looks right does (dasauto.js dasAutoOk). 11/9: Andy's Yes on the AHJ step never counted, the AHJ waited on a
  // Looks right he couldn't see, and the walk kept coming back ("Take me there. We were just there."). The record still wins.
  const OPEN_FACT = { "R1.c": "ahj", "R2e.f": "plan" };
  const waiting = (t, n) => { const f = OPEN_FACT[`${t.id}.${n.id}`]; return !!f && (((G.j.data || {}).auto || {}).open || []).includes(f) ? f : ""; };
  // what the answer confirms, named, so nobody confirms a guess they haven't seen (review, 11/10)
  const factWords = f => { const d = G.j.data || {}, plan = ((d.presurvey || {}).plan || []);
    return f === "ahj" ? `the AHJ, <b>${esc(d.ahj || "")}</b>` : `the channel plan, <b>${plan.length} channel${plan.length === 1 ? "" : "s"}</b>`; };
  async function keep(patch) {
    const j = G.j, guide = { ...((j.data || {}).guide || {}), ...patch };
    try { G.j = await post(`/api/das/jobs/${j.id}`, { data: { guide }, rev: j.rev }); }  // as of the copy it was worked out on
    catch (e) { dasSay("Not saved: " + e.message); G.j = { ...j, data: { ...j.data, guide } }; }  // the walk carries on: the next save tries again
  }
  function arrive() {
    if (G.auto) { const t = tree(), n = node(), s = t.kind === "run" && n.k !== "done" ? said(t, n, G.j) : null;
      if (s && s.from === "record" && s.v !== false) { const to = after(n, s.v); if (to && !P().isTree(to)) { G.step = to; return arrive(); } }
      take(node()); }
    draw();
  }
  async function answer(to, label) {
    const t = tree(), n = node(), f = waiting(t, n);
    if (f && (n.k !== "test" || label === "Yes") && window.dasAutoOk) {
      // once it's saved, only this job's Looks right line on the Overview goes (no redraw under the person); the panel stays as the
      // DAS tab moves, so the Overview on screen can be another job's (review 11/10)
      try { G.j = await window.dasAutoOk(G.j, f); if (f === "ahj") document.querySelector(`#ahjOk[data-job="${G.job}"]`)?.remove(); }
      catch (e) { dasSay("Not saved: " + e.message); } }
    if (t.kind === "run") await keep({ answers: { ...answers(G.j.data), [`${t.id}.${n.id}`]: { a: label, at: today(), by: (S.me && S.me.user) || "" } } });
    G.path.push({ tree: G.tree, step: G.step });
    if (P().isTree(to)) { G.stack.push({ tree: G.tree, step: n.then || n.id }); G.tree = to; G.step = null; } else G.step = to;
    arrive();
  }
  function begin() { const r = pickUp(G.j); G.tree = r.t.id; G.step = r.w.at.id; G.stack = []; G.path = []; G.view = "step"; arrive(); }
  const stageWords = to => ({ title: `Before ${to}`, intro: "This job's file is still missing these. Do them now, or say why you're moving on.", hints: window.startNeedHint, whyLabel: "Moving on anyway: why?", placeholder: "Waiting to hear back from the fire marshal",
    stay: "Stay here", go: "Move on", open: sub => { S.das = S.das || { q: "" }; S.das.view = "board"; S.das.job = G.job; S.das.sub = sub; if (S.tab === "das") render(); else setTab("das"); } });
  function nextStage(n) {
    const to = P().STAGES[n.stage - 1];
    window.dasMoveStage(G.job, to, async moved => { if (!moved) return; G.j = await fetchJob(G.job); begin(); }, stageWords(to));
  }

  /* ---------- the panel: on the page, not in a tab, so it stays as the tabs move under it ---------- */
  const box = () => document.getElementById("dgPanel") || Object.assign(document.body.appendChild(document.createElement("div")), { id: "dgPanel", className: "dg no-print" });
  const modeHtml = () => `<span class="seg dg-mode" id="dgMode"><button data-mode="step" class="${G.auto ? "" : "on"}" title="It waits for you to press Next or Done">Step</button><button data-mode="auto" class="${G.auto ? "on" : ""}" title="It opens each place itself and moves on when the record shows the step done. Physical checks still wait for you">Auto</button></span>`;
  const head = title => `<div class="dg-top"><b>${esc(title)}</b><span class="dg-tools">${modeHtml()}<button class="sm" id="dgFold" title="${G.fold ? "Open it" : "Fold it away"}" aria-label="${G.fold ? "Open the guide" : "Fold the guide"}">${G.fold ? "▴" : "▾"}</button><button class="sm" id="dgClose" title="Close. Your answers stay on the job" aria-label="Close the guide">✕</button></span></div>`;
  function whereHtml() {
    const rows = stands(G.j), now = stageNo(G.j), by = new Map(); rows.forEach(r => by.set(r.s, [...(by.get(r.s) || []), r]));
    const line = ([s, rs]) => { const on = rs.reduce((a, r) => a + r.on.length, 0), told = rs.reduce((a, r) => a + r.told, 0), miss = rs.flatMap(r => r.miss.map(n => ({ n, t: r.t }))), here = s === now;
      const say = [on ? `${on} on file` : "", told ? `${told} answered` : "", miss.length ? `${miss.length} missing` : ""].filter(Boolean).join(" · ") || "Nothing on file yet";
      return `<li class="${miss.length ? "gap" : here ? "now" : "ok"}"><b>${esc(P().STAGES[s - 1])}</b><span class="hint">${here ? "this stage · " : ""}${esc(say)}</span>
        ${miss.length ? `<ul>${miss.map(x => `<li>${esc(x.n.t)}${placeOf(x.n) ? ` <button class="sm" data-gap="${esc(x.t.id)}|${esc(x.n.id)}">Go there</button>` : ""}</li>`).join("")}</ul>` : ""}</li>`; };
    const r = pickUp(G.j);
    return `<p class="hint" style="margin:0 0 6px">${esc(G.j.name)}. This is what the job's record shows so far. A physical check isn't on any record, so it'll ask you about those as it goes.</p>
      <ol class="dg-where">${[...by].map(line).join("")}</ol>
      <p style="margin:8px 0 4px"><b>${r.w.end ? `${esc(r.t.title)} looks finished.` : "It picks up at:"}</b> ${r.w.end ? "" : esc(r.w.at.t)}</p>
      <div class="row dg-ans"><button class="primary" id="dgRun" title="Does every desk step it can, then gives you a list to check">Run it for me, I'll check after</button><button id="dgGo">Walk me through it</button>${(G.j.data.auto?.did || []).length ? `<button id="dgAfter">Check what it did</button>` : ""}</div>`;
  }
  const ROW_MARK = { working: "…", done: "✓", skip: "·", none: "·", failed: "!" };
  const rowHtml = r => `<li class="${r.state === "failed" ? "gap" : r.state === "done" ? "ok" : ""}"><b>${ROW_MARK[r.state] || ""} ${esc(r.label)}</b><span class="hint">${esc(r.state === "working" ? "Working on it…" : r.said || "")}</span></li>`;
  const runHtml = () => `<p class="hint" style="margin:0 0 6px">Doing the desk work for ${esc(G.j.name)}. Keep this page open: the building outline can take up to a minute. It only fills what's empty.</p><ol class="dg-where">${(G.rows || []).map(rowHtml).join("")}</ol>`;
  function afterHtml() {
    const a = G.j.data.auto || {}, did = a.did || [], check = did.filter(x => x.open), done = did.filter(x => !x.open), other = (G.rows || []).filter(r => r.state !== "done" || r.key === "mail"), r = pickUp(G.j);
    const line = x => `<li class="${x.open ? "gap" : "ok"}"><b>${esc(x.label)}</b><span class="hint">${esc(x.said || "")}</span><div class="row" style="gap:6px;margin-top:4px">${x.open ? `<button class="sm primary" data-ok="${esc(x.key)}">Looks right</button>` : ""}${Object.keys(x.after || {}).length ? `<button class="sm" data-undo="${esc(x.key)}">Undo</button>` : ""}</div></li>`;
    return `<p class="hint" style="margin:0 0 6px">${esc(G.j.name)}: what Run it for me did.</p>${check.length ? `<p style="margin:0 0 4px"><b>Check ${check.length === 1 ? "this" : `these ${check.length}`}.</b> DAStastic chose ${check.length === 1 ? "it" : "them"} for you, so ${check.length === 1 ? "it doesn't" : "they don't"} count until you say so.</p><ol class="dg-where">${check.map(line).join("")}</ol>` : `<p style="margin:0 0 4px"><b>Nothing left to check.</b></p>`}
      ${done.length ? `<p class="hint" style="margin:8px 0 4px">Also done:</p><ol class="dg-where">${done.map(line).join("")}</ol>` : ""}
      ${other.length ? `<ol class="dg-where" style="margin-top:6px">${other.map(rowHtml).join("")}</ol>` : ""}
      <p style="margin:8px 0 4px"><b>${r.w.end ? `${esc(r.t.title)} looks finished.` : "Next for a person:"}</b> ${r.w.end ? "" : esc(r.w.at.t)}</p>
      <div class="row dg-ans"><button class="primary" id="dgGo">Walk me through the rest</button></div>`;
  }
  function stepHtml() {
    const t = tree(), n = node(), P2 = P(), i = t.nodes.indexOf(n) + 1, s = t.kind === "run" ? said(t, n, G.j) : null, place = placeOf(n), ret = G.stack[G.stack.length - 1];
    const row = (k, v) => v ? `<dt>${k}</dt><dd>${P2.gloss(v)}</dd>` : "";
    const same = t.kind === "run" && n.k === "done" ? trees(t.stage, G.j.data).find(x => x.id !== t.id && !walk(x, G.j).end) : null;
    const ends = n.k !== "done" ? "" : ret ? `<button class="primary" data-ret="1">Back to ${esc(P2.nameOf(ret.tree))}</button>` : same ? `<button class="primary" data-tree="${esc(same.id)}">Next: ${esc(same.title)}</button>`
      : n.stage ? `<button class="primary" id="dgStage">Move this job to ${esc(P2.STAGES[n.stage - 1])}</button>` : `<button class="primary" id="dgDone">Finish</button>`;
    const fixed = n.k === "stop" && !n.next && ret ? `<button data-ret="1">Fixed. Back to ${esc(P2.nameOf(ret.tree))}</button>` : "";
    return `<div class="dg-crumb">${esc(t.title)} · step ${i} of ${t.nodes.length}${ret ? ` · after this, back to ${esc(P2.nameOf(ret.tree))}` : ""}</div>
      <span class="fi-kind" style="--c:var(${P2.KIND[n.k][1]})"><i></i>${P2.KIND[n.k][0]}</span><h3 class="dg-q" id="dgQ">${P2.gloss(n.t)}</h3>
      ${n.warn ? `<div class="fi-warn">${P2.gloss(n.warn)}</div>` : ""}
      ${s ? `<p class="dg-on">${s.from === "record" ? (s.v === false ? "The record says this isn't done." : "The record shows this is on file.") : `Answered ${esc(s.v === true ? "Yes" : s.v === false ? "No" : s.v)}${s.at ? ` on ${esc(s.at)}` : ""}${s.by ? ` by ${esc(s.by)}` : ""}.`}${waiting(t, n) ? ` DAStastic filled in ${factWords(waiting(t, n))} for you (Run it for me): ${n.k === "test" ? "Yes" : "your answer"} here confirms it.` : ""}</p>` : ""}
      <dl class="fi-dl">${row("How", n.how)}${row("Good is", n.good)}${row("Tool", n.tool)}${row("Who", n.who)}</dl>
      ${place ? `<button class="sm" id="dgThere" title="Opens ${esc(place.label)}, or shows the section when it's open already">Take me there</button>` : ""}
      <div class="row dg-ans">${P2.branches(n).map(b => `<button class="${b.c || ""}" data-to="${esc(b.to)}" data-l="${esc(b.l)}">${esc(b.l)}</button>`).join("")}${ends}${fixed}</div>
      <div class="row dg-low"><button class="sm" id="dgBack" ${G.path.length ? "" : "disabled"}>Back a step</button>${n.k === "test" || n.k === "do" ? `<button class="sm" id="dgStuck">Can't do this</button>` : ""}<button class="sm" id="dgWhere">Where this job stands</button></div>`;
  }
  function draw() {
    if (!G.job || !G.j) { document.getElementById("dgPanel")?.remove(); return; }
    const el = box(); el.classList.toggle("fold", !!G.fold); el.setAttribute("role", "region"); el.setAttribute("aria-label", "What's next on this job");
    const title = { where: "Where this job stands", run: "Running it for you", after: "Done. Check this" }[G.view] || "What's next on this job";  // the button's name (Cody 11/8, UX review #13)
    el.innerHTML = head(title) + (G.fold ? (G.view === "step" ? `<p class="dg-small">${esc(node()?.t || "")}</p>` : "") : `<div class="dg-body">${({ where: whereHtml, run: runHtml, after: afterHtml }[G.view] || stepHtml)()}</div>`);
    el.onclick = onClick;
  }
  // the page showing this job is drawn again from a fresh read after the run, Looks right or Undo: the DAS tab, or Start's step (review
  // round 5: Start stayed as drawn before the run, so the person's next Start save clashed with their own run, and Keep yours, the
  // focused button, saved Start's old blank area over the run's 45,000 sq ft)
  const redrawJob = id => { if (S.tab === "das") render(); else if (S.tab === "start" && window.startRedraw) window.startRedraw(id); };
  async function onClick(e) {
    const b = e.target.closest("button"); if (!b) return; const d = b.dataset;
    if (d.mode) { G.auto = d.mode === "auto"; await keep({ auto: G.auto }); if (G.view === "step") arrive(); else draw(); }
    else if (b.id === "dgFold") { G.fold = !G.fold; draw(); }
    else if (b.id === "dgClose") { G.job = null; G.j = null; localStorage.removeItem(LS); draw(); }
    else if (b.id === "dgGo") { G.j = await fetchJob(G.job); begin(); }
    else if (b.id === "dgRun") {
      // the run belongs to the job it was pressed on: the panel can be opened on another job while it works (review 11/11: job A's
      // result took over job B's panel, and its Looks right then confirmed A's guess with nobody looking at A)
      const id = G.job, name = G.j.name, mine = () => G.job === id;
      G.view = "run"; G.rows = []; draw();
      try { const r = await window.dasAutoRun(id, rows => { if (mine()) { G.rows = rows; draw(); } });
        if (mine()) { G.j = r.job; G.rows = r.rows; G.view = "after"; redrawJob(id); }
        else dasSay(`Run it for me finished on ${name}. Its What's next has the list to check.`, true); }
      catch (err) { if (mine()) { dasSay(err.message); G.view = "where"; } else dasSay(`Run it for me stopped on ${name}: ${err.message}`); }
      if (mine()) draw(); }
    else if (b.id === "dgAfter") { G.j = await fetchJob(G.job); G.rows = []; G.view = "after"; draw(); }
    else if (d.ok || d.undo) { b.disabled = true; const id = G.job;
      try { const j = await (d.ok ? window.dasAutoOk(G.j, d.ok) : window.dasAutoUndo(G.j, d.undo)); if (G.job === id) G.j = j; redrawJob(id); } catch (err) { dasSay("Not saved: " + err.message); }
      draw(); }
    else if (b.id === "dgWhere") { G.j = await fetchJob(G.job); G.view = "where"; draw(); }
    else if (d.gap) { const [t, s] = d.gap.split("|"), n = P().TREES().get(t).nodes.find(x => x.id === s); take(n, true); }
    else if (b.id === "dgThere") take(node(), true);
    else if (d.to) answer(d.to, d.l);
    else if (d.ret) { const r = G.stack.pop(); G.tree = r.tree; G.step = r.step; arrive(); }
    else if (d.tree) { G.tree = d.tree; G.step = walk(P().TREES().get(d.tree), G.j).at.id; arrive(); }
    else if (b.id === "dgStage") nextStage(node());
    else if (b.id === "dgDone") { dasSay("That's the end of this job's walk.", true); G.job = null; G.j = null; localStorage.removeItem(LS); draw(); }
    else if (b.id === "dgBack") { const p = G.path.pop(); if (p) { if (p.tree !== G.tree && G.stack.length) G.stack.pop(); G.tree = p.tree; G.step = p.step; draw(); } }
    else if (b.id === "dgStuck") { const t = tree(), q = document.getElementById("dgQ"); if (q && !document.getElementById("dgStuckNote")) q.insertAdjacentHTML("afterend", `<div class="fi-warn" id="dgStuckNote">Stop here. Don't guess. Note what you measured, then call ${P().gloss(t.call)}.</div>`); }
  }
  // Auto: the record moved on (a date saved, a test passed), so the walk does too
  setInterval(async () => {
    if (!G.job || !G.auto || G.view !== "step" || document.hidden) return;
    const id = G.job; let j; try { j = await fetchJob(id); } catch (e) { return; }
    if (G.job !== id || (j.rev != null && j.rev === G.j.rev)) return;
    G.j = j; const t = tree(), n = node(), s = t.kind === "run" && n.k !== "done" ? said(t, n, j) : null;
    if (s && s.from === "record" && s.v !== false) { const to = after(n, s.v); if (to && !P().isTree(to)) { G.path.push({ tree: G.tree, step: G.step }); G.step = to; dasSay("That's on file: moved on.", true); return arrive(); } }
    draw();
  }, POLL_MS);

  window.dasWalkOpen = async id => {
    try { G.j = await fetchJob(id); } catch (e) { localStorage.removeItem(LS); return; }
    G.job = id; G.view = "where"; G.fold = false; G.auto = !!((G.j.data || {}).guide || {}).auto; G.tree = null; G.step = null; G.stack = []; G.path = [];
    localStorage.setItem(LS, id); draw();
  };
  // a confirm, a person's own pick or an Undo made elsewhere (the Overview, Start): the panel, open on that job, shows the job as it saved
  window.dasGuideSaw = j => { if (j && G.job != null && G.j && String(j.id) === String(G.job)) { G.j = j; draw(); } };
  window.dasGuideParts = { rec, stands, walk, trees, placeOf, draw };
  { const keep1 = +localStorage.getItem(LS); if (keep1) setTimeout(() => window.dasWalkOpen(keep1), 1500); }  // a reload picks up where it was
})();
