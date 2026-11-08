"use strict";
/* DAStastic (beta): the Note button, on every screen of the PC version, the web version and DAStastic lite.
   Five ways to leave a note: a voice note; the screen recorded while you talk and point; a photo with a voice note;
   a photo with words; just words. Each note carries when, which screen, the pin or GPS position and the mission.
   Where notes go: on a PC (and from the PC's remote link) to the server (notes.py: a folder per note, in Drive);
   in the web version and lite, this browser's storage, with Share to send one to Cody.
   Standalone (no other DAStastic script needed), so the phone app loads it too.
     RFNotes.mount({store: "server" | "browser", context: () => ({screen, lat, lon, mission, mission_id}), bottom, z}) */
(() => {
const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const ICON = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>',
  screen: '<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8 20.5h8M12 16.5v4"/><path d="m11 8 4.5 2-2 .7-.8 2z" fill="currentColor"/>',
  cam: '<path d="M3.5 8.5h3.2L8.5 6h7l1.8 2.5h3.2v10.5h-17z"/><circle cx="12" cy="13.5" r="3.4"/>',
  pen: '<path d="M12 20h8.5"/><path d="M16.5 3.6a2.1 2.1 0 0 1 3 3L7.2 18.9l-4 1 1-4z"/>',
  note: '<path d="M5 3.5h10l4 4V20.5H5z"/><path d="M14.5 3.5v4.5H19M8.5 12h7M8.5 15.5h5"/>'};
const svg = (k, s = 22) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
const TILES = [
  ["voice", ["mic"], "Voice note", "Talk. Press Stop when you're done."],
  ["screen", ["screen", "mic"], "Record the screen", "Talk and point while it records this screen."],
  ["photo-voice", ["cam", "mic"], "Photo + voice note", "Snap something, then say what it is."],
  ["photo-text", ["cam", "pen"], "Photo + written note", "Snap something, then type about it."],
  ["text", ["pen"], "Written note", "Just type."]];
const KIND_LABEL = {voice: "Voice note", screen: "Screen recording", "photo-voice": "Photo + voice note", "photo-text": "Photo + written note",
  text: "Written note"};  // a saved note's kind, as notes.py KINDS names it
// Send email now: the note goes to DAStastic's note mailer (app/mail/notes_mailer.gs, a Google Apps Script under Cody's
// account), which numbers it, has Claude name it, and emails Cody. Each person's send code comes in their link (?send=)
// and is kept in this browser; the mailer checks it.
const MAIL_URL = window.RFR_MAIL_URL  // tests point this at a stand-in mailer
  || "https://script.google.com/macros/s/AKfycbxrBO08HXAxE4Oi2wb60eVnI0M7F6_7HSfiicosras--oG2SPkN7T8db4zMnjyqJdwlcA/exec";
const MAIL_MAX = 20 * 1024 * 1024;
const ls = {get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private window: asked again next time */ } }};
try {
  const u = new URL(location.href), c = u.searchParams.get("send");
  if (c) { ls.set("rfr.sendCode", c.trim().toUpperCase()); u.searchParams.delete("send"); history.replaceState(history.state, "", u.pathname + u.search + u.hash); }
} catch (e) { /* an odd address: the code can be typed instead */ }
const pick = list => (window.MediaRecorder && list.find(t => MediaRecorder.isTypeSupported(t))) || "";
const AUDIO = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];
const VIDEO = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
const extOf = t => /jpeg/.test(t) ? "jpg" : /png/.test(t) ? "png" : /webp/.test(t) ? "webp" : /heic/.test(t) ? "heic" : /ogg/.test(t) ? "ogg"
  : /mp4|m4a|aac/.test(t) ? (t.startsWith("audio") ? "m4a" : "mp4") : /quicktime/.test(t) ? "mov" : /mpeg/.test(t) ? "mp3" : /wav/.test(t) ? "wav" : "webm";
const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const canScreen = () => !!navigator.mediaDevices?.getDisplayMedia && !matchMedia("(pointer: coarse)").matches;
const touch = () => matchMedia("(pointer: coarse)").matches;

