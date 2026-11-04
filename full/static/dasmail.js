"use strict";
/* RF Recon — mail from your own mailbox (Cody 11/4: "send/receive automatically from RF Recon without leaving the
   window/tab/sub tab", with a naming convention in the subject). Each login connects its own mailbox once (IMAP +
   SMTP with an app password; mailbox.py, dasmail.py). Every email RF Recon sends carries a tag like [RFR Q12.2];
   replies are read every 5 minutes (or on Check now) and filed where they belong: a supplier's quote into the
   comparison, a prospect's reply or opt-out into their status, plans and consent replies into the job's files.
   Nothing is sent unless the person presses Send. Without a mailbox (or in the web version) everything keeps
   working as before: Open in my mail.
   Needs core.js (api, post, esc, $, S), das.js (dasSay). */

window.rfMail = (() => {
  let info = null, infoAt = 0;
  const say = (t, bad) => (window.dasSay ? dasSay(t) : alert(t));
  async function account(force) {
    if (!force && info && Date.now() - infoAt < 60000) return info;
    try { info = await api("/api/mail/account"); } catch (e) { info = { available: false, why: e.message }; }
    infoAt = Date.now(); return info;
  }
  const ready = async () => { const a = await account(); return !!(a.available && a.account); };
  const when = t => t ? String(t).slice(5, 16).replace("T", " ") : "";
  const badge = s => ({ applied: ["filed", "good"], proposal: ["prices to apply", "warn"], reply: ["read it", "warn"], held: ["held: check it", "warn"],
    error: ["couldn't file", "bad"], sent: ["sent", ""] }[s] || [s || "", ""]);

  // an address as pasted: no spaces, zero-width or direction marks, <> or quotes (mailbox.clean_address does the same)
  const cleanAddr = s => { const m = /<([^<>]*@[^<>]*)>/.exec(s || ""); s = (m ? m[1] : s || "").replace(/[\s\u00ad\u200b-\u200f\u2028-\u202f\u2060-\u2064\ufeff<>"']/g, "");
    const i = s.lastIndexOf("@"); return i < 0 ? s : s.slice(0, i + 1) + s.slice(i + 1).toLowerCase(); };

  // ---- your mailbox
  async function connectPanel(el, done) {
    const a = await account(true);
    // the web version (its stand-in server answers "runs on the PC only") and the phone app: a browser can't sign in to a mailbox
    if (!a.available) { el.innerHTML = `<div class="panel"><h3 style="margin-top:0">Email from your own mailbox</h3>
      <p>Sending from your mailbox and filing the replies into jobs, quotes and prospects works on the RF Recon server and in the PC app: a web page can't sign in to a mailbox itself.</p>
      <p class="hint" style="margin-bottom:0">Here, each email button (quote requests, prospects, plans, consent letters, the AHJ report) opens the email in your own mail app, ready to send; replies stay in your mail.</p></div>`; return; }
    const ac = a.account || {}, st = a.state || {};
    const q = s => el.querySelector(s);
    el.innerHTML = `<div class="panel" id="mlAcct"><h3 style="margin-top:0">Your mailbox <span class="hint">· ${esc(a.login === "local" ? "this PC" : a.login)}: RF Recon sends from it when you press Send, and files tagged replies</span></h3>
      ${ac.address ? `<p>Connected: <b>${esc(ac.address)}</b> <span class="hint">(${esc(ac.provider || "")}, folder ${esc(ac.folder || "INBOX")}${st.last_check ? `, checked ${esc(when(st.last_check))}` : ""})</span>
        ${st.last_error ? `<span class="status err">${esc(st.last_error)}</span>` : ""}</p>` : `<p class="hint">Not connected. RF Recon reads only emails with "[RFR" in the subject, never marks anything read, and keeps your password sealed on ${a.login === "local" ? "this PC" : "the server"}, never shown again.</p>`}
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:end">
        <label>Email address<input id="mlAddr" type="email" value="${esc(ac.address || "")}" style="width:230px" autocomplete="email"></label>
        <label>Your name (on emails)<input id="mlName" autocomplete="name" value="${esc(ac.name || S.me?.name || "")}" style="width:170px"></label>
        <label>App password<input id="mlPw" type="password" autocomplete="new-password" placeholder="${ac.address ? "kept: type to change" : "from your provider"}" style="width:200px"></label>
        <label>Folder or label<input id="mlFolder" autocomplete="off" data-lpignore="true" value="${esc(ac.folder || "INBOX")}" style="width:140px" title="Where RF Recon looks for tagged replies. A mail filter on [RFR can put them in their own folder or label."></label>
        <button class="primary" id="mlSave">${ac.address ? "Save and test" : "Connect and test"}</button>
        ${ac.address ? `<button id="mlCheck">⟳ Check now</button><button id="mlDel">Disconnect</button>` : ""}</div>
      <p class="hint" id="mlHow" style="margin:6px 0 0"></p>
      <details style="margin-top:4px"><summary class="hint" style="cursor:pointer">Server settings (filled in from your address)</summary>
        <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:6px">
          <label>IMAP host<input id="mlIh" autocomplete="off" data-lpignore="true" value="${esc(ac.imap_host || "")}" style="width:190px"></label><label>Port<input id="mlIp" autocomplete="off" data-lpignore="true" value="${esc(ac.imap_port || "")}" style="width:70px"></label>
          <label>SMTP host<input id="mlSh" autocomplete="off" data-lpignore="true" value="${esc(ac.smtp_host || "")}" style="width:190px"></label><label>Port<input id="mlSp" autocomplete="off" data-lpignore="true" value="${esc(ac.smtp_port || "")}" style="width:70px"></label>
          <label>SMTP security<select id="mlSm"><option value="ssl" ${ac.smtp_mode !== "starttls" ? "selected" : ""}>SSL (465)</option><option value="starttls" ${ac.smtp_mode === "starttls" ? "selected" : ""}>STARTTLS (587)</option></select></label>
          <label>Sign-in name<input id="mlUser" autocomplete="off" data-lpignore="true" value="${esc(ac.user || "")}" placeholder="usually your address" style="width:190px"></label></div></details>
      <p id="mlMsg" class="hint" style="margin:6px 0 0"></p></div>`;
    const hostIds = ["#mlIh", "#mlIp", "#mlSh", "#mlSp", "#mlSm"];
    hostIds.forEach(id => { const x = q(id); x.dataset.guessed = ac.imap_host ? "" : "1"; x.addEventListener("input", () => { x.dataset.guessed = ""; }); });
    const guess = async () => { const v = cleanAddr(q("#mlAddr").value); if (v !== q("#mlAddr").value) q("#mlAddr").value = v; if (!/@[^@.]+\.[^@]+$/.test(v)) return;
      try { const g = await api(`/api/mail/guess?address=${encodeURIComponent(v)}`); if (q("#mlAddr").value.trim() !== v) return;
        q("#mlHow").textContent = g.how || "";
        if (g.imap_host) [["#mlIh", g.imap_host], ["#mlIp", g.imap_port], ["#mlSh", g.smtp_host], ["#mlSp", g.smtp_port], ["#mlSm", g.smtp_mode]]
          .forEach(([id, val]) => { const x = q(id); if (!x.value || x.dataset.guessed) { x.value = val; x.dataset.guessed = "1"; } });
      } catch (e) { /* the guess is a help only */ } };
    q("#mlAddr").onchange = guess; q("#mlAddr").oninput = () => { clearTimeout(q("#mlAddr")._t); q("#mlAddr")._t = setTimeout(guess, 700); }; if (q("#mlAddr").value) guess();
    q("#mlSave").onclick = async e => { const b = e.currentTarget; q("#mlAddr").value = cleanAddr(q("#mlAddr").value); if (/@/.test(q("#mlUser").value)) q("#mlUser").value = cleanAddr(q("#mlUser").value); b.disabled = true; q("#mlMsg").className = "hint"; q("#mlMsg").textContent = "Signing in to read and to send…";
      try { const r = await post("/api/mail/account", { address: q("#mlAddr").value, name: q("#mlName").value, password: q("#mlPw").value, folder: q("#mlFolder").value,
          imap_host: q("#mlIh").value, imap_port: q("#mlIp").value, smtp_host: q("#mlSh").value, smtp_port: q("#mlSp").value, smtp_mode: q("#mlSm").value, user: q("#mlUser").value });
        info = null; say(`Mailbox connected: ${r.account.address}.`); await connectPanel(el, done); done && done(); }
      catch (err) { q("#mlMsg").className = "status err"; q("#mlMsg").textContent = err.message; b.disabled = false; } };
    q("#mlCheck") && (q("#mlCheck").onclick = async e => { e.currentTarget.disabled = true; const r = await post("/api/mail/check").catch(x => ({ error: x.message }));
      say(r.error ? `Mail: ${r.error}` : r.new ? `${r.new} new: ${r.filed.map(f => `${f.from} (${f.result})`).join("; ")}` : "No new tagged mail."); await connectPanel(el, done); done && done(); });
    q("#mlDel") && (q("#mlDel").onclick = async () => { if (!confirm("Disconnect your mailbox? RF Recon forgets the app password; sent emails and filed replies stay.")) return;
      await post("/api/mail/account/delete"); info = null; await connectPanel(el, done); done && done(); });
  }

  // ---- compose and send (inline, in the tab you're on)
  // o: {kind: "rfq"|"prospect"|"job", refs, to, subject, body, files: [job files offered], rfqSheet, title, onSent, write}
  // Cody 11/4: pick who from RF Recon's contacts (or type an address), RF Recon writes it, a preview every time, then Send.
  // o.write: a free-form email (nothing written for you): it opens on the message box instead of the preview.
  async function compose(el, o) {
    const a = await account();
    const mailto = () => `mailto:${encodeURIComponent(st.to || "")}?subject=${encodeURIComponent(st.subject || "")}&body=${encodeURIComponent(st.body || "")}`;
    const st = { to: o.to || "", cc: "", subject: o.subject || "", body: o.body || "", editing: !!o.write, touched: false };
    if (!(a.available && a.account)) {
      el.innerHTML = `<div class="panel" style="margin-top:10px"><div class="row" style="justify-content:space-between"><b>${esc(o.title || "Email")}</b><button class="sm" data-mx>✕</button></div>
        <p class="hint">${a.available ? "Connect your mailbox to send from here and have the reply filed by itself." : esc(a.why || "")} Meanwhile: <a href="${esc(mailto())}">Open in my mail</a>.</p>
        ${a.available ? `<div data-mconn></div>` : ""}</div>`;
      el.querySelector("[data-mx]").onclick = () => { el.innerHTML = ""; };
      const c = el.querySelector("[data-mconn]"); if (c) connectPanel(c, () => compose(el, o));
      return;
    }
    const jid = o.refs?.job_id;
    let ppl = [];
    const loadPeople = async () => { try { ppl = (await api(`/api/mail/people${jid != null ? `?job=${jid}` : ""}`)).people || []; } catch (e) { ppl = []; } };
    await loadPeople();
    const who = e => ppl.find(x => x.email === cleanAddr(e || "").toLowerCase());
    const label = x => [x.name || x.org, x.role || (x.name ? x.org : "")].filter(Boolean).join(" · ") || x.email;  // "Talley · Supplier"
    // "Hello," becomes "Hello Jane," for the person picked, until the message is edited by hand
    const greet = (body, x) => { const first = x?.name && !/@/.test(x.name) ? x.name.trim().split(/\s+/)[0] : "";
      return body.replace(/^(Hello|Hi|Dear)( [^,\n]{1,40})?,/, first ? `$1 ${first},` : "$1,"); };
    if (st.to) st.body = greet(st.body, who(st.to));
    const uid = "m" + Math.random().toString(36).slice(2, 8);
    el.innerHTML = `<div class="panel" style="margin-top:10px"><div class="row" style="justify-content:space-between"><b>${esc(o.title || "Email")}</b><button class="sm" data-mx title="Close">✕</button></div>
      <p class="hint" style="margin:2px 0 6px">From ${esc(a.account.address)}. RF Recon adds a tag to the subject so the reply files itself; nothing goes until you press Send.</p>
      ${o.templates && jid != null ? `<label style="max-width:420px">Kind of email<select data-mtpl></select></label>` : ""}
      <div data-mpeople class="row" style="gap:6px;flex-wrap:wrap;margin:0 0 6px"></div>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:end">
        <label style="flex:1 1 280px">To<input data-mto list="${uid}" value="${esc(st.to)}" placeholder="pick someone or type their email" autocomplete="off"></label>
        <datalist id="${uid}"></datalist>
        <button class="sm" data-mccbtn type="button">+ Cc</button>
        <label class="sm hint" style="cursor:pointer" title="Add people from a vCard (.vcf) or a CSV exported from your phone, Gmail or Outlook">⇪ Import contacts<input type="file" data-mimp accept=".vcf,.csv,.tsv,.txt,.xlsx" hidden></label></div>
      <label data-mccrow style="display:none">Cc<input data-mcc list="${uid}" placeholder="optional" autocomplete="off"></label>
      <p class="hint" data-mwho style="margin:4px 0 0"></p>
      <div data-mprev class="panel" style="margin:8px 0 0;padding:10px 12px"></div>
      <div data-medit style="display:none">
        <label>Subject<input data-msub value="${esc(st.subject)}"></label>
        <label>Message<textarea data-mbody rows="12">${esc(st.body)}</textarea></label></div>
      ${o.rfqSheet ? `<label class="hint" style="display:block"><input type="checkbox" data-msheet checked style="width:auto"> Attach the quote sheet (CSV): filled in and sent back, it reads straight into the comparison</label>` : ""}
      ${(o.files || []).length ? `<details><summary class="hint" style="cursor:pointer">Attach job files</summary>${o.files.map(f => `<label class="hint" style="display:block"><input type="checkbox" data-mfile="${esc(f)}" style="width:auto"> ${esc(f)}</label>`).join("")}</details>` : ""}
      <div class="row" style="gap:8px;margin-top:8px;align-items:center"><button data-medbtn type="button"></button><button class="primary" data-msend>✉ Send</button><a class="hint" data-mmailto href="#">or open in my mail</a></div>
      <p class="hint" data-mmsg style="margin:6px 0 0"></p></div>`;
    const q = s => el.querySelector(s);
    const drawPeople = () => {
      q(`#${uid}`).innerHTML = ppl.map(x => `<option value="${esc(x.email)}">${esc(label(x))}</option>`).join("");
      const job = ppl.filter(x => x.source === "job");
      q("[data-mpeople]").innerHTML = job.length ? `<span class="hint">This job:</span>${job.map(x => `<button class="sm${cleanAddr(st.to).toLowerCase() === x.email ? " on" : ""}" type="button" data-mpick="${esc(x.email)}" title="${esc(x.email)}">${esc(x.role)}: ${esc(x.name || x.email)}</button>`).join("")}`
        : `<span class="hint">${ppl.length ? `${ppl.length} people in RF Recon's contacts and suppliers: type a name or pick from the list.` : "No contacts with an email yet: type an address, or import contacts."}</span>`;
      q("[data-mpeople]").querySelectorAll("[data-mpick]").forEach(btn => btn.onclick = () => setTo(btn.dataset.mpick));
    };
    const drawWho = () => {
      const tos = st.to.split(/[,;]/).map(cleanAddr).filter(Boolean), out = q("[data-mwho]");
      if (!tos.length) { out.innerHTML = ""; return; }
      out.innerHTML = tos.map(e => { const x = who(e);
        return x ? `→ <b>${esc(label(x))}</b> &lt;${esc(e)}&gt;${x.source === "replied" ? ` <button class="sm" type="button" data-msave="${esc(e)}">＋ Save as contact</button>` : ""}`
          : /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,24}$/.test(e) ? `→ ${esc(e)} <span class="hint">(not in your contacts)</span> <button class="sm" type="button" data-msave="${esc(e)}">＋ Save as contact</button>`
          : `<span class="status err">“${esc(e)}” isn't an email address yet</span>`; }).join("<br>");
      out.querySelectorAll("[data-msave]").forEach(btn => btn.onclick = () => saveContact(btn.dataset.msave, btn));
    };
    const drawPrev = () => {
      const files = [...el.querySelectorAll("[data-mfile]:checked")].map(x => x.dataset.mfile), sheet = q("[data-msheet]")?.checked;
      q("[data-mprev]").style.display = st.editing ? "none" : ""; q("[data-medit]").style.display = st.editing ? "" : "none";  // not [hidden]: .panel / label styles beat it
      q("[data-medbtn]").textContent = st.editing ? "Preview" : "✎ Edit";
      q("[data-mprev]").innerHTML = `<div class="hint" style="margin-bottom:4px">Preview · what they'll receive</div>
        <div><b>${esc(st.subject || "(no subject)")}</b> <span class="hint mono">[RFR …]</span></div>
        <pre style="white-space:pre-wrap;font:inherit;margin:6px 0 0;max-height:320px;overflow:auto">${esc(st.body || "(no message)")}</pre>
        ${sheet || files.length ? `<div class="hint" style="margin-top:6px">📎 ${[sheet ? "Quote sheet (CSV)" : "", ...files].filter(Boolean).map(esc).join(", ")}</div>` : ""}`;
      q("[data-mmailto]").href = mailto();
    };
    const setTo = v => { const before = st.to; st.to = v; q("[data-mto]").value = v;
      if (!st.touched) { st.body = greet(st.body, who(v.split(/[,;]/)[0])); q("[data-mbody]").value = st.body; }
      if (before !== v) { drawPeople(); } drawWho(); drawPrev(); };
    const saveContact = async (e, btn) => {
      const x = who(e) || {}; btn.disabled = true;
      const name = window.prompt("Save as contact: their name", x.name || e.split("@")[0].replace(/[._]/g, " ").replace(/\b\w/g, c => c.toUpperCase()));
      if (name == null) { btn.disabled = false; return; }
      try { await post("/api/das/contacts", { name, email: e, org: x.org || "", notes: jid != null ? `Saved from mail about job ${jid}` : "Saved from mail" });
        if (window.S?.das) S.das.contacts = (await api("/api/das/contacts")).contacts;
        await loadPeople(); drawPeople(); drawWho(); say(`${name} saved to Contacts.`);
      } catch (err) { btn.disabled = false; say(err.message); }
    };
    q("[data-mx]").onclick = () => { el.innerHTML = ""; };
    q("[data-mto]").onchange = e => setTo(e.target.value.split(/[,;]/).map(cleanAddr).filter(Boolean).join(", "));
    q("[data-mto]").oninput = e => { st.to = e.target.value; drawWho(); };
    q("[data-mccbtn]").onclick = () => { q("[data-mccrow]").style.display = ""; q("[data-mcc]").focus(); };
    q("[data-mcc]").oninput = e => { st.cc = e.target.value; };
    q("[data-msub]").oninput = e => { st.subject = e.target.value; };
    q("[data-mbody]").oninput = e => { st.body = e.target.value; st.touched = true; };
    q("[data-medbtn]").onclick = () => { st.editing = !st.editing; drawPrev(); if (st.editing) q("[data-mbody]").focus(); };
    el.querySelectorAll("[data-mfile], [data-msheet]").forEach(x => x.onchange = drawPrev);
    q("[data-mimp]").onchange = async e => { const f = e.target.files[0]; if (!f) return;
      try { const r = await api(`/api/das/contacts/import?name=${encodeURIComponent(f.name)}`, { method: "POST", body: await f.arrayBuffer() });
        if (window.S?.das) S.das.contacts = (await api("/api/das/contacts")).contacts;
        await loadPeople(); drawPeople(); drawWho(); say(`Contacts: ${r.added} added of ${r.found} in ${f.name}.`);
      } catch (err) { say(`Couldn't import ${f.name}: ${err.message}`); } e.target.value = ""; };
    drawPeople(); drawWho(); drawPrev();
    if (st.editing) q("[data-mbody]").focus();
    if (q("[data-mtpl]")) {  // a written email for this job: status, access, scope, the AHJ, plans, retest (mailqueue.py)
      const tl = (await api("/api/mail/templates").catch(() => ({ templates: [] }))).templates;
      q("[data-mtpl]").innerHTML = tl.map(t => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join("");
      q("[data-mtpl]").onchange = async e => { const t = await api(`/api/mail/template?job=${jid}&t=${encodeURIComponent(e.target.value)}`).catch(err => ({ error: err.message }));
        if (t.error) { q("[data-mmsg]").textContent = t.error; return; }
        o.refs = { ...o.refs, topic: t.topic || "MAIL" }; st.subject = t.subject; st.body = t.body; st.touched = false;
        q("[data-msub]").value = st.subject; q("[data-mbody]").value = st.body;
        if (t.to) setTo(t.to); else { drawWho(); }
        st.editing = e.target.value === "blank"; drawPrev(); if (st.editing) q("[data-mbody]").focus(); };
    }
    q("[data-msend]").onclick = async e => {
      const b = e.currentTarget, m = q("[data-mmsg]"); if (b.disabled) return;
      st.to = q("[data-mto]").value.split(/[,;]/).map(cleanAddr).filter(Boolean).join(", ");
      if (!st.to) { m.className = "status err"; m.textContent = "Pick who it goes to, or type their email."; q("[data-mto]").focus(); return; }
      b.disabled = true; m.className = "hint"; m.textContent = "Sending…";
      try {
        const r = await post("/api/mail/send", { kind: o.kind, refs: o.refs, to: st.to, cc: st.cc.split(/[,;]/).map(cleanAddr).filter(Boolean).join(", "), in_reply_to: o.in_reply_to,
          subject: st.subject, body: st.body,
          rfq_sheet: !!q("[data-msheet]")?.checked, files: [...el.querySelectorAll("[data-mfile]:checked")].map(x => x.dataset.mfile) });
        el.innerHTML = `<p class="hint" style="margin:8px 0 0">Sent to ${esc(st.to)}: “${esc(r.subject)}”${r.attached.length ? ` with ${r.attached.map(esc).join(", ")}` : ""}. The reply files itself here.</p>`;
        o.onSent && o.onSent(r);
      } catch (err) { m.className = "status err"; m.textContent = err.message; b.disabled = false; }
    };
  }

  // ---- a conversation (sent and received), with Apply for typed prices
  async function thread(el, q, onChange) {
    if (!(await ready())) { el.innerHTML = ""; return; }
    let r; try { r = await api(`/api/mail/threads?${new URLSearchParams(q)}`); } catch (e) { el.innerHTML = ""; return; }
    if (!el.isConnected) return;
    if (!r.mail.length) { el.innerHTML = ""; return; }
    el.innerHTML = `<details class="panel" style="margin-top:10px" open><summary style="cursor:pointer"><b>Mail</b> <span class="hint">· ${r.mail.length} message${r.mail.length === 1 ? "" : "s"}${r.state?.last_check ? `, checked ${esc(when(r.state.last_check))}` : ""}</span> <button class="sm" data-mcheck>⟳ Check now</button></summary>
      ${r.mail.map(m => { const [b, cls] = badge(m.status); return `<div style="border-top:1px solid var(--line);padding:6px 0">
        <div class="row" style="gap:8px;flex-wrap:wrap"><b ${m.direction === "in" ? `data-mfrom="${esc(m.counterpart)}" data-mname="${esc(m.counterpart_name || "")}"` : ""}>${m.direction === "out" ? "→ " + esc(m.counterpart) : "← " + esc(m.counterpart_name ? `${m.counterpart_name} <${m.counterpart}>` : m.counterpart)}</b><span class="hint">${esc(when(m.ts))}</span>
          ${b ? `<span class="tag" ${cls ? `style="background:var(--${cls === "good" ? "good" : cls === "bad" ? "bad" : "warn"});color:#fff"` : ""}>${esc(b)}</span>` : ""}<span class="hint">${esc(m.subject || "")}</span></div>
        ${m.result ? `<div class="hint">${esc(m.result)}</div>` : ""}
        ${m.direction === "in" ? `<pre style="white-space:pre-wrap;font:inherit;margin:4px 0;max-height:160px;overflow:auto">${esc((m.body || "").slice(0, 2000))}</pre>` : ""}
        ${(m.attachments || []).filter(x => x.saved).map(x => `<a class="hint" href="/api/mail/${m.id}/attachment?name=${encodeURIComponent(x.saved)}">📎 ${esc(x.saved)}</a>`).join(" ")}
        ${m.status === "proposal" ? `<button class="sm primary" data-mapply="${m.id}">Apply these prices</button> <span class="hint">${Object.keys(m.proposal?.lines || {}).length} line(s)${m.proposal?.terms?.ship_cost != null ? `, shipping $${m.proposal.terms.ship_cost}` : ""}</span>` : ""}
      </div>`; }).join("")}</details>`;
    let saved = new Set();
    try { saved = new Set(((await api(`/api/mail/people${q.job != null ? `?job=${q.job}` : ""}`)).people || []).filter(x => x.source !== "replied").map(x => x.email)); } catch (e) { /* the button is a help only */ }
    el.querySelectorAll("[data-mfrom]").forEach(s => { const e = s.dataset.mfrom; if (saved.has(e)) return;
      s.insertAdjacentHTML("afterend", ` <button class="sm" type="button" data-mkeep="${esc(e)}" data-mname="${esc(s.dataset.mname || "")}" title="Add them to RF Recon's contacts, to pick next time">＋ Save as contact</button>`); });
    el.querySelectorAll("[data-mkeep]").forEach(btn => btn.onclick = async ev => { ev.preventDefault(); ev.stopPropagation(); const e = btn.dataset.mkeep;
      const name = window.prompt("Save as contact: their name", btn.dataset.mname || e.split("@")[0].replace(/[._]/g, " ").replace(/\b\w/g, c => c.toUpperCase()));
      if (name == null) return; btn.disabled = true;
      try { await post("/api/das/contacts", { name, email: e, notes: q.job != null ? `Replied by email about job ${q.job}` : "Replied by email" });
        if (window.S?.das) S.das.contacts = (await api("/api/das/contacts")).contacts; say(`${name} saved to Contacts.`); thread(el, q, onChange);
      } catch (err) { btn.disabled = false; say(err.message); } });
    el.querySelector("[data-mcheck]").onclick = async e => { e.preventDefault(); e.stopPropagation(); const r2 = await post("/api/mail/check").catch(x => ({ error: x.message }));
      say(r2.error ? `Mail: ${r2.error}` : r2.new ? `${r2.new} new tagged email${r2.new === 1 ? "" : "s"} filed.` : "No new tagged mail."); thread(el, q, onChange); if (r2.new && onChange) onChange(); };
    el.querySelectorAll("[data-mapply]").forEach(b => b.onclick = async () => { b.disabled = true;
      try { await post(`/api/mail/${b.dataset.mapply}/apply`); say("Prices applied to the comparison."); onChange ? onChange() : thread(el, q); } catch (err) { b.disabled = false; say(err.message); } });
  }

  // ---- Ready to send (mailqueue.py): written for you, lined up, sent only when you click (Cody 11/4)
  async function queue(el, onChange) {
    let r; try { r = await api("/api/mail/queue"); } catch (e) { el.innerHTML = ""; return; }
    if (!el.isConnected) return;
    qCount(r.ready);
    if (!r.items.length) { el.innerHTML = `<div class="panel"><h3 style="margin-top:0">Ready to send</h3><p class="hint" style="margin:0">Nothing waiting. Follow-ups (no reply in 5 days), retest reminders (30 days before), plans requests (jobs with no plans) and prospect emails you queue from Prospects appear here, written and ready: nothing goes until you click.</p></div>`; return; }
    const groups = [...new Set(r.items.map(x => x.group))];
    el.innerHTML = `<div class="panel" id="mqPanel"><h3 style="margin-top:0">Ready to send <span class="hint">· ${r.ready} ready${r.items.length > r.ready ? `, ${r.items.length - r.ready} need something first` : ""}; nothing goes until you click</span></h3>
      ${groups.map(g => `<div class="mq-group" data-mqg="${esc(g)}" style="margin-top:8px"><b>${esc(g)}</b>${r.items.filter(x => x.group === g).map(x => `
        <div class="mq-item" style="border-top:1px solid var(--line);padding:6px 0">
          <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
            <input type="checkbox" data-mq="${esc(x.key)}" ${x.blocked ? "disabled" : ""} style="width:auto;margin:0">
            <span style="flex:1 1 300px"><b>${esc(x.to_name || x.to || "(no address)")}</b>${x.to && x.to_name ? ` <span class="hint">&lt;${esc(x.to)}&gt;</span>` : ""} · ${esc(x.subject)}
              <div class="hint">${esc(x.why)}</div>${x.blocked ? `<div class="status err" style="margin:2px 0 0">${esc(x.blocked)}</div>` : ""}</span>
            <button class="sm" data-mqopen="${esc(x.key)}">Preview</button>
            <button class="sm" data-mqlater="${esc(x.key)}" title="Put it off a week">Later</button>
            <button class="sm" data-mqdrop="${esc(x.key)}" title="Don't suggest this one again">✕</button></div>
          <div data-mqbox="${esc(x.key)}"></div></div>`).join("")}</div>`).join("")}
      <div class="row" style="gap:8px;margin-top:10px;align-items:center"><button class="primary" id="mqSend" disabled>✉ Send selected</button><span class="hint" id="mqMsg">Tick the ones to send (or Preview one to read and edit it first).</span></div></div>`;
    const P = el.querySelector("#mqPanel"), byKey = Object.fromEntries(r.items.map(x => [x.key, x]));
    const sel = () => [...P.querySelectorAll("[data-mq]:checked")].map(c => byKey[c.dataset.mq]);
    const upd = () => { const n = sel().length; P.querySelector("#mqSend").disabled = !n; P.querySelector("#mqSend").textContent = n ? `✉ Send ${n} selected` : "✉ Send selected"; };
    P.addEventListener("change", upd);
    if (window.rfChecks) P.querySelectorAll(".mq-group").forEach(g => rfChecks(g, { sel: "[data-mq]:not(:disabled)", fold: false, word: "picked", head: g.querySelector("b"), commit: () => upd() }));
    const later = async (key, days) => { await post("/api/mail/queue/later", { key, days }); queue(el, onChange); };
    P.querySelectorAll("[data-mqlater]").forEach(b => b.onclick = () => later(b.dataset.mqlater, 7));
    P.querySelectorAll("[data-mqdrop]").forEach(b => b.onclick = () => later(b.dataset.mqdrop, 0));
    P.querySelectorAll("[data-mqopen]").forEach(b => b.onclick = () => { const x = byKey[b.dataset.mqopen], box = P.querySelector(`[data-mqbox="${CSS.escape(x.key)}"]`);
      if (box.innerHTML) { box.innerHTML = ""; return; }
      compose(box, { kind: x.kind, refs: x.refs, to: x.to, subject: x.subject, body: x.body, in_reply_to: x.in_reply_to, title: x.why,
        onSent: () => { queue(el, onChange); onChange && onChange(); } }); });
    P.querySelector("#mqSend").onclick = async e => {
      const b = e.currentTarget, list = sel(), m = P.querySelector("#mqMsg"); if (!list.length) return;
      if (!confirm(`Send ${list.length} email${list.length === 1 ? "" : "s"} from ${info?.account?.address || "your mailbox"} now?\n\n${list.slice(0, 12).map(x => `• ${x.to}: ${x.subject}`).join("\n")}${list.length > 12 ? `\n… and ${list.length - 12} more` : ""}`)) return;
      b.disabled = true; let ok = 0;
      for (const x of list) {
        m.textContent = `Sending ${ok + 1} of ${list.length}: ${x.to}…`;
        try { await post("/api/mail/send", { kind: x.kind, refs: x.refs, to: x.to, subject: x.subject, body: x.body, in_reply_to: x.in_reply_to }); ok++; }
        catch (err) { m.className = "status err"; m.textContent = `Sent ${ok}; stopped at ${x.to}: ${err.message}`; break; }
        await new Promise(res => setTimeout(res, 1200));  // a steady pace: mail providers dislike bursts
      }
      if (ok === list.length) say(`Sent ${ok} email${ok === 1 ? "" : "s"}. Replies file themselves.`);
      setTimeout(() => queue(el, onChange), ok === list.length ? 0 : 4000); onChange && onChange();
    };
  }
  // the count on DAS › Mail: emails written and ready to send
  function qCount(n) { if (window.rfMail) window.rfMail.ready_n = n; const b = document.querySelector('#dsView [data-v="mail"]'); if (b) b.textContent = n ? `Mail · ${n}` : "Mail"; }
  async function qBadge() { if (!(await ready())) return; try { qCount((await api("/api/mail/queue")).ready); } catch (e) { /* the count is a help only */ } }

  // ---- the DAS Mail view: your mailbox and every tagged conversation
  async function view(el) {
    el.innerHTML = `<div data-mqueue></div><div data-macct></div><div data-mall></div>`;
    const draw = async () => {
      const box = el.querySelector("[data-mall]"); if (!box) return;
      if (!(await ready())) { box.innerHTML = ""; return; }
      const r = await api("/api/mail/threads").catch(() => ({ mail: [] }));
      const by = new Map(); for (const m of r.mail) { if (!by.has(m.tag)) by.set(m.tag, []); by.get(m.tag).push(m); }
      const what = t => /^Q/.test(t) ? "Quote request" : /^P-/.test(t) ? "Prospect" : / PLANS/.test(t) ? "Plans request" : / CONSENT/.test(t) ? "Consent" : / AHJ/.test(t) ? "AHJ" : "Job mail";
      box.innerHTML = by.size ? `<div class="panel"><h3 style="margin-top:0">Conversations <span class="hint">· newest first; replies file themselves</span></h3>
        <table><thead><tr><th>What</th><th>With</th><th>Last</th><th>Status</th><th>Tag</th></tr></thead><tbody>${[...by].map(([t, ms]) => { const last = ms[0], inb = ms.filter(m => m.direction === "in"); const [b] = badge(last.status);
          return `<tr><td>${esc(what(t))}${last.job_id ? ` <a href="#" data-mjob="${last.job_id}">job ${last.job_id}</a>` : ""}</td><td>${esc([...new Set(ms.map(m => m.counterpart))].join(", "))}</td>
            <td class="hint">${esc(when(last.ts))}</td><td>${inb.length ? esc(b) : "waiting for a reply"}</td><td class="mono hint">[RFR ${esc(t)}]</td></tr>`; }).join("")}</tbody></table></div>`
        : `<p class="hint">No RF Recon emails yet. Send one from a quote request, a prospect, a job's plans request, consent letters or the AHJ report.</p>`;
      box.querySelectorAll("[data-mjob]").forEach(a => a.onclick = e => { e.preventDefault(); S.das.job = +a.dataset.mjob; S.das.sub = "overview"; S.views.das($("#view")); });
    };
    await connectPanel(el.querySelector("[data-macct]"), draw); draw();
    if (await ready()) queue(el.querySelector("[data-mqueue]"), draw);
  }

  // ---- new replies while you work: a note every few minutes, only when something was filed
  let lastSeen = null;
  setInterval(async () => {
    if (document.hidden || !info?.account) return;
    const r = await api("/api/mail/threads").catch(() => null); if (!r) return;
    const inb = r.mail.filter(m => m.direction === "in");
    const newest = inb[0]?.ts || "";
    if (lastSeen != null && newest > lastSeen) { const fresh = inb.filter(m => m.ts > lastSeen);
      say(`${fresh.length} new repl${fresh.length === 1 ? "y" : "ies"}: ${fresh.slice(0, 3).map(m => `${m.counterpart} (${m.result || m.status})`).join("; ")}`); }
    lastSeen = newest || lastSeen || "";
  }, 120000);

  setTimeout(qBadge, 1500); setInterval(() => { if (!document.hidden) qBadge(); }, 300000);
  return { account, ready, connectPanel, compose, thread, view, queue, badge: qBadge };
})();
