"use strict";
/* RF Recon — a DAS job's licence and site checks (served by dasx.py):
   - the licence watch: the job's licences snapshotted, then compared with each FCC data build (daswatch.py)
   - consent letters and emails addressed from each licence's own FCC contact record (ulscontacts.py)
   - the licensees inside each booster passband, with consent per licensee (47 CFR 90.219(b)(1))
   - intermod (IM3 / IM5) of the job's downlinks landing in its uplinks: frequencies to watch and a PIM test plan
   - the existing-system (legacy booster) audit (dasaudit.py)
   - a first AHJ guess from the USFA fire department registry and the Census place (ahj.py)
   - tunnels near the building, and tunnels as prospects (tunnels.py, OpenStreetMap, ODbL)
   Every finding says where it came from. Needs core.js (api, post, esc, $, S, num, fmtF, render) and das.js (dasSay,
   dasConsent, dasConsentText, dasBand, today, fileSafe, dasDl, csvOf). */

const DX = { contacts: {}, kept: null, err: "" };
const dxUp = c => String(c || "").trim().toUpperCase();
const dxKey = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().slice(0, 120);  // = daswatch.licensee_key
const dxMHz = f => fmtF(f);
const dxList = (fs, n = 6) => fs.slice(0, n).map(dxMHz).join(", ") + (fs.length > n ? ` +${fs.length - n}` : "");
const DX_SEV = { high: ["Act", "var(--bad)"], medium: ["Check", "var(--warn)"], low: ["Note", "var(--muted)"] };
const dxSev = s => { const [l, c] = DX_SEV[s] || DX_SEV.low; return `<span class="tag" style="background:${c};color:#fff;border-color:${c}">${l}</span>`; };
const DX_STATE = { problem: ["Problem", "var(--bad)"], check: ["To check", "var(--warn)"], ok: ["OK", "var(--good)"] };
const dxState = s => { const [l, c] = DX_STATE[s] || DX_STATE.check; return `<span class="tag" style="background:${c};color:#fff;border-color:${c}">${l}</span>`; };
const dxSrc = list => (list || []).map(s => `<a class="hint" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>`).join(" · ");

/* ---------- each licence's own contact (FCC ULS EN records) ---------- */
async function dxContacts(calls){
  const need = [...new Set(calls.map(dxUp).filter(Boolean))].filter(c => !(c in DX.contacts));
  for(let i = 0; i < need.length; i += 150){
    const part = need.slice(i, i + 150);
    try{ const r = await api(`/api/das/x/contacts?calls=${encodeURIComponent(part.join(","))}`); DX.kept = r.kept; DX.err = "";
      for(const c of part) DX.contacts[c] = r.contacts[c] || null; }
    catch(e){ DX.err = e.message; break; }  // the letters still print, addressed by the licensee's name only
  }
  return calls.map(c => DX.contacts[dxUp(c)]).filter(Boolean);
}
// who a licensee's letter goes to: the licence's contact when it has an address, else the licensee; never made up
function dxAddr(calls){
  for(const c of calls){ const r = DX.contacts[dxUp(c)]; if(!r) continue;
    const e = r.contact?.has_address ? r.contact : r.licensee?.has_address ? r.licensee : (r.contact || r.licensee); if(!e) continue;
    return { lines: e.lines || [], email: r.contact?.email || r.licensee?.email || "", phone: e.phone || r.licensee?.phone || "", call: dxUp(c),
      who: e.kind === "CL" ? "the licensee's contact" : "the licensee", source: r.source, url: r.url, rec: r, has_address: !!e.has_address }; }
  return null;
}
window.dasConsentAddr = ss => dxAddr((ss || []).map(s => s.call_sign || s));
window.dasConsentPrefetch = ss => dxContacts((ss || []).map(s => s.call_sign || s));
const dxAddrLine = a => a ? `From the FCC licence record for ${a.call} (${a.who}): ${a.source.replace(/^.*?, licence \S+,?\s*/, "")}` : "";
function dxContactCell(calls){
  const a = dxAddr(calls);
  if(!a) return DX.kept === false ? '<span class="hint">No FCC contact records on this copy yet: they come with the next FCC data update.</span>'
    : `<span class="hint">No contact on the FCC record${DX.err ? ` (${esc(DX.err)})` : ""}</span>`;
  return `<div style="white-space:normal;min-width:180px">${a.lines.map(esc).join("<br>")}${a.phone ? `<br>${esc(a.phone)}` : ""}${a.email ? `<br><a href="mailto:${esc(a.email)}">${esc(a.email)}</a>` : ""}
    <div class="hint">FCC record for <a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.call)}</a>, ${esc(a.who)}${a.has_address ? "" : "; no street address on file"}</div></div>`;
}