const CSS = `
.rfn-fab { position: fixed; right: 18px; bottom: var(--rfn-bottom, 18px); z-index: var(--rfn-z, 900); display: inline-flex; align-items: center; gap: 7px;
  height: 46px; padding: 0 18px 0 14px; border-radius: 999px; font: 600 15px/1 var(--font, system-ui), system-ui, sans-serif; color: var(--ink, #f4efe8);
  border: 1px solid var(--g-border, rgba(255,255,255,.15)); background: var(--g-strong, rgba(30,27,23,.92)); box-shadow: 0 8px 26px rgba(0,0,0,.35);
  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); cursor: pointer; transition: transform .35s cubic-bezier(.22,1,.36,1), background .2s ease; }
.rfn-fab:hover { transform: translateY(-2px); }
.rfn-fab svg { color: var(--accent, #f0a37a); }
.rfn-fab[hidden] { display: none; }
.rfn-dlg { width: min(560px, calc(100vw - 32px)); max-height: min(88vh, 900px); padding: 0; border-radius: 22px; color: var(--ink, #f4efe8);
  border: 1px solid var(--g-border, rgba(255,255,255,.15)); box-shadow: 0 24px 60px rgba(0,0,0,.5);
  background: linear-gradient(var(--g-strong, rgba(30,27,23,.92)), var(--g-strong, rgba(30,27,23,.92))), var(--surface, #1f1b17);  /* solid in every skin */
  font: 15px/1.45 var(--font, system-ui), system-ui, sans-serif; overflow: auto; }
.rfn-dlg::backdrop { background: rgba(0,0,0,.45); }
.rfn-dlg .rfn-h { display: flex; align-items: center; gap: 10px; padding: 16px 18px 6px; }
.rfn-dlg .rfn-h strong { font-size: 18px; flex: 1; }
.rfn-dlg .rfn-b { padding: 6px 18px 18px; }
.rfn-dlg .rfn-x { width: 36px; height: 36px; border-radius: 999px; border: 1px solid var(--g-border, rgba(255,255,255,.15)); background: none; color: inherit; font-size: 16px; cursor: pointer; }
.rfn-hint { color: var(--muted, #958c81); font-size: 13px; margin: 0 0 12px; }
.rfn-tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.rfn-tile { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; text-align: left; padding: 14px; min-height: 104px; border-radius: 16px;
  border: 1px solid var(--g-border, rgba(255,255,255,.15)); background: rgba(255,255,255,.04); color: inherit; font: inherit; cursor: pointer;
  transition: transform .35s cubic-bezier(.22,1,.36,1), background .2s ease, border-color .2s ease; }
.rfn-tile:hover:not(:disabled) { transform: translateY(-2px); border-color: var(--accent, #f0a37a); background: rgba(255,255,255,.07); }
.rfn-tile:disabled { opacity: .45; cursor: default; }
.rfn-tile .rfn-ic { display: flex; gap: 4px; color: var(--accent, #f0a37a); }
.rfn-tile b { font-size: 15px; }
.rfn-tile span { font-size: 12.5px; color: var(--ink-2, #c4bbaf); }
.rfn-tile.wide { grid-column: 1 / -1; min-height: 0; flex-direction: row; align-items: center; gap: 12px; }
.rfn-btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.rfn-btn { height: 44px; padding: 0 16px; border-radius: 999px; border: 1px solid var(--g-border, rgba(255,255,255,.15)); background: rgba(255,255,255,.05);
  color: inherit; font: 600 14px var(--font, system-ui), system-ui, sans-serif; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.rfn-btn.primary { background: var(--accent, #f0a37a); color: var(--accent-ink, #1a1310); border-color: transparent; }
.rfn-btn.stop { background: var(--critical, #e5534b); color: #fff; border-color: transparent; }
.rfn-btn.quiet { border-color: transparent; background: none; color: var(--ink-2, #c4bbaf); }
.rfn-btn.danger { color: var(--bad-ink, #f28b82); }
.rfn-rec { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 18px 0 6px; }
.rfn-dot { width: 18px; height: 18px; border-radius: 50%; background: var(--critical, #e5534b); animation: rfn-pulse 1.2s ease-in-out infinite; }
@keyframes rfn-pulse { 50% { opacity: .35; } }
.rfn-time { font: 600 34px/1 ui-monospace, monospace; }
.rfn-level { width: 70%; height: 8px; border-radius: 4px; background: var(--wash-2, rgba(127,127,127,.2)); overflow: hidden; }
.rfn-level i { display: block; height: 100%; width: 0; background: var(--good, #3ccf7a); transition: width .08s linear; }
.rfn-media img, .rfn-media video { display: block; max-width: 100%; max-height: 42vh; border-radius: 12px; margin: 0 auto 10px; background: #000; }
.rfn-media audio { width: 100%; margin-bottom: 10px; }
.rfn-dlg textarea { width: 100%; min-height: 96px; box-sizing: border-box; border-radius: 12px; padding: 10px 12px; font: 15px/1.4 inherit;
  color: inherit; background: rgba(255,255,255,.05); border: 1px solid var(--g-border, rgba(255,255,255,.15)); resize: vertical; }
.rfn-ctx { font-size: 12.5px; color: var(--muted, #958c81); margin-top: 6px; }
.rfn-err { color: var(--bad-ink, #f28b82); font-size: 14px; margin: 8px 0 0; }
.rfn-list { display: flex; flex-direction: column; gap: 10px; }
.rfn-item { border: 1px solid var(--g-border, rgba(255,255,255,.15)); border-radius: 14px; padding: 12px; }
.rfn-item .rfn-meta { font-size: 12.5px; color: var(--muted, #958c81); margin-bottom: 6px; }
.rfn-item p { margin: 0 0 8px; white-space: pre-wrap; }
.rfn-item img { max-width: 100%; max-height: 220px; border-radius: 10px; display: block; margin-bottom: 8px; }
.rfn-item video { max-width: 100%; max-height: 260px; border-radius: 10px; display: block; margin-bottom: 8px; background: #000; }
.rfn-item audio { width: 100%; margin-bottom: 8px; }
.rfn-item .rfn-btns { margin-top: 4px; }
.rfn-sent { display: inline-flex; align-items: center; height: 44px; padding: 0 4px; font-weight: 600; color: var(--good-ink, #1a7f37); }
.rfn-code { color: inherit; background: rgba(255,255,255,.05); border: 1px solid var(--g-border, rgba(255,255,255,.15)); font: 16px ui-monospace, monospace; }
.rfn-bar { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 2147483000; display: flex; align-items: center; gap: 12px;
  padding: 8px 8px 8px 16px; border-radius: 999px; color: #fff; background: rgba(20,18,16,.9); border: 1px solid rgba(255,255,255,.18);
  box-shadow: 0 10px 30px rgba(0,0,0,.45); font: 600 14px system-ui, sans-serif; }
.rfn-halo { position: fixed; left: 0; top: 0; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; pointer-events: none; z-index: 2147483001;
  border: 3px solid #ffcc33; background: rgba(255,204,51,.18); box-shadow: 0 0 0 2px rgba(0,0,0,.35); transition: opacity .2s ease; }
.rfn-ripple { position: fixed; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50%; border: 3px solid #ffcc33; pointer-events: none;
  z-index: 2147483001; animation: rfn-ripple .6s cubic-bezier(.22,1,.36,1) forwards; }
@keyframes rfn-ripple { to { transform: scale(4); opacity: 0; } }
@media (max-width: 640px) {
  .rfn-dlg { width: 100vw; max-width: 100vw; margin: auto 0 0; border-radius: 22px 22px 0 0; max-height: 92vh; padding-bottom: env(safe-area-inset-bottom, 0px); }
  .rfn-fab { right: 12px; height: 44px; padding: 0 15px 0 12px; }
}
@media (prefers-reduced-motion: reduce) { .rfn-dot { animation: none; } .rfn-tile, .rfn-fab { transition: none; } }
@media print { .rfn-fab, .rfn-bar, .rfn-halo { display: none !important; } }`;

