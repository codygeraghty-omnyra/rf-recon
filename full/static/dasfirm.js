"use strict";
/* DAStastic: Equipment & people, and the AHJ book (Cody's automation ideas 1 and 4, 11/6). dasfirm.py and ahjbook.py do the work.
   The list keeps each instrument and person once. A job offers them, and picking one copies it onto the job's own fields, so every tab that
   reads an instrument or a tester reads what it always did. Nothing here writes into a job without a press, and a job's past readings keep the
   calibration they were taken under.
   The AHJ book offers what another job learned here. It can fill the Code check's answers, and it can't confirm them: the person who confirms
   is at the AHJ, for this building, and their name and date go in by hand. The page redraws whenever a search lands, so anything typed and not
   yet saved is kept in S.das.firmDraft, and every panel here draws whole from what the server says. Needs core.js, das.js, dasahj.js, dasscreen.js. */
(() => {
  const LIST = "Equipment & people";
  const draft = k => { const D = S.das, f = D.firmDraft || (D.firmDraft = {}); return f[k] || (f[k] = {}); };
  const stateChip = s => `<span class="cc-chip ${s.k === "bad" ? "cc-bad" : s.k === "warn" ? "cc-warn" : "cc-ok"}">${esc(s.t)}</span>`;
  const calState = i => i.cal ? ahjCertState(i) : { k: "warn", t: "no calibration date" };
  const credState = (t, on) => { const left = daysTo(on); return left < 0 ? { k: "bad", t: `${t} ran out ${on}` } : left <= 60 ? { k: "warn", t: `${t} runs out ${on}, in ${left} day${left === 1 ? "" : "s"}` } : { k: "good", t: `${t} to ${on}` }; };
  const words = list => list.length < 3 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  const jobList = x => { const js = x.jobs || []; if (!js.length) return '<span class="hint">On no job yet.</span>';
    return `<span class="hint">On ${js.length} job${js.length === 1 ? "" : "s"}:</span> ${js.map(j => `<button class="sm" data-open-job="${j.id}">${esc(j.name)}${j.old ? " (older calibration)" : ""}</button>`).join(" ")}`; };
  const fileLink = (id, name) => `<a class="fr-file" href="/api/das/register/${id}/file?name=${encodeURIComponent(name)}" download title="Download this certificate">${esc(name)}</a>`;
  const upload = (id, label, extra = "") => `<label class="fr-up">${esc(label)}<input type="file" data-up="${id}" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.heic"${extra} hidden></label>`;
  const DOCS = { b03: "B-03 certificate", operator_cert: "Operator certificate" };

  function instRow(i) {
    return `<div class="fr-row" data-fr="${i.id}">
      <div class="fr-head"><b>${esc(i.name)}</b>${i.serial ? ` <span class="mono">${esc(i.serial)}</span>` : ""} ${stateChip(calState(i))}</div>
      <div class="fr-fields"><label>Calibrated<input type="date" data-f="cal" value="${esc(i.cal || "")}"></label>
        <label title="The date on the certificate. Empty: ${DAS.cal_months} months from the calibration date">Runs out<input type="date" data-f="expires" value="${esc(i.expires || "")}"></label>
        <span class="fr-cert">${i.cert ? fileLink(i.id, i.cert) : '<span class="hint">No certificate yet.</span>'}${upload(i.id, i.cert ? "Replace it" : "Add the certificate")}</span>
        <button class="sm" data-del="${i.id}" title="Off this list. Jobs that use it keep their own copy">Remove</button></div>
      <div class="fr-jobs">${jobList(i)}</div></div>`;
  }
  function personRow(p) {
    const creds = [["NICET", p.nicet_expires], ["Manufacturer certificate", p.mfr_expires], ["FDNY B-03", p.b03_expires]].filter(c => c[1]).map(c => stateChip(credState(...c))).join(" ");
    const field = (k, label, type = "text", title = "") => `<label${title ? ` title="${esc(title)}"` : ""}>${esc(label)}<input type="${type}" data-f="${k}" value="${esc(p[k] || "")}"></label>`;
    return `<div class="fr-row" data-fr="${p.id}">
      <div class="fr-head"><b>${esc(p.name)}</b> ${creds}</div>
      <div class="fr-fields">${field("email", "Email", "email", "Calibration and certificate reminders go here")}${field("grol", "FCC GROL", "text", "An FCC GROL is issued for life: it has no expiry to track")}${field("nicet", "NICET")}
        ${field("nicet_expires", "NICET expires", "date")}${field("mfr_expires", "Manufacturer certificate expires", "date")}${field("b03_expires", "FDNY B-03 expires", "date")}</div>
      <div class="fr-fields">${(p.docs || []).map(d => `<span class="fr-cert">${esc(DOCS[d.kind] || "Certificate")}: ${fileLink(p.id, d.file)}</span>`).join("")}
        <label>Add a certificate<select data-doc="${p.id}">${Object.entries(DOCS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select></label>${upload(p.id, "Choose the file")}
        <button class="sm" data-del="${p.id}" title="Off this list. Jobs that use them keep their own copy">Remove</button></div>
      <div class="fr-jobs">${jobList(p)}</div></div>`;
  }
  const bookWhere = e => [e.where, e.ahj].filter(Boolean).join(" · ");
  const ANS = [["code", "Fire code"], ["edition", "Edition"], ["amendment", "Local amendment"], ["policy", "Written policy"], ["final_say", "Who has the final say"], ["radio_shop", "Who runs the radio system"],
    ["third_party", "Third-party tester or tool"], ["stages", "Stages they want"], ["read_url", "The page read"], ["read_note", "What it says"], ["note", "What they told us"]];
  const answersHtml = a => `<dl class="cc-facts">${ANS.filter(([k]) => a[k]).map(([k, l]) => `<dt>${esc(l)}</dt><dd>${k === "read_url" && /^https?:/i.test(a[k]) ? `<a href="${esc(a[k])}" target="_blank" rel="noopener">${esc(a[k])}</a>` : esc(a[k])}</dd>`).join("")}</dl>`;
  const ageChip = e => `<span class="cc-chip ${e.old ? "cc-warn" : "cc-ok"}">${e.old ? `Old: ${esc(e.age)}` : esc(e.age)}</span>`;
  const whoLine = e => `Confirmed by ${esc(e.confirmed_by)}, ${esc(e.confirmed_on)}${e.how ? `, by ${esc(e.how.toLowerCase())}` : ""}, on ${esc(e.job)}`;
  const oldLine = e => e.moved ? '<p class="fr-old">The state\'s rule has changed since then. Check this before you lean on it.</p>' : e.old ? '<p class="fr-old">This is over a year old. A code or an amendment may have changed since.</p>' : "";

  /* ---------- the Equipment & people screen ---------- */
  window.dasRegister = async el => {
    const gen = S.das.gen;
    el.innerHTML = '<p class="hint">Reading the list…</p>';
    let R, B;
    try { [R, B] = await Promise.all([api("/api/das/register"), api("/api/das/book")]); }
    catch (e) { if (gen === S.das.gen && el.isConnected) el.innerHTML = `<p class="status err">${esc(e.message)}</p>`; return; }
    if (gen !== S.das.gen || !el.isConnected) return;
    const ni = draft("inst"), np = draft("person"), seen = R.seen || { instruments: [], people: [] };
    el.innerHTML = `<div class="fr" id="frScreen">
      <p class="fr-lead">Keep each instrument and person here once, then pick them on any job. Picking copies them onto that job, so a report keeps what was true on its date. Everyone with a login on this server shares this list.</p>
      <section class="panel" id="frInst"><h3>Instruments <span class="hint">· ${R.instruments.length}</span></h3>
        ${R.instruments.map(instRow).join("") || '<p class="hint">Nothing here yet. Add your first instrument below.</p>'}
        ${seen.instruments.length ? `<div class="fr-seen"><b>Already on your jobs</b> ${seen.instruments.map((x, n) => `<span class="fr-chip">${esc([x.model, x.serial].filter(Boolean).join(" "))} <span class="hint">${x.jobs} job${x.jobs === 1 ? "" : "s"}</span><button class="sm" data-seen-i="${n}">Add to the list</button></span>`).join("")}</div>` : ""}
        <h4>Add an instrument</h4>
        <div class="fr-fields" id="frNewInst"><label class="grow">Model<input data-n="name" list="frModels" value="${esc(ni.name || "")}" placeholder="Maker and model"></label>
          <datalist id="frModels">${(typeof SCREEN_RX !== "undefined" ? SCREEN_RX : []).map(x => `<option value="${esc(x.name)}">`).join("")}</datalist>
          <label>Serial<input data-n="serial" value="${esc(ni.serial || "")}"></label><label>Calibrated<input type="date" data-n="cal" value="${esc(ni.cal || "")}"></label>
          <label title="The date on the certificate. Empty: ${DAS.cal_months} months from the calibration date">Runs out<input type="date" data-n="expires" value="${esc(ni.expires || "")}"></label>
          <button class="primary" id="frAddInst">Add to the list</button></div></section>
      <section class="panel" id="frPeople"><h3>People <span class="hint">· ${R.people.length}</span></h3>
        ${R.people.map(personRow).join("") || '<p class="hint">Nobody here yet. Add the people who test and sign reports.</p>'}
        ${seen.people.length ? `<div class="fr-seen"><b>Already on your jobs</b> ${seen.people.map((x, n) => `<span class="fr-chip">${esc(x.name)} <span class="hint">${x.jobs} job${x.jobs === 1 ? "" : "s"}</span><button class="sm" data-seen-p="${n}">Add to the list</button></span>`).join("")}</div>` : ""}
        <h4>Add a person</h4>
        <div class="fr-fields" id="frNewPerson"><label class="grow">Name<input data-n="name" value="${esc(np.name || "")}"></label><label>Email<input type="email" data-n="email" value="${esc(np.email || "")}"></label>
          <label>FCC GROL<input data-n="grol" value="${esc(np.grol || "")}"></label><label>NICET<input data-n="nicet" value="${esc(np.nicet || "")}"></label>
          <label>NICET expires<input type="date" data-n="nicet_expires" value="${esc(np.nicet_expires || "")}"></label><button class="primary" id="frAddPerson">Add to the list</button></div></section>
      <section class="panel" id="frBook"><h3>AHJ book <span class="hint">· ${B.entries.length}</span></h3>
        <p class="hint">What each AHJ told us, kept when a job's Code check is confirmed. The next job in that place is offered it, and someone at the AHJ still confirms it for that job: it never clears a Code check on its own.</p>
        ${B.entries.map(e => `<div class="fr-row" data-book="${e.id}"><div class="fr-head"><b>${esc(bookWhere(e) || "Somewhere")}</b> ${ageChip(e)}</div>${answersHtml(e.answers)}<p class="hint fr-who">${whoLine(e)}.</p>${oldLine(e)}
          <div class="fr-fields"><button class="sm" data-book-del="${e.id}" title="Out of the book. It comes back if that job is confirmed again">Remove</button></div></div>`).join("") || '<p class="hint">Nothing yet. Confirm a job\'s Code check and it starts here.</p>'}</section>
      <p class="status err" id="frMsg" hidden></p></div>`;
    const msg = t => { const m = el.querySelector("#frMsg"); if (m) { m.textContent = t; m.hidden = !t; } }, fail = e => { msg(e.message); dasSay("Not saved: " + e.message); };
    const add = async (body, d) => { try { await post("/api/das/register", body); if (d) Object.keys(d).forEach(k => delete d[k]); render(); } catch (e) { fail(e); } };
    el.querySelectorAll("#frNewInst [data-n]").forEach(i => i.oninput = () => { ni[i.dataset.n] = i.value; });
    el.querySelectorAll("#frNewPerson [data-n]").forEach(i => i.oninput = () => { np[i.dataset.n] = i.value; });
    el.querySelector("#frAddInst").onclick = () => add({ kind: "instrument", name: ni.name, serial: ni.serial, cal: ni.cal, expires: ni.expires }, ni);
    el.querySelector("#frAddPerson").onclick = () => add({ kind: "person", ...np }, np);
    el.querySelectorAll("[data-seen-i]").forEach(b => b.onclick = () => { const x = seen.instruments[+b.dataset.seenI]; add({ kind: "instrument", name: x.model, serial: x.serial, cal: x.cal, expires: x.expires }); });
    el.querySelectorAll("[data-seen-p]").forEach(b => b.onclick = () => { const { jobs, ...x } = seen.people[+b.dataset.seenP]; add({ kind: "person", ...x }); });
    el.querySelectorAll("[data-fr] [data-f]").forEach(i => i.onchange = async () => { try { await post("/api/das/register", { id: +i.closest("[data-fr]").dataset.fr, [i.dataset.f]: i.value }); render(); } catch (e) { fail(e); render(); } });
    el.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => { if (!confirm("Take this off the list? Jobs that use it keep their own copy.")) return; try { await post(`/api/das/register/${b.dataset.del}/delete`); render(); } catch (e) { fail(e); } });
    el.querySelectorAll("[data-book-del]").forEach(b => b.onclick = async () => { if (!confirm("Take this out of the AHJ book? The job it came from keeps its Code check.")) return; try { await post(`/api/das/book/${b.dataset.bookDel}/delete`); render(); } catch (e) { fail(e); } });
    el.querySelectorAll("[data-open-job]").forEach(b => b.onclick = () => { S.das.job = +b.dataset.openJob; S.das.sub = "overview"; render(); });
    el.querySelectorAll("[data-up]").forEach(i => i.onchange = async () => { const f = i.files[0]; if (!f) return; const row = i.closest("[data-fr]"), doc = row.querySelector(`[data-doc="${i.dataset.up}"]`)?.value || "";
      try { await api(`/api/das/register/${i.dataset.up}/file?name=${encodeURIComponent(f.name)}&doc=${doc}`, { method: "POST", body: await f.arrayBuffer() }); render(); } catch (e) { fail(e); } });
  };

  /* ---------- on a job: Overview, Testing ---------- */
  window.dasFirmUse = async (jid, id) => { const r = await post(`/api/das/jobs/${jid}/register`, { id }); dasSay(r.say, true); return r; };
  // the same instrument: its serial, or its model when neither has one (dasfirm.py same_instrument has the last word on a pick)
  const low = s => String(s || "").trim().toLowerCase();
  const onList = (list, i) => list.find(x => low(x.serial) || low(i.serial) ? low(x.serial) === low(i.serial) : low(x.name) === low(i.model));
  window.dasFirmPick = async (el, j) => {
    if (!el) return;
    let R;
    try { R = await api("/api/das/register?brief=1"); } catch (e) { el.innerHTML = ""; return; }
    if (!el.isConnected) return;
    const T = (j.data || {}).testing || {}, mine = T.instruments || [], free = R.instruments.filter(x => !mine.some(i => onList([x], i))), people = R.people.filter(p => (p.name || "").toLowerCase() !== (T.tester || "").toLowerCase());
    if (!R.instruments.length && !R.people.length) { el.innerHTML = `<p class="hint fr-none">Keep your instruments and testers once under <button class="sm" id="dfOpen">${esc(LIST)}</button>, then pick them here.</p>`; }
    else {
      const later = mine.map((i, n) => ({ i, n, x: onList(R.instruments, i) })).filter(r => r.x && r.x.cal && r.x.cal > (r.i.cal || ""));
      el.innerHTML = `<div class="fr-pick">
        ${people.length ? `<label>Tester from your list<select id="dfPerson"><option value="">Pick a person…</option>${people.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></label><button id="dfPersonGo">Use on this job</button>` : ""}
        ${free.length ? `<label>Instrument from your list<select id="dfInst"><option value="">Pick an instrument…</option>${free.map(x => `<option value="${x.id}">${esc([x.name, x.serial].filter(Boolean).join(" "))} · ${esc(calState(x).t)}</option>`).join("")}</select></label><button id="dfInstGo">Add to this job</button>` : ""}
        ${!people.length && !free.length ? `<span class="hint">Everything on your list is on this job.</span>` : ""}</div>
        ${later.map(r => `<div class="fr-later"><span><b>${esc(instName(r.i))}</b> has a newer calibration on your list: ${esc(r.x.cal)}${r.x.expires ? `, to ${esc(r.x.expires)}` : ""}. Readings already taken keep the one they were taken under.</span><button class="sm" data-later="${r.x.id}">Use it on this job</button></div>`).join("")}`;
    }
    const use = async id => { try { await window.dasFirmUse(j.id, id); render(); } catch (e) { dasSay("Not saved: " + e.message); } };
    const go = (btn, sel) => { const b = el.querySelector(btn); if (b) b.onclick = () => { const v = el.querySelector(sel).value; if (v) use(+v); else el.querySelector(sel).focus(); }; };
    go("#dfPersonGo", "#dfPerson"); go("#dfInstGo", "#dfInst");
    el.querySelectorAll("[data-later]").forEach(b => b.onclick = () => use(+b.dataset.later));
    const o = el.querySelector("#dfOpen"); if (o) o.onclick = () => window.dasOpenView("register");
  };
  // the Grid test's Taken with: what's on the list and not yet on this job, as one more group of the same drop-down
  window.dasFirmGrid = async (sel, mine) => {
    if (!sel) return;
    const R = await api("/api/das/register?brief=1").catch(() => null);
    if (!R || !sel.isConnected) return;
    const free = R.instruments.filter(x => !mine.some(i => onList([x], i)));
    if (!free.length) return;
    const g = document.createElement("optgroup"); g.label = "From your list";
    g.innerHTML = free.map(x => `<option value="reg:${x.id}">${esc([x.name, x.serial].filter(Boolean).join(" "))}</option>`).join("");
    sel.append(g);
  };

  /* ---------- the Code check: what the book holds for this place ---------- */
  window.dasBookCard = (el, j, P) => {
    if (!el) return;
    const list = P.book || [], c = P.check || {}, b = c.book, ok = P.status === "confirmed";
    const used = b && !ok ? `<div class="cc-level cc-warn" id="ccBookUsed"><b>Filled in from the AHJ book, not confirmed.</b> Those answers came from ${esc(b.job)}, confirmed by ${esc(b.by)} on ${esc(b.on)}. The AHJ has the final say on this building: ask them, then put who said so and the date under Confirmed by.
      <div style="margin-top:6px"><button class="sm" id="ccBookUndo">Take those answers back out</button></div></div>` : "";
    const row1 = e => `<div class="fr-offer" data-book="${e.id}">
        <div class="fr-head"><b>${e.match === "place" ? "Same place" : "Same AHJ"}: ${esc(bookWhere(e))}</b> ${ageChip(e)}</div>
        ${answersHtml(e.answers)}<p class="hint fr-who">${whoLine(e)}.</p>${oldLine(e)}
        ${ok || b ? "" : `<button class="sm" data-book-use="${e.id}">Use these answers</button>`}</div>`;
    // closed, with one line: how many, for which AHJ, the newest, and the newest's answers a press away. Open, the entries go by
    // AHJ and the person who answered, newest first (UX review 11/8 #4: it opened on every new job and listed each entry on its
    // own, 7 of them from one person on one day). The server sends them newest first, so each group's first is its newest
    const groups = [];
    for (const e of list) { const k = `${e.ahj || e.where}|${e.confirmed_by}`; let g = groups.find(x => x.k === k); if (!g) groups.push(g = { k, es: [] }); g.es.push(e); }
    const ahjs = [...new Set(list.map(e => e.ahj || e.where).filter(Boolean))], top = list[0];
    const line = list.length ? `${list.length} answer${list.length === 1 ? "" : "s"} on file for ${esc(ahjs[0] || "this place")}${ahjs.length > 1 ? ` and ${ahjs.length - 1} more` : ""}, newest ${esc(top.confirmed_on)}` : "";
    const group = g => { const e = g.es[0];
      return `<div class="fr-group"><div class="fr-ghead"><b>${esc(e.ahj || e.where || "Somewhere")}</b> · ${esc(e.confirmed_by || "no name")} <span class="hint">· ${g.es.length} answer${g.es.length === 1 ? "" : "s"}, newest ${esc(e.confirmed_on)}</span></div>${g.es.map(row1).join("")}</div>`; };
    el.innerHTML = used + (list.length ? `<details class="fr-book" id="ccBook"><summary><b>From the AHJ book</b> <span class="hint">· ${line}</span>
        <span class="fr-book-acts">${ok || b ? "" : `<button class="sm" data-book-use="${top.id}" title="Fills the empty answers from the newest entry. It confirms nothing">Use the newest</button>`}<button class="sm" data-book-all aria-expanded="false">Show all</button></span></summary>
      ${ok ? "" : '<p class="hint">Another job already asked here. It saves the research, not the call: nothing here counts for this job until someone at the AHJ confirms it for this building.</p>'}${groups.map(group).join("")}</details>` : "");
    const det = el.querySelector("#ccBook"), all = el.querySelector("[data-book-all]");
    if (det && all) {
      all.onclick = e => { e.preventDefault(); det.open = !det.open; };
      det.addEventListener("toggle", () => { all.textContent = det.open ? "Show less" : "Show all"; all.setAttribute("aria-expanded", String(det.open)); });
    }
    el.querySelectorAll("[data-book-use]").forEach(x => x.onclick = async ev => { ev.preventDefault(); try { await post(`/api/das/x/book/${j.id}`, { id: +x.dataset.bookUse }); render(); } catch (e) { dasSay("Not saved: " + e.message); } });
    const u = el.querySelector("#ccBookUndo"); if (u) u.onclick = async () => { try { await post(`/api/das/x/book/${j.id}/undo`); render(); } catch (e) { dasSay("Not saved: " + e.message); } };
  };

  /* ---------- Needs you: one line per instrument or person ---------- */
  // das.js builds the list and calls this with one line from the server (dasfirm.board). -> [job or a stand-in, text, sort, item], or null
  window.dasFirmNeed = n => {
    const t = dasLifeNeed(n.item); if (!t) return null;
    const js = n.jobs, names = js.map(x => x.name), full = js.length === 1 && S.das.jobs.find(x => x.id === js[0].id);
    const who = full || { id: js[0]?.id, name: js.length ? (js.length > 3 ? `${names.slice(0, 2).join(", ")} and ${js.length - 2} more` : words(names)) : LIST, stage: js.length ? `${js.length} jobs` : "" };
    return [who, t, n.item.days ?? 0, { ...n.item, firm: n.firm_id, fold: js.length !== 1 }];
  };
})();