/* ---------- consent per licensee ---------- */
const DX_CONSENT = ["not asked", "asked", "given", "refused", "not needed"];
// who this job's booster passes, so who has to consent: a Class A passes what's next to its channels, a Class B its whole span
const dxPasses = d => { const isB = (d.booster_class || "Class A (channelized)").startsWith("Class B"); return x => x.chosen || (isB ? x.class_b : x.class_a); };
async function dxSetConsent(j, row, patch){
  return post(`/api/das/x/consent/${j.id}`, { key: row.key, licensee: row.licensee, calls: row.calls, ...patch });
}
// a consent email sent from the job marks that licensee "asked" (never downgrades a "given")
window.dasConsentSent = async (j, lic, ss) => {
  const k = dxKey(lic), cur = ((j.data || {}).consents || {})[k];
  if(cur && ["given", "refused", "not needed"].includes(cur.status)) return;
  try{ await dxSetConsent(j, { key: k, licensee: lic, calls: ss.map(s => s.call_sign) }, { status: "asked", date: today() }); }
  catch(e){ dasSay("Consent status not saved: " + e.message); }
};
/* ---------- the job's one list of emails (dasmail.js jobAll): who still has to be asked, in the letters' own words ---------- */
const DX_ASKED = ["asked", "given", "refused", "not needed"], DX_CROWD = 10;
window.dasJobMailRows = async (j, r) => {
  let crowd = false;
  const d = j.data || {}, scope = dasScope(d), rows = [], off = new Set(r.off || []), sent = new Set(r.sent || []), plan = (d.presurvey || {}).plan || [], where = d.address ? `, ${d.address}` : "";
  if(!S.das?.contacts){ const c = await api("/api/das/contacts"); S.das = S.das || { view: "board", q: "", job: null, sub: "overview" }; S.das.contacts = c.contacts; }
  const add = x => { if(!off.has(x.key)) rows.push({ kind: "job", group: r.group, ...x }); };
  const noMail = a => `No email on the FCC record${a?.phone ? `: call ${a.phone}` : ""}. Type one here if you have it.`;
  // Discovery names the main system: its radio shop says what the building has to carry. Once a plan's saved, that's been answered
  const main = d.guided?.discovery?.main;
  if(scope.ps && main?.call && !plan.length && ["Lead", "Pre-survey"].includes(j.stage) && !sent.has(`J${j.id} MAIL RADIO`)){
    await dxContacts([main.call]); const a = dxAddr([main.call]);
    add({ key: `radio:${j.id}`, refs: { job_id: j.id, topic: "MAIL", extra: "RADIO" }, to: a?.email || "", to_name: main.licensee, blocked: a?.email ? "" : noMail(a),
      subject: `Radio system for ${j.name}${where}`, why: `${main.licensee} looks like the main system here, and only its radio shop knows what the building has to carry`,
      body: `Hello,\n\nWe're looking at in-building emergency responder radio coverage at ${j.name}${where}. Licence ${main.call} looks like the main system here. Could you tell us:\n\n1. Which system and channels this building has to carry\n2. Whether it falls under a subsystem\n3. Who we should ask for consent to retransmit\n\nThank you,\n${r.sig || ""}` });
  }
  if(scope.ps && plan.length){
    const pb = await api(`/api/das/x/passband/${j.id}`), passes = dxPasses(d);
    const todo = pb.licensees.filter(x => passes(x) && !DX_ASKED.includes(x.consent.status));
    crowd = todo.filter(x => x.chosen).length > DX_CROWD;  // one press reaches every ticked row: this many says the plan needs a look first
    if(todo.length){
      await dxContacts(todo.flatMap(x => x.calls.slice(0, 3)));
      const inc = new Set((d.presurvey || {}).include || []), ps = todo.some(x => x.chosen) ? await api(`/api/das/presurvey?lat=${d.lat}&lon=${d.lon}&radius=${(d.presurvey || {}).radius || 15}&job=${j.id}&threshold=-95&env=suburban`).catch(() => ({})) : {};
      const chosen = (ps.systems || []).filter(s => inc.has(s.call_sign));
      for(const x of todo){
        const got = x.chosen ? chosen.filter(s => dxKey(s.licensee) === x.key) : [], ss = got.length ? got : dxSys(x), a = dxAddr(x.calls);
        add({ key: `consent:${j.id}:${x.key}`, refs: { job_id: j.id, topic: "CONSENT", extra: ss[0]?.call_sign || x.calls[0] }, to: a?.email || "", to_name: x.licensee, blocked: a?.email ? "" : noMail(a),
          subject: `Consent to retransmit ${x.calls.slice(0, 6).join(", ")}: ${j.name}`, body: dasConsentText(j, x.licensee, ss),
          untick: !x.chosen || crowd, why: x.chosen ? `The booster passes ${x.licensee}'s channels, and it hasn't been asked (47 CFR 90.219(b)(1))` : `The booster would pass ${x.licensee}'s channels, but this job doesn't carry it. Unticked until you've checked it needs asking (47 CFR 90.219(b)(1))`, after: () => window.dasConsentSent(j, x.licensee, ss) });
      }
    }
  }
  if(scope.cell && window.dasCellConsentMail){
    const cell = { ...(d.cellular || {}), approvals: { ...((d.cellular || {}).approvals || {}) } };
    for(const c of (d.cellular?.profile?.carriers || [])){
      const car = carrierName(c), ap = cell.approvals[car] || {}, m = window.dasCellConsentMail(j, car);
      if(ap.asked || ap.consent || sent.has(`J${j.id} CONSENT ${(m.refs.extra || "").toUpperCase()}`)) continue;
      add({ ...m, key: `carrier:${j.id}:${m.refs.extra}`, to_name: car, want_file: "consent", blocked: m.to ? "" : `No consent address on file for ${car}. Type the one they gave you.`, why: `${car} hasn't been asked for its consent (47 CFR 20.21(c))`,
        after: async () => { cell.approvals[car] = { ...(cell.approvals[car] || {}), asked: today() }; await post(`/api/das/jobs/${j.id}`, { data: { cellular: cell } }); } });
    }
  }
  // one press reaches every licensee on the list, so the Pre-survey's warning about these addresses comes with it
  const fcc = rows.some(x => x.key.startsWith("consent:") || x.key.startsWith("radio:"));
  if(crowd) return { rows, note: `That's more than ${DX_CROWD} licensees on this job's plan, so none of them start ticked. Check the channel plan on the Pre-survey, then tick the ones to ask.` };
  return { rows, note: scope.ps && !plan.length && j.stage !== "Lead" ? "Licensee consent requests join this list once the channel plan is saved."
    : fcc ? "Licensee addresses come from each licence's FCC record. That's often a radio shop or a consultant, not the agency: check them before you press." : "" };
};

// the AHJ's contact, found or made, so an email to the AHJ has somewhere to go: Use as AHJ, This one and Run it for me all land here
window.dasAhjContact = async x => {
  const cs = (await api("/api/das/contacts")).contacts || [];
  let c = cs.find(k => (k.org || "") === x.name && /AHJ|fire marshal/i.test(k.role || ""));
  if(c) return c;
  c = await post("/api/das/contacts", { name: "Fire marshal's office", org: x.name, role: "AHJ / fire marshal", phone: x.phone || "",
    notes: `From the USFA National Fire Department Registry (records before June 2026)${x.fdid ? `, FDID ${x.fdid}` : ""}.${x.hq ? ` HQ: ${x.hq}.` : ""}${x.website ? ` Website: ${x.website}.` : ""} Confirm who signs off ERCES with its fire prevention or fire marshal office.` });
  return c.contact || c;
};

// letter "systems" for licensees outside the chosen ones: one per call sign, with the frequencies inside the passbands
const dxSys = row => (row.calls || []).map(c => ({ licensee: row.licensee, call_sign: c, down: ((row.by_call || {})[c] || []).map(f => ({ freq: f })), up: [] }));

/* ---------- the pre-survey's extra panels ---------- */
window.dasPresurveyX = async (el, j, save, r, chosen) => {
  el.innerHTML = `<div class="panel" id="pxPb"><h3>Licensees in the booster's passbands</h3><p class="hint">Reading the FCC data…</p></div>
    <div class="panel" id="pxWatch" style="margin-top:10px"><h3>Licence watch</h3><p class="hint">Checking…</p></div>
    <div class="panel" id="pxTun" style="margin-top:10px"></div>`;
  dxPassband($("#pxPb"), j, r, chosen);
  dxWatch($("#pxWatch"), j);
  dxTunnels($("#pxTun"), j, save);
};

