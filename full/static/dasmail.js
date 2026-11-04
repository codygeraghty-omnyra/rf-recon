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

  // ---- your mailbox
  async function connectPanel(el, done) {
    const a = await account(true);
    // the web version (its stand-in server answers "runs on the PC only") and the phone app: a browser can't sign in to a mailbox
    if (!a.available) { el.innerHTML = `<div class="panel"><h3 style="margin-top:0">Email from your own mailbox</h3>
      <p>Sending from your mailbox and filing the replies into jobs, quotes and prospects works on the RF Recon server and in the PC app: a web page can't sign in to a mailbox itself.</p>
      <p class="hint" style="margin-bottom:0">Here, each email button (quote requests, prospects, plans, consent letters, the AHJ report) opens the email in your own mail app, ready to send; replies stay in your mail.</p></div>`; return; }
    const ac = a.account || {}, st = a.state || {};
    el.innerHTML = `<div class="panel" id="mlAcct"><h3 style="margin-top:0">Your mailbox <span class="hint">· ${esc(a.login === "local" ? "this PC" : a.login)}: RF Recon sends from it when you press Send, and files tagged replies</span></h3>
      ${ac.address ? `<p>Connected: <b>${esc(ac.address)}</b> <span class="hint">(${esc(ac.provider || "")}, folder ${esc(ac.folder || "INBOX")}${st.last_check ? `, checked ${esc(when(st.last_check))}` : ""})</span>
        ${st.last_error ? `<span class="status err">${esc(st.last_error)}</span>` : ""}</p>` : `<p class="hint">Not connected. RF Recon reads only emails with "[RFR" in the subject, never marks anything read, and keeps your password sealed on ${a.login === "local" ? "this PC" : "the server"}, never shown again.</p>`}
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:end">
        <label>Email address<input id="mlAddr" type="email" value="${esc(ac.address || "")}" style="width:230px" autocomplete="email"></label>
        <label>Your name (on emails)<input id="mlName" value="${esc(ac.name || S.me?.name || "")}" style="width:170px"></label>
        <label>App password<input id="mlPw" type="password" autocomplete="new-password" placeholder="${ac.address ? "kept: type to change" : "from your provider"}" style="width:200px"></label>
        <label>Folder or label<input id="mlFolder" value="${esc(ac.folder || "INBOX")}" style="width:140px" title="Where RF Recon looks for tagged replies. A mail filter on [RFR can put them in their own folder or label."></label>
        <button class="primary" id="mlSave">${ac.address ? "Save and test" : "Connect and test"}</button>
        ${ac.address ? `<button id="mlCheck">⟳ Check now</button><button id="mlDel">Disconnect</button>` : ""}</div>
      <p class="hint" id="mlHow" style="margin:6px 0 0"></p>
      <details style="margin-top:4px"><summary class="hint" style="cursor:pointer">Server settings (filled in from your address)</summary>
        <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:6px">
          <label>IMAP host<input id="mlIh" value="${esc(ac.imap_host || "")}" style="width:190px"></label><label>Port<input id="mlIp" value="${esc(ac.imap_port || "")}" style="width:70px"></label>
          <label>SMTP host<input id="mlSh" value="${esc(ac.smtp_host || "")}" style="width:190px"></label><label>Port<input id="mlSp" value="${esc(ac.smtp_port || "")}" style="width:70px"></label>
          <label>SMTP security<select id="mlSm"><option value="ssl" ${ac.smtp_mode !== "starttls" ? "selected" : ""}>SSL (465)</option><option value="starttls" ${ac.smtp_mode === "starttls" ? "selected" : ""}>STARTTLS (587)</option></select></label>
          <label>Sign-in name<input id="mlUser" value="${esc(ac.user || "")}" placeholder="usually your address" style="width:190px"></label></div></details>
      <p id="mlMsg" class="hint" style="margin:6px 0 0"></p></div>`;
    const guess = async () => { const v = $("#mlAddr").value.trim(); if (!/@/.test(v)) return;
      try { const g = await api(`/api/mail/guess?address=${encodeURIComponent(v)}`); $("#mlHow").textContent = g.how || "";
        if (g.imap_host && !$("#mlIh").value) { $("#mlIh").value = g.imap_host; $("#mlIp").value = g.imap_port; $("#mlSh").value = g.smtp_host; $("#mlSp").value = g.smtp_port; $("#mlSm").value = g.smtp_mode; }
      } catch (e) { /* the guess is a help only */ } };
    $("#mlAddr").onchange = guess; if ($("#mlAddr").value) guess();
    $("#mlSave").onclick = async e => { const b = e.currentTarget; b.disabled = true; $("#mlMsg").className = "hint"; $("#mlMsg").textContent = "Signing in to read and to send…";
      try { const r = await post("/api/mail/account", { address: $("#mlAddr").value, name: $("#mlName").value, password: $("#mlPw").value, folder: $("#mlFolder").value,
          imap_host: $("#mlIh").value, imap_port: $("#mlIp").value, smtp_host: $("#mlSh").value, smtp_port: $("#mlSp").value, smtp_mode: $("#mlSm").value, user: $("#mlUser").value });
        info = null; say(`Mailbox connected: ${r.account.address}.`); await connectPanel(el, done); done && done(); }
      catch (err) { $("#mlMsg").className = "status err"; $("#mlMsg").textContent = err.message; b.disabled = false; } };
    $("#mlCheck") && ($("#mlCheck").onclick = async e => { e.currentTarget.disabled = true; const r = await post("/api/mail/check").catch(x => ({ error: x.message }));
      say(r.error ? `Mail: ${r.error}` : r.new ? `${r.new} new: ${r.filed.map(f => `${f.from} (${f.result})`).join("; ")}` : "No new tagged mail."); await connectPanel(el, done); done && done(); });
    $("#mlDel") && ($("#mlDel").onclick = async () => { if (!confirm("Disconnect your mailbox? RF Recon forgets the app password; sent emails and filed replies stay.")) return;
      await post("/api/mail/account/delete"); info = null; await connectPanel(el, done); done && done(); });
  }

  // ---- compose and send (inline, in the tab you're on)
  // o: {kind: "rfq"|"prospect"|"job", refs, to, subject, body, files: [job files offered], rfqSheet, title, onSent}
  async function compose(el, o) {
    const a = await account();
    const mailto = `mailto:${encodeURIComponent(o.to || "")}?subject=${encodeURIComponent(o.subject || "")}&body=${encodeURIComponent(o.body || "")}`;
    if (!(a.available && a.account)) {
      el.innerHTML = `<div class="panel" style="margin-top:10px"><div class="row" style="justify-content:space-between"><b>${esc(o.title || "Email")}</b><button class="sm" data-mx>✕</button></div>
        <p class="hint">${a.available ? "Connect your mailbox to send from here and have the reply filed by itself." : esc(a.why || "")} Meanwhile: <a href="${esc(mailto)}">Open in my mail</a>.</p>
        ${a.available ? `<div data-mconn></div>` : ""}</div>`;
      el.querySelector("[data-mx]").onclick = () => { el.innerHTML = ""; };
      const c = el.querySelector("[data-mconn]"); if (c) connectPanel(c, () => compose(el, o));
      return;
    }
    el.innerHTML = `<div class="panel" style="margin-top:10px"><div class="row" style="justify-content:space-between"><b>${esc(o.title || "Email")}</b><button class="sm" data-mx title="Close">✕</button></div>
      <p class="hint" style="margin:2px 0 6px">From ${esc(a.account.address)}. RF Recon adds a tag to the subject so the reply files itself.</p>
      <label>To<input data-mto value="${esc(o.to || "")}" placeholder="their email"></label>
      <label>Cc<input data-mcc placeholder="optional"></label>
      <label>Subject<input data-msub value="${esc(o.subject || "")}"></label>
      <label>Message<textarea data-mbody rows="12">${esc(o.body || "")}</textarea></label>
      ${o.rfqSheet ? `<label class="hint" style="display:block"><input type="checkbox" data-msheet checked style="width:auto"> Attach the quote sheet (CSV): filled in and sent back, it reads straight into the comparison</label>` : ""}
      ${(o.files || []).length ? `<details><summary class="hint" style="cursor:pointer">Attach job files</summary>${o.files.map(f => `<label class="hint" style="display:block"><input type="checkbox" data-mfile="${esc(f)}" style="width:auto"> ${esc(f)}</label>`).join("")}</details>` : ""}
      <div class="row" style="gap:8px;margin-top:8px"><button class="primary" data-msend>✉ Send</button><a class="hint" href="${esc(mailto)}">or open in my mail</a></div>
      <p class="hint" data-mmsg style="margin:6px 0 0"></p></div>`;
    el.querySelector("[data-mx]").onclick = () => { el.innerHTML = ""; };
    el.querySelector("[data-msend]").onclick = async e => {
      const b = e.currentTarget; if (b.disabled) return; b.disabled = true; const m = el.querySelector("[data-mmsg]"); m.className = "hint"; m.textContent = "Sending…";
      try {
        const r = await post("/api/mail/send", { kind: o.kind, refs: o.refs, to: el.querySelector("[data-mto]").value, cc: el.querySelector("[data-mcc]").value,
          subject: el.querySelector("[data-msub]").value, body: el.querySelector("[data-mbody]").value,
          rfq_sheet: !!el.querySelector("[data-msheet]")?.checked, files: [...el.querySelectorAll("[data-mfile]:checked")].map(x => x.dataset.mfile) });
        el.innerHTML = `<p class="hint" style="margin:8px 0 0">Sent: “${esc(r.subject)}”${r.attached.length ? ` with ${r.attached.map(esc).join(", ")}` : ""}. The reply files itself here.</p>`;
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
        <div class="row" style="gap:8px;flex-wrap:wrap"><b>${m.direction === "out" ? "→ " + esc(m.counterpart) : "← " + esc(m.counterpart)}</b><span class="hint">${esc(when(m.ts))}</span>
          ${b ? `<span class="tag" ${cls ? `style="background:var(--${cls === "good" ? "good" : cls === "bad" ? "bad" : "warn"});color:#fff"` : ""}>${esc(b)}</span>` : ""}<span class="hint">${esc(m.subject || "")}</span></div>
        ${m.result ? `<div class="hint">${esc(m.result)}</div>` : ""}
        ${m.direction === "in" ? `<pre style="white-space:pre-wrap;font:inherit;margin:4px 0;max-height:160px;overflow:auto">${esc((m.body || "").slice(0, 2000))}</pre>` : ""}
        ${(m.attachments || []).filter(x => x.saved).map(x => `<a class="hint" href="/api/mail/${m.id}/attachment?name=${encodeURIComponent(x.saved)}">📎 ${esc(x.saved)}</a>`).join(" ")}
        ${m.status === "proposal" ? `<button class="sm primary" data-mapply="${m.id}">Apply these prices</button> <span class="hint">${Object.keys(m.proposal?.lines || {}).length} line(s)${m.proposal?.terms?.ship_cost != null ? `, shipping $${m.proposal.terms.ship_cost}` : ""}</span>` : ""}
      </div>`; }).join("")}</details>`;
    el.querySelector("[data-mcheck]").onclick = async e => { e.preventDefault(); e.stopPropagation(); const r2 = await post("/api/mail/check").catch(x => ({ error: x.message }));
      say(r2.error ? `Mail: ${r2.error}` : r2.new ? `${r2.new} new tagged email${r2.new === 1 ? "" : "s"} filed.` : "No new tagged mail."); thread(el, q, onChange); if (r2.new && onChange) onChange(); };
    el.querySelectorAll("[data-mapply]").forEach(b => b.onclick = async () => { b.disabled = true;
      try { await post(`/api/mail/${b.dataset.mapply}/apply`); say("Prices applied to the comparison."); onChange ? onChange() : thread(el, q); } catch (err) { b.disabled = false; say(err.message); } });
  }

  // ---- the DAS Mail view: your mailbox and every tagged conversation
  async function view(el) {
    el.innerHTML = `<div data-macct></div><div data-mall></div>`;
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

  return { account, ready, connectPanel, compose, thread, view };
})();
