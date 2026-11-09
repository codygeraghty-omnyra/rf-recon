"use strict";
/* DAStastic: Code check and stage gates (codecheck.py). The card on a job's Overview answers: which fire code applies here,
   can a system be required at all, what we already hold on this jurisdiction, and who at the AHJ confirmed it. Every line
   says how far it was read. It never says "not required": it says what we read, and that the AHJ hasn't confirmed it.
   DAStastic doesn't fetch the code sites: their terms bar robots, so the links are searches a person clicks. Nothing sends
   without a click. The gate dialog stands in front of a move forward: it lists what's missing, each with a way to go fix it,
   and a move anyway needs a reason, which the job's log keeps. Needs core.js, das.js, dasmail.js. */

const CC_READ = { read: "read", excerpt: "search excerpt", "not found": "not found" };
const CC_LEVEL = { no_mandate: "cc-bad", local: "cc-warn", discretion: "cc-warn", required: "cc-ok", unknown: "cc-warn" };
// past research by state, so a job in that state sees what we already hold (name fragments of DAS_PROFILES and DAS_LICENSEES)
const CC_HELD = { AZ: /Chandler/, IA: /Iowa/, MN: /Minnesota|Maple Grove/, ND: /North Dakota/, CA: /Sacramento|San Diego|LA County|Santa Clara|Riverside|OCSD|California/, CO: /Colorado Springs|Denver|Douglas/, FL: /Florida|Miami-Dade|Osceola|Broward/,
  MD: /Maryland/, MI: /Michigan/, NC: /Charlotte|Durham/, NV: /Clark County/, NY: /NYC|FDNY/, OH: /Ohio/, SC: /Charleston/, TX: /McKinney|Prosper|College Station/, UT: /Murray|Salt Lake/,
  VA: /Fairfax/, WA: /Seattle|PSERN/ };
const CC_PACKET = { MN: ["maple_grove"], CA: ["san_diego", "la_county", "santa_clara", "riverside"], CO: ["colorado_springs", "denver", "douglas"], FL: ["miami_dade", "osceola"], NC: ["charlotte", "durham"],
  NV: ["clark"], NY: ["fdny"], TX: ["college_station"], UT: ["murray", "slc"], WA: ["seattle"], AZ: ["phoenix"], VA: ["fairfax"] };
const CC_DEADLINE = { CA: "OCSD", WA: "Seattle SFC 510", SC: "Charleston SC", NV: "Clark County FPAN", CO: "Douglas County CO", NY: "NYC FDNY ARCS (3 RCNY 510-01)" };
let CC_RES = null;  // the research files, read once
const ccResearch = async () => CC_RES || (CC_RES = await Promise.all(["ahj_packets", "ahj_deadlines"].map(f => fetch(`static/research/${f}.json`).then(r => r.json()).catch(() => ({})))));
const ccRead = x => `<span class="cc-chip">${esc(CC_READ[x?.status] || x?.status || "not checked")}</span>`;
const ccLink = u => /^https?:/i.test(u || "") ? `<a href="${esc(u)}" target="_blank" rel="noopener">source</a>` : "";