/* ---------- the two stores: the PC's server (notes.py), or this browser (IndexedDB) ---------- */
const server = {
  async list() {
    const r = await fetch("/api/notes");
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  },
  async save(n) {
    const r = await fetch("/api/notes", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({kind: n.kind, text: n.text, transcript: n.transcript, screen: n.screen, lat: n.lat, lon: n.lon, mission: n.mission, mission_id: n.mission_id})});
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    for (const f of n.files) {
      const q = new URLSearchParams({role: f.role, ext: extOf(f.type)});
      if (f.secs) q.set("secs", Math.round(f.secs));
      const u = await fetch(`/api/notes/${j.id}/file?${q}`, {method: "POST", headers: {"Content-Type": "application/octet-stream"}, body: f.blob});
      if (!u.ok) throw new Error((await u.json().catch(() => ({}))).error || `The ${f.role} didn't save (${u.status}).`);
    }
    return j.id;
  },
  async remove(id) {
    const r = await fetch(`/api/notes/${id}/delete`, {method: "POST"});
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  },
  async blobs(n) { return Promise.all(n.files.map(async f => ({...f, blob: await (await fetch(f.url)).blob()}))); },
  sent: id => JSON.parse(ls.get(`rfr.sent.${location.host}.${id}`) || "null"),  // a note marked in this browser before 11/4
  async markSent(id, s) {  // on the note itself (notes.mark_sent), so another browser doesn't offer to send it again
    ls.set(`rfr.sent.${location.host}.${id}`, JSON.stringify(s));
    // the email already went: a mark that doesn't reach the server stays in this browser, and the send isn't undone
    try { await fetch(`/api/notes/${id}/sent`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(s)}); }
    catch (e) { console.warn("Note marked sent in this browser only:", e.message); }
  }};
const browser = {
  db: null,
  open() {
    return this.db || (this.db = new Promise((ok, no) => {
      const r = indexedDB.open("rfrecon-notes", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("notes", {keyPath: "id", autoIncrement: true});
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error || new Error("This browser won't keep notes (private window?)."));
    }));
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((ok, no) => {
      const t = db.transaction("notes", mode), req = fn(t.objectStore("notes"));
      t.oncomplete = () => ok(req?.result);
      t.onerror = t.onabort = () => no(t.error || new Error("This browser's storage is full. Share and delete some notes."));
    });
  },
  async list() {
    const all = (await this.tx("readonly", s => s.getAll())) || [];
    all.sort((a, b) => b.id - a.id);
    for (const n of all) n.files = n.files.map(f => ({...f, url: URL.createObjectURL(f.blob)}));
    return {notes: all, where: "browser"};
  },
  async save(n) {
    const ts = new Date();
    const rec = {ts: `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, "0")}-${String(ts.getDate()).padStart(2, "0")} ${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}`,
      kind: n.kind, label: KIND_LABEL[n.kind] || "Note", text: n.text, transcript: n.transcript || "", screen: n.screen, lat: n.lat, lon: n.lon, mission: n.mission, who: "",
      files: n.files.map((f, i, all, k = all.filter((g, j) => j < i && g.role === f.role).length) => ({name: `${f.role}${k ? " " + (k + 1) : ""}.${extOf(f.type)}`,
        role: f.role, type: f.type, secs: f.secs ? Math.round(f.secs) : undefined, blob: f.blob}))};
    return this.tx("readwrite", s => s.add(rec));
  },
  remove(id) { return this.tx("readwrite", s => s.delete(id)); },
  async blobs(n) { return n.files; },
  sent: () => null,  // kept on the note itself (n.sent)
  async markSent(id, s) {
    const rec = await this.tx("readonly", st => st.get(id));
    if (rec) { rec.sent = s; await this.tx("readwrite", st => st.put(rec)); }
  }};

/* ---------- capture: microphone, screen, camera ---------- */
let live = [];  // every stream and timer in use, stopped together
function stopLive() {
  for (const x of live) { try { x.stop ? x.stop() : x.getTracks ? x.getTracks().forEach(t => t.stop()) : clearInterval(x); } catch (e) { /* already stopped */ } }
  live = [];
}
// what's said while a voice note or the screen records, written down by the browser's own speech recognition (free;
// Chrome sends the audio to Google for it, Safari does it on the device); a note without it still sends
function listen() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let text = "", on = true, rec, ended;
  const done = new Promise(ok => { ended = ok; });
  if (!SR) return {stop: async () => ""};
  try {
    rec = new SR();
    rec.continuous = true; rec.interimResults = false; rec.lang = navigator.language || "en-US";
    rec.onresult = e => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) text += e.results[i][0].transcript.trim() + " "; };
    rec.onerror = () => { /* no permission, no network, mic busy: the recording carries on */ };
    rec.onend = () => { if (on) { try { rec.start(); } catch (e) { ended(); } } else ended(); };  // it stops itself after a pause
    rec.start();
  } catch (e) { return {stop: async () => ""}; }
  return {stop: async () => { on = false; try { rec.stop(); } catch (e) { ended(); }
    await Promise.race([done, new Promise(ok => setTimeout(ok, 1500))]); return text.trim(); }};
}
const micWords = e => e?.name === "NotAllowedError" ? "DAStastic can't use the microphone. Allow it for this page (the icon at the left of the address bar, or the phone's browser settings), then try again."
  : e?.name === "NotFoundError" ? "This device has no microphone DAStastic can use." : `The microphone didn't start: ${e?.message || e}`;