async function dxPassband(el, j, r, chosen){
  const d = j.data || {};
  if(!((d.presurvey || {}).plan || []).length){ el.innerHTML = `<h3>Licensees in the booster's passbands</h3><p class="hint">Tick the systems above: the passbands come from the channel plan.</p>`; return; }
  let pb; try{ pb = await api(`/api/das/x/passband/${j.id}`); }catch(e){ if(el.isConnected) el.innerHTML = `<h3>Licensees in the booster's passbands</h3><p class="status err">${esc(e.message)}</p>`; return; }
  await dxContacts(pb.licensees.flatMap(x => x.calls.slice(0, 3)));
  if(!el.isConnected) return;
  const cls = d.booster_class || "Class A (channelized)", isB = cls.startsWith("Class B");
  const passes = dxPasses(d);
  const showAll = !!S.das.pxAll, rows = pb.licensees.filter(x => showAll || passes(x));
  const need = pb.licensees.filter(passes), given = need.filter(x => x.consent.status === "given" || x.consent.status === "not needed");
  const how = x => x.esmr && !x.chosen ? '<span class="tag w">ESMR (commercial): keep out</span>' : x.chosen ? "chosen system" : [x.class_a ? "Class A and B" : "Class B only", x.co_channel ? "on a job channel" : x.adjacent ? "next to a job channel" : "", x.firstnet ? "Band 14" : ""].filter(Boolean).join(" · ");
  el.innerHTML = `<h3>Licensees in the booster's passbands <span class="hint">· 47 CFR 90.219(b)(1): the consent of each licensee whose channels it retransmits</span></h3>
    <div class="tw"><table><thead><tr><th>Band</th><th>Direction</th><th class="n">From MHz</th><th class="n">To MHz</th><th class="n">Planned channels</th><th class="n">Other licensees inside (Class B)</th><th class="n">Inside a 75 kHz Class A filter</th></tr></thead><tbody>
      ${pb.bands.map(b => `<tr><td>${esc(b.band)}</td><td>${esc(b.dir)}</td><td class="n mono">${dxMHz(b.lo)}</td><td class="n mono">${dxMHz(b.hi)}</td><td class="n">${b.channels.length}</td><td class="n">${b.others}</td><td class="n">${b.others_class_a}</td></tr>`).join("")}</tbody></table></div>
    <p style="margin:8px 0 4px">This job's booster: <b>${esc(cls)}</b> (Overview, Testing). It passes <b>${need.length}</b> licensee${need.length === 1 ? "" : "s"}; consent on file from <b>${given.length}</b>.
      ${isB ? "A Class B booster passes each band's whole span, so every licensee inside it needs to consent." : "A Class A booster passes 75 kHz or less around each planned channel: the chosen systems, plus any licensee that close."}</p>
    <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center;margin:4px 0 8px">
      <label class="inl" style="display:inline-flex;flex-direction:row;gap:6px;align-items:center"><input type="checkbox" id="pxAll" style="width:auto;margin:0" ${showAll ? "checked" : ""}> Show every licensee inside the spans (${pb.licensees.length})</label>
      <button id="pxLetters" ${need.some(x => !["given", "not needed"].includes(x.consent.status)) ? "" : "disabled"}>⎙ Letters to all still to consent</button>
      <button id="pxCsv">⇩ Licensees CSV</button></div>
    <div class="tw" style="max-height:55vh"><table><thead><tr><th>Licensee</th><th>Call signs</th><th>MHz inside the passbands</th><th class="n">Nearest</th><th>Passed by</th><th>FCC contact</th><th>Consent</th><th></th></tr></thead><tbody>
      ${rows.map((x, i) => `<tr data-px="${i}"><td style="white-space:normal;min-width:160px;max-width:240px"><b>${esc(x.licensee)}</b>${x.services?.length ? `<div class="hint">${esc(x.services.slice(0, 2).join(", "))}</div>` : ""}</td>
        <td class="mono">${x.calls.slice(0, 4).map(esc).join("<br>")}${x.calls.length > 4 ? `<br><span class="hint">+${x.calls.length - 4}</span>` : ""}</td>
        <td class="mono" style="white-space:normal;max-width:180px">${dxList(x.chosen ? x.freqs.concat(x.also_freqs || []) : x.freqs)}</td>
        <td class="n">${x.nearest_mi != null ? `${num(x.nearest_mi, 1)} mi` : ""}</td><td>${how(x)}</td><td>${dxContactCell(x.calls)}</td>
        <td><select data-pxc="${i}">${DX_CONSENT.map(s => `<option ${s === x.consent.status ? "selected" : ""}>${s}</option>`).join("")}</select>
          <input type="date" data-pxd="${i}" value="${esc(x.consent.date || "")}" style="width:140px;margin-top:3px"></td>
        <td><button class="sm" data-pxl="${i}">⎙ Letter</button>${window.rfMail ? `<button class="sm" data-pxm="${i}">✉ Email</button>` : ""}</td></tr><tr><td colspan="8" style="padding:0;border:0"><div data-pxbox="${i}"></div></td></tr>`).join("")
        || '<tr><td colspan="8" class="hint">No other licensee inside the passbands near the building.</td></tr>'}</tbody></table></div>
    <p class="hint">${esc(pb.source)}: base and fixed stations within ${num(pb.area?.radius_mi, 0)} mi whose frequencies fall inside a passband (downlink and uplink each from the lowest to the highest planned channel). A chosen system's licensee includes its other licences in the span. Contacts are each licence's own FCC record: often a consulting engineer or a radio shop, not the agency.</p>`;
  const sysFor = x => x.chosen ? (chosen || []).filter(s => dxKey(s.licensee) === x.key) : dxSys(x);
  $("#pxAll").onchange = e => { S.das.pxAll = e.target.checked; dxPassband(el, j, r, chosen); };
  el.querySelectorAll("[data-pxc]").forEach(s => s.onchange = async () => { const x = rows[+s.dataset.pxc], dt = el.querySelector(`[data-pxd="${s.dataset.pxc}"]`);
    if(["asked", "given", "refused"].includes(s.value) && !dt.value) dt.value = today();
    try{ j = await dxSetConsent(j, x, { status: s.value, date: dt.value }); dxPassband(el, j, r, chosen); dxConsentAll(j, need.map(n => n.key === x.key ? { ...n, consent: { status: s.value } } : n)); }
    catch(e){ dasSay("Not saved: " + e.message); } });
  el.querySelectorAll("[data-pxd]").forEach(i => i.onchange = async () => { const x = rows[+i.dataset.pxd];
    try{ j = await dxSetConsent(j, x, { status: x.consent.status, date: i.value }); }catch(e){ dasSay("Not saved: " + e.message); } });
  el.querySelectorAll("[data-pxl]").forEach(b => b.onclick = () => dasConsent(j, sysFor(rows[+b.dataset.pxl])));
  el.querySelectorAll("[data-pxm]").forEach(b => b.onclick = () => { const x = rows[+b.dataset.pxm], ss = sysFor(x), a = dxAddr(x.calls);
    rfMail.compose(el.querySelector(`[data-pxbox="${b.dataset.pxm}"]`), { kind: "job", refs: { job_id: j.id, topic: "CONSENT", extra: ss[0]?.call_sign || x.calls[0] },
      title: `Consent request to ${x.licensee}`, to: a?.email || "", subject: `Consent to retransmit ${x.calls.slice(0, 6).join(", ")}: ${j.name}`,
      body: dasConsentText(j, x.licensee, ss), onSent: () => window.dasConsentSent(j, x.licensee, ss) }); });
  $("#pxLetters").onclick = () => { const todo = need.filter(x => !["given", "not needed"].includes(x.consent.status)); dasConsent(j, todo.flatMap(sysFor)); };
  $("#pxCsv").onclick = () => dasDl(`${fileSafe(j.name)} passband licensees.csv`, csvOf(pb.licensees.map(x => { const a = dxAddr(x.calls);
    return { licensee: x.licensee, call_signs: x.calls.join(" "), mhz: x.freqs.join(" "), nearest_mi: x.nearest_mi ?? "", chosen: x.chosen ? "yes" : "", class_a_passes: x.class_a ? "yes" : "",
      class_b_passes: x.class_b ? "yes" : "", co_channel: x.co_channel ? "yes" : "", esmr: x.esmr ? "yes" : "", consent: x.consent.status, consent_date: x.consent.date,
      contact: a ? a.lines.join(" / ") : "", phone: a?.phone || "", email: a?.email || "", contact_source: a ? dxAddrLine(a) : "" }; })), "text/csv");
}
// every licensee the booster passes has consented: offer the Compliance date (never set on its own)
function dxConsentAll(j, need){
  const ck = ((j.data || {}).checks || {});
  if(!need.length || ck.consent || !need.every(x => ["given", "not needed"].includes(x.consent.status))) return;
  if(confirm(`Every licensee this booster passes has consented. Mark "Licensee consent" done on the Overview (Compliance) with today's date?`))
    return post(`/api/das/jobs/${j.id}`, { data: { checks: { ...ck, consent: today() } } }).catch(e => dasSay("Not saved: " + e.message));
}

/* ---------- a reply on the board's Needs you (dasmail.py): it fills the form, a person presses. Nothing here keeps a record of its own:
   a press saves through the same routes as the Pre-survey's and the Code check's own controls, so the stage gate, the one list of emails
   and Walk me through see it with nothing further. Then the reply is closed. The open reader lives in S.das, since render() redraws
   the board on every search landing. ---------- */
