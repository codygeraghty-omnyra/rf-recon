"use strict";
/* DAStastic: the spec sheet and certificate readers on screen. readers.js does the reading, in the browser, from pdf.js's words (plans.js
   pdfRead). Here: each proposal with the words it came from, and the press. Nothing fills without a press, a press fills only an empty field,
   and the value someone typed stays, saved or not. What's been read lives on S.das, so a redraw (render() runs whenever a search lands) keeps it.
   The certificate reader fills the job's own fields (data.testing), and nothing else: the firm register joins at merge.
   Needs core.js, das.js, plans.js (pdfRead), readers.js, fieldref.js (PC_LAB). */
const RD_PAGES = 12;
const rdQuote = s => `<q class="rd-src">${esc(s)}</q>`;
const rdFail = got => got.locked ? "This PDF is locked with a password. DAStastic needs an unlocked copy." : got.broken ? "This PDF is damaged and won't open." : "";
async function rdBytes(url) { const r = await fetch(url); if (!r.ok) throw new Error(`That file didn't load (${r.status}).`); return r.arrayBuffer(); }

/* ---------- a spec sheet ---------- */
// box: where it draws. p: the part. on.form(): what's in each field now, typed or not. on.filled(part, patch): after a press. on.only: read already done elsewhere
window.specReadBox = (box, p, on = {}) => {
  const D = S.das, store = D.specRead || (D.specRead = {});
  const draw = (msg = "") => {
    const R = store[p.id], F = R && !R.fail && !R.read.scan ? R.read.fields : {}, form = on.form(), keys = Object.keys(PC_LAB).filter(k => F[k]);
    const free = keys.filter(k => F[k].v && !String(form[k] || "").trim());
    const row = k => { const x = F[k], now = String(form[k] || "").trim();
      return `<div class="rd-row" data-f="${k}"><div class="rd-what"><b>${esc(PC_LAB[k])}</b>${x.v ? ` <span class="mono rd-val">${esc(x.v)}</span>` : ""}</div>
        <div class="rd-why">${rdQuote(x.words)}${x.warn ? `<br><span class="rd-w">${esc(x.warn)}</span>` : ""}</div>
        <div class="rd-do">${!x.v ? '<span class="hint">Nothing proposed.</span>' : !now ? `<button class="sm" data-rd-use="${k}">Use</button>` : now === x.v ? '<span class="hint">Already this.</span>' : `<span class="hint">Kept what's there: ${esc(now)}</span>`}</div></div>`; };
    box.innerHTML = `${on.only ? "" : `<div class="rd-pick"><b>Read a spec sheet</b>
        ${p.spec_file ? '<button class="sm" data-rd-kept>Read the sheet kept on this part</button>' : ""}
        <label class="in-up rd-file">${p.spec_file ? "Or read another PDF" : "Read a PDF"}<input type="file" data-rd-file accept=".pdf,application/pdf" hidden></label>
        <span class="hint">Proposes its code fields from its own words. Nothing fills until you press. Reading a PDF here doesn't keep it.</span></div>`}
      ${!R ? "" : R.fail ? `<p class="status err">${esc(R.fail)}</p>` : R.read.scan ? `<div class="rd" data-rd="scan"><p class="rd-say"><b>scan: needs a person</b></p><p class="hint" style="margin:2px 0 0">${esc(R.name)} has no words DAStastic can read, so it proposes nothing. Type the fields from the sheet.</p></div>`
        : `<div class="rd" data-rd="spec"><div class="rd-head"><h5>What ${esc(R.name)} says</h5>${free.length ? `<button class="primary sm" data-rd-all>Fill ${free.length} empty field${free.length === 1 ? "" : "s"}</button>` : ""}</div>
          ${R.read.namesPart === false ? `<p class="rd-w">This sheet never names ${esc(p.part)}. Check it's the right sheet before you use anything from it.</p>` : ""}
          ${keys.length ? keys.map(row).join("") : '<p class="hint" style="margin:4px 0 0">No code field found in its words. Makers lay sheets out differently, so a blank here means it wasn\'t found, not that it isn\'t so.</p>'}</div>`}
      ${msg ? `<p class="hint" data-rd-msg role="status">${esc(msg)}</p>` : ""}`;
  };
  const read = async (name, data) => { box.querySelector("[data-rd-msg]")?.remove(); draw(`Reading ${name}…`);
    try { const got = await pdfRead(data, RD_PAGES), fail = rdFail(got); store[p.id] = fail ? {name, fail} : {name, read: Readers.specSheet(got.pages, p)}; }
    catch (e) { store[p.id] = {name, fail: e.message}; }
    if (box.isConnected) draw(); };
  const use = async ks => { const form = on.form(), R = store[p.id], patch = {};
    for (const k of ks) { const x = R.read.fields[k]; if (x && x.v && !String(form[k] || "").trim()) patch[k] = {v: x.v, src: "spec sheet"}; }
    const n = Object.keys(patch).length; if (!n) { draw("Nothing to fill: those fields have a value."); return; }
    try { const np = await post(`/api/das/parts/${p.id}`, {codes: patch, fill_only: true}); p = np; on.filled(np, patch); }
    catch (e) { draw(`Not saved: ${e.message}`); } };
  box.onclick = async e => { const b = e.target.closest("button"); if (!b) return; const a = b.dataset;
    if (a.rdKept != null) { b.disabled = true; try { await read(`${p.part || p.item || "the part"}'s sheet`, await rdBytes(`/api/das/parts/${p.id}/spec`)); } catch (x) { draw(x.message); } }
    else if (a.rdUse) { b.disabled = true; await use([a.rdUse]); }
    else if (a.rdAll != null) { b.disabled = true; await use(Object.keys(store[p.id].read.fields)); } };
  box.onchange = async e => { const i = e.target; if (i.dataset.rdFile == null || !i.files[0]) return; const f = i.files[0]; await read(f.name, await f.arrayBuffer()); };
  draw();
};
// Materials: every spec sheet behind this list at once: the sheets kept on its parts, and the job's Files that Intake called spec sheets. A BOM of 40 parts is where this saves time
window.dasSpecBatch = async (el, j, parts) => {
  if (!el) return;
  const D = S.das, files = ((await api(`/api/das/jobs/${j.id}/files`).catch(() => ({files: []}))).files || []).filter(f => f.kind === "spec_sheet" && /\.pdf$/i.test(f.name));
  if (!el.isConnected) return;
  const kept = parts.filter(p => p.spec_file), asked = D.readDoc?.job === j.id; if (asked) delete D.readDoc;
  const n = kept.length + files.length, B = D.specBatch?.job === j.id ? D.specBatch : null;
  const draw = () => { const B2 = D.specBatch?.job === j.id ? D.specBatch : null;
    el.innerHTML = `<div class="rd-pick" style="margin-top:8px"><button id="dmRead" ${n ? "" : "disabled"}>Read the spec sheets for this list (${n})</button>
      <span class="hint" id="dmReadMsg" role="status">${esc(B2?.msg || "") || (n ? "Proposes each part's code fields from its sheet. Nothing fills until you press." : "No sheets to read yet: keep a spec sheet PDF on a part, or drop one in.")}</span></div><div id="dmReadOut"></div>`;
    $("#dmRead").onclick = go;
    if (!B2) return;
    const out = $("#dmReadOut"); out.innerHTML = B2.loose.length ? `<p class="hint">Named no part on this list, so it wasn't read further: ${esc(B2.loose.join(", "))}</p>` : "";
    for (const pid of B2.parts) { const p = parts.find(x => x.id === pid); if (!p) continue;
      const sec = document.createElement("div"); sec.dataset.part = pid; sec.innerHTML = `<h5 class="rd-part">${esc(p.part || p.item || "")} <span class="hint">${esc(p.maker || "")}</span></h5><div></div>`; out.appendChild(sec);
      window.specReadBox(sec.lastElementChild, p, {only: true, form: () => Object.fromEntries(Object.entries(p.codes || {}).map(([k, v]) => [k, v.v])), filled: (np, patch) => { Object.assign(p, np); D.specBatch.msg = `${p.part || p.item}: filled ${Object.keys(patch).map(k => PC_LAB[k]).join(", ")}.`; draw(); }}); } };
  const go = async () => { const msg = t => { const m = $("#dmReadMsg"); if (m) m.textContent = t; }; const store = D.specRead || (D.specRead = {}), done = [], loose = []; $("#dmRead").disabled = true;
    let i = 0;
    for (const p of kept) { msg(`Reading ${++i} of ${n}: ${p.part || p.item}…`);
      try { const got = await pdfRead(await rdBytes(`/api/das/parts/${p.id}/spec`), RD_PAGES), fail = rdFail(got); store[p.id] = fail ? {name: `${p.part}'s sheet`, fail} : {name: `${p.part}'s sheet`, read: Readers.specSheet(got.pages, p)}; }
      catch (e) { store[p.id] = {name: `${p.part}'s sheet`, fail: e.message}; }
      done.push(p.id); }
    for (const f of files) { msg(`Reading ${++i} of ${n}: ${f.name}…`);
      let got; try { got = await pdfRead(await rdBytes(`/api/das/jobs/${j.id}/file?name=${encodeURIComponent(f.name)}`), RD_PAGES); } catch (e) { loose.push(f.name); continue; }
      if (rdFail(got)) { loose.push(f.name); continue; }
      const p = parts.find(x => !done.includes(x.id) && x.part && Readers.specSheet(got.pages, x).namesPart);
      if (p) { store[p.id] = {name: f.name, read: Readers.specSheet(got.pages, p)}; done.push(p.id); } else if (!parts.some(x => x.part && Readers.specSheet(got.pages, x).namesPart)) loose.push(f.name); }
    D.specBatch = {job: j.id, parts: done, loose};
    if (el.isConnected) draw(); };
  draw();
  if (asked && !B && n) go();
};

/* ---------- a certificate, and a credential: the job's Testing and Tester's certificates fields ---------- */
const RD_TC = {nicet_expires: "NICET expires", mfr_expires: "Manufacturer certificate expires", b03_expires: "FDNY B-03 expires"};
window.dasCertReader = async (el, j, keep) => {
  if (!el) return;
  const D = S.das, files = (await api(`/api/das/jobs/${j.id}/files`).catch(() => ({files: []}))).files || [];
  if (!el.isConnected) return;
  const rank = k => ["cal_cert", "operator_cert", "b03"].includes(k) ? 0 : 1;
  const pdfs = files.filter(f => /\.pdf$/i.test(f.name)).sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name));
  const cur = () => D.certRead?.job === j.id ? D.certRead : null;
  const insts = () => (j.data.testing || {}).instruments || [];
  // readings are tied to an instrument by model and serial (das.js instKey): a serial filled in behind them would cut them loose
  const tied = i => { const {testing, ...rest} = j.data || {}, key = JSON.stringify(instKey(i)).slice(1, -1); return JSON.stringify(rest).includes(key); };
  const target = c => { const L = insts(), R = c.read; const hit = R.serial ? L.findIndex(i => String(i.serial || "").toLowerCase() === R.serial.v.toLowerCase()) : -1;
    return hit >= 0 ? hit : c.pick === "new" ? "new" : c.pick != null && c.pick !== "" ? +c.pick : -1; };
  // the Expires box beside the instrument, as typed: it saves when it loses focus, which can be the same press
  const onScreen = (k, f) => document.querySelector(`[data-ci="${k}"] [data-c="${f}"]`)?.value?.trim() || "";
  const row = (f, label, x, now, canFill, extra = "") => `<div class="rd-row" data-f="${f}"><div class="rd-what"><b>${esc(label)}</b> <span class="mono rd-val">${esc(x.v)}</span>${x.past ? ' <span class="tag w">already past</span>' : ""}</div>
    <div class="rd-why">${x.words ? rdQuote(x.words) : '<span class="hint">this file</span>'}${extra}</div>
    <div class="rd-do">${now ? (String(now).toLowerCase() === String(x.v).toLowerCase() ? '<span class="hint">Already this.</span>' : `<span class="hint">Kept what's there: ${esc(now)}</span>`) : canFill === true ? `<button class="sm" data-cr-use="${f}">Use</button>` : `<span class="hint">${esc(canFill || "")}</span>`}</div></div>`;
  const past = x => x ? {...x, past: x.v < today()} : x;
  const calView = c => { const R = c.read, k = target(c), L = insts(), i = typeof k === "number" && k >= 0 ? L[k] : null, isNew = k === "new", pickFirst = isNew ? "" : !i ? "Pick the instrument first." : true;
    const vals = {serial: R.serial, cal: R.cal, expires: past(R.expires), cert: {v: c.name}}, rows = [];
    if (vals.serial) rows.push(row("serial", "Serial", vals.serial, i ? i.serial : "", i && tied(i) ? "Readings are tied to this instrument as typed, so its serial stays." : pickFirst));
    if (vals.cal) rows.push(row("cal", "Calibrated", vals.cal, i ? i.cal : "", pickFirst));
    if (vals.expires) rows.push(row("expires", "Expires", vals.expires, i ? i.expires || onScreen(k, "expires") : "", pickFirst));
    rows.push(row("cert", "Certificate", vals.cert, i ? i.cert : "", pickFirst));
    const free = !i && !isNew ? [] : Object.keys(vals).filter(f => vals[f] && !(i && i[f]) && !(f === "serial" && i && tied(i)));
    const none = !R.serial && !R.expires && !R.cal;
    const pick = !R.serial || !L.some(i2 => String(i2.serial || "").toLowerCase() === R.serial.v.toLowerCase());
    const pickable = L.map((x, n) => [x, n]).filter(([x]) => !R.serial || !String(x.serial || "").trim());  // a serial it does have rules out any instrument with another
    return `<div class="rd-head"><h5>What ${esc(c.name)} says</h5>${free.length ? `<button class="primary sm" data-cr-all>${isNew ? "Add the instrument" : `Fill ${free.length} empty field${free.length === 1 ? "" : "s"}`}</button>` : ""}</div>
      ${none ? '<p class="hint" style="margin:4px 0 0">It reads as a calibration certificate, but no serial or date was found in its words. A blank here means it wasn\'t found: fill these by hand.</p>' : ""}
      ${i && !pick ? `<p class="hint rd-note">This is ${esc(instName(i))} on this job: its serial matches.</p>` : ""}
      ${pick && !none ? `<div class="rd-to"><label>Which instrument<select data-cr-pick aria-label="Which instrument this certificate is for"><option value="">Pick…</option>${pickable.map(([x, n]) => `<option value="${n}" ${String(c.pick) === String(n) ? "selected" : ""}>${esc(instName(x) || x.model)}</option>`).join("")}<option value="new" ${c.pick === "new" ? "selected" : ""}>Add it as a new instrument${R.model ? `: ${esc(R.model.v)}` : ""}</option></select></label>
        ${R.serial ? `<span class="hint">Serial ${esc(R.serial.v)} isn't one of this job's instruments${pickable.length ? ". Only an instrument with no serial can take it" : ""}.</span>` : ""}</div>` : ""}
      ${none ? "" : rows.join("")}${(R.notes || []).map(t => `<p class="rd-w">${esc(t)}</p>`).join("")}`; };
  const credView = c => { const R = c.read, T = j.data.testing || {};
    if (R.life) return `<p class="rd-say"><b>${esc(c.name)}</b>: FCC GROL. It's issued for life, so there's no expiry to fill.</p>`;
    const f = R.field || c.as || "", x = past(R.expires);
    const who = T.tester && !new RegExp(`\\b${T.tester.trim().split(/\s+/).pop().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(R.text || "") ? `<p class="rd-w">This certificate doesn't name ${esc(T.tester)}, the job's tester. Check it's theirs.</p>` : "";
    return `<div class="rd-head"><h5>What ${esc(c.name)} says</h5></div>${who}
      ${!x ? '<p class="hint" style="margin:4px 0 0">No expiry date found in its words. Type it from the certificate.</p>' : !R.field ? `<div class="rd-to"><label>What this is<select data-cr-as aria-label="What this certificate is"><option value="">Pick…</option>${Object.entries(RD_TC).map(([k, t]) => `<option value="${k}" ${c.as === k ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label><span class="hint">The words don't say which certificate this is.</span></div>` : ""}
      ${x ? row(f || "expires", f ? RD_TC[f] : "Expires", x, f ? T[f] || document.querySelector(`[data-tc="${f}"]`)?.value?.trim() || "" : "", f ? true : "Pick what it is first.", x.monthOnly ? '<br><span class="hint">It gives a month, so the first of the month is used.</span>' : "") : ""}`; };
  const draw = () => { const c = cur(), out = $("#crOut"); if (!out) return;
    if (!c) { out.innerHTML = ""; return; }
    out.innerHTML = c.fail ? `<p class="status err">${esc(c.fail)}</p>` : c.read.scan ? `<div class="rd" data-rd="scan"><p class="rd-say"><b>scan: needs a person</b></p><p class="hint" style="margin:2px 0 0">${esc(c.name)} has no words DAStastic can read, so it proposes nothing.</p></div>`
      : `<div class="rd" data-rd="cert">${c.read.kind === "cal" ? calView(c) : c.read.kind === "credential" || c.read.expires ? credView(c) : `<p class="rd-say"><b>${esc(c.name)}</b>: no calibration or credential words in it, so it proposes nothing.</p>`}${c.msg ? `<p class="hint" role="status">${esc(c.msg)}</p>` : ""}</div>`; };
  const fillInst = async (c, names) => { const R = c.read, now = (await api(`/api/das/jobs/${j.id}`)).data || {}, T = now.testing || {}, list = [...(T.instruments || [])], k0 = target(c), put = [], at = k0 === "new" ? list.length : k0;
    const vals = {serial: R.serial?.v, cal: R.cal?.v, expires: R.expires?.v, cert: c.name};
    const x = k0 === "new" ? {model: R.model?.v || "Instrument", serial: "", cal: ""} : {...list[at]};
    for (const f of names) { if (!vals[f] || String(x[f] || "").trim() || (k0 !== "new" && onScreen(at, f))) continue; if (f === "serial" && k0 !== "new" && tied(x)) continue; x[f] = vals[f]; put.push(f); }
    if (!put.length) { c.msg = "Nothing to fill: those fields have a value."; draw(); return; }
    list[at] = x; c.msg = `Filled ${put.join(", ")} on ${instName(x)}.`;
    if (k0 === "new") c.pick = null;
    if (!await keep({testing: {...T, instruments: list}})) { c.msg = "Not saved."; draw(); } };
  const fillTc = async (c, f) => { const now = (await api(`/api/das/jobs/${j.id}`)).data || {}, T = now.testing || {};
    if (String(T[f] || "").trim() || document.querySelector(`[data-tc="${f}"]`)?.value?.trim()) { c.msg = "Nothing to fill: that field has a value."; draw(); return; }
    c.msg = `Filled ${RD_TC[f]}.`;
    if (!await keep({testing: {...T, [f]: c.read.expires.v}})) { c.msg = "Not saved."; draw(); } };
  const read = async name => { const m = $("#crMsg"); if (m) m.textContent = `Reading ${name}…`;
    let c = {job: j.id, name};
    try { const got = await pdfRead(await rdBytes(`/api/das/jobs/${j.id}/file?name=${encodeURIComponent(name)}`), RD_PAGES), fail = rdFail(got); if (fail) c.fail = fail; else c.read = Readers.certificate(got.pages); }
    catch (e) { c.fail = e.message; }
    D.certRead = c; if ($("#crMsg")) $("#crMsg").textContent = ""; draw(); };
  const c0 = cur();
  el.innerHTML = `<div class="rd-pick" style="margin-top:10px"><b>Read a certificate</b><span class="hint">A calibration certificate's serial and dates, or a credential's expiry, from its own words. Nothing fills until you press.</span>
    ${pdfs.length ? `<div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end;width:100%"><label class="grow">A PDF in this job's files<select id="crPick"><option value="">Pick a PDF…</option>${pdfs.map(f => `<option value="${esc(f.name)}" ${c0 && c0.name === f.name ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select></label><button id="crGo">Read it</button><span class="hint" id="crMsg"></span></div>` : '<p class="hint" style="margin:4px 0 0">Add the certificate PDF under Files, or drop it anywhere, then read it here.</p>'}</div><div id="crOut"></div>`;
  if ($("#crGo")) $("#crGo").onclick = async () => { const n = $("#crPick").value; if (!n) { $("#crMsg").textContent = "Pick a PDF first."; return; } $("#crGo").disabled = true; await read(n); if ($("#crGo")) $("#crGo").disabled = false; };
  $("#crOut").onclick = async e => { const b = e.target.closest("button"), c = cur(); if (!b || !c) return; const a = b.dataset; if (a.crAll == null && !a.crUse) return; b.disabled = true;
    try { if (a.crUse && RD_TC[a.crUse]) await fillTc(c, a.crUse); else await fillInst(c, a.crAll != null ? ["serial", "cal", "expires", "cert"] : [a.crUse]); }
    catch (x) { c.msg = `Not saved: ${x.message}`; draw(); } };
  $("#crOut").onchange = e => { const c = cur(), t = e.target; if (!c) return; if (t.dataset.crPick != null) { c.pick = t.value; c.msg = ""; draw(); } else if (t.dataset.crAs != null) { c.as = t.value; draw(); } };
  draw();
  const asked = D.readDoc?.job === j.id ? D.readDoc.name : null; if (asked) { delete D.readDoc; if (pdfs.some(f => f.name === asked)) { if ($("#crPick")) $("#crPick").value = asked; await read(asked); } }
};