function recorder(stream, types, onLevel) {
  const type = pick(types), rec = new MediaRecorder(stream, type ? {mimeType: type} : undefined), chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const t0 = Date.now();
  let meter = null;
  if (onLevel && stream.getAudioTracks().length && (window.AudioContext || window.webkitAudioContext)) {
    const ac = new (window.AudioContext || window.webkitAudioContext)(), an = ac.createAnalyser(), buf = new Uint8Array(512);
    ac.createMediaStreamSource(stream).connect(an);
    an.fftSize = 512;
    meter = setInterval(() => { an.getByteTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v - 128)); onLevel(Math.min(1, m / 90)); }, 80);
    live.push(meter, {stop: () => ac.close()});
  }
  const done = new Promise(ok => { rec.onstop = () => ok({blob: new Blob(chunks, {type: (rec.mimeType || type || chunks[0]?.type || "").split(";")[0] || "audio/webm"}), secs: (Date.now() - t0) / 1000}); });
  rec.start(1000);
  live.push({stop: () => rec.state !== "inactive" && rec.stop()});
  return {stop: () => { if (rec.state !== "inactive") rec.stop(); if (meter) clearInterval(meter); return done; }, t0};
}

async function shrink(file) {  // phone photos are 3-8 MB: 2560 px on the long side is plenty for a note
  try {
    const bmp = await createImageBitmap(file), k = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
    if (k === 1 && file.size < 2.5e6) return file;
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(ok => c.toBlob(b => ok(b || file), "image/jpeg", .85));
  } catch (e) { return file; }  // a format this browser can't draw (HEIC off Safari): kept as it came
}
function pickFile(capture, accept = "image/*") {
  return new Promise(ok => {
    const i = document.createElement("input");
    i.type = "file"; i.accept = accept;
    if (capture) i.setAttribute("capture", "environment");
    i.onchange = () => ok(i.files[0] || null);
    i.click();
  });
}

/* ---------- the button and the sheet ---------- */
let opts, dlg, draft, store, screenOn = false, recOn = false;
// something recorded, photographed or typed that isn't saved: a stray click or Esc doesn't throw it away
const dirty = () => recOn || !!(draft && (draft.files.length || (draft.text || "").trim()));
function mount(o) {
  opts = o; store = o.store === "server" ? server : browser;
  const st = document.createElement("style"); st.textContent = CSS; document.head.append(st);
  const fab = document.createElement("button");
  fab.type = "button"; fab.className = "rfn-fab"; fab.id = "noteFab";
  fab.title = "Leave a note: voice, screen, photo or words" + (touch() ? "" : " (N)");
  fab.innerHTML = `${svg("note", 20)}<span>Note</span>`;
  fab.onclick = () => open();
  document.body.append(fab);
  dlg = document.createElement("dialog");
  dlg.className = "rfn-dlg"; dlg.setAttribute("aria-label", "Leave a note");
  dlg.addEventListener("close", () => { if (!screenOn) { stopLive(); recOn = false; } });  // a screen recording goes on with the sheet shut
  dlg.addEventListener("cancel", e => { if (dirty()) e.preventDefault(); });
  dlg.addEventListener("click", e => { if (e.target === dlg && !dirty()) dlg.close(); });  // a click outside the sheet
  document.body.append(dlg);
  if (o.bottom) document.documentElement.style.setProperty("--rfn-bottom", o.bottom);
  if (o.z) document.documentElement.style.setProperty("--rfn-z", o.z);
  document.addEventListener("keydown", e => {
    if (e.key !== "n" && e.key !== "N" || e.ctrlKey || e.metaKey || e.altKey || dlg.open) return;
    // typing somewhere: keys.js says where (one rule for every shortcut); the phone app, without keys.js, asks here
    if (window.RFKeys ? RFKeys.typing() : /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "") || document.activeElement?.isContentEditable) return;
    if (document.querySelector("dialog[open]")) return;
    e.preventDefault(); open();
  });
}
// Chrome's recordings carry no length, so the player shows none and can't seek: a jump to the end finds it, then back
function fixLength(el) {
  el.addEventListener("loadedmetadata", () => {
    if (el.duration !== Infinity) return;
    el.ontimeupdate = () => { el.ontimeupdate = null; el.currentTime = 0; };
    el.currentTime = 1e101;
  }, {once: true});
}
function show(title, body, back) {
  dlg.innerHTML = `<div class="rfn-h">${back ? `<button class="rfn-x" data-act="back" title="Back" aria-label="Back">‹</button>` : ""}<strong>${h(title)}</strong>
    <button class="rfn-x" data-act="close" title="Close" aria-label="Close">✕</button></div><div class="rfn-b">${body}</div>`;
  dlg.querySelectorAll("audio, video").forEach(fixLength);
  dlg.querySelector("[data-act=close]").onclick = () => dlg.close();
  if (back) dlg.querySelector("[data-act=back]").onclick = back;
  if (!dlg.open) dlg.showModal();
}
const whereText = () => opts.store !== "server" ? "Kept in this browser on this device until you delete it. Share with Cody emails a note to him."
  : opts.remote ? "Goes straight to Cody's DAStastic. Only you and Cody see it." : "Saved on this PC, a folder each in RF Recon › notes in Drive.";
function context() {
  let c = {};
  try { c = opts.context?.() || {}; } catch (e) { /* the page isn't ready: a note without context */ }
  return c;
}
const ctxLine = c => [c.screen && `On ${c.screen}`, c.lat != null && c.lon != null && `${(+c.lat).toFixed(5)}, ${(+c.lon).toFixed(5)}`, c.mission && `Mission: ${c.mission}`].filter(Boolean).join(" · ");