const DX_MARK = { given: "Mark given", refused: "Mark refused", confirmed: "Mark confirmed" };
const dxMarkBtn = (k, primary) => `<button ${primary ? 'class="primary" ' : ""}data-rpmark="${k}">${DX_MARK[k]}</button>`;
window.dasReplyBtns = r => `${(r.line || []).map(k => dxMarkBtn(k, true)).join("")}<button data-rpread="${r.id}">Read it</button>`;
async function dxMark(jid, r, how){  // saves, then says what's left to offer once the line is closed
  const said = `From the reply of ${r.date}, ${r.from}`;
  if(how === "confirmed"){
    const P = await api(`/api/das/x/code/${jid}`).catch(() => ({}));  // the state goes too, as the card's Save sends it: that's how a later change to the state's row warns
    await post(`/api/das/x/code/${jid}`, { confirmed_by: r.confirmed_by, confirmed_on: r.confirmed_on, how: r.how, state: P.state, ...(P.check?.note ? {} : { note: said }) });
    return null;
  }
  if(r.kind === "carrier"){  // the Pre-survey's carrier table: a consent date on the carrier's row
    const C = (await api(`/api/das/jobs/${jid}`)).data.cellular || {}, all = C.approvals || {};
    await post(`/api/das/jobs/${jid}`, { data: { cellular: { ...C, approvals: { ...all, [r.carrier]: { ...(all[r.carrier] || {}), consent: r.date } } } } });
    return null;
  }
  const pb = await api(`/api/das/x/passband/${jid}`).catch(() => ({ licensees: [] }));
  const row = pb.licensees.find(x => x.key === r.key || (r.call && x.calls.includes(r.call))) || (r.key ? r : null);
  if(!row) throw new Error(`nothing on this job says whose licence ${r.call || "this is"}. Set it in the Pre-survey.`);
  const j = await dxSetConsent({ id: jid }, row, { status: how, date: r.date, note: said });
  return () => dxConsentAll(j, pb.licensees.filter(dxPasses(j.data)).map(n => n.key === row.key ? { ...n, consent: { status: how } } : n));
}
async function dxPress(btns, jid, r, how, after){
  btns.forEach(b => { b.disabled = true; });  // one press, one save
  let more = null;
  if(how !== "cleared") try{ more = await dxMark(jid, r, how); }
    catch(e){ btns.forEach(b => { b.disabled = false; }); dasSay("Not saved: " + e.message); return; }
  // the job has it by now, and a job's own record takes the line off the board: a failure here is only a note
  try{ await post(`/api/das/x/reply/${jid}`, { id: r.id, done: how }); }catch(e){ dasSay("Saved on the job, but the reply wasn't closed: " + e.message); }
  if(S.das.rpOpen === r.id) S.das.rpOpen = null;
  if(more) await more();
  after();
}
const dxFills = r => r.kind === "code" ? `Mark confirmed saves: confirmed by ${r.confirmed_by}, ${r.confirmed_on}, how: ${r.how}.`
  : r.kind === "carrier" ? `Mark given saves ${r.date} as ${r.carrier}'s consent date.`
  : r.kind === "consent" ? `It saves ${r.licensee || r.call} with the date ${r.date}.` : "";
async function dxReplyOpen(box, jid, r, after){
  S.das.rpOpen = r.id; box.innerHTML = '<p class="hint" style="margin:6px 0">Opening the email…</p>';
  let m; try{ m = await post(`/api/das/x/reply/${jid}`, { id: r.id }); }
  catch(e){ S.das.rpOpen = null; if(box.isConnected) box.innerHTML = `<p class="status err">${esc(e.message)}</p>`; return; }
  if(!box.isConnected || S.das.rpOpen !== r.id) return;
  box.innerHTML = `<div class="panel" style="margin:6px 0 2px;padding:10px 12px">
    <div><b>${esc(m.name ? `${m.name} <${m.from}>` : m.from)}</b> <span class="hint">${esc((m.ts || "").slice(0, 16))}</span></div>
    <div class="hint" style="overflow-wrap:anywhere">${esc(m.subject || "")}</div>
    <pre style="white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:6px 0;max-height:320px;overflow:auto">${esc(m.body || "(no message)")}</pre>
    ${m.files.length ? `<div class="hint" style="overflow-wrap:anywhere">In the job's files: ${m.files.map(f => `<a href="/api/das/jobs/${jid}/file?name=${encodeURIComponent(f)}" target="_blank" rel="noopener">${esc(f)}</a>`).join(", ")}</div>` : ""}
    ${r.trusted ? (r.reader || []).length ? `<p class="hint" style="margin:6px 0">${esc(dxFills(r))} Nothing changes until you press.</p>` : "" : `<p class="hint" style="margin:6px 0">We didn't write to ${esc(r.from)}, so nothing can be marked from this. If it's real, set it on the job yourself.</p>`}
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">${(r.reader || []).map(k => dxMarkBtn(k, false)).join("")}<button data-rpclear title="Takes this line off Needs you. Nothing changes on the job">Clear this line</button></div></div>`;
  const all = () => [...box.querySelectorAll("button"), ...(box.parentElement?.querySelectorAll(`[data-rprow="${r.id}"] button`) || [])];
  box.querySelectorAll("[data-rpmark]").forEach(b => b.onclick = () => dxPress(all(), jid, r, b.dataset.rpmark, after));
  box.querySelector("[data-rpclear]").onclick = () => dxPress(all(), jid, r, "cleared", after);
}
// items: [{jid, r}], each with a [data-rprow] and a [data-rpbox] of its own under el. after: redraw what's holding them
window.dasReplyWire = (el, items, after) => { if(!el) return;
  S.das = S.das || { view: "board", q: "", job: null, sub: "overview" };  // Start's list can come first
  for(const { jid, r } of items){
    const row = el.querySelector(`[data-rprow="${r.id}"]`), box = el.querySelector(`[data-rpbox="${r.id}"]`); if(!row || !box) continue;
    row.querySelectorAll("[data-rpmark]").forEach(b => b.onclick = () => dxPress([...row.querySelectorAll("button")], jid, r, b.dataset.rpmark, after));
    row.querySelector("[data-rpread]").onclick = () => { if(S.das.rpOpen === r.id){ S.das.rpOpen = null; box.innerHTML = ""; return; } dxReplyOpen(box, jid, r, after); };
    if(S.das.rpOpen === r.id) dxReplyOpen(box, jid, r, after);
  } };

/* ---------- the licence watch ---------- */
async function dxWatch(el, j, force){
  let w; try{ w = await api(`/api/das/x/watch/${j.id}${force ? "?force=1" : ""}`); }catch(e){ if(el.isConnected) el.innerHTML = `<h3>Licence watch</h3><p class="status err">${esc(e.message)}</p>`; return; }
  if(!el.isConnected) return;
  const snap = w.snapshot || {}, ack = w.ack || {}, open = w.open || [], done = (w.findings || []).filter(f => ack[f.key]);
  const row = (f, on) => `<div class="row" style="justify-content:space-between;align-items:flex-start;gap:10px;border-top:1px solid var(--line);padding:6px 0">
      <div style="flex:1">${dxSev(f.severity)} <b>${esc(f.what)}</b><div>${esc(f.why)}</div>
        <div class="hint">${esc(f.source)} · <a href="${esc(f.url)}" target="_blank" rel="noopener">FCC licence</a> · first seen ${esc(f.first_seen || "")}${on ? ` · handled ${esc(ack[f.key])}` : ""}</div></div>
      <button class="sm" data-wk="${esc(f.key)}" data-on="${on ? 0 : 1}">${on ? "Reopen" : "Mark handled"}</button></div>`;
  el.innerHTML = `<h3>Licence watch <span class="hint">· the FCC data against this job's snapshot of its licences</span></h3>
    ${!w.calls?.length ? '<p class="hint">Nothing to watch yet: tick the systems above.</p>' : `
    <p style="margin:2px 0 6px">${w.calls.length} licence${w.calls.length === 1 ? "" : "s"} watched (${esc(w.calls.slice(0, 8).join(", "))}${w.calls.length > 8 ? "…" : ""})${snap.neighbours ? `, and ${snap.neighbours.length} other licensee${snap.neighbours.length === 1 ? "" : "s"} in the passbands` : ""}.
      Snapshot of the FCC data of <b>${esc(snap.built_at || "?")}</b>; the FCC data now: <b>${esc(w.built_at || "?")}</b>; checked ${esc(w.checked_at || "")}.</p>
    ${open.length ? open.map(f => row(f, false)).join("") : `<p class="hint">No change since the snapshot.${snap.built_at === w.built_at ? " The FCC data hasn't been updated since it was taken: the first comparison comes with the next update." : ""}</p>`}
    ${done.length ? `<details style="margin-top:6px"><summary>${done.length} handled</summary>${done.map(f => row(f, true)).join("")}</details>` : ""}
    <div class="row" style="gap:8px;margin-top:8px"><button id="pwCheck">Check now</button><button id="pwBase" title="Every change so far counts as handled: today's FCC data becomes what later updates are compared with">Take today's FCC data as the baseline</button></div>
    <p class="hint">The watch runs after every FCC data update. A change goes on the board's Needs you until it's marked handled.</p>`}`;
  $("#pwCheck") && ($("#pwCheck").onclick = () => dxWatch(el, j, true));
  $("#pwBase") && ($("#pwBase").onclick = async () => { if(!confirm("Take today's FCC data as the new baseline? Every change so far counts as handled.")) return;
    try{ await post(`/api/das/x/watch/${j.id}/baseline`); dxWatch(el, j); }catch(e){ dasSay("Not saved: " + e.message); } });
  el.querySelectorAll("[data-wk]").forEach(b => b.onclick = async () => {
    try{ await post(`/api/das/x/watch/${j.id}/ack`, { key: b.dataset.wk, on: b.dataset.on === "1" }); dxWatch(el, j); }catch(e){ dasSay("Not saved: " + e.message); } });
}