window.dasCodeCard = async (el, j, save) => {
  if (!el) return;
  el.innerHTML = '<p class="hint">Reading the state rules…</p>';
  let P;
  try { P = await api(`/api/das/x/code/${j.id}`); }
  catch (e) { if (el.isConnected) el.innerHTML = `<p class="hint">Code check couldn't load: ${esc(e.message)}</p>`; return; }
  if (!el.isConnected) return;
  const r = P.rule, c = P.check || {}, ok = P.status === "confirmed", st = P.state;
  const [pk, dl] = await ccResearch();
  if (!el.isConnected) return;
  const re = CC_HELD[st], profiles = re ? Object.keys(typeof DAS_PROFILES === "object" ? DAS_PROFILES : {}).filter(k => re.test(k)) : [];
  const lic = re && typeof DAS_LICENSEES === "object" ? DAS_LICENSEES.filter(x => re.test(x.who)) : [];
  const packets = (CC_PACKET[st] || []).map(k => pk?.packets?.[k]).filter(Boolean), dead = CC_DEADLINE[st] && dl?.ahjs?.[CC_DEADLINE[st]];
  const held = [...profiles.map(n => `<li>AHJ profile: ${esc(n)}</li>`), ...packets.map(x => `<li>Packet list: ${esc(x.name || x.ahj || "AHJ packet")}</li>`),
    ...(dead ? [`<li>Filing deadlines: ${esc(CC_DEADLINE[st])}</li>`] : []), ...lic.map(x => `<li>Licensee process: ${esc(x.who)}</li>`)];
  const steps = [["State", "1. The state"], ["Edition", "2. The edition"], ["Amendment", "3. The local amendment"], ["Guideline", "4. The fire department's guideline"]];
  const banner = !r ? `<p>${st ? `No state row for ${esc(st)}.` : "Set the building's location, or type a full address, to find the state."}</p>`
    : `<div class="cc-level ${CC_LEVEL[r.level]}"><b>${esc(P.says)}</b>${ok ? "" : " The AHJ hasn't confirmed."}</div>`;
  const facts = r ? `<dl class="cc-facts">
      <dt>Fire code</dt><dd>${esc(r.fire_code.base || "")} ${esc(r.fire_code.edition || "")}${r.fire_code.effective ? `, ${esc(r.fire_code.effective)}` : ""} ${ccRead(r.fire_code)} ${ccLink(r.fire_code.source)}</dd>
      <dt>The rule</dt><dd>${esc(r.erces.summary || "")}${r.erces.citation ? ` <span class="hint">${esc(r.erces.citation)}</span>` : ""} ${ccRead(r.erces)} ${ccLink(r.erces.source)}</dd>
      ${r.erces.thresholds ? `<dt>Triggers</dt><dd>${esc(r.erces.thresholds)}</dd>` : ""}
      ${r.local_amendments ? `<dt>Local changes</dt><dd>${esc(r.local_amendments)}</dd>` : ""}
      ${r.ahj ? `<dt>Who rules</dt><dd>${esc(r.ahj)}</dd>` : ""}
      ${r.pending ? `<dt>Coming</dt><dd>${esc(r.pending)}</dd>` : ""}
      ${r.hand_check ? `<dt>Check first</dt><dd class="cc-warn-t">${esc(r.hand_check)}</dd>` : ""}</dl>` : "";
  const field = (k, label, ph = "") => `<label>${esc(label)}<input data-cc="${k}" value="${esc(c[k] || "")}" placeholder="${esc(ph)}"></label>`;
  el.innerHTML = `<details class="panel cc" id="ccCard" ${ok ? "" : "open"}>
    <summary style="cursor:pointer;display:flex;gap:10px;align-items:center;flex-wrap:wrap;list-style:none"><h3 style="margin:0">Code check</h3>
      <span class="cc-chip ${ok ? "cc-ok" : "cc-warn"}">${ok ? `Confirmed by ${esc(c.confirmed_by)}, ${esc(c.confirmed_on)}` : P.status === "started" ? "Started, not confirmed" : "Not confirmed"}</span>
      ${st ? `<span class="hint">${esc([P.place, P.county, r?.name || st].filter(Boolean).join(", "))}</span>` : ""}</summary>
    ${banner}
    <div id="ccBookOut"></div>
    ${P.stale ? `<div class="cc-level cc-warn">The state's row changed after this was confirmed. Confirm it again.</div>` : ""}
    ${P.tribal ? `<div class="cc-level cc-warn"><b>Tribal land: ${esc(P.tribal)}.</b> ${esc(P.land)}</div>` : ""}
    <p class="cc-auth">${esc(P.authority)}</p>
    <div class="cc-cols"><div>${facts}
    ${r ? `<p class="hint">Machine lead from the state's table, checked ${esc(r.checked)}. Each line says how far it was read. ${esc(P.land)}</p>` : ""}
    ${held.length ? `<h4>What we already hold for this state</h4><ul class="cc-held">${held.join("")}</ul>` : ""}</div><div>
    <h4 style="margin-top:0">Find it</h4><p class="hint">DAStastic doesn't read these sites for you: their terms bar it. Press each, read what's there, and paste the page below.</p>
    ${steps.map(([k, t]) => { const ls = P.links.filter(x => x.step === k); return ls.length ? `<div class="cc-step"><b>${t}</b> ${ls.map(x => `<a class="btn sm" href="${esc(x.url)}" target="_blank" rel="noopener"${x.guess ? ' title="A guess at the address: this city may not be on it"' : ""}>${esc(x.label)}${x.guess ? " ?" : ""}</a>`).join(" ")}</div>` : ""; }).join("")}
    <div class="grid2" style="margin-top:6px">${field("read_url", "The page you read", "Paste its address")}${field("read_note", "What it says", "510 unchanged, or the section")}</div>
    <h4>Ask the AHJ</h4><ol class="cc-q">${P.questions.map(q => `<li>${esc(q)}</li>`).join("")}</ol>
    <div class="row" style="gap:8px"><button id="ccMail">Draft the email</button><button id="ccCopy">Copy as a call sheet</button></div></div></div><div id="ccMailBox"></div>
    <h4>What they said</h4>
    <div class="grid2">${field("code", "Fire code", r?.fire_code?.base || "")}${field("edition", "Edition", r?.fire_code?.edition || "")}${field("amendment", "Local amendment", "None, or the section")}${field("policy", "Written policy", "Link or name")}
      ${field("final_say", "Who has the final say, and the appeal")}${field("radio_shop", "Who runs the radio system")}${field("third_party", "Third-party tester or tool")}${field("stages", "Stages they want to be involved in")}</div>
    <h4>Confirmed by</h4>
    <div class="grid2">${field("confirmed_by", "Name and title at the AHJ")}<label>Date<input type="date" data-cc="confirmed_on" value="${esc(c.confirmed_on || "")}"></label>${field("how", "How", "Email, call, or letter")}${field("note", "Note")}</div>
    <div class="row" style="gap:8px;margin-top:8px"><button class="primary" id="ccSave">Save</button><button id="ccUse" title="Put the confirmed code on the job's Overview">Use on this job</button><span class="hint" id="ccMsg"></span></div></details>`;
  window.dasBookCard?.(el.querySelector("#ccBookOut"), j, P);  // what other jobs learned here. Offered, never confirmed (dasfirm.js, ahjbook.py)
  const card = el.querySelector("#ccCard"), vals = () => Object.fromEntries([...card.querySelectorAll("[data-cc]")].map(i => [i.dataset.cc, i.value])), msg = t => { const m = card.querySelector("#ccMsg"); if (m) m.textContent = t; };
  card.querySelector("#ccSave").onclick = async () => { try { await post(`/api/das/x/code/${j.id}`, { ...vals(), state: st }); render(); } catch (e) { msg("Not saved: " + e.message); } };
  card.querySelector("#ccUse").onclick = async () => { const v = vals(); await save({ code: [v.code, v.edition].filter(Boolean).join(" ") + (v.amendment ? `, ${v.amendment}` : "") }); render(); };
  card.querySelector("#ccMail").onclick = () => { const ahj = (S.das.contacts || []).find(x => String(x.id) === String((j.data.contacts || {}).ahj));
    rfMail.compose(card.querySelector("#ccMailBox"), { kind: "job", refs: { job_id: j.id, topic: "AHJ" }, title: "Ask the AHJ", to: ahj?.email || "", subject: P.draft.subject, body: P.draft.body }); };
  card.querySelector("#ccCopy").onclick = async () => { const t = `${P.draft.subject}\n\n${P.reading}\n\n${P.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n`;
    try { await navigator.clipboard.writeText(t); msg("Copied."); } catch (e) { msg("Copy failed: your browser blocked it."); } };
};

// a move forward: what's missing, each with a way to go fix it. after(moved) runs once it's settled. o: Start's words for someone
// new (start.js): title, intro, hints by need, whyLabel, placeholder, why (a reason already given), stay, go, and open(sub) for Go there
window.dasMoveStage = async (id, to, after, o = {}) => {
  const done = m => { after && after(m); };
  try {
    const { needs } = await api(`/api/das/x/gate/${id}?to=${encodeURIComponent(to)}`);
    if (!needs.length) { await post(`/api/das/jobs/${id}`, { stage: to }); return done(true); }
    const box = document.createElement("div"); box.className = "cc-gate"; box.setAttribute("role", "dialog");
    box.innerHTML = `<div class="cc-gate-box"><h3 style="margin:0 0 6px">${esc(o.title || `Not ready for ${to}`)}</h3><p class="hint" style="margin:0 0 8px">${esc(o.intro || "Still needed:")}</p>
      <ul>${needs.map((n, i) => `<li>${esc(n.text)} <button class="sm" data-go="${i}">Go there</button>${o.hints?.[n.key] ? `<div class="hint">${esc(o.hints[n.key])}</div>` : ""}</li>`).join("")}</ul>
      <label style="display:block;margin-top:10px">${esc(o.whyLabel || "Move anyway: why?")} <span class="hint">This goes in the job's log.</span><input id="ccWhy" placeholder="${esc(o.placeholder || "We took this job over part way through")}" value="${esc(o.why || "")}"></label>
      <div class="row" style="gap:8px;margin-top:10px;justify-content:flex-end"><button id="ccStay">${esc(o.stay || "Stay in this stage")}</button><button id="ccAnyway" class="primary" ${o.why ? "" : "disabled"}>${esc(o.go || "Move anyway")}</button></div><p class="hint" id="ccGateMsg"></p></div>`;
    document.body.append(box);
    const close = moved => { box.remove(); document.removeEventListener("keydown", esc2); done(moved); }, esc2 = e => { if (e.key === "Escape") close(false); };
    document.addEventListener("keydown", esc2);
    box.onclick = e => { if (e.target === box) close(false); };
    box.querySelector("#ccStay").onclick = () => close(false);
    const why = box.querySelector("#ccWhy"), go = box.querySelector("#ccAnyway");
    why.oninput = () => { go.disabled = !why.value.trim(); }; why.focus();
    box.querySelectorAll("[data-go]").forEach(b => b.onclick = () => { const n = needs[+b.dataset.go]; if (o.open) { close(false); return o.open(n.sub); }
      const D = S.das; D.job = id; D.sub = n.sub; close(false); });
    go.onclick = async () => { try { await post(`/api/das/jobs/${id}`, { stage: to, gate_reason: why.value.trim() }); close(true); } catch (e) { box.querySelector("#ccGateMsg").textContent = "Not moved: " + e.message; } };
  } catch (e) { dasSay("Not moved: " + e.message); done(false); }
};

// the state's row for a building, for Prospects and Pitch. A lead, and the wording says so
let CC_RULES = null;
window.dasStateRules = async () => CC_RULES || (CC_RULES = await fetch("static/research/state_rules.json").then(r => r.json()).catch(() => ({ states: {} })));
window.dasStateFlag = (rules, state) => { const r = rules?.states?.[state]; if (!r || r.level === "required") return null;
  return { level: r.level, cls: CC_LEVEL[r.level], short: { no_mandate: "No mandate here", local: "Local code only", discretion: "Exceptions apply", unknown: "State rule not found" }[r.level], name: r.name, line: r.erces?.summary || "", read: r.erces?.status }; };