async function open() {
  if (screenOn) return;  // the recording bar's Stop ends a screen recording
  stopLive(); recOn = false;
  if (opts.store === "server" && opts.remote == null) {  // signed in through a door? the note stays with the copy serving it (the server, or Cody's PC), and only theirs show
    try { const me = await (await fetch("/api/me")).json(); opts.remote = !!me.remote && me.role !== "admin"; } catch (e) { opts.remote = false; }
  }
  draft = {kind: null, text: "", files: [], ...context()};
  let count = "";
  try { const n = (await store.list()).notes.length; count = n ? ` (${n})` : ""; } catch (e) { /* listed when opened */ }
  show("Leave a note", `<p class="rfn-hint">${h(whereText())}</p>
    <div class="rfn-tiles">${TILES.map(([k, ic, t, sub]) => {
      const phone = k === "screen" && !canScreen();  // phones can't record a page: their own screen recorder, then the video here
      return `<button class="rfn-tile${k === "text" ? " wide" : ""}" data-k="${k}">
        <span class="rfn-ic">${ic.map(i => svg(i)).join("")}</span><span><b>${t}</b><br><span>${phone ? "Record with your phone's screen recorder, then pick the video here." : sub}</span></span></button>`;
    }).join("")}</div>
    <div class="rfn-btns"><button class="rfn-btn quiet" data-act="list">My notes${count}</button></div>`);
  dlg.querySelectorAll(".rfn-tile").forEach(b => b.onclick = () => start(b.dataset.k));
  dlg.querySelector("[data-act=list]").onclick = () => list();
}

function start(kind) {
  draft.kind = kind;
  if (kind === "voice") return voice();
  if (kind === "screen") return canScreen() ? screen() : phoneScreen();
  if (kind === "text") return compose(true);
  return photo(kind === "photo-voice" ? voice : () => compose(true));
}

async function voice() {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}}); }
  catch (e) { return compose(false, micWords(e)); }
  live.push(stream);
  const photoUrl = draft.files.find(f => f.role === "photo") && URL.createObjectURL(draft.files.find(f => f.role === "photo").blob);
  show("Recording your voice", `<div class="rfn-media">${photoUrl ? `<img src="${photoUrl}" alt="Your photo">` : ""}</div>
    <div class="rfn-rec"><div class="rfn-dot"></div><div class="rfn-time" id="rfnTime">0:00</div><div class="rfn-level"><i id="rfnLvl"></i></div>
    <div class="rfn-hint" style="margin:0">Talk now. Your words are recorded until you press Stop.</div></div>
    <div class="rfn-btns" style="justify-content:center"><button class="rfn-btn stop" data-act="stop">■ Stop</button><button class="rfn-btn quiet" data-act="cancel">Cancel</button></div>`);
  const lvl = dlg.querySelector("#rfnLvl"), tm = dlg.querySelector("#rfnTime");
  const r = recorder(stream, AUDIO, v => { lvl.style.width = `${Math.round(v * 100)}%`; }), ear = listen();
  recOn = true;
  const tick = setInterval(() => { tm.textContent = clock((Date.now() - r.t0) / 1000); }, 250);
  live.push(tick, ear);
  dlg.querySelector("[data-act=cancel]").onclick = () => { stopLive(); recOn = false; open(); };
  dlg.querySelector("[data-act=stop]").onclick = async () => {
    const [got, heard] = await Promise.all([r.stop(), ear.stop()]);
    stopLive(); recOn = false;
    draft.files.push({role: "voice", blob: got.blob, type: got.blob.type, secs: got.secs});
    if (heard) draft.transcript = [draft.transcript, heard].filter(Boolean).join(" ");
    compose(false);
  };
}