/* ---------- tunnels near the building (OpenStreetMap) ---------- */
const dxTunLine = t => `<b>${esc(t.name)}</b> · ${t.kind === "road" ? "road" : "rail"} tunnel (${esc((t.classes || []).join(", "))}), about ${num(t.length_m, 0)} m end to end · ${num(t.dist_m, 0)} m away · ${esc(t.code)} · <a href="${esc(t.osm)}" target="_blank" rel="noopener">OpenStreetMap</a>`;
function dxTunnels(el, j, save){
  const d = j.data || {}, T = d.tunnels_near, isTun = /\(osm_tunnels\)/.test(d.notes || "");
  el.innerHTML = `<h3>Tunnels near the building <span class="hint">· OpenStreetMap (ODbL)</span></h3>
    ${isTun ? '<p style="margin:2px 0 6px"><b>This job is a tunnel</b> (from the tunnel prospects): road tunnels fall under NFPA 502 and rail and transit tunnels under NFPA 130, besides the IFC. Plan the grid along its length, portals and cross-passages included, and ask the AHJ which standard it tests against.</p>' : ""}
    ${T ? (T.list.length ? T.list.map(t => `<div style="border-top:1px solid var(--line);padding:4px 0">${dxTunLine(t)}</div>`).join("") : `<p class="hint">No road or rail tunnel within ${T.radius_m} m.</p>`)
        + `<p class="hint">Looked ${esc(T.at)} within ${T.radius_m} m.${T.note ? ` ${esc(T.note)}` : ""}${T.list.length ? ` ${esc(T.why || "")}` : ""}</p>` : '<p class="hint">Not looked yet.</p>'}
    <div class="row" style="gap:8px;align-items:center"><button id="ptLook">${T ? "Look again" : "Look for tunnels within 400 m"}</button><span class="hint" id="ptMsg"></span></div>`;
  $("#ptLook").onclick = async () => { if(d.lat == null) return; const b = $("#ptLook"); b.disabled = true; $("#ptMsg").textContent = "Asking OpenStreetMap (can take up to a minute when it is busy)…";
    try{ const r = await api(`/api/das/x/tunnels?lat=${d.lat}&lon=${d.lon}&radius_m=400${T ? "&fresh=1" : ""}`);
      j = await save({ tunnels_near: { at: today(), radius_m: r.radius_m, note: r.note || "", why: r.why, list: r.tunnels.slice(0, 12).map(t => ({ name: t.name, kind: t.kind, classes: t.classes, length_m: t.length_m, dist_m: t.dist_m, code: t.code, osm: t.osm })) } });
      dxTunnels(el, j, save); }
    catch(e){ b.disabled = false; $("#ptMsg").textContent = e.message; } };
}
// Prospects: "Find tunnels here" (dasprospects.js), the way "Find high-rises here" works
window.dasFindTunnels = async (e, P, load, el) => {
  if(!P.where){ dasSay("Pick where to look first."); return; }
  const r = Math.min(10, P.radius), msg = $("#prTunMsg") || $("#prHighMsg");
  e.target.disabled = true; if(msg) msg.textContent = `Asking OpenStreetMap for road and rail tunnels within ${r} mi…`;
  try{ const got = await post("/api/das/x/tunnels/prospects", { lat: P.where[0], lon: P.where[1], radius: r });
    if(msg) msg.textContent = `${got.tunnels.toLocaleString()} tunnel${got.tunnels === 1 ? "" : "s"} within ${r} mi (OpenStreetMap, ODbL: kept off the public field packs).`;
    if(!P.kinds.includes("tunnel")){ P.kinds.push("tunnel"); const c = el.querySelector('[data-k="tunnel"]'); if(c) c.checked = true; }
    load(); }
  catch(x){ if(msg) msg.textContent = x.message; } finally { e.target.disabled = false; }
};

