/* The Phone window (phone.py; Cody 11/8, for the Mobili-Fi demo on 11/9): a Phone button in the top bar opens a window
   laid out like Omnyra Phone (a rail of Texts, Calls, Keypad, Contacts and the AI receptionist beside the view), in the
   copy's own colours: Mobili-Fi's, read off mobili-fi.com (Cody: "use Mobili-Fi palette colors for the in app phone").
   Texts go through the Omnyra SDR campaign and calls ring your cell first; both only to the copy's demo list. Email opens
   Gmail (Cody: "nothing facing, just so he can launch email from that window"; "configure for Gmail for now").
   Nothing loads until the window opens; while it's open and on screen it refreshes every 8 seconds. Also here: the
   licence chip, saying whose copy this is (licence.py). */
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const GMAIL = "https://mail.google.com/mail/";
  const EVERY_MS = 8000;

  // ------------------------------------------------------------ small pieces (as Omnyra Phone's ui.tsx)
  const PHONE = "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z";
  const PATHS = {
    phone: [PHONE], "phone-in": [PHONE, "M16 2v6h6", "M23 1l-7 7"], "phone-out": [PHONE, "M23 7V1h-6", "M16 8l7-7"],
    "phone-missed": [PHONE, "M23 1l-6 6", "M17 1l6 6"],
    chat: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
    contacts: ["M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2", "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M23 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
    keypad: ["M5 4h.01", "M12 4h.01", "M19 4h.01", "M5 10h.01", "M12 10h.01", "M19 10h.01", "M5 16h.01", "M12 16h.01", "M19 16h.01", "M12 22h.01"],
    sparkle: ["M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z", "M19 17l.6 1.4L21 19l-1.4.6L19 21l-.6-1.4L17 19l1.4-.6z"],
    search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M21 21l-4.35-4.35"],
    back: ["M19 12H5", "M12 19l-7-7 7-7"], plus: ["M12 5v14", "M5 12h14"], send: ["M22 2L11 13", "M22 2l-7 20-4-9-9-4 20-7z"],
    x: ["M18 6L6 18", "M6 6l12 12"], erase: ["M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z", "M18 9l-6 6", "M12 9l6 6"],
    cell: ["M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", "M12 18h.01"],
    mail: ["M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M22 6l-10 7L2 6"],
    lock: ["M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z", "M7 11V7a5 5 0 0 1 10 0v4"],
    bars: ["M4 20v-4", "M9 20v-8", "M14 20v-12", "M19 20V4"],
  };
  const icon = (name, size = 20) => `<svg class="ph-ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${name === "keypad" ? 3.2 : name === "bars" ? 2.6 : 1.9}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${(PATHS[name] || []).map(d => `<path d="${d}"/>`).join("")}</svg>`;
  const fmt = n => { const d = String(n || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(n || ""); };
  const e164 = n => { const d = String(n || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); return d.length === 10 ? "+1" + d : ""; };
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  function ago(iso) {
    if (!iso) return "";
    const d = new Date(iso), now = Date.now(), mins = Math.round((now - d.getTime()) / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    if (sameDay(d, new Date(now))) return mins < 360 ? `${Math.floor(mins / 60)}h` : d.toLocaleTimeString([], {hour: "numeric", minute: "2-digit"});
    if (sameDay(d, new Date(now - 86400000))) return "Yesterday";
    if (now - d.getTime() < 6 * 86400000) return d.toLocaleDateString([], {weekday: "short"});
    return d.toLocaleDateString([], {month: "short", day: "numeric"});
  }
  const stamp = iso => iso ? new Date(iso).toLocaleString([], {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"}) : "";
  const dur = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const HUES = [152, 212, 96, 190, 276, 28, 338, 250];
  const hue = s => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return HUES[(h >>> 0) % HUES.length]; };
  const initials = n => String(n || "").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
  const avatar = (name, seed, size = "") => `<span class="ph-av${size ? " ph-av-" + size : ""}" style="--h:${hue(seed)}" aria-hidden="true">${name ? esc(initials(name)) : icon("phone", size === "sm" ? 13 : 16)}</span>`;

  // ------------------------------------------------------------ state
  const S = {conf: null, licence: null, view: "texts", threads: [], open: "", convo: [], calls: [], callF: "all", contacts: [],
             dial: "", composing: false, q: "", timer: null, busy: false, win: null};
  const SEEN_KEY = "rfr.phoneSeen";
  const seen = () => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}"); } catch (e) { return {}; } };
  function markSeen(n, at) { const m = seen(); if (at && (!m[n] || m[n] < at)) { m[n] = at; try { localStorage.setItem(SEEN_KEY, JSON.stringify(m)); } catch (e) { /* private window */ } } }
  const unreadOf = t => (seen()[t.other] || "") >= t.last.at ? 0 : (t.unread || 0);
  const nameOf = n => { const c = S.contacts.find(c => c.phone === n); return c ? c.name : ""; };
  const label = n => nameOf(n) || fmt(n);
  const business = () => (S.licence && S.licence.licensee) || (S.conf && S.conf.business) || "DAStastic";
  async function api(path, body) {
    const r = await fetch(path, body ? {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)} : {});
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `The server answered ${r.status}.`);
    return d;
  }

  // ------------------------------------------------------------ the licence chip
  function licenceChip(lic) {
    if (!lic || $("#licChip")) return;
    const b = document.createElement("button");
    b.className = "hbtn"; b.id = "licChip"; b.title = "Whose copy of DAStastic this is";
    b.innerHTML = `${icon("lock", 13)} <span>${esc(lic.licensee)}</span>`;
    b.onclick = () => {
      $("#dlgTitle").textContent = "Licence";
      const row = (k, v) => v ? `<tr><th style="text-align:left;padding:4px 14px 4px 0;font-weight:550">${k}</th><td>${esc(v)}</td></tr>` : "";
      $("#dlgBody").innerHTML = `<p>This copy of DAStastic is licensed to <b>${esc(lic.licensee)}</b>.</p><table>${row("Licence", lic.id)}${row("Licensee", lic.licensee)}
        ${row("Contact", lic.contact)}${row("Email", lic.email)}${row("Kind", lic.kind)}${row("Issued", lic.issued)}${row("Ends", lic.ends)}
        ${row("Website", lic.website)}</table><p class="hint">Its logins, jobs, contacts and settings are its own. Licensed by Omnyra.</p>`;
      $("#dlg").showModal();
    };
    const anchor = $("#netChip");
    if (anchor) anchor.before(b);
  }

  // ------------------------------------------------------------ boot: called with /api/me (mission.js missionBoot)
  window.phoneBoot = function (me) {
    if (!me) return;
    S.licence = me.licence || null;
    licenceChip(S.licence);
    if (S.licence && S.licence.palette) S.palette = S.licence.palette;
    if (!me.phone || $("#phoneChip")) return;
    const b = document.createElement("button");
    b.className = "hbtn"; b.id = "phoneChip"; b.setAttribute("aria-haspopup", "dialog"); b.setAttribute("aria-expanded", "false");
    b.title = "Phone: texts and calls, and email";
    b.innerHTML = `${icon("phone", 14)} <span>Phone</span> <b class="ph-badge" id="phBadge" hidden></b>`;
    b.onclick = () => (S.win && !S.win.hidden ? close() : openWin());
    const anchor = $("#netChip");
    if (anchor) anchor.before(b);
  };

  // ------------------------------------------------------------ the window
  const VIEWS = [["texts", "Texts", "chat"], ["calls", "Calls", "phone"], ["keypad", "Keypad", "keypad"], ["contacts", "Contacts", "contacts"],
                 ["receptionist", "Receptionist", "sparkle"]];

  function build() {
    const w = document.createElement("div");
    w.id = "phWin"; w.className = "ph"; w.tabIndex = -1; w.setAttribute("role", "dialog"); w.setAttribute("aria-label", `${business()} Phone`); w.hidden = true;
    if (S.palette) for (const [k, v] of Object.entries(S.palette)) w.style.setProperty(`--ph-${k}`, v);
    w.innerHTML = `
      <div class="ph-top" id="phDrag">
        <span class="ph-brand"><span class="ph-logo">${icon("bars", 17)}</span><span class="ph-name">${esc(business())} <span>Phone</span></span></span>
        <span class="ph-line" id="phLine"></span>
        <span class="ph-status" id="phStatus"><span class="ph-pip"></span><span></span></span>
        <span class="ph-grow"></span>
        <button class="ph-ghost ph-small" id="phMail" title="Open Gmail in a new tab">${icon("mail", 16)} Gmail</button>
        <button class="ph-icon" id="phClose" aria-label="Close the phone">${icon("x", 18)}</button>
      </div>
      <div class="ph-rail" role="navigation" aria-label="Phone sections">${VIEWS.map(([v, t, i]) => `<button class="ph-nav" data-v="${v}">${icon(i)}<span>${t}</span>${v === "texts" ? '<span class="ph-count" id="phUnread" hidden></span>' : ""}</button>`).join("")}</div>
      <div class="ph-stage" id="phStage" aria-live="polite"></div>
      <div class="ph-toast" id="phToast" role="status" hidden></div>`;
    document.body.appendChild(w);
    $("#phClose", w).onclick = close;
    $("#phMail", w).onclick = () => window.open(GMAIL, "_blank", "noopener,noreferrer");
    w.querySelectorAll(".ph-nav").forEach(b => b.onclick = () => { S.view = b.dataset.v; S.open = ""; draw(); refresh(); });
    w.addEventListener("keydown", e => { if (e.key === "Escape" && !e.target.closest("textarea, input")) { e.stopPropagation(); close(); } });
    drag(w, $("#phDrag", w));
    return w;
  }

  function drag(w, handle) {  // move the window by its top bar; it stays on screen
    handle.addEventListener("pointerdown", e => {
      if (e.target.closest("button") || matchMedia("(max-width: 760px)").matches) return;
      const r = w.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      handle.setPointerCapture(e.pointerId);
      const move = ev => {
        w.style.left = Math.max(0, Math.min(innerWidth - 120, ev.clientX - dx)) + "px";
        w.style.top = Math.max(0, Math.min(innerHeight - 60, ev.clientY - dy)) + "px";
        w.style.right = "auto"; w.style.bottom = "auto";
      };
      const up = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); };
      handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", up);
    });
  }

  async function openWin() {
    S.win = S.win || build();
    S.win.hidden = false;
    $("#phoneChip")?.setAttribute("aria-expanded", "true");
    try { S.conf = await api("/api/phone"); if (S.conf.licence) S.licence = S.conf.licence; } catch (e) { S.conf = {ready: false, error: e.message}; }
    head();
    draw();
    try { S.contacts = (await api("/api/phone/contacts")).contacts || []; } catch (e) { S.contacts = []; }
    await refresh();
    clearInterval(S.timer);
    S.timer = setInterval(() => { if (!document.hidden && S.win && !S.win.hidden) refresh(true); }, EVERY_MS);
    S.win.focus();  // the window takes focus (Tab reaches the rail); a ring on Texts would read as a selection
  }

  function close() {
    if (!S.win) return;
    S.win.hidden = true;
    clearInterval(S.timer);
    $("#phoneChip")?.setAttribute("aria-expanded", "false");
    $("#phoneChip")?.focus();
  }

  function head() {
    const c = S.conf || {};
    $("#phLine", S.win).textContent = c.line ? fmt(c.line) : "";
    const st = $("#phStatus", S.win);
    st.className = "ph-status" + (c.ready ? " ph-ok" : "");
    st.lastElementChild.textContent = c.ready ? (c.fake ? "Ready (test copy)" : "Ready") : "Not set up";
    st.title = c.ready ? "Texts go through the Omnyra SDR campaign, to the demo list's numbers only" : (c.error || "The phone isn't set up on this copy");
  }

  function toast(msg, bad) {
    const t = $("#phToast", S.win);
    t.textContent = msg; t.className = "ph-toast" + (bad ? " ph-bad" : ""); t.hidden = false;
    clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3000);
  }

  async function refresh(quiet) {
    if (!S.conf || !S.conf.ready || S.busy) return;
    try {
      if (S.view === "texts") {
        S.threads = (await api("/api/phone/threads")).threads || [];
        if (S.open) { S.convo = (await api("/api/phone/thread?n=" + encodeURIComponent(S.open))).messages || []; if (S.convo.length) markSeen(S.open, S.convo[S.convo.length - 1].at); }
      } else if (S.view === "calls") {
        S.calls = (await api("/api/phone/calls")).calls || [];
      } else if (!quiet) {
        S.threads = (await api("/api/phone/threads")).threads || [];
      }
      if (quiet && S.win.contains(document.activeElement) && document.activeElement.matches("textarea, input")) { badge(); return paneUpdate(); }
      draw();
    } catch (e) {
      if (!quiet) toast(e.message, true);
    }
  }

  function badge() {
    const n = S.threads.reduce((a, t) => a + unreadOf(t), 0);
    const u = $("#phUnread", S.win); if (u) { u.textContent = n; u.hidden = !n; }
    const b = $("#phBadge"); if (b) { b.textContent = n; b.hidden = !n; }
  }

  function paneUpdate() {  // while you type, only the bubbles and the list redraw, so the box keeps its text and focus
    if (S.view !== "texts") return;
    const list = $("#phRows", S.win); if (list) list.innerHTML = threadRows();
    const bub = $("#phBubbles", S.win); if (bub) { const atEnd = bub.scrollHeight - bub.scrollTop - bub.clientHeight < 40; bub.innerHTML = bubbles(); if (atEnd) bub.scrollTop = bub.scrollHeight; }
  }

  function draw() {
    if (!S.win) return;
    S.win.querySelectorAll(".ph-nav").forEach(b => { const on = b.dataset.v === S.view; b.classList.toggle("ph-on", on); on ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"); });
    badge();
    const st = $("#phStage", S.win);
    if (S.view === "receptionist") { st.innerHTML = receptionist(); return; }
    if (!S.conf || !S.conf.ready) {
      st.innerHTML = `<div class="ph-empty">${icon("phone", 34)}<p>The phone isn't set up on this copy.</p><p class="ph-muted ph-sm">${esc((S.conf && S.conf.error) || "Cody sets it up on the server: the line, the Omnyra SDR campaign and the demo list.")}</p></div>`;
      return;
    }
    st.innerHTML = S.view === "texts" ? texts() : S.view === "calls" ? callsView() : S.view === "keypad" ? keypad() : contactsView();
    wire(st);
    const bub = $("#phBubbles", st); if (bub) bub.scrollTop = bub.scrollHeight;
  }

  // ------------------------------------------------------------ Texts
  function threadRows() {
    const q = S.q.trim().toLowerCase();
    const rows = S.threads.filter(t => !q || label(t.other).toLowerCase().includes(q) || t.other.includes(q.replace(/\D/g, "") || "~"));
    if (!rows.length) return `<li class="ph-hint">${S.threads.length ? "No conversation matches." : "No texts with the demo list yet. Start one with New."}</li>`;
    return rows.map(t => ({t, u: unreadOf(t)})).map(({t, u}) => `<li><button class="ph-row${S.open === t.other ? " ph-on" : ""}${u ? " ph-unread" : ""}" data-open="${esc(t.other)}">
      <span class="ph-lead">${avatar(nameOf(t.other), t.other)}</span>
      <span class="ph-body"><span class="ph-title">${esc(label(t.other))}</span><span class="ph-detail">${t.last.dir === "out" ? "You: " : ""}${esc(t.last.body)}</span></span>
      <span class="ph-when">${ago(t.last.at)}${u ? `<span class="ph-count">${u}</span>` : ""}</span></button></li>`).join("");
  }
  function bubbles() {
    if (!S.convo.length) return `<p class="ph-muted ph-sm ph-center">No messages yet. Say hello.</p>`;
    return S.convo.map(m => `<div class="ph-bubble ${m.dir === "out" ? "ph-out" : "ph-in"}"><span class="ph-text">${esc(m.body)}</span>
      <span class="ph-meta">${stamp(m.at)}${m.dir === "out" ? " · " + esc(m.status) : ""}</span>${m.error ? `<span class="ph-err">Twilio error ${esc(m.error)}</span>` : ""}</div>`).join("");
  }
  function suggest() {
    const allow = (S.conf.allow || []);
    const q = S.q.trim().toLowerCase(), digits = q.replace(/\D/g, "");
    const people = allow.map(n => ({phone: n, name: nameOf(n)})).filter(p => !q || p.name.toLowerCase().includes(q) || (digits && p.phone.includes(digits)));
    return `<ul class="ph-rows">${people.map(p => `<li><button class="ph-row" data-start="${esc(p.phone)}"><span class="ph-lead">${avatar(p.name, p.phone)}</span>
      <span class="ph-body"><span class="ph-title">${esc(p.name || fmt(p.phone))}</span><span class="ph-detail">${p.name ? fmt(p.phone) : "On the demo list"}</span></span></button></li>`).join("")
      || `<li class="ph-hint">Texts go to the demo list's numbers only (the Omnyra SDR campaign carries staff and demo texts). None matches.</li>`}</ul>`;
  }
  function texts() {
    const open = S.open;
    return `<div class="ph-split${open ? " ph-has-detail" : ""}">
      <div class="ph-pane ph-list" role="region" aria-label="Conversations">
        <div class="ph-pane-head"><div class="ph-titles"><p class="ph-eyebrow">${esc(fmt(S.conf.line))}</p><h2>Texts</h2></div>
          <button class="ph-ghost ph-small" id="phNew">${icon("plus", 15)} New</button></div>
        <div class="ph-search">${icon("search", 16)}<input id="phQ" type="search" placeholder="${S.composing ? "Who to text" : "Search texts"}" aria-label="${S.composing ? "Who to text" : "Search texts"}" value="${esc(S.q)}" autocomplete="off"></div>
        ${S.composing ? suggest() : `<ul class="ph-rows" id="phRows">${threadRows()}</ul>`}
      </div>
      <div class="ph-pane ph-detailpane" role="region" aria-label="Conversation">
        ${open ? `<div class="ph-pane-head ph-convo-head"><button class="ph-icon ph-back" aria-label="Back to conversations" data-back>${icon("back")}</button>
            ${avatar(nameOf(open), open, "sm")}<span class="ph-who"><strong>${esc(label(open))}</strong>${nameOf(open) ? `<span class="ph-muted ph-sm">${fmt(open)}</span>` : ""}</span>
            <button class="ph-icon" title="Call via your cell" aria-label="Call ${esc(label(open))}" data-call="${esc(open)}">${icon("phone")}</button></div>
          <div class="ph-bubbles" id="phBubbles">${bubbles()}</div>
          <div class="ph-composer"><div class="ph-as">Sent as “${esc(business())} via Omnyra:” through the Omnyra SDR campaign</div>
            <div class="ph-compose-row"><textarea id="phDraft" rows="1" maxlength="560" placeholder="Text ${esc(label(open))}" aria-label="Message"></textarea>
            <button class="ph-send" id="phSend" aria-label="Send">${icon("send", 18)}</button></div></div>`
          : `<div class="ph-empty">${icon("chat", 34)}<p>Pick a conversation, or start a new one.</p></div>`}
      </div></div>`;
  }

  // ------------------------------------------------------------ Calls
  function callsView() {
    const match = c => S.callF === "all" || (S.callF === "missed" ? c.status === "missed" : c.dir === S.callF);
    const chips = [["all", "All"], ["missed", "Missed"], ["in", "Incoming"], ["out", "Outgoing"]];
    const rows = S.calls.filter(match);
    const line = c => c.dir === "in" ? (c.status === "answered" ? `Incoming, ${dur(c.seconds)}` : c.status === "missed" ? "Missed call" : "Incoming")
      : (c.status === "answered" ? `Outgoing, ${dur(c.seconds)}` : `Outgoing${c.status ? ", " + c.status.replace("-", " ") : ""}`);
    return `<div class="ph-view"><div class="ph-viewhead"><div class="ph-titles"><p class="ph-eyebrow">${esc(fmt(S.conf.line))}</p><h2>Calls</h2></div>
      <div class="ph-chips" role="group" aria-label="Show">${chips.map(([k, t]) => `<button class="ph-chip" aria-pressed="${S.callF === k}" data-f="${k}">${t}<span class="ph-n">${S.calls.filter(c => k === "all" || (k === "missed" ? c.status === "missed" : c.dir === k)).length}</span></button>`).join("")}</div></div>
      ${rows.length ? `<ul class="ph-rows ph-card">${rows.map(c => `<li><div class="ph-row-item"><span class="ph-row"><span class="ph-lead">${avatar(nameOf(c.other), c.other)}
        <span class="ph-kind${c.status === "missed" ? " ph-missed" : ""}">${icon(c.dir === "out" ? "phone-out" : c.status === "missed" ? "phone-missed" : "phone-in", 11)}</span></span>
        <span class="ph-body"><span class="ph-title${c.status === "missed" ? " ph-missed" : ""}">${esc(label(c.other))}</span><span class="ph-detail">${line(c)}</span></span>
        <span class="ph-when">${ago(c.at)}</span></span>
        <span class="ph-quick"><button class="ph-icon" title="Text" aria-label="Text ${esc(label(c.other))}" data-text="${esc(c.other)}">${icon("chat", 17)}</button>
        <button class="ph-icon" title="Call via your cell" aria-label="Call ${esc(label(c.other))}" data-call="${esc(c.other)}">${icon("phone", 17)}</button></span></div></li>`).join("")}</ul>`
        : `<div class="ph-empty">${icon("phone", 34)}<p>${S.calls.length ? "No calls with this filter." : "No calls with the demo list yet."}</p></div>`}</div>`;
  }

  // ------------------------------------------------------------ Keypad
  const KEYS = [["1", ""], ["2", "ABC"], ["3", "DEF"], ["4", "GHI"], ["5", "JKL"], ["6", "MNO"], ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"], ["*", ""], ["0", "+"], ["#", ""]];
  function keypad() {
    const cell = S.conf.cell;
    return `<div class="ph-view ph-keypad-view"><div class="ph-keypad">
      <div class="ph-titles ph-center"><p class="ph-eyebrow">Calling from · ${esc(fmt(S.conf.line))}</p><h2>Keypad</h2></div>
      <input id="phDial" class="ph-dial" inputmode="tel" placeholder="Name or number" aria-label="Number to call" value="${esc(S.dial)}" autocomplete="off">
      <div class="ph-matches" id="phMatches">${matches()}</div>
      <div class="ph-pad" role="group" aria-label="Dial pad">${KEYS.map(([k, sub]) => `<button class="ph-key" data-k="${k}" aria-label="${k}"><span class="ph-d">${k}</span><span class="ph-s">${sub || "&nbsp;"}</span></button>`).join("")}</div>
      <div class="ph-pad-actions"><span></span>
        <button class="ph-call" id="phCall" aria-label="Call via your cell" title="${cell ? `Rings your cell (${fmt(cell)}); answer and it dials, showing ${fmt(S.conf.line)}` : "Save your cell first"}">${icon("phone", 26)}</button>
        <button class="ph-icon ph-erase" id="phErase" aria-label="Delete a digit">${icon("erase", 22)}</button></div>
      <div class="ph-cellrow">${icon("cell", 16)} <label for="phCell" class="ph-muted ph-sm">Your cell</label>
        <input id="phCell" inputmode="tel" placeholder="(612) 555-0123" value="${esc(cell ? fmt(cell) : "")}" aria-describedby="phCellWhy">
        <button class="ph-ghost ph-small" id="phCellSave">${cell ? "Change" : "Save"}</button></div>
      <p class="ph-muted ph-sm ph-center" id="phCellWhy">Calls go via your cell: Twilio rings it, you answer, and it dials the number showing ${esc(fmt(S.conf.line))}. No microphone needed on this computer.</p>
    </div></div>`;
  }
  function matches() {
    const q = S.dial.trim().toLowerCase();
    if (q.length < 2 || !/[a-z]/.test(q)) return "";
    return S.contacts.filter(c => c.listed && (c.name.toLowerCase().includes(q) || c.org.toLowerCase().includes(q))).slice(0, 4)
      .map(c => `<button class="ph-match" data-pick="${esc(c.phone)}">${avatar(c.name, c.phone, "sm")} <span>${esc(c.name)}</span> <span class="ph-muted ph-sm">${fmt(c.phone)}</span></button>`).join("");
  }

  // ------------------------------------------------------------ Contacts
  function contactsView() {
    const allow = S.conf.allow || [];
    const known = new Set(S.contacts.map(c => c.phone));
    const extra = allow.filter(n => !known.has(n)).map(n => ({id: "n" + n, name: "", org: "On the demo list", phone: n, listed: true}));
    const list = [...S.contacts, ...extra].sort((a, b) => (b.listed - a.listed) || (a.name || a.phone).localeCompare(b.name || b.phone));
    return `<div class="ph-view"><div class="ph-viewhead"><div class="ph-titles"><p class="ph-eyebrow">DAS contacts with a number</p><h2>Contacts</h2></div></div>
      ${list.length ? `<ul class="ph-rows ph-card">${list.map(c => `<li><div class="ph-row-item${c.listed ? "" : " ph-off"}"><span class="ph-row"><span class="ph-lead">${avatar(c.name, c.phone)}</span>
        <span class="ph-body"><span class="ph-title">${esc(c.name || fmt(c.phone))}</span><span class="ph-detail">${esc([c.org, c.name ? fmt(c.phone) : ""].filter(Boolean).join(" · "))}${c.listed ? "" : " · not on the demo list"}</span></span></span>
        ${c.listed ? `<span class="ph-quick"><button class="ph-icon" title="Text" aria-label="Text ${esc(c.name || fmt(c.phone))}" data-text="${esc(c.phone)}">${icon("chat", 17)}</button>
        <button class="ph-icon" title="Call via your cell" aria-label="Call ${esc(c.name || fmt(c.phone))}" data-call="${esc(c.phone)}">${icon("phone", 17)}</button></span>` : ""}</div></li>`).join("")}</ul>`
        : `<div class="ph-empty">${icon("contacts", 34)}<p>No contacts with a phone number yet. Add them on a DAS job.</p></div>`}
      <p class="ph-muted ph-sm">Texts and calls reach the demo list's numbers only. The rest show here, greyed out.</p></div>`;
  }

  // ------------------------------------------------------------ AI receptionist: shown, not set up (Cody 11/8)
  function receptionist() {
    const b = business();
    return `<div class="ph-view"><div class="ph-viewhead"><div class="ph-titles"><p class="ph-eyebrow">${esc(b)} · main line</p><h2>AI receptionist</h2></div>
        <span class="ph-pill">Not set up</span></div>
      <div class="ph-rcard">
        <div class="ph-rhead">${avatar("A I", "receptionist", "lg")}<div><strong>Answers ${esc(b)}'s line, day and night</strong>
          <p class="ph-muted ph-sm">Greets every caller with the business's name, answers what it has been told, takes a message, and puts a live caller through to the right person's cell.</p></div></div>
        <div class="ph-rgrid">
          <label><span>Greeting</span><textarea rows="2" disabled>Thanks for calling ${esc(b)}. How can I help with your building's radio coverage today?</textarea></label>
          <label><span>Hours it hands calls to people</span><input disabled value="Mon to Fri, 7 AM to 6 PM"></label>
          <label><span>What it can answer</span><textarea rows="3" disabled>Public safety DAS and BDA systems, ERCES code questions, site surveys, annual retests, quotes and scheduling.</textarea></label>
          <label><span>Hands a live caller to</span><input disabled value="The on-call tech's cell"></label>
          <label><span>After hours</span><input disabled value="Takes a message and texts it to the team"></label>
          <label><span>Voice</span><input disabled value="Warm, plain spoken"></label>
        </div>
        <div class="ph-ractions"><button class="ph-primary" disabled>${icon("sparkle", 16)} Set up the receptionist</button>
          <span class="ph-muted ph-sm">Not connected to the line yet. Nothing here answers calls.</span></div>
      </div></div>`;
  }

  // ------------------------------------------------------------ actions
  function startThread(n) { S.view = "texts"; S.open = n; S.composing = false; S.q = ""; S.convo = []; draw(); refresh(); setTimeout(() => $("#phDraft", S.win)?.focus(), 30); }

  async function callNumber(n) {
    if (!S.conf.cell) { S.view = "keypad"; S.dial = fmt(n); draw(); toast("Save your cell first: Twilio rings it, then dials.", true); $("#phCell", S.win)?.focus(); return; }
    try {
      S.busy = true;
      const r = await api("/api/phone/call", {to: n});
      toast(`Ringing your cell (${fmt(r.cell)}). Answer and it dials ${label(r.to)}.`);
    } catch (e) { toast(e.message, true); } finally { S.busy = false; }
  }

  function wire(st) {
    st.querySelectorAll("[data-open]").forEach(b => b.onclick = () => { S.open = b.dataset.open; S.convo = []; draw(); refresh(); });
    st.querySelectorAll("[data-start]").forEach(b => b.onclick = () => startThread(b.dataset.start));
    st.querySelectorAll("[data-text]").forEach(b => b.onclick = () => startThread(b.dataset.text));
    st.querySelectorAll("[data-call]").forEach(b => b.onclick = () => callNumber(b.dataset.call));
    st.querySelectorAll("[data-f]").forEach(b => b.onclick = () => { S.callF = b.dataset.f; draw(); });
    const back = $("[data-back]", st); if (back) back.onclick = () => { S.open = ""; draw(); };
    const nw = $("#phNew", st); if (nw) nw.onclick = () => { S.composing = !S.composing; S.q = ""; draw(); $("#phQ", S.win)?.focus(); };
    const q = $("#phQ", st);
    if (q) q.oninput = () => {
      S.q = q.value;
      if (S.composing) { const n = e164(q.value); const box = q.closest(".ph-list"); box.querySelector(".ph-rows").outerHTML = suggest(); wire(box);
        if (n && (S.conf.allow || []).includes(n)) startThread(n); }
      else { $("#phRows", S.win).innerHTML = threadRows(); wire($("#phRows", S.win)); }
    };
    const draft = $("#phDraft", st), send = $("#phSend", st);
    if (draft) {
      const grow = () => { draft.style.height = "auto"; draft.style.height = Math.min(140, draft.scrollHeight) + "px"; };
      draft.oninput = grow;
      draft.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send.click(); } };
      send.onclick = async () => {
        const body = draft.value.trim(); if (!body) return;
        send.disabled = true; S.busy = true;
        try {
          await api("/api/phone/text", {to: S.open, body});
          draft.value = ""; grow();
          S.convo.push({sid: "pending", dir: "out", body: `${business()} via Omnyra: ${body}`, status: "sending", at: new Date().toISOString()});
          const bub = $("#phBubbles", S.win); if (bub) { bub.innerHTML = bubbles(); bub.scrollTop = bub.scrollHeight; }
        } catch (e) { toast(e.message, true); }
        finally { send.disabled = false; S.busy = false; setTimeout(() => refresh(true), 1500); }
      };
    }
    const dial = $("#phDial", st);
    if (dial) {
      const pick = () => st.querySelectorAll("[data-pick]").forEach(b => b.onclick = () => { S.dial = fmt(b.dataset.pick); dial.value = S.dial; $("#phMatches", st).innerHTML = ""; });
      dial.oninput = () => { S.dial = dial.value; $("#phMatches", st).innerHTML = matches(); pick(); };
      dial.onkeydown = e => { if (e.key === "Enter") $("#phCall", st).click(); };
      st.querySelectorAll("[data-k]").forEach(b => b.onclick = () => { S.dial += b.dataset.k; dial.value = S.dial; dial.oninput(); });
      $("#phErase", st).onclick = () => { S.dial = S.dial.slice(0, -1); dial.value = S.dial; dial.oninput(); };
      $("#phCall", st).onclick = () => {
        const letters = /[a-z]/i.test(S.dial);
        const n = letters ? (S.contacts.find(c => c.listed && c.name.toLowerCase().includes(S.dial.trim().toLowerCase())) || {}).phone : e164(S.dial);
        if (!n) return toast("Type a 10-digit number, or a name on the demo list.", true);
        callNumber(n);
      };
      $("#phCellSave", st).onclick = async () => {
        try { const r = await api("/api/phone/cell", {cell: $("#phCell", st).value}); S.conf.cell = r.cell; toast(r.cell ? `Saved: calls ring ${fmt(r.cell)} first.` : "Cell cleared."); draw(); }
        catch (e) { toast(e.message, true); }
      };
    }
  }
})();