async function screen() {
  let disp, mic = null;
  try {
    disp = await navigator.mediaDevices.getDisplayMedia({video: {displaySurface: "browser", frameRate: 15}, audio: false,
      preferCurrentTab: true, selfBrowserSurface: "include", surfaceSwitching: "include"});
  } catch (e) { return; }  // they closed the picker: the sheet stays as it was
  try { mic = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}}); }
  catch (e) { /* recorded without a voice; said on the note */ }
  live.push(disp); if (mic) live.push(mic);
  screenOn = true;
  dlg.close();
  const both = new MediaStream([...disp.getVideoTracks(), ...(mic ? mic.getAudioTracks() : [])]);
  const r = recorder(both, VIDEO), ear = mic ? listen() : {stop: async () => ""};
  live.push(ear);
  const bar = document.createElement("div");
  bar.className = "rfn-bar";
  bar.innerHTML = `<span class="rfn-dot" style="width:12px;height:12px"></span><span id="rfnBarT">Recording screen${mic ? " and voice" : " (no microphone)"} 0:00</span>
    <button class="rfn-btn stop" style="height:36px">■ Stop</button>`;
  const halo = document.createElement("div");
  halo.className = "rfn-halo"; halo.style.opacity = "0";
  document.body.append(bar, halo);
  const move = e => { halo.style.opacity = "1"; halo.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`; };
  const down = e => { const p = document.createElement("div"); p.className = "rfn-ripple"; p.style.left = `${e.clientX}px`; p.style.top = `${e.clientY}px`; document.body.append(p); setTimeout(() => p.remove(), 700); };
  addEventListener("pointermove", move, true); addEventListener("pointerdown", down, true);
  const tick = setInterval(() => { bar.querySelector("#rfnBarT").textContent = `Recording screen${mic ? " and voice" : " (no microphone)"} ${clock((Date.now() - r.t0) / 1000)}`; }, 500);
  let ended = false;
  const finish = async () => {
    if (ended) return; ended = true;
    clearInterval(tick);
    removeEventListener("pointermove", move, true); removeEventListener("pointerdown", down, true);
    bar.remove(); halo.remove();
    const [got, heard] = await Promise.all([r.stop(), ear.stop()]);
    screenOn = false;
    stopLive();
    draft.files.push({role: "screen", blob: got.blob, type: got.blob.type, secs: got.secs});
    if (heard) draft.transcript = [draft.transcript, heard].filter(Boolean).join(" ");
    if (!mic) draft.text = "(Recorded without a microphone.) ";
    compose(false);
  };
  bar.querySelector("button").onclick = finish;
  disp.getVideoTracks()[0].addEventListener("ended", finish);  // the browser's own Stop sharing
}

function phoneScreen() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  show("Record the screen", `<ol style="margin:0 0 4px;padding-left:20px;line-height:1.6">
      <li>${ios ? "Open Control Center (swipe down from the top-right corner). Press and hold the Screen Recording button, turn the Microphone on so your voice is in it, then tap Start Recording. If the button isn't there, add it to Control Center first."
        : "Swipe down twice from the top of the screen and tap Screen record (Screen recorder on Samsung; if it isn't there, add it with the pencil). Choose to record sound from the microphone, then start."}</li>
      <li>Come back to DAStastic, show what you mean and talk about it.</li>
      <li>Stop the recording, then tap below and pick it.</li></ol>
    <div class="rfn-btns"><button class="rfn-btn primary" data-act="pick">Pick the video</button></div>`, () => open());
  dlg.querySelector("[data-act=pick]").onclick = async () => {
    const f = await pickFile(false, "video/*");
    if (!f) return;
    draft.files.push({role: "screen", blob: f, type: f.type || "video/mp4"});
    compose(false);
  };
}

async function photo(next) {
  let f = null;
  if (touch() || !navigator.mediaDevices?.getUserMedia) f = await pickFile(true);
  else f = await camera();
  if (!f) return draft.files.length ? compose(false) : open();  // went back, or no picture
  const b = await shrink(f);
  draft.files.push({role: "photo", blob: b, type: b.type || "image/jpeg"});
  next();
}

function camera() {  // a computer: its camera live, Snap; or a picture file; or a picture of this screen
  return new Promise(async ok => {
    let cam = null;
    try { cam = await navigator.mediaDevices.getUserMedia({video: {facingMode: "environment", width: {ideal: 1920}}}); live.push(cam); }
    catch (e) { /* no camera: the other two ways */ }
    show("Take a photo", `<div class="rfn-media">${cam ? '<video id="rfnCam" autoplay playsinline muted></video>' : '<p class="rfn-hint">No camera here. Choose a picture, or take one of this screen.</p>'}</div>
      <div class="rfn-btns" style="justify-content:center">${cam ? `<button class="rfn-btn primary" data-act="snap">${svg("cam", 18)} Snap</button>` : ""}
      <button class="rfn-btn" data-act="file">Choose a picture</button>${navigator.mediaDevices?.getDisplayMedia ? '<button class="rfn-btn" data-act="shot">Picture of this screen</button>' : ""}</div>`,
      () => { stopLive(); ok(undefined); });
    const v = dlg.querySelector("#rfnCam");
    if (v) v.srcObject = cam;
    const grab = (video, w, hgt) => new Promise(res => { const c = document.createElement("canvas"); c.width = w; c.height = hgt; c.getContext("2d").drawImage(video, 0, 0, w, hgt); c.toBlob(res, "image/jpeg", .9); });
    dlg.querySelector("[data-act=snap]")?.addEventListener("click", async () => { const b = await grab(v, v.videoWidth, v.videoHeight); stopLive(); ok(b); });
    dlg.querySelector("[data-act=file]").onclick = async () => { const f = await pickFile(false); if (f) { stopLive(); ok(f); } };
    dlg.querySelector("[data-act=shot]")?.addEventListener("click", async () => {
      let s;
      try { s = await navigator.mediaDevices.getDisplayMedia({video: {displaySurface: "browser"}, audio: false, preferCurrentTab: true, selfBrowserSurface: "include"}); }
      catch (e) { return; }
      const sv = document.createElement("video"); sv.muted = true; sv.srcObject = s; await sv.play();
      await new Promise(r => setTimeout(r, 300));
      const b = await grab(sv, sv.videoWidth, sv.videoHeight);
      s.getTracks().forEach(t => t.stop()); stopLive(); ok(b);
    });
  });
}

function compose(focusText, err) {
  const has = r => draft.files.some(f => f.role === r);
  const media = draft.files.map((f, i) => {
    const u = URL.createObjectURL(f.blob);
    return f.role === "photo" ? `<img src="${u}" alt="Photo ${i + 1}">` : f.role === "screen" ? `<video src="${u}" controls playsinline></video>` : `<audio src="${u}" controls></audio>`;
  }).join("");
  const c = ctxLine(draft);
  show(KIND_LABEL[draft.kind] || "Note", `<div class="rfn-media">${media}</div>
    <textarea id="rfnText" placeholder="${draft.files.length ? "Add words if you like (optional)" : "What do you want Cody to know?"}">${h(draft.text)}</textarea>
    ${draft.transcript ? `<div class="rfn-ctx">Heard: ${h(draft.transcript)}</div>` : ""}
    ${c ? `<div class="rfn-ctx">Saved with it: ${h(c)}</div>` : ""}
    ${err ? `<p class="rfn-err">${h(err)}</p>` : ""}
    <div class="rfn-btns"><button class="rfn-btn primary" data-act="save">Save note</button>
      <button class="rfn-btn" data-act="photo">${svg("cam", 18)} ${has("photo") ? "Another photo" : "Add a photo"}</button>
      ${has("voice") || has("screen") ? "" : `<button class="rfn-btn" data-act="voice">${svg("mic", 18)} Add your voice</button>`}
      <button class="rfn-btn quiet danger" data-act="discard">Discard</button></div>`);
  const ta = dlg.querySelector("#rfnText");
  ta.oninput = () => { draft.text = ta.value; };
  if (focusText) setTimeout(() => ta.focus(), 50);
  dlg.querySelector("[data-act=photo]").onclick = () => photo(() => compose(false));
  dlg.querySelector("[data-act=voice]")?.addEventListener("click", () => voice());
  dlg.querySelector("[data-act=discard]").onclick = () => { draft = null; dlg.close(); };
  dlg.querySelector("[data-act=save]").onclick = async e => {
    draft.text = ta.value.trim();
    if (!draft.text && !draft.files.length) { ta.focus(); ta.placeholder = "Type something first, or add a photo or your voice."; return; }
    if (!has("photo") && !has("voice") && !has("screen")) draft.kind = "text";
    else if (has("screen")) draft.kind = "screen";
    else if (has("photo")) draft.kind = has("voice") ? "photo-voice" : "photo-text";
    else draft.kind = "voice";
    e.target.disabled = true; e.target.textContent = "Saving…";
    try {
      const id = await store.save(draft);
      draft = null;
      saved(id);
    } catch (x) {
      e.target.disabled = false; e.target.textContent = "Save note";
      const p = dlg.querySelector(".rfn-err") || Object.assign(document.createElement("p"), {className: "rfn-err"});
      p.textContent = `Not saved: ${x.message}`; dlg.querySelector(".rfn-btns").before(p);
    }
  };
}

async function saved(id) {
  const n = opts.remote ? null : (await store.list().catch(() => ({notes: []}))).notes.find(x => x.id === id);
  show("Note saved", `<p>${h(opts.remote ? "Cody has it." : opts.store !== "server" ? "It's kept in this browser. Share it with Cody to email it to him." : "It's in RF Recon › notes, and under My notes here.")}</p>
    ${n ? sendBox(n) : ""}
    <div class="rfn-btns"><button class="rfn-btn" data-act="done">Done</button><button class="rfn-btn quiet" data-act="list">My notes</button></div>`);
  dlg.querySelector("[data-act=done]").onclick = () => dlg.close();
  dlg.querySelector("[data-act=list]").onclick = () => list();
  if (n) wireSend(dlg.querySelector(".rfn-send"), n);
}

/* ---------- Share with Cody: press once and it becomes Send email now; press that and the note goes, from this window ---------- */
const sentOf = n => n.sent || store.sent(n.id);
function sendBox(n) {
  const s = sentOf(n);
  return `<div class="rfn-send"><div class="rfn-btns" style="margin-top:6px">${s ? `<span class="rfn-sent">✓ Emailed to Cody · report #${s.report}</span>`
    : '<button class="rfn-btn primary" data-act="send">Share with Cody</button>'}
    <button class="rfn-btn quiet" data-act="other" ${s ? "" : "hidden"}>${s ? "Share again another way" : "Share another way"}</button></div><div class="rfn-sendmsg"></div></div>`;
}
const b64 = blob => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] || ""); r.onerror = () => no(r.error); r.readAsDataURL(blob); });
const appName = () => `${opts.store === "browser" ? (/\/full\//.test(location.pathname) ? "the web version" : "DAStastic lite") : "the PC version"} on ${
  /iPhone|iPad/.test(navigator.userAgent) ? "an iPhone or iPad" : /Android/.test(navigator.userAgent) ? "Android" : /Windows/.test(navigator.userAgent) ? "Windows" : /Mac/.test(navigator.userAgent) ? "a Mac" : "a computer"}`;
function wireSend(box, n) {
  const btn = box.querySelector("[data-act=send]"), other = box.querySelector("[data-act=other]"), msg = box.querySelector(".rfn-sendmsg");
  other.onclick = () => share(n);
  if (!btn) return;
  const say = (t, bad) => { msg.innerHTML = t ? `<p class="${bad ? "rfn-err" : "rfn-hint"}" style="margin:6px 0 0">${t}</p>` : ""; };
  btn.onclick = async () => {
    if (!MAIL_URL) return share(n);  // no mailer set up: the share sheet, as before
    if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = "Send email now"; other.hidden = false; return; }
    let code = ls.get("rfr.sendCode");
    if (!code) {
      // asked once per browser: a home-screen app on an iPhone keeps its own storage, so a code a link set in Safari
      // doesn't reach it, and the person types it here
      say(`<label style="display:block">Type your send code. Cody gave it to you with your DAStastic link; it looks like NAME-AB123.
        <input class="rfn-code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="NAME-AB123"
          style="display:block;width:100%;margin-top:4px;height:44px;border-radius:10px;padding:0 10px"></label>
        <div class="rfn-btns" style="margin-top:6px"><button class="rfn-btn primary" data-act="code">Use it and send</button>
          <button class="rfn-btn quiet" data-act="nocode">No code? Share another way</button></div>
        <p class="rfn-hint" style="margin:4px 0 0">It's asked once on this phone or computer.</p>`);
      msg.querySelector("[data-act=nocode]").onclick = () => share(n);
      const inp = msg.querySelector(".rfn-code"); inp.focus();
      inp.onkeydown = e => { if (e.key === "Enter") msg.querySelector("[data-act=code]").click(); };  // the phone keyboard's Go
      // a wrong code or no signal: said under the box, which stays, so it can be typed again
      const oops = t => { let p = msg.querySelector(".rfn-codeerr");
        if (!p) { p = Object.assign(document.createElement("p"), {className: "rfn-err rfn-codeerr"}); p.style.margin = "6px 0 0"; msg.append(p); }
        p.textContent = t; inp.focus(); inp.select(); };
      msg.querySelector("[data-act=code]").onclick = async () => {
        const c = inp.value.trim().toUpperCase(); if (!c) return inp.focus();
        try {
          const r = await (await fetch(MAIL_URL, {method: "POST", body: JSON.stringify({check: true, code: c})})).json();
          if (!r.ok) return oops(r.error);
          ls.set("rfr.sendCode", c); ls.set("rfr.sendName", r.name); btn.click();
        } catch (e) { oops("No connection to send it. Try again with signal, or Share another way."); }
      };
      return;
    }
    btn.disabled = true; btn.textContent = "Sending…"; say("");
    try {
      const files = await store.blobs(n);
      if (files.reduce((s, f) => s + (f.blob?.size || 0), 0) > MAIL_MAX) throw new Error("This note is too big to email (over 20 MB). Use Share another way.");
      const body = JSON.stringify({code, label: n.label || KIND_LABEL[n.kind] || "Note", kind: n.kind, ts: n.ts, screen: n.screen || "", lat: n.lat, lon: n.lon,
        mission: n.mission || "", text: n.text || "", transcript: n.transcript || "", app: appName(),
        files: await Promise.all(files.map(async f => ({name: `DAStastic note ${n.ts.replace(/:/g, "-")} ${f.name}`, type: f.type, b64: await b64(f.blob)})))});
      const r = await (await fetch(MAIL_URL, {method: "POST", body})).json();
      if (!r.ok) throw new Error(r.error || "It didn't send.");
      const s = {report: r.report, subject: r.subject, at: new Date().toISOString()};
      await store.markSent(n.id, s); n.sent = s;
      btn.outerHTML = `<span class="rfn-sent">✓ Emailed to Cody · report #${r.report}</span>`;
      other.textContent = "Share again another way";
      say(h(r.subject));
    } catch (e) {
      btn.disabled = false; btn.textContent = "Send email now";
      say(h(/fetch|network|Failed/i.test(e.message) ? "No connection to send it. Try again with signal, or Share another way." : e.message), true);
    }
  };
}