/* ---------- intermod: the job's downlinks mixing into its uplinks (IM3, IM5) ---------- */
const DX_UL_HALF = 0.00625;  // a 12.5 kHz uplink channel, ± half
const DX_CLASS_A_HALF = 0.0375;  // a Class A filter: 75 kHz around the channel
function dxCellBands(d){
  const all = typeof DAS_LTE_BANDS !== "undefined" ? DAS_LTE_BANDS : [];
  return ((d.design || {}).cell_bands || []).map(id => all.find(b => b.id === id)).filter(Boolean);
}
// tones (downlink carriers) and targets (uplinks) from the plan and the cellular bands added in Design
function dxImInputs(d){
  const plan = (d.presurvey || {}).plan || [], dlCall = {}, ulCall = {};
  for(const p of plan){ const f = +p.downlink_mhz; if(f > 0) dlCall[f] = p.call_sign;
    for(const u of String(p.uplink_mhz || "").split(" ").filter(Boolean).map(Number)) if(u > 0) ulCall[u] = p.call_sign; }
  const dl = Object.keys(dlCall).map(Number).sort((a, b) => a - b), ul = Object.keys(ulCall).map(Number).sort((a, b) => a - b);
  const spans = new Map(); for(const u of ul){ const b = dasBand(u), x = spans.get(b) || { lo: 1e9, hi: 0 }; x.lo = Math.min(x.lo, u); x.hi = Math.max(x.hi, u); spans.set(b, x); }
  const cells = dxCellBands(d), tdd = cells.filter(b => !b.ul || (b.ul[0] === b.dl[0] && b.ul[1] === b.dl[1]));
  const tones = dl.map(f => ({ lo: f, hi: f, name: `${dxMHz(f)}`, band: dasBand(f), call: dlCall[f], pt: true }))
    .concat(cells.filter(b => !tdd.includes(b)).map(b => ({ lo: b.dl[0], hi: b.dl[1], name: `${b.label} downlink`, band: b.label, pt: false })));
  const targets = ul.map(u => ({ kind: "channel", lo: u - DX_UL_HALF, hi: u + DX_UL_HALF, f: u, call: ulCall[u], band: dasBand(u), label: `${dxMHz(u)} MHz uplink (${ulCall[u]})` }))
    .concat([...spans].map(([b, x]) => ({ kind: "span", lo: x.lo - DX_UL_HALF, hi: x.hi + DX_UL_HALF, band: b, label: `${b} uplink passband ${dxMHz(x.lo)}–${dxMHz(x.hi)} MHz` })))
    .concat(cells.filter(b => b.ul && !tdd.includes(b)).map(b => ({ kind: "cell", lo: b.ul[0], hi: b.ul[1], band: b.label, label: `${b.label} uplink ${b.ul[0]}–${b.ul[1]} MHz` })));
  return { tones, targets, ul, dl, tdd };
}
function dxIntermod(d){
  const { tones, targets, ul, dl, tdd } = dxImInputs(d);
  const hits = [], cap = 6000;
  const land = (order, expr, lo, hi, ts) => { if(hits.length >= cap) return;
    for(const t of targets){ if(hi < t.lo || lo > t.hi) continue;
      const mid = (lo + hi) / 2, near = t.kind === "channel" ? Math.abs(mid - t.f) : null;
      hits.push({ order, expr, lo, hi, tones: ts, t, sev: t.kind === "channel" ? "high" : t.kind === "cell" ? "medium" : "low" }); } };
  // classify a span hit: on top of a Class A filter (within 37.5 kHz of an uplink channel) counts more
  const N = tones.length;
  for(let a = 0; a < N; a++) for(let b = 0; b < N; b++){
    const A = tones[a], B = tones[b]; if(a === b && (A.pt || B.pt)) continue;
    const e = (k, m) => `${k}·${A.name} − ${m > 1 ? `${m}·` : ""}${B.name}`;
    land(3, e(2, 1), 2 * A.lo - B.hi, 2 * A.hi - B.lo, [A, B]);
    land(5, e(3, 2), 3 * A.lo - 2 * B.hi, 3 * A.hi - 2 * B.lo, [A, B]);
  }
  const pts = tones.filter(t => t.pt);
  if(pts.length <= 60) for(let a = 0; a < pts.length; a++) for(let b = a + 1; b < pts.length; b++) for(let c = 0; c < pts.length; c++){
    if(c === a || c === b) continue; const f = pts[a].lo + pts[b].lo - pts[c].lo;
    land(3, `${pts[a].name} + ${pts[b].name} − ${pts[c].name}`, f, f, [pts[a], pts[b], pts[c]]); }
  for(const h of hits) if(h.t.kind === "span" && ul.some(u => Math.abs((h.lo + h.hi) / 2 - u) <= DX_CLASS_A_HALF && h.hi - h.lo < 0.01)) h.sev = "medium";
  return { hits, tones, targets, ul, dl, tdd, capped: hits.length >= cap };
}
// one PIM test per band: the pair of the band's own downlinks whose IM3 (else IM5) lands in an uplink
function dxPimPlan(d, im){
  const byBand = new Map(); for(const t of im.tones.filter(t => t.pt)){ const x = byBand.get(t.band) || []; x.push(t.lo); byBand.set(t.band, x); }
  const inTarget = f => im.targets.filter(t => f >= t.lo && f <= t.hi);
  const out = [];
  for(const [band, fs] of byBand){ if(fs.length < 2) continue; fs.sort((a, b) => a - b);
    let best = null;
    for(let i = 0; i < fs.length; i++) for(let k = 0; k < fs.length; k++){ if(i === k) continue;
      for(const [order, f] of [[3, 2 * fs[i] - fs[k]], [5, 3 * fs[i] - 2 * fs[k]]]){ const t = inTarget(f); if(!t.length) continue;
        const rank = (t.some(x => x.kind === "channel") ? 0 : 10) + order;
        if(!best || rank < best.rank) best = { rank, order, f1: Math.min(fs[i], fs[k]), f2: Math.max(fs[i], fs[k]), at: f, t }; } }
    out.push(best ? { band, ...best } : { band, order: 3, f1: fs[0], f2: fs[fs.length - 1], at: 2 * fs[0] - fs[fs.length - 1], t: [], none: true });
  }
  for(const b of dxCellBands(d)){ if(!b.ul || b.ul[0] === b.dl[0]) continue;
    const f1 = b.dl[0] + 1, f2 = b.dl[1] - 1, cands = [[3, 2 * f1 - f2], [3, 2 * f2 - f1], [5, 3 * f1 - 2 * f2], [5, 3 * f2 - 2 * f1]];
    const hit = cands.map(([o, f]) => ({ o, f, t: inTarget(f) })).find(x => x.t.length);
    out.push(hit ? { band: b.label, order: hit.o, f1, f2, at: hit.f, t: hit.t } : { band: b.label, order: 3, f1, f2, at: 2 * f1 - f2, t: [], none: true });
  }
  return out;
}
window.dasIntermod = (el, j, save, where) => {
  const d = j.data || {}, im = dxIntermod(d);
  if(!im.dl.length && !im.tones.length){ el.innerHTML = `<div class="panel"><h3>Intermod from this job's channels</h3><p class="hint">No channel plan yet: tick the systems in the Pre-survey (and add any cellular band in Design).</p></div>`; return; }
  // frequencies to watch: each uplink target hit, worst first, with the products that land there
  const by = new Map(); for(const h of im.hits){ const k = h.t.label; const x = by.get(k) || { t: h.t, sev: h.sev, hits: [], o: 9 }; x.hits.push(h); x.o = Math.min(x.o, h.order);
    if(h.sev === "high" || (h.sev === "medium" && x.sev === "low")) x.sev = h.sev; by.set(k, x); }
  const rank = { high: 0, medium: 1, low: 2 }, watch = [...by.values()].sort((a, b) => rank[a.sev] - rank[b.sev] || a.o - b.o || b.hits.length - a.hits.length);
  const plan = dxPimPlan(d, im), compact = where === "design";
  const prod = h => `IM${h.order} ${esc(h.expr)} = ${h.lo === h.hi ? `${dxMHz(h.lo)} MHz` : `${num(h.lo, 1)}–${num(h.hi, 1)} MHz`}`;
  const rows = (compact ? watch.slice(0, 6) : watch).map(x => { const o3 = x.hits.filter(h => h.order === 3).length, o5 = x.hits.length - o3;
    return `<tr><td>${dxSev(x.sev)}</td><td>${esc(x.t.label)}</td><td class="n">${o3}</td><td class="n">${o5}</td><td style="white-space:normal">${x.hits.slice(0, compact ? 1 : 3).map(prod).join("<br>")}${x.hits.length > (compact ? 1 : 3) ? `<br><span class="hint">+${x.hits.length - (compact ? 1 : 3)} more</span>` : ""}</td></tr>`; }).join("");
  el.innerHTML = `<div class="panel"><h3>Intermod from this job's channels <span class="hint">· 3rd and 5th order products of the downlinks that land in an uplink</span></h3>
    <p style="margin:2px 0 6px">${im.dl.length} downlink channel${im.dl.length === 1 ? "" : "s"}${dxCellBands(d).length ? ` and ${dxCellBands(d).length - im.tdd.length} cellular band${dxCellBands(d).length - im.tdd.length === 1 ? "" : "s"}` : ""} into ${im.ul.length} uplink channel${im.ul.length === 1 ? "" : "s"}:
      <b>${watch.filter(x => x.sev === "high").length}</b> uplink channel${watch.filter(x => x.sev === "high").length === 1 ? "" : "s"} hit directly, <b>${watch.filter(x => x.sev !== "high").length}</b> other uplink range${watch.filter(x => x.sev !== "high").length === 1 ? "" : "s"} reached.${im.capped ? " (The first 6,000 products shown.)" : ""}</p>
    ${watch.length ? `<div class="tw" style="max-height:${compact ? 260 : 420}px"><table><thead><tr><th></th><th>Frequencies to watch</th><th class="n">IM3</th><th class="n">IM5</th><th>Products</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="hint">No 3rd or 5th order product of these downlinks lands in their uplinks.</p>'}
    ${compact ? `<p class="hint">Act: a product on an uplink channel. Check: inside a cellular uplink, or next to an uplink channel. Note: inside the uplink passband only, which only a Class B booster passes. The PIM tab has the test plan.</p>` : `
    <h3 style="margin-top:10px">PIM test plan</h3>
    ${plan.length ? `<div class="tw"><table><thead><tr><th>Band</th><th class="n">F1 MHz</th><th class="n">F2 MHz</th><th>Measure</th><th>Lands in</th><th></th></tr></thead><tbody>${plan.map((p, i) => `<tr><td>${esc(p.band)}</td><td class="n mono">${dxMHz(p.f1)}</td><td class="n mono">${dxMHz(p.f2)}</td>
      <td>IM${p.order} at <span class="mono">${dxMHz(p.at)}</span> MHz</td><td>${p.none ? '<span class="hint">no listed uplink: use the analyser\'s band preset</span>' : esc(p.t.map(t => t.label).join("; "))}</td>
      <td>${$("#dpF1") ? `<button class="sm" data-imrun="${i}">Use in a run</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
      : '<p class="hint">One band needs two downlink channels for a two-tone test.</p>'}
    <p class="hint">Act: a product on an uplink channel (±6.25 kHz). Check: inside a cellular uplink, or within a 75 kHz Class A filter of an uplink channel. Note: inside the uplink passband only, which only a Class B booster passes. Two tones at 2 × 43 dBm (lower for low-power DAS segments); the pass limit is the PIM runs' above. This is a risk list from the licensed channels, not a prediction: real PIM depends on the parts and the site.${im.tdd.length ? ` TDD bands (${esc(im.tdd.map(b => b.label).join(", "))}) send and receive on one band: not checked here.` : ""}</p>`}</div>`;
  el.querySelectorAll("[data-imrun]").forEach(b => b.onclick = () => { const p = plan[+b.dataset.imrun];
    const set = (s, v) => { const x = $(s); if(x){ x.value = v; x.dispatchEvent(new Event("input")); } };
    set("#dpF1", fmtF(p.f1)); set("#dpF2", fmtF(p.f2)); set("#dpBand", p.band); set("#dpOrd", String(p.order)); set("#dpNote", `IM${p.order} at ${dxMHz(p.at)} MHz`);
    $("#dpWhere")?.focus(); });
};

/* ---------- existing system (legacy booster) audit: a job sub-tab ---------- */
const DX_LEG_SEL = { cls: ["unknown", "Class A", "Class B"], registered: ["unknown", "yes", "no"], ul2524: ["unknown", "3rd", "2nd", "1st", "none"],
  band14: ["unknown", "passes", "filtered", "not in its bands"], oscillation: ["unknown", "yes", "no"] };
window.dasAudit = async (el, j, save) => {
  const d = j.data || {}, L = d.legacy || {};
  const keep = async patch => { j = await save({ legacy: { ...(j.data.legacy || {}), ...patch } }); window.dasAudit(el, j, save); };
  if(!L.flag){
    el.innerHTML = `<div class="panel"><h3>Existing system</h3>
      <p>For a building that already has a booster (BDA) or ERCES: an annual retest, a takeover, a system that stopped working, or an FCC interference notice. The audit checks it against today's rules (47 CFR 90.219 consent, Class A / B and registration, Band 14, ESMR), its listing and its tests, and puts the findings on the AHJ report.</p>
      <button class="primary" id="laOn">This building has an existing system: audit it</button></div>`;
    $("#laOn").onclick = () => keep({ flag: true }); return;
  }
  el.innerHTML = '<p class="hint">Reading the audit…</p>';
  let a; try{ a = await api(`/api/das/x/audit/${j.id}`); }catch(e){ if(el.isConnected) el.innerHTML = `<p class="status err">${esc(e.message)}</p>`; return; }
  if(!el.isConnected) return;
  const sel = (k, l) => `<label>${l}<select data-lg="${k}">${DX_LEG_SEL[k].map(v => `<option ${v === (L[k] || "unknown") ? "selected" : ""}>${v}</option>`).join("")}</select></label>`;
  const inp = (k, l, w, ph = "", type = "text") => `<label>${l}<input data-lg="${k}" type="${type}" value="${esc(L[k] || "")}" placeholder="${esc(ph)}" style="width:${w}px"></label>`;
  el.innerHTML = `<div class="grid2" style="margin-top:0">
    <div class="panel"><h3>The existing booster <span class="hint">· from its label, its settings or its last test report</span></h3>
      <div class="row" style="gap:8px;flex-wrap:wrap">${inp("installed", "Installed (year)", 90, "2012")}${inp("maker", "Maker", 150)}${inp("model", "Model", 150)}
        <label>FCC ID<input data-lg="fcc_id" value="${esc(L.fcc_id || "")}" style="width:150px"></label>${L.fcc_id ? `<a href="https://fccid.io/${encodeURIComponent(L.fcc_id)}" target="_blank" rel="noopener" style="align-self:end">its grant</a>` : ""}</div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:6px">${sel("cls", "Class")}${sel("registered", "FCC registration on file")}${inp("reg_id", "Registration no.", 120, "SB0009568")}${sel("ul2524", "UL 2524 listing")}</div>
      <label style="margin-top:6px;display:block">Passbands, MHz <input data-lg="passbands" value="${esc(L.passbands || "")}" placeholder="851-861, 806-816, 769-775, 799-805" style="width:100%"></label>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:6px">${sel("band14", "Band 14 (FirstNet)")}${inp("band14_auth", "Band 14 authorization", 170, "letter date or reference")}${sel("oscillation", "Oscillation shutdown works")}${inp("last_test", "Last annual test", 150, "", "date")}</div>
      <label style="margin-top:6px;display:block">Notes<textarea data-lg="notes" rows="3" style="width:100%">${esc(L.notes || "")}</textarea></label>
      <p class="hint" style="margin:6px 0 0">Not an existing system after all? <a href="#" id="laOff">Stop auditing it</a> (what's entered is kept).</p></div>
    <div class="panel"><h3>Findings <span class="hint">· ${a.counts.problem} problem${a.counts.problem === 1 ? "" : "s"}, ${a.counts.check} to check, ${a.counts.ok} OK</span></h3>
      ${a.findings.map(f => `<div style="border-top:1px solid var(--line);padding:5px 0">${dxState(f.state)} <b>${esc(f.what)}</b>${f.do ? `<div>${esc(f.do)}</div>` : ""}${f.sources.length ? `<div>${dxSrc(f.sources)}</div>` : ""}</div>`).join("")}
      <p class="hint">${esc(a.note)} Problems go on the board's Needs you and the AHJ report.</p></div></div>
    <div class="panel" style="margin-top:10px"><h3>Checklist <span class="hint">· ${a.ticked} of ${a.checklist.length} done; a tick keeps the date</span></h3>
      ${a.checklist.map(c => `<label style="display:flex;flex-direction:row;gap:10px;align-items:flex-start;padding:5px 0;border-top:1px solid var(--line)"><input type="checkbox" data-lc="${esc(c.key)}" ${c.done ? "checked" : ""} style="margin-top:4px">
        <span><b>${esc(c.step)}</b>${c.done ? ` <span class="hint">done ${esc(c.done)}</span>` : ""}${c.why ? `<div class="hint">${esc(c.why)}</div>` : ""}${c.sources.length ? `<div>${dxSrc(c.sources)}</div>` : ""}</span></label>`).join("")}</div>`;
  el.querySelectorAll("[data-lg]").forEach(i => i.onchange = () => keep({ [i.dataset.lg]: i.value === "unknown" ? "" : i.value.trim() }));
  el.querySelectorAll("[data-lc]").forEach(c => c.onchange = () => keep({ checks: { ...((j.data.legacy || {}).checks || {}), [c.dataset.lc]: c.checked ? today() : "" } }));
  $("#laOff").onclick = e => { e.preventDefault(); keep({ flag: false }); };
};

/* ---------- AHJ guess (Overview) ---------- */
window.dasAhjGuess = (el, j, save) => {
  const d = j.data || {}, G = d.ahj_guess;
  const card = (x, i) => `<div style="border-top:1px solid var(--line);padding:5px 0"><div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px">
      <span><b>${esc(x.name)}</b>${x.phone ? ` · ${esc(x.phone)}` : ""}${x.website ? ` · <a href="${esc(/^https?:/i.test(x.website) ? x.website : "https://" + x.website)}" target="_blank" rel="noopener">website</a>` : ""}
        <div class="hint">${esc(x.hq)}${x.dept_type ? ` · ${esc(x.dept_type)}` : ""}${x.stations ? ` · ${x.stations} station${x.stations === 1 ? "" : "s"}` : ""}</div><div class="hint">${esc(x.why.join("; "))}</div></span>
      <button class="sm" data-ahj="${i}">Use as AHJ</button></div></div>`;
  el.innerHTML = `<div class="row" style="gap:8px;align-items:center;margin-top:6px"><button id="ahjGo" title="Fire departments covering this address, from the USFA National Fire Department Registry and the Census place the building is in">Suggest the AHJ (USFA fire department list)</button><span class="hint" id="ahjMsg"></span></div>
    <div id="ahjOut">${G ? `${G.list.length ? G.list.slice(0, 4).map(card).join("") : '<p class="hint">No department matched this address.</p>'}<p class="hint">${esc(G.where || "")} · ${esc(G.source || "")}, looked ${esc(G.at)}. ${esc(G.note || "")}</p>` : ""}</div>`;
  const go = async () => { if(d.lat == null){ alert("Set the building's location first."); return; } const b = $("#ahjGo"), msg = $("#ahjMsg"); b.disabled = true; msg.textContent = "Looking…";
    try{ let r; try{ r = await api(`/api/das/x/ahj/${j.id}`); }
      catch(e){ if(!/isn't on this copy/.test(e.message)) throw e;
        if(!confirm("The USFA fire department list (about 12 MB, US government) isn't on this copy yet. Download it now?")){ msg.textContent = "Not downloaded."; b.disabled = false; return; }
        msg.textContent = "Downloading the USFA registry…"; await post("/api/das/x/ahj/refresh"); r = await api(`/api/das/x/ahj/${j.id}`); }
      const w = r.where || {}, where = w.state ? `The building is in ${[w.place, w.county, w.state].filter(Boolean).join(", ")} (${w.source})` : r.typed?.state ? `From the job's address: ${[r.typed.city, r.typed.state].filter(Boolean).join(", ")}` : "The Census place couldn't be read: nearest departments";
      j = await save({ ahj_guess: { at: today(), where, source: `${r.registry.name}, ${r.registry.as_of}`, note: r.note,
        list: r.suggestions.map(x => ({ name: x.name, fdid: x.fdid, phone: x.phone, website: x.website, hq: x.hq, dept_type: x.dept_type, stations: x.stations, why: x.why })) } });
      window.dasAhjGuess(el, j, save); }
    catch(e){ b.disabled = false; msg.textContent = e.message; } };
  $("#ahjGo").onclick = go;
  el.querySelectorAll("[data-ahj]").forEach(b => b.onclick = async () => { const x = G.list[+b.dataset.ahj];
    try{ const c = await window.dasAhjContact(x);
      await save({ ahj: x.name, contacts: { ...(j.data.contacts || {}), ahj: c.id } });
      render(); }
    catch(e){ dasSay("Not saved: " + e.message); } });
};

