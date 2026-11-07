"use strict";
/* RF Recon: one Intake (Cody 11/5: "dump all forms/files/pdfs/plans/contacts/folder/etc in one location and have it auto scan them to make
   sure they're good, then auto distribute them", "for the whole RF Recon app"). Drop anywhere, on any tab: the window takes files, folders,
   zips and old emails; the chip in the header opens the same list. intake.py does the scanning and the filing. This page does two things
   the server can't: it reads each PDF with pdf.js, and it builds a job's checklist, since the AHJ's list and Start's checks live here.
   The panel and the drop target sit on the page, not in a tab: render() redraws the open tab on every search landing and never touches them.
   The boxes on each tab all still work, and a box that takes a drop keeps it (the window only sees a drop nobody took).
   Needs core.js, plans.js (pdfjs), dasahj.js (ahjPacketRows), start.js (startChecks). */
(() => {
  const G = S.intake = S.intake || { open: false, data: null, can: false, busy: false, msg: "", errs: [], target: null, jobs: [], batch: null, view: null, lists: {} };
  const TEXT_PAGES = 12, SIZE_PAGES = 40, POLL_MS = 120000;
  const CHECKS = [["opens", "Opens"], ["belongs", "Belongs"], ["complete", "Complete"], ["in_date", "In date"]];
  const SUB_WORD = { grid: "Grid test", commission: "Commissioning" };
  const say = (t, ok) => { if (window.dasSay) dasSay(t, ok); else alert(t); };
  const kb = b => b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round((b || 0) / 1e3))} KB`;
  const openJobId = () => S.tab === "das" && S.das && S.das.job ? S.das.job : S.tab === "start" && S.start && S.start.job ? S.start.job : null;
  const jobName = id => (G.jobs.find(j => j.id === id) || {}).name || "";
  const box = id => document.getElementById(id);

  /* ---------- on the page: the drop target and the panel ---------- */
  function mount() {
    const d = document.createElement("div");
    d.id = "inDrop"; d.className = "in-drop no-print"; d.hidden = true;
    d.innerHTML = `<div class="in-drop-b"><b>Drop to scan</b><span>Every file is checked first. Readings wait for your press.</span><span id="inDropTo"></span></div>`;
    const p = document.createElement("aside");
    p.id = "inPanel"; p.className = "in no-print"; p.hidden = true;
    p.setAttribute("role", "dialog"); p.setAttribute("aria-label", "Intake");
    document.body.append(d, p);
    p.onclick = onClick; p.onchange = onChange;
    return p;
  }
  const panel = () => box("inPanel") || mount();

  function chip() {
    const c = box("inChip"), n = box("inCount"), open = (G.data && G.data.open) || 0;
    if (!c) return;
    c.hidden = !G.can;
    n.hidden = !open; n.textContent = open || "";
    c.title = open ? `Intake: ${open} waiting on you` : "Intake: drop files, folders, zips or old emails anywhere, on any tab";
  }

  /* ---------- what's there ---------- */
  async function load() {
    G.data = await api("/api/intake");
    G.can = !!G.data.can;
    chip();
    return G.data;
  }
  async function loadJobs() {
    try { G.jobs = ((await api("/api/das/jobs")).jobs || []).map(j => ({ id: j.id, name: j.name })); } catch (e) { G.jobs = []; }
  }
  const after = id => { if (S.tab === "das" && S.das && S.das.job) render(); };
  // a filed PDF the readers can read (readers.js): its button goes to where the proposals are
  const READ_AT = { plan_set: ["plans", "Read its floors"], spec_sheet: ["materials", "Read its code fields"], cal_cert: ["overview", "Read it"], operator_cert: ["overview", "Read it"], b03: ["overview", "Read it"] };
  async function reload() {
    try {
      await load();
      if (G.batch) G.view = await viewOf(G.batch);
    } catch (e) { G.msg = e.message; }
    draw(); after();  // the press shows at once. The checklist follows: it asks three routes
    for (const j of Object.keys(G.lists)) await fillList(+j);
    draw();
  }
  // the last drop's items, in the list's own shape
  const viewOf = async b => { const items = (G.data.items || []).filter(x => x.batch === b); return { batch: b, items, jobs: [...new Set(items.map(x => x.job_id).filter(Boolean))] }; };

  /* ---------- a drop: every file to the server, every PDF through pdf.js, then the decision ---------- */
  async function readPdf(data) {
    const lib = await pdfjs();
    let doc;
    // isEvalSupported off: a PDF from outside must not get to run code through a crafted font (CVE-2024-4367, fixed in pdf.js 4.2.67; the app ships 3.11)
    try { doc = await lib.getDocument({ data, isEvalSupported: false, disableFontFace: true }).promise; }
    catch (e) { return e && e.name === "PasswordException" ? { locked: true } : { broken: true }; }
    const sizes = [], bits = [], n = doc.numPages;
    try {
      for (let p = 1; p <= Math.min(n, SIZE_PAGES); p++) {
        const pg = await doc.getPage(p), v = pg.getViewport({ scale: 1 });
        sizes.push([Math.round(v.width), Math.round(v.height)]);
        if (p <= TEXT_PAGES) bits.push((await pg.getTextContent()).items.map(i => i.str).join(" "));
      }
    } catch (e) { if (!sizes.length) return { broken: true }; }
    // a sealed report prints its code on every page in Chrome and on the last page elsewhere. It's read whole, since the server checks every word against what was sealed
    try {
      if (n > TEXT_PAGES) {
        const words = async p => (await (await doc.getPage(p)).getTextContent()).items.map(i => i.str).join(" "), last = await words(n);
        if (/v\s*e\s*r\s*i\s*f\s*y\s*c\s*o\s*d\s*e/i.test(bits.join(" ") + last)) for (let p = TEXT_PAGES + 1; p < n; p++) bits.push(await words(p));
        bits.push(last);
      }
    } catch (e) { /* the pages read so far still count */ }
    doc.destroy();
    return { pages: n, read: bits.length, sizes, text: bits.join("\n").slice(0, 190000) };
  }
  const progress = t => { const p = box("inProg"); if (p) p.textContent = t; };
  async function sendOne(batch, f, path) {
    const url = `/api/intake/file?batch=${batch}&name=${encodeURIComponent(f.name)}&path=${encodeURIComponent(path || f.name)}`;
    const body = window.RFPack ? await f.arrayBuffer() : f;  // the web version hands bytes to its worker
    return (await api(url, { method: "POST", body })).made;
  }
  async function takeIn(list) {
    if (!list.length || !G.can) return;
    if (G.busy) { say("One drop at a time: wait for this one to finish."); return; }
    G.busy = true; G.errs = []; G.msg = ""; G.open = true;
    await loadJobs();
    draw();
    try {
      let job = G.target ?? openJobId();
      if (job === 0) job = null;  // "work it out from each file"
      let batch;
      try { batch = (await post("/api/intake/batch", { job, label: list.length === 1 ? list[0].file.name : `${list.length} files` })).id; }
      catch (e) { batch = (await post("/api/intake/batch", { label: `${list.length} files` })).id; }  // the open job refused it: each file finds its own
      G.batch = batch;
      const pdfs = [];
      for (let i = 0; i < list.length; i++) {
        const { file, path } = list[i];
        progress(`Scanning ${i + 1} of ${list.length}: ${file.name}`);
        try {
          const made = await sendOne(batch, file, path);
          for (const m of made) if (m.pdf) pdfs.push({ ...m, file: made.length === 1 ? file : null });
        } catch (e) { G.errs.push(`${file.name}: ${e.message}`); }
      }
      await readAll(pdfs);
      progress("Filing…");
      const v = await post(`/api/intake/batch/${batch}/finish`);
      G.lists = {};
      for (const j of v.jobs) await fillList(j);
      await load();
      G.view = await viewOf(batch);
      G.last = v.counts;
    } catch (e) { G.msg = `That drop stopped: ${e.message}`; }
    G.busy = false;
    draw(); after();
  }
  async function readAll(pdfs) {
    for (let i = 0; i < pdfs.length; i++) {
      const m = pdfs[i];
      progress(`Reading PDF ${i + 1} of ${pdfs.length}: ${m.name}`);
      let info;
      try {
        const data = m.file ? await m.file.arrayBuffer() : await (await fetch(`/api/intake/item/${m.id}/bytes`)).arrayBuffer();
        info = await readPdf(data);
      } catch (e) { info = { broken: true }; }
      await post(`/api/intake/item/${m.id}/pdf`, info);
    }
  }
  // PDFs that came with nobody watching, or a page closed part way: read here, then whatever they belonged to settles
  async function readWaiting() {
    const list = ((G.data && G.data.items) || []).filter(x => x.pdf);
    if (!list.length || G.busy) return;
    G.busy = true;
    try {
      await readAll(list);
      for (const b of new Set(list.map(x => x.batch))) await post(`/api/intake/batch/${b}/finish`);
      await load();
    } catch (e) { /* the next look tries again */ }
    G.busy = false;
    if (G.open) draw();
  }

  /* ---------- one job's list: what it should have, and whether it now does ---------- */
  async function fillList(jid) {
    let c, j, P = null;
    try { [c, j] = await Promise.all([api(`/api/intake/job/${jid}/checklist`), api(`/api/das/jobs/${jid}`)]); }
    catch (e) { delete G.lists[jid]; return; }
    const d = j.data || {}, rows = [], hold = typeof DASJ !== "undefined" ? DASJ : null;
    for (const s of c.stages) for (const n of s.needs) rows.push({ g: s.stage, t: n.text, ok: false, sub: n.sub, note: (window.startNeedHint || {})[n.key] });
    if (window.startChecks) try { for (const [, t, ok, note, sub] of window.startChecks(d)) rows.push({ g: "The job", t, ok, note, sub }); } catch (e) { /* the rest of the list still reads */ }
    try {
      P = await ahjPackets();
      DASJ = dasProfile(d.profile);
      const R = ahjPacketRows(d, P, c.files);
      for (const x of R.rows) if (x.state !== "outside") rows.push({ g: R.pk.name, t: x.t, ok: x.state === "ok", note: x.state === "ok" ? "" : x.app });
    } catch (e) { /* no AHJ list here: the stage and job rows still read */ }
    if (hold) DASJ = hold;
    G.lists[jid] = { id: jid, name: c.job.name, stage: c.job.stage, rows, all: (G.lists[jid] || {}).all };
  }
  function listHtml(c) {
    const miss = c.rows.filter(r => !r.ok), have = c.rows.length - miss.length, show = c.all ? miss : miss.slice(0, 5);
    const line = r => `<li><span>${esc(r.t)}<span class="hint"> · ${esc(r.g)}${c.all && r.note ? `: ${esc(r.note)}` : ""}</span></span>${r.sub ? `<button class="sm" data-open="${c.id}" data-sub="${esc(r.sub)}">Open</button>` : ""}</li>`;
    return `<section class="in-cl" data-cl="${c.id}"><h4>${esc(c.name)} <span class="hint">· ${have} of ${c.rows.length} on file</span></h4>
      ${miss.length ? `<p class="in-cl-say">${miss.length} still missing:</p><ul class="in-miss">${show.map(line).join("")}</ul>${!c.all ? `<button class="sm" data-more="${c.id}">Show all ${c.rows.length}, with how to do each</button>` : ""}`
        : `<p class="in-cl-say good">Everything on its list is on file.</p>`}
      ${c.all && have ? `<details class="in-have"><summary>${have} on file</summary><ul>${c.rows.filter(r => r.ok).map(r => `<li>✓ ${esc(r.t)}<span class="hint"> · ${esc(r.g)}</span></li>`).join("")}</ul></details>` : ""}</section>`;
  }

  /* ---------- the three lists ---------- */
  const checksHtml = c => CHECKS.filter(([k]) => c && c[k] && (c[k][0] !== null || c[k][1])).map(([k, l]) => { const [ok, t] = c[k];
    return `<li class="${ok === true ? "ok" : ok === false ? "no" : "na"}"><i aria-hidden="true">${ok === true ? "✓" : ok === false ? "✕" : "·"}</i><b>${l}</b>${t ? ` ${esc(t)}` : ""}</li>`; }).join("");
  const probsHtml = p => (p || []).map(x => `<li class="${esc(x.level)}">${esc(x.text)}</li>`).join("");
  const jobSel = x => { const pick = x.job_id || (x.candidates.length === 1 ? x.candidates[0].id : ""), first = x.candidates.map(c => c.id);
    const js = [...G.jobs.filter(j => first.includes(j.id)), ...G.jobs.filter(j => !first.includes(j.id))];
    return `<label>Job<select data-pick="job" aria-label="Which job"><option value="">Pick a job…</option>${js.map(j => `<option value="${j.id}" ${j.id === pick ? "selected" : ""}>${esc(j.name)}</option>`).join("")}</select></label>`; };
  const kindSel = x => { const K = (G.data && G.data.kinds) || {}, first = x.maybe || [], keys = [...first, ...Object.keys(K).filter(k => !first.includes(k))];
    return `<label>It is<select data-pick="kind" aria-label="What it is"><option value="">${esc(x.kind_label || "Pick what it is…")}</option>${keys.filter(k => K[k]).map(k => `<option value="${k}">${esc(K[k])}</option>`).join("")}</select></label>`; };
  function needsHtml(x) {
    return (x.needs || []).map(n => n === "inst"
      ? `<label>Taken with<select data-need="inst" aria-label="What took these readings"><option value="">Pick…</option>${(x.insts || []).map(i => `<option value="${esc(i.key)}">${esc(i.name)}</option>`).join("")}</select></label>`
      : n === "supplier" ? (x.suppliers ? `<label>Supplier<select data-need="supplier" aria-label="Which supplier"><option value="">Pick…</option>${x.suppliers.map(s => `<option>${esc(s)}</option>`).join("")}</select></label>`
        : `<label>Supplier<input data-need="supplier" aria-label="Which supplier" placeholder="Who it's from"></label>`) : "").join("");
  }
  function actions(x) {
    const b = (a, t, c = "") => `<button class="sm ${c}" data-a="${a}">${esc(t)}</button>`;
    const get = `<a class="in-get" href="/api/intake/item/${x.id}/bytes">Get the file</a>`;
    if (x.status === "refused") return b("drop", "Throw away");
    if (x.corrupt) return `${get}${b("drop", "Throw away")}`;
    if (x.locked) return `${jobSel(x)}${b("keep", "Keep in Files")}${get}${b("drop", "Throw away")}`;
    if (x.status === "waiting") return `${needsHtml(x)}${b("apply", x.tab ? `Keep in Files, open ${SUB_WORD[x.tab] || "the tab"}` : "Apply", "primary")}${x.tab ? "" : b("keep", "Keep in Files only")}${jobSel(x)}${x.job_id ? b("move", "Move") : ""}`;
    if (x.status === "pile") return x.act === "own" ? `${x.tab === "data" && S.remote ? "" : `<button class="sm" data-tab="${esc(x.tab)}">Take me there</button>`}${get}${b("drop", "Throw away")}`
      : `${kindSel(x)}${jobSel(x)}${b("pick", "File it", "primary")}${b("newjob", "Make a job from this")}${get}${b("drop", "Throw away")}`;
    if (x.mark === "scan: needs a person" && x.status === "filed") return `${kindSel(x)}${b("pick", "Say what it is", "primary")}${b("undo", "Undo")}`;
    if (x.status === "undone") return `${jobSel(x)}${b("pick", "File it again")}${b("drop", "Throw away")}`;
    const rd = READ_AT[x.kind], read = rd && x.job_id && x.saved && /\.pdf$/i.test(x.saved) && ["filed", "kept"].includes(x.status) ? `<button class="sm" data-read="${x.job_id}" data-sub="${rd[0]}" data-file="${esc(x.saved)}">${rd[1]}</button>` : "";
    return read + (x.can_undo ? b("undo", "Undo") : "") + (x.job_id ? `<button class="sm" data-open="${x.job_id}" data-sub="${x.tab || "files"}">Open</button>` : "")
      + (["filed", "applied", "kept"].includes(x.status) ? `${b("mv", "Move")}<span class="in-mv" hidden>${jobSel(x)}${b("move", "Move here")}</span>` : "");
  }
  // a calibration certificate and the firm's list (dasfirm.py): only on a press, and only the list. A job takes the new date on its own Overview
  function firmHtml(x) {
    const f = x.firm; if (!f) return "";
    const dates = [f.cal && `calibrated ${f.cal}`, f.due && `runs out ${f.due}`].filter(Boolean).join(", "), m = f.match;
    const line = t => `<div class="in-firm" data-firm="${esc(f.state)}"><p>${t}</p>`;
    if (f.state === "done") return `${line(`Serial ${esc(f.serial)} is on your Equipment & people list from this certificate. Jobs that carry it take the new date on their Overview.`)}<div class="in-firm-acts"><button class="sm" data-a="unregister">Take it back</button></div></div>`;
    if (f.state === "same") return `${line(`Your Equipment & people list already has this calibration for ${esc(m.name)}.`)}</div>`;
    if (f.state === "older") return `${line(`Your Equipment & people list already has a newer calibration for ${esc(m.name)}: ${esc(m.cal || m.expires)}. It stays.`)}</div>`;
    if (f.state === "newer") return `${line(`Serial ${esc(f.serial)} is ${esc(m.name)} on your Equipment & people list, calibrated ${esc(m.cal || "with no date")}. This certificate says ${esc(dates)}.`)}<div class="in-firm-acts"><button class="sm primary" data-a="register">Update the list</button></div></div>`;
    return `${line(`Serial ${esc(f.serial)} isn't on your Equipment & people list.${dates ? ` This certificate says ${esc(dates)}.` : ""}`)}<div class="in-firm-acts"><label>What instrument is it?<input data-firm-model value="${esc(f.model || "")}" placeholder="Maker and model" aria-label="What instrument is it"></label><button class="sm primary" data-a="register">Add to the list</button></div></div>`;
  }
  function itemHtml(x) {
    const where = x.status === "refused" ? "Refused. It's in no job's Files and can't be opened from here. RF Recon clears it after 30 days." : x.dest || (x.job_name ? `For ${x.job_name}` : "");
    const top = x.mark ? `<p class="in-mark ${x.status === "refused" ? "bad" : ""}">${esc(x.mark)}</p>` : "";
    return `<article class="in-item in-${esc(x.status)}" data-id="${x.id}" data-batch="${x.batch}" data-name="${esc(x.name)}">
      <div class="in-head"><b class="in-name">${esc(x.name)}</b>${x.kind_label ? `<span class="tag">${esc(x.kind_label)}</span>` : ""}<span class="hint">${kb(x.size)}</span></div>
      ${x.refused ? `<p class="in-mark bad">${esc(x.refused)}</p>` : top}
      ${where ? `<p class="in-where">${esc(where)}${x.job_why && x.status !== "refused" && !(x.checks && x.checks.belongs) ? `<span class="hint"> · ${esc(x.job_why)}</span>` : ""}</p>` : ""}
      ${x.plan ? `<p class="in-plan">${esc(x.plan)}</p>` : ""}
      ${x.checks && Object.keys(x.checks).length ? `<ul class="in-checks">${checksHtml(x.checks)}</ul>` : ""}
      ${x.problems && x.problems.length ? `<ul class="in-probs">${probsHtml(x.problems)}</ul>` : ""}
      ${firmHtml(x)}
      <p class="in-virus hint">${esc(x.virus)}</p>
      <div class="in-acts">${actions(x)}</div></article>`;
  }
  const seen = x => !["unpacked", "dropped"].includes(x.status);
  const needsLook = x => x.status === "pile" || x.status === "reading" || x.status === "refused" || (x.status === "filed" && x.mark === "scan: needs a person");
  function draw() {
    const el = panel();
    if (!G.open) { el.hidden = true; return; }
    el.hidden = false;
    const all = ((G.view ? G.view.items : (G.data && G.data.items) || [])).filter(seen).sort((a, b) => a.id - b.id);
    const rank = x => x.status === "pile" || x.status === "reading" ? 0 : x.status === "filed" ? 1 : 2;
    const waiting = all.filter(x => x.status === "waiting"), look = all.filter(needsLook).sort((a, b) => rank(a) - rank(b) || a.id - b.id), filed = all.filter(x => !needsLook(x) && x.status !== "waiting");
    const sure = waiting.filter(x => !(x.needs || []).length).length, here = openJobId(), to = G.target ?? here;
    const n = { f: filed.filter(x => x.status !== "undone" && x.status !== "duplicate").length, d: filed.filter(x => x.status === "duplicate").length };
    const sect = (id, title, rows, none) => `<section class="in-list" id="${id}"><h4>${title} <span class="in-n">${rows.length}</span></h4>${rows.length ? rows.map(itemHtml).join("") : `<p class="hint">${none}</p>`}</section>`;
    el.innerHTML = `<div class="in-top"><h3>Intake</h3><span class="hint">${G.view ? "This drop" : "Everything open"}</span><button class="sm" id="inX" aria-label="Close Intake">✕</button></div>
      <div class="in-body">
      <div class="in-zone" id="inZone"><b>Drop files, folders, zips or old emails anywhere, on any tab.</b>
        <div class="in-picks"><label class="in-up">Choose files<input type="file" id="inPick" multiple hidden></label><label class="in-up">Choose a folder<input type="file" id="inDir" webkitdirectory multiple hidden></label></div>
        <label class="in-to">Going to<select id="inTo"><option value="0" ${to === 0 || to == null ? "selected" : ""}>Work it out from each file</option>${G.jobs.map(j => `<option value="${j.id}" ${j.id === to ? "selected" : ""}>${esc(j.name)}</option>`).join("")}</select></label>
        ${all.length ? "" : `<p class="hint">Plain documents file themselves. Readings and prices wait for your press. Nothing already here is written over, and anything filed can be undone. ${esc(G.data && G.data.virus === "not virus-scanned" ? "No virus scanner on this machine, so files are checked but not virus-scanned." : "")}</p>`}</div>
      <p class="in-prog" id="inProg" role="status">${G.busy ? "Working…" : ""}</p>
      ${G.msg ? `<p class="status err">${esc(G.msg)}</p>` : ""}${G.errs.length ? `<ul class="in-probs">${G.errs.map(e => `<li class="bad">${esc(e)}</li>`).join("")}</ul>` : ""}
      ${all.length ? `<p class="in-total" id="inTotal">${all.length} file${all.length === 1 ? "" : "s"}: ${n.f} filed, ${waiting.length} waiting for your press, ${look.length} need${look.length === 1 ? "s" : ""} a look${n.d ? `, ${n.d} already here` : ""}.</p>
        <div class="in-all">${sure ? `<button class="primary" id="inApplyAll">Apply all the sure ones (${sure})</button>` : ""}${G.view ? `<button id="inUndoAll">Undo this drop</button><button id="inEvery">Show everything open</button>` : ""}</div>` : ""}
      ${Object.values(G.lists).map(listHtml).join("")}
      ${all.length ? sect("inWaiting", "Waiting for your press", waiting, "Nothing is waiting.") + sect("inLook", "Needs a look", look, "Nothing needs a look.") + sect("inFiled", "Filed", filed, "Nothing filed yet.") : `<p class="hint">Nothing in Intake yet.</p>`}
      </div>`;
  }

  /* ---------- presses ---------- */
  const rowOf = t => t.closest("[data-id]");
  const val = (row, sel) => { const e = row && row.querySelector(sel); return e ? e.value : ""; };
  async function act(id, a, body) {
    const b = body || {};
    try { await post(`/api/intake/item/${id}/${a}`, b); G.msg = ""; }
    catch (e) {
      if (/anyway\?$/.test(e.message)) { if (confirm(e.message)) return act(id, a, { ...b, force: true }); return; }
      G.msg = e.message;
    }
    await reload();
  }
  function goJob(id, sub, read) {
    S.das = S.das || { view: "board", q: "", job: null, sub: "overview" };
    S.das.view = "board"; S.das.job = id; S.das.sub = sub || "overview";
    if (read) S.das.readDoc = { job: id, name: read };
    if (S.tab === "das") render(); else setTab("das");
    if (innerWidth < 700) { G.open = false; draw(); }
  }
  async function onClick(e) {
    const t = e.target, b = t.closest("button"); if (!b) return;
    const row = rowOf(b), id = row && +row.dataset.id, d = b.dataset;
    if (b.id === "inX") { G.open = false; G.target = null; draw(); }
    else if (b.id === "inEvery") { G.view = null; G.batch = null; await reload(); }
    else if (b.id === "inApplyAll") {
      const list = (G.view ? G.view.items : G.data.items).filter(x => x.status === "waiting" && !(x.needs || []).length), left = [];
      for (const k of new Set(list.map(x => x.batch))) { const v = await post(`/api/intake/batch/${k}/apply`).catch(x => ({ left: [x.message] })); left.push(...(v.left || [])); }
      G.msg = left.length ? `Left for you: ${left.join(", ")}` : ""; await reload(); }
    else if (b.id === "inUndoAll") { if (!confirm("Undo everything filed from this drop?")) return; const v = await post(`/api/intake/batch/${G.batch}/undo`).catch(x => ({ error: x.message })); if ((v.stuck || []).length) G.msg = v.stuck.join(" "); else if (v.error) G.msg = v.error; await reload(); }
    else if (d.more) { G.lists[d.more].all = true; draw(); }
    else if (d.read) goJob(+d.read, d.sub, d.file);
    else if (d.open) goJob(+d.open, d.sub);
    else if (d.tab) setTab(d.tab);
    else if (d.a === "undo") await act(id, "undo");
    else if (d.a === "register") await act(id, "register", { model: val(row, "[data-firm-model]") });
    else if (d.a === "unregister") await act(id, "unregister");
    else if (d.a === "drop") { if (confirm("Throw this away? It can't be brought back.")) await act(id, "drop"); }
    else if (d.a === "keep") { const j = val(row, '[data-pick="job"]'); await act(id, "keep", j ? { job: +j } : {}); }
    else if (d.a === "mv") { const s = row.querySelector(".in-mv"); s.hidden = !s.hidden; }
    else if (d.a === "apply") { const body = {}; row.querySelectorAll("[data-need]").forEach(x => { body[x.dataset.need] = x.value; }); await act(id, "apply", body); }
    else if (d.a === "move") { const j = val(row, '[data-pick="job"]'); if (!j) { G.msg = "Pick a job first."; return draw(); } await act(id, "pick", { job: +j }); }
    else if (d.a === "pick") { const j = val(row, '[data-pick="job"]'), k = val(row, '[data-pick="kind"]'); await act(id, "pick", { job: j ? +j : (((G.view ? G.view.items : G.data.items).find(x => x.id === id) || {}).job_id || null), kind: k || null }); }
    else if (d.a === "newjob") { const x = (G.view ? G.view.items : G.data.items).find(y => y.id === id) || {}, name = prompt("Name for the new job", (x.guess || {}).name || x.name); if (!name) return; await act(id, "newjob", { name, address: (x.guess || {}).address || "" }); await loadJobs(); draw(); }
  }
  function onChange(e) {
    const t = e.target;
    if (t.id === "inTo") G.target = +t.value;
    else if (t.id === "inPick" || t.id === "inDir") { const fs = [...t.files].map(f => ({ file: f, path: f.webkitRelativePath || f.name })); t.value = ""; takeIn(fs); }
  }

  /* ---------- a folder dragged in: dataTransfer.files alone only lists its name ---------- */
  const entryFile = en => new Promise((ok, no) => en.file(ok, no));
  const entries = rd => new Promise((ok, no) => rd.readEntries(ok, no));
  async function walk(en, out) {
    if (en.isFile) { try { out.push({ file: await entryFile(en), path: en.fullPath.replace(/^\//, "") }); } catch (e) { G.errs.push(`${en.name}: couldn't be read`); } return; }
    const rd = en.createReader();
    for (;;) { const got = await entries(rd); if (!got.length) break; for (const x of got) await walk(x, out); }  // a folder hands over 100 at a time
  }
  async function fromDrop(dt) {
    const ents = [...(dt.items || [])].filter(i => i.kind === "file").map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (!ents.length) return [...dt.files].map(f => ({ file: f, path: f.name }));
    const out = [];
    for (const en of ents) await walk(en, out);
    return out;
  }
  const hasFiles = e => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
  const ownBox = e => e.defaultPrevented || (e.target && e.target.type === "file");
  let hide = null;
  const shown = v => { const d = box("inDrop"); if (d) d.hidden = !v; };
  window.addEventListener("dragover", e => {
    if (!G.can || !hasFiles(e)) return;
    clearTimeout(hide); hide = setTimeout(() => shown(false), 250);
    if (ownBox(e)) { shown(false); return; }  // the job Files box and every other file box keep their own drops
    e.preventDefault(); e.dataTransfer.dropEffect = "copy";
    const to = G.target ?? openJobId(), line = box("inDropTo");
    if (line) line.textContent = to ? `Going to: ${jobName(to) || (S.das && S.das.jobData && S.das.jobData.name) || "this job"}. Change it in the Intake list.` : "Each file finds its own place.";
    shown(true);
  });
  window.addEventListener("drop", async e => {
    shown(false);
    if (!G.can || !hasFiles(e) || ownBox(e)) return;
    e.preventDefault();
    takeIn(await fromDrop(e.dataTransfer));
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && G.open && !document.querySelector("dialog[open]")) { G.open = false; G.target = null; draw(); } });

  window.intakeOpen = async job => {
    if (job) G.target = job;
    G.open = true;
    await loadJobs();
    try { await load(); } catch (e) { G.msg = e.message; }
    if (job) await fillList(job);
    draw();
  };
  // one press from the Report tab: the file picker, opened on Downloads where the browser can, and straight into Intake for that job
  window.intakePick = async job => {
    const take = fs => { G.target = job; takeIn(fs.map(f => ({ file: f, path: f.name }))); };
    if (window.showOpenFilePicker) {
      try { const hs = await window.showOpenFilePicker({ startIn: "downloads", types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }] }); take(await Promise.all(hs.map(h => h.getFile()))); }
      catch (e) { if (e.name !== "AbortError") say(e.message); }
      return;
    }
    const i = Object.assign(document.createElement("input"), { type: "file", accept: ".pdf,application/pdf" });
    i.onchange = () => take([...i.files]); i.click();
  };
  async function look() {
    if (G.busy) return;
    try { await load(); await readWaiting(); } catch (e) { G.can = false; chip(); }
  }
  panel();
  box("inChip").onclick = async () => { if (G.open) { G.open = false; G.target = null; draw(); return; } await window.intakeOpen(openJobId()); };
  setTimeout(look, 1500);  // after the page has worked out who's signed in
  setInterval(() => { if (!document.hidden) look(); }, POLL_MS);
})();