function noteTxt(n) {
  return [`DAStastic (beta): ${(n.label || KIND_LABEL[n.kind] || "note").toLowerCase()}`, `When: ${n.ts}`, n.screen && `Screen: ${n.screen}`,
    n.lat != null && n.lon != null && `Place: ${(+n.lat).toFixed(5)}, ${(+n.lon).toFixed(5)}  https://maps.google.com/?q=${(+n.lat).toFixed(5)},${(+n.lon).toFixed(5)}`,
    n.mission && `Mission: ${n.mission}`, "", n.text || "(no words)",
    ...(n.transcript ? ["", "What was said (the browser's own transcript, may have mistakes):", n.transcript] : [])].filter(x => x !== false && x != null).join("\n");
}
async function share(n) {  // the phone's share sheet (Messages, Gmail, Drive, ...); where there's none, the files are saved
  const stamp = n.ts.replace(/:/g, "-");
  const files = [new File([noteTxt(n)], `DAStastic note ${stamp}.txt`, {type: "text/plain"}),
    ...n.files.map(f => new File([f.blob], `DAStastic note ${stamp} ${f.name}`, {type: f.type}))];
  try {
    if (navigator.canShare?.({files})) { await navigator.share({files, title: `DAStastic note ${n.ts}`, text: n.text || ""}); return; }
  } catch (e) { if (e.name === "AbortError") return; }
  for (const f of files) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f); a.download = f.name; document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
  }
}