/* ---------- a line at the top of the job: open licence changes, existing-system problems ---------- */
window.dasXBanner = (el, j) => {
  const d = j.data || {}, w = d.lic_watch || {}, ack = w.ack || {}, open = (w.findings || []).filter(f => !ack[f.key] && f.severity !== "low");
  const items = [];
  if(open.length) items.push(`<span>${dxSev(open.some(f => f.severity === "high") ? "high" : "medium")} <b>${open.length} FCC licence change${open.length === 1 ? "" : "s"}</b> on this job's licences since the snapshot: ${esc(open[0].what)}</span> <button class="sm" data-go="presurvey" data-at="pxWatch">Show</button>`);
  if((d.legacy || {}).flag) items.push(`<span id="dxBanAudit"></span>`);
  if(!items.length){ el.innerHTML = ""; return; }
  el.innerHTML = `<div class="panel no-print" style="margin:0 0 10px;padding:8px 12px">${items.map(x => `<div class="row" style="gap:8px;align-items:center;justify-content:space-between">${x}</div>`).join("")}</div>`;
  if((d.legacy || {}).flag) api(`/api/das/x/audit/${j.id}`).then(a => { const x = el.querySelector("#dxBanAudit"); if(!x) return;
    x.innerHTML = a.counts.problem ? `${dxState("problem")} <b>Existing system: ${a.counts.problem} problem${a.counts.problem === 1 ? "" : "s"}</b> (${esc(a.findings.find(f => f.state === "problem").what)}) <button class="sm" data-go="audit">Show</button>`
      : `${dxState(a.counts.check ? "check" : "ok")} Existing system: no problems found${a.counts.check ? `, ${a.counts.check} to check` : ""} <button class="sm" data-go="audit">Show</button>`;
    wire(); }).catch(e => { const x = el.querySelector("#dxBanAudit"); if(x) x.textContent = `Existing system audit: ${e.message}`; });
  const wire = () => el.querySelectorAll("[data-go]").forEach(b => b.onclick = () => { S.das.sub = b.dataset.go; S.das.scrollTo = b.dataset.at || null; render(); });
  wire();
  if(S.das.scrollTo){ const id = S.das.scrollTo; S.das.scrollTo = null; const t0 = Date.now();
    const tick = () => { const x = document.getElementById(id); if(x && x.querySelector("button")){ x.scrollIntoView({ behavior: "smooth", block: "start" }); return; } if(Date.now() - t0 < 20000) setTimeout(tick, 400); }; tick(); }
};