async function list() {
  let got;
  try { got = await store.list(); } catch (e) { return show("My notes", `<p class="rfn-err">${h(e.message)}</p>`, () => open()); }
  const ns = got.notes;
  show("My notes", `<p class="rfn-hint">${ns.length ? h(whereText()) : "No notes yet."}</p><div class="rfn-list">${ns.map(n => `<div class="rfn-item" data-id="${n.id}">
      <div class="rfn-meta">${h(n.ts)} · ${h(n.label || KIND_LABEL[n.kind] || "Note")}${n.who ? ` · from ${h(n.who)}` : ""}${ctxLine(n) ? ` · ${h(ctxLine(n))}` : ""}</div>
      ${n.files.map(f => f.role === "photo" ? `<img src="${f.url}" alt="Photo" loading="lazy">` : f.role === "screen" ? `<video src="${f.url}" controls playsinline preload="metadata"></video>`
        : `<audio src="${f.url}" controls preload="metadata"></audio>`).join("")}
      ${n.text ? `<p>${h(n.text)}</p>` : ""}${n.transcript ? `<p class="rfn-hint" style="margin:0 0 8px">Heard: ${h(n.transcript)}</p>` : ""}
      ${opts.remote ? "" : sendBox(n)}
      <div class="rfn-btns">${opts.remote ? "" : '<button class="rfn-btn quiet danger" data-act="del">Delete</button>'}</div></div>`).join("")}</div>`, () => open());
  dlg.querySelectorAll(".rfn-item").forEach(el => {
    const n = ns.find(x => String(x.id) === el.dataset.id);
    if (!opts.remote) wireSend(el.querySelector(".rfn-send"), n);
    const del = el.querySelector("[data-act=del]");
    if (del) del.onclick = async () => {
      if (del.dataset.sure !== "1") { del.dataset.sure = "1"; del.textContent = "Delete it? Press again"; setTimeout(() => { del.dataset.sure = ""; del.textContent = "Delete"; }, 4000); return; }
      try { await store.remove(n.id); el.remove(); } catch (e) { del.textContent = e.message; }
    };
  });
}

window.RFNotes = {mount, open};

// the PC version and the full web version (both from app/static): mounted here; DAStastic lite mounts it itself
if (document.getElementById("missionChip") && typeof S === "object") {
  mount({store: window.RFPack ? "browser" : "server", context: () => {
    const tab = document.querySelector(`#tabs [data-t="${S.tab}"]`)?.textContent?.trim();
    return {screen: tab ? `the ${tab} tab` : "", lat: S.center?.[0], lon: S.center?.[1], mission: S.mission?.name || "",
      mission_id: S.missionId || null};
  }});
}
})();