/* ---------- the AHJ report's extra sections ---------- */
window.dasXReport = async (el, j) => {
  const d = j.data || {}, cons = Object.values(d.consents || {}), w = d.lic_watch || {}, ack = w.ack || {}, open = (w.findings || []).filter(f => !ack[f.key] && f.severity !== "low");
  let html = "";
  if(cons.length) html += `<h3>Licensee consent (47 CFR 90.219(b)(1))</h3><table><thead><tr><th>Licensee</th><th>Call signs</th><th>Consent</th><th>Date</th></tr></thead><tbody>${cons.map(c => `<tr><td style="white-space:normal">${esc(c.licensee)}</td><td class="mono">${esc((c.calls || []).join(", "))}</td><td>${esc(c.status)}</td><td class="mono">${esc(c.date || "")}</td></tr>`).join("")}</tbody></table>`;
  if(open.length) html += `<h3>FCC licence changes since the channel plan</h3><table><thead><tr><th>Change</th><th>What it means</th></tr></thead><tbody>${open.map(f => `<tr><td style="white-space:normal">${esc(f.what)}</td><td style="white-space:normal">${esc(f.why)}</td></tr>`).join("")}</tbody></table><p class="hint">${esc(open[0].source)}</p>`;
  if((d.legacy || {}).flag){
    try{ const a = await api(`/api/das/x/audit/${j.id}`), L = d.legacy;
      html += `<h3>Existing system audit</h3><div class="kvg"><div>Booster</div><div>${esc([L.maker, L.model, L.fcc_id ? `FCC ID ${L.fcc_id}` : "", L.cls, L.installed ? `installed ${L.installed}` : ""].filter(Boolean).join(" · ") || "not entered")}</div>
        <div>Passbands</div><div>${esc(L.passbands || "not entered")}</div></div>
        <table style="margin-top:6px"><thead><tr><th>Result</th><th>Finding</th><th>What to do</th><th>Source</th></tr></thead><tbody>${a.findings.map(f => `<tr><td>${esc(DX_STATE[f.state]?.[0] || f.state)}</td><td style="white-space:normal">${esc(f.what)}</td><td style="white-space:normal">${esc(f.do)}</td><td style="white-space:normal">${f.sources.map(s => esc(s.label)).join("; ")}</td></tr>`).join("")}</tbody></table>
        <p class="hint">Checklist: ${a.ticked} of ${a.checklist.length} items done${a.ticked ? ` (${esc(a.checklist.filter(c => c.done).map(c => `${c.step}: ${c.done}`).join("; "))})` : ""}.</p>`; }
    catch(e){ html += `<p class="hint">The existing system audit couldn't be read: ${esc(e.message)}</p>`; }
  }
  if(el.isConnected) el.innerHTML = html;
};
