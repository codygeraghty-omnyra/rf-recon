"use strict";
/* DAStastic — recording a survey on DAStastic for Android (Cody 11/12; plan 11/10 section 8, "the page loop"). Andy drives or
   walks his own sites with his Android: Record in the map's ▦ Survey menu, Stop when done, and the squares paint as he goes.
   Only where the app's bridge is (window.RFRadio, Android 1.3: startSurvey(ms), drain(), stop(), status()); on a computer the
   menu says recording needs the Android app. Not offered to a view-only login, nor on a copy with no server to keep a run.
   - The run is made first (POST /api/survey with the recording's own id, client_key, so a create whose answer was lost, or
     two at once, make one run): a refused run never starts the phone; with no signal it starts and the run is made later.
   - The loop: startSurvey(2000) (a reading every 2 s, GPS once a second), drain() every 5 s; each snapshot becomes readings
     (survey.js fromSnapshot: the primary, its legs and the neighbours at the snapshot's own GPS fix) and goes on the map at once.
   - Uploads: every batch is queued in this browser (IndexedDB) before it's sent, under its recording's own id, so a dead spot
     or no signal loses nothing; each tick sends everything waiting, merged up to 2,000 readings a request (POST
     /api/survey/append: a batch sent twice is kept once). Every request gives up after 20 s, as no signal does. Stop sends
     the rest and ends the run (POST /api/survey/stop); a recording that couldn't finish goes when the signal comes back, this
     visit, the next, or before the next Record, each recording on its own. A run the server refuses (403, 404, a 400) is never
     retried: its readings stay on the phone and the menu offers them as a CSV, or to discard them.
   - The bridge's log has one owner: Record waits while the DAS walk test logs, and the walk test while a survey records
     (daswalk.js asks RFSurveyRec.owns()).
   - The screen stays on (the app's own flag and the page's wake lock); it stops by itself at 15% battery unless charging.
   - The status line: time, readings, the serving cell, GPS accuracy, battery and uploads waiting, with Stop and Follow me.
     Stop's result, and an automatic stop's reason, are said on the map: whether every reading reached the server.
   - Follow me: off on a computer; on a phone it comes on with Record and pans only when the dot leaves the middle 60% of the
     part of the map a results sheet or side panel leaves free, to that part's middle (it never zooms); a drag or a pinch turns
     it off; while a square's viewer is open it waits. The dot is a plain marker that takes no clicks.
   RFSurveyRec.section(c) / wire(c, panel) for surveymap.js's menu, attach(c) for each map's survey; REC (the loop's timings)
   and state() for tests/ui_sweep.mjs's fake RFRadio; owns() for the walk test. */
(() => {
  if (!window.RFSurvey) return;
  const SV = window.RFSurvey;
  // batch: a request's most readings; minBatch: its least after timeouts, and a queued batch's size; retryMs: how often a stopped
  // recording still to finish is tried again while the page is open
  const REC = {interval: 2000, drainMs: 5000, batch: 2000, minBatch: 200, lowBattery: 15, timeoutMs: 20000, retryMs: 30000};
  const TOUCH = !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);
  const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const n0 = v => Number(v || 0).toLocaleString();
  const radio = () => { try{ return window.RFRadio && window.RFRadio.available() ? window.RFRadio : null; }catch(e){ return null; } };
  // DAStastic for Android 1.2 has the walk test's start() and no startSurvey(): its readings carry no GPS fix
  const OLD_APP = "Recording a survey needs DAStastic for Android 1.3 or newer (a GPS fix with every reading): this phone has an older one. Install the new version (Help › Android app).";
  const surveyApp = () => { try{ return typeof window.RFRadio.startSurvey === "function"; }catch(e){ return false; } };
  const bridge = (fn, ...a) => { try{ const v = window.RFRadio[fn](...a); return typeof v === "string" ? JSON.parse(v) : v; }catch(e){ return {error: "bridge", message: e.message}; } };
  // the bridge's log, and whose it is, from the bridge itself: only startSurvey turns its GPS on, so a log with GPS is a survey's
  // and one without is the DAS walk test's. This page's stored entries said "recording" for a log an app exit had ended, and
  // the page then took the walk's log for the survey's (review 11/12, round 2)
  const logging = () => { try{ return !!radio() && !!window.RFRadio.logging(); }catch(e){ return false; } };
  const surveyLog = () => { if (!logging() || !surveyApp()) return false; const st = bridge("status"); return !!(st && !st.error && st.gps_on); };
  const canPost = () => !window.RFSurveyMap || !RFSurveyMap.canPost || RFSurveyMap.canPost();
  // every request gives up after REC.timeoutMs: a stalled one on a weak signal held Stop (and every upload behind it) for minutes
  const post = async (url, body) => { const ctl = typeof AbortController === "function" ? new AbortController() : null, t = ctl ? setTimeout(() => ctl.abort(), REC.timeoutMs) : 0;
    try{ const r = await fetch(url, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body), ...(ctl ? {signal: ctl.signal} : {})});
      const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), {status: r.status}); return j; }
    catch(e){ if (e && e.name === "AbortError") throw Object.assign(new Error(`no answer in ${Math.round(REC.timeoutMs / 1000)} s`), {status: 0, timeout: true}); throw e; }
    finally{ clearTimeout(t); } };
  // refused for good (a view-only login, a job not shared, a run deleted, a request the server can't take): never retried. A
  // signed-out session (401), a timeout (408), too many (429) and no answer at all are tried again
  const final = e => e && e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status);
  const device = () => { const m = /Android [\d.]+; ([^;)]+?)(?: Build|\))/.exec(navigator.userAgent || ""); return `DAStastic for Android${m ? ` on ${m[1].trim()}` : ""}`; };
  const stamp = ms => { const d = new Date(ms), p = x => String(x).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  const dur = ms => { const s = Math.max(0, Math.round(ms / 1000)), p = x => String(x).padStart(2, "0"); return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`; };

  /* ---------- the queue: IndexedDB, or this page's memory where the browser has none ---------- */
  // q: batches {k, lid, rs}; meta: one per recording {lid, scope, run, runId, keep, site, t0, n, stopped, refused}
  const mem = {q: [], meta: new Map(), k: 0};
  let dbp = null;
  const db = () => dbp || (dbp = new Promise(ok => { try{ const r = indexedDB.open("rfr-survey", 2);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains("q")) d.createObjectStore("q", {keyPath: "k", autoIncrement: true});
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta", {keyPath: "lid"}); if (d.objectStoreNames.contains("rec")) d.deleteObjectStore("rec"); };
    r.onsuccess = () => ok(r.result); r.onerror = () => ok(null); r.onblocked = () => ok(null); }catch(e){ ok(null); /* no IndexedDB: this page's memory */ } }));
  const idb = async (store, mode, fn) => { const d = await db();
    return new Promise((ok, no) => { const t = d.transaction(store, mode), s = t.objectStore(store); let out; const r = fn(s); if (r && "onsuccess" in r) r.onsuccess = () => { out = r.result; }; t.oncomplete = () => ok(out); t.onerror = () => no(t.error); }); };
  const Q = {
    add: async (lid, rs) => { for (let i = 0; i < rs.length; i += REC.minBatch) { const part = rs.slice(i, i + REC.minBatch);
      if (!(await db())) { mem.q.push({k: ++mem.k, lid, rs: part}); continue; } await idb("q", "readwrite", s => s.add({lid, rs: part})); } },
    all: async lid => { const a = (await db()) ? (await idb("q", "readonly", s => s.getAll()) || []) : mem.q; return a.filter(x => !lid || x.lid === lid).sort((x, y) => x.k - y.k); },
    del: async ks => { if (!(await db())) { mem.q = mem.q.filter(x => !ks.includes(x.k)); return; } await idb("q", "readwrite", s => { for (const k of ks) s.delete(k); }); },
    metas: async () => (await db()) ? (await idb("meta", "readonly", s => s.getAll()) || []) : [...mem.meta.values()],
    put: async m => { if (!(await db())) { mem.meta.set(m.lid, m); return; } await idb("meta", "readwrite", s => s.put(m)); },
    drop: async lid => { if (!(await db())) { mem.meta.delete(lid); mem.q = mem.q.filter(x => x.lid !== lid); return; }
      await idb("q", "readwrite", s => { const c = s.openCursor(); c.onsuccess = () => { const x = c.result; if (!x) return; if (x.value.lid === lid) x.delete(); x.continue(); }; });
      await idb("meta", "readwrite", s => s.delete(lid)); }};
  const waitingOf = async lid => (await Q.all(lid)).reduce((s, b) => s + b.rs.length, 0);

  /* ---------- recordings: the one running (rec), and earlier ones still to finish ---------- */
  let rec = null, starting = false, cancelStart = false;
  let earlierN = 0, refusedList = [], unfinished = false;  // what the menu and the status line say about earlier recordings
  const stops = new Set();  // recordings whose Stop is still sending: each its own (one flag for all left a new one's Stop dead)
  const live = new Map();    // slot -> the map's survey now (a tab left and come back to makes its map again)
  const busy = new Set();    // recordings being finished now (Stop's, leftovers'): never two at once
  const cOf = () => rec && (live.get(rec.slot) || rec.c);
  const keepArgs = r => r.keep ? {keep_mi: 2, ...(r.scope.scope === "scratch" && r.site ? {lat: r.site[0], lon: r.site[1]} : {})} : {};
  const metaOf = r => ({lid: r.lid, scope: r.scope, run: {name: r.run.name, device: r.run.device, source: "android", started_at: r.t0}, runId: r.runId || null,
    keep: !!r.keep, site: r.site || null, t0: r.t0, n: r.n || 0, stopped: !!r.stopped, refused: r.refused || null, cap: r.cap || null});
  const fromMeta = m => ({lid: m.lid, scope: m.scope, run: {...m.run, id: m.runId || `rec:${m.t0}`}, runId: m.runId || null, keep: m.keep, site: m.site, t0: m.t0, n: m.n || 0,
    stopped: m.stopped, refused: m.refused, cap: m.cap || null});
  const save = r => Q.put(metaOf(r));
  // the run, once per recording: the recording's own id goes with it (survey.py client_key), so a lost answer or two creates at
  // once make one run. A refusal is final and kept with the recording
  function create(r){
    if (r.runId || r.refused) return Promise.resolve(r.runId);
    if (!r.creating) r.creating = (async () => {
      try{ const j = await post("/api/survey", {scope: r.scope.scope, scope_id: r.scope.id, name: r.run.name, source: "android", device: r.run.device, client_key: r.lid, ...keepArgs(r)});
        r.runId = j.id; r.run.created_by = j.created_by || ""; r.netMsg = ""; await save(r); }
      catch(e){ if (final(e)) { r.refused = e.message; await save(r); } else r.netMsg = "No signal: the readings wait on this phone and go when there's signal."; }
      finally{ r.creating = null; }
      return r.runId; })();
    return r.creating;
  }
  // everything this recording has waiting, oldest first, up to r.cap readings a request; false when some is still waiting. The
  // cap halves after a request that got no answer in time, down to REC.minBatch, and doubles back after one that did: 2,000
  // readings (about 530 KB) never finished inside the time limit on a weak uplink, and went again and again (review 11/12,
  // round 2)
  function send(r){
    if (r.sending) return r.sending;
    r.sending = (async () => {
      try{
        if (r.refused || !(await create(r))) return false;  // refused once is refused: never tried again (it was, every tick)
        let bs = await Q.all(r.lid), again = true;
        while (bs.length) {
          const cap = r.cap || REC.batch, take = []; let n = 0; for (const b of bs) { if (take.length && n + b.rs.length > cap) break; take.push(b); n += b.rs.length; }
          try{ await post("/api/survey/append", {scope: r.scope.scope, scope_id: r.scope.id, run: r.runId, readings: take.flatMap(b => b.rs)}); await Q.del(take.map(b => b.k)); r.netMsg = "";
            r.cap = Math.min(REC.batch, cap * 2); }
          catch(e){ if (final(e)) { r.refused = e.status === 404 ? "the run was deleted on the server" : e.message; await save(r); }
            else { r.netMsg = "No signal: the readings wait on this phone and go when there's signal.";
              // a request too big for the uplink: the next is half, kept with the recording (a retry pass rebuilt it at 2,000 and
              // timed out every time, review 11/12 round 3), and tried once more now, so a pass makes progress
              if (e.timeout && cap > REC.minBatch) { r.cap = Math.max(REC.minBatch, Math.floor(cap / 2)); await save(r); if (again) { again = false; continue; } } }
            return false; }
          // and what was added meanwhile: Stop's last readings came in while a tick's send was on its way, and the end went
          // without them
          bs = bs.slice(take.length); if (!bs.length) bs = await Q.all(r.lid);
        }
        return true;
      } finally { r.sending = null; } })();
    return r.sending;
  }
  // a stopped recording: everything sent, then its end; its meta goes once the server has it all
  async function finish(r){
    if (busy.has(r.lid)) return false; busy.add(r.lid);
    try{
      if (!r.runId && !(await waitingOf(r.lid))) { await Q.drop(r.lid); return true; }  // never made, nothing to send: no empty run made for it
      if (!(await send(r))) return false;
      try{ r.info = await post("/api/survey/stop", {scope: r.scope.scope, scope_id: r.scope.id, run: r.runId, ...keepArgs(r)}); }
      catch(e){ if (final(e)) { r.refused = e.status === 404 ? "the run was deleted on the server" : e.message; await save(r); } return false; }
      await Q.drop(r.lid); return true;
    } finally { busy.delete(r.lid); }
  }
  // earlier recordings still to finish: every one that's stopped, one pass at a time (an 'online' event, the page coming back,
  // a Record, the menu's Send now, and every REC.retryMs while one is left: with the phone on LTE the browser never says
  // 'online', and they waited for the next Record or visit, review 11/12 round 2)
  let lefting = null;
  function leftovers(){
    if (lefting) return lefting;
    lefting = (async () => { try{
      for (const m of await Q.metas()) { if ((rec && m.lid === rec.lid) || !m.stopped || m.refused || busy.has(m.lid)) continue; await finish(fromMeta(m)); }
    } finally { lefting = null; await earlier(); } })();
    return lefting;
  }
  // what the menu and the status line say about earlier recordings: readings still waiting, and runs the server refused
  async function earlier(){
    const ms = await Q.metas(), cur = rec && rec.lid; let n = 0; const bad = [];
    for (const m of ms) { if (m.lid === cur) continue; const w = await waitingOf(m.lid); if (m.refused) bad.push({...m, waiting: w}); else n += w; }
    earlierN = n; refusedList = bad; unfinished = ms.some(m => m.stopped && !m.refused && m.lid !== cur);
    for (const c of live.values()) if (c.paint) c.paint(); status();
  }

  async function start(c){
    if (rec || starting) return;
    const r0 = radio(); if (!r0) { c.msg = "Recording needs DAStastic for Android: on a computer, import a log instead."; return paint(c); }
    if (!surveyApp()) { c.msg = OLD_APP; return paint(c); }
    if (!canPost()) { c.msg = "A view-only login can't record a survey: ask whoever runs this copy."; return paint(c); }
    if (c.noServer) { c.msg = `This copy can't keep a survey run, so it doesn't record: ${c.noServer}`; return paint(c); }
    const s = c.scope(), site = c.site(), keep = !!c.kept.keep;
    if (keep && s.scope === "scratch" && !site) { c.msg = "\u201cKeep only what's within 2 mi of the site\u201d needs the site: pick an address first, or untick it."; return paint(c); }
    // the bridge's log has one owner: the DAS walk test's own log is never taken over (its readings go on its floor); a survey's
    // log this page lost track of (a reload) is picked up, its stored recording's if there is one, else as a new one
    const svLog = surveyLog();
    if (svLog) { c.msg = "The phone is still recording a survey this page lost track of: picking it up."; paint(c); await resume(c); if (rec) { c.msg = ""; return paint(c); } }
    else if (logging()) { c.msg = "The phone is already logging for the DAS walk test (DAS › the job › Grid test › Walk). Press Stop on that walk first (its readings go on its floor), then Record."; return paint(c); }
    const st = bridge("status");
    if (st && st.permission === "needed") { const a = bridge("read"); if (a && a.error) { c.msg = a.message || "Allow DAStastic to use location, then press Record again."; return paint(c); } }
    if (st && st.battery != null && st.battery <= REC.lowBattery && !st.charging) { c.msg = `The battery is at ${st.battery}%: plug the phone in to record (it stops by itself at ${REC.lowBattery}%).`; return paint(c); }
    starting = true; cancelStart = false; c.msg = "Starting: making the run on the server…"; paint(c);
    try{
      const t0 = Date.now(), lid = `r${t0}-${Math.random().toString(36).slice(2, 8)}`;
      const r = {lid, c, slot: c.slot, scope: s, run: {id: `rec:${t0}`, name: `Survey ${stamp(t0)}`, source: "android", device: device(), readings: 0, started_at: t0, created_by: "", recording: true},
        runId: null, t0, n: 0, last: null, acc: null, battery: st && st.battery, charging: !!(st && st.charging), waiting: 0, follow: TOUCH, keep, site, netMsg: ""};
      await create(r);  // no signal: it starts anyway, and the run is made later
      // nothing recorded yet: the recording kept for the create goes (it was listed as refused, with no readings, for good)
      if (r.refused) { await Q.drop(lid); c.msg = `Not recording: the server won't keep a run here (${r.refused}).`; return; }
      // stopped (the walk test's Stop the survey) while the run was being made: it never starts
      if (cancelStart) { await Q.drop(lid); if (r.runId) post("/api/survey/delete", {scope: s.scope, scope_id: s.id, run: r.runId}).catch(() => {}); c.msg = "Not recording: stopped before it started."; return; }
      const go = svLog ? {ok: true} : bridge("startSurvey", REC.interval);  // a survey log already on (a reload): it carries on into this one
      if (!go || go.error || go.ok === false) { c.msg = (go && go.message) || "The phone didn't start recording."; await Q.drop(lid);
        if (r.runId) post("/api/survey/delete", {scope: s.scope, scope_id: s.id, run: r.runId}).catch(() => {}); return; }
      rec = r; live.set(c.slot, c); await save(r);
      c.msg = ""; c.set(r.run, []);
      if (c.closePanel) c.closePanel();  // the map for the squares and the status line: on a phone the open menu covered half of it
      // and on a phone the legend folded (▸ opens it again): open, it left Follow me no room clear of it and the status line
      if (TOUCH && c.kept && c.kept.open) { c.kept.open = false; c.redraw(); }
      if (c.hideSay) c.hideSay();  // an earlier run's note ("Imported … Zoom to run") is about another run
      lock(true);
      rec.timer = setInterval(() => tick(), REC.drainMs);
      status(); leftovers();  // earlier recordings' readings go up meanwhile, and the status line says how many
    } finally { starting = false; paint(c); }
  }
  async function tick(final){
    const r = rec; if (!r) return;
    const snaps = bridge("drain"), got = [];
    if (Array.isArray(snaps)) for (const sn of snaps) { got.push(...SV.fromSnapshot(sn)); if (sn && sn.fix) r.fix = sn.fix;
      const p = (sn && sn.serving || []).find(x => !x.nsa && x.conn !== "secondary") || (sn && sn.serving || [])[0]; if (p) r.last = p; }
    if (got.length) { r.n += got.length; const c = cOf(); if (c && c.run === r.run) c.more(got); await Q.add(r.lid, got); await save(r); }
    const st = bridge("status");
    if (st && !st.error) { r.battery = st.battery ?? r.battery; r.charging = !!st.charging; r.acc = st.gps && st.gps.acc != null ? st.gps.acc : r.fix ? r.fix.acc : r.acc; }
    r.waiting = await waitingOf(r.lid);
    dot(); status();
    if (final || rec !== r) return;
    if (r.battery != null && r.battery <= REC.lowBattery && !r.charging) return stop(`Stopped by itself at ${r.battery}% battery, to leave the phone some: plug it in and press Record for more.`);
    // everything waiting goes, not one batch a tick: after a dead spot the backlog never caught up while recording
    send(r).then(async () => { if (rec === r) { r.waiting = await waitingOf(r.lid); status(); } });
  }
  // -> whether it stopped anything. A recording on this page; else a start still making its run (it won't start); else a survey
  // log the bridge is still running that this page has no recording of (a reload on the DAS tab: the walk test's Stop the survey
  // said "stopped" and nothing was, review 11/12 round 2), whose readings go with its stored recording
  async function stop(why){
    if (!rec) { if (starting) { cancelStart = true; return true; } return stopLog(); }
    if (rec.stopping) return false;
    const r = rec, c = cOf(); r.stopping = true; stops.add(r.lid);
    try{
      clearInterval(r.timer); bridge("stop");
      await tick(true);  // after stop() the bridge places the rest with the fixes there are and hands over everything
      lock(false); r.follow = false; rec = null; r.stopped = true; r.run.recording = false; await save(r);
      if (c && c.legFollow) { c.legFollow = 0; c.fitLegend(); }  // the legend's height back: Follow me is done with it
      if (c && c.hideSay) c.hideSay();
      status(); dot();
      if (c) c.say(`${why ? `${why} ` : ""}Sending the last readings…`, null, 25000);
      const ok = await finish(r), left = await waitingOf(r.lid);
      if (ok && r.info) Object.assign(r.run, r.info, {recording: false});
      // only the run's end still to come (every reading went, the end's answer didn't): said so, not "N wait" (review 11/12, round 2)
      const msg = `${why ? `${why} ` : ""}Recorded ${n0(r.n)} readings in ${dur(Date.now() - r.t0)}. ${ok ? "All on the server."
        : r.refused ? `The server refused them (${r.refused}): ${n0(left)} stay on this phone (▦ Survey offers them as a CSV).`
        : left ? `${n0(left)} wait on this phone and go up when there's signal (DAStastic tries again every ${Math.round(REC.retryMs / 1000)} s while it's open).`
        : `Every reading is on the server; the run's end is still to be confirmed, and goes when there's signal.`}`;
      if (c) { c.msg = msg; c.say(msg, null, ok ? 10000 : 30000); c.changed(); paint(c); if (c.list) c.list(); }
      return true;
    } finally { r.stopping = false; stops.delete(r.lid); earlier(); }
  }
  async function stopLog(){
    if (!surveyLog()) return false;
    bridge("stop"); const snaps = bridge("drain"), got = [];
    if (Array.isArray(snaps)) for (const sn of snaps) got.push(...SV.fromSnapshot(sn));
    const open = (await Q.metas()).filter(m => !m.stopped).sort((a, b) => b.t0 - a.t0);
    // no stored recording to put them with (this browser's storage cleared): a new one, this copy's, so they go up all the same
    if (!open.length && got.length) { const t0 = Date.now(), lid = `r${t0}-${Math.random().toString(36).slice(2, 8)}`;
      open.push({lid, scope: {scope: "scratch", id: 0, name: "this copy"}, run: {name: `Survey ${stamp(t0)} (picked up)`, device: device(), source: "android", started_at: t0},
        runId: null, keep: false, site: null, t0, n: 0, stopped: false, refused: null, cap: null}); }
    if (open[0] && got.length) await Q.add(open[0].lid, got);
    for (const m of open) await Q.put({...m, stopped: true, n: (m.n || 0) + (m === open[0] ? got.length : 0)});
    lock(false); leftovers(); return true;
  }
  // the page opened again while the app still records (reloaded, or Android took the page away): the loop picks up where it was,
  // on this page's first map, the count carried on; the app stopped meanwhile: that recording is stopped and finished
  // Whose the log is comes from the bridge (surveyLog): the walk's log (no GPS) never takes a stored recording, which is stopped and
  // finished instead (review 11/12, round 2: it drained the walk's readings and threw them away), and one the server refused is
  // picked up too, so its Stop works (it was neither picked up nor stopped, and nothing could stop the phone's log)
  async function resume(c0){
    if (rec) return;
    const ms = await Q.metas(), open = ms.filter(m => !m.stopped).sort((a, b) => b.t0 - a.t0);
    const svLog = surveyLog();
    const c = c0 || live.get("towers") || live.get("search") || [...live.values()][0];
    // the bridge still logging a survey and no survey map open (the tab left before this ran): the recording is left as it is,
    // and the next map that opens picks it up. It was marked stopped and finished, and the walk test's Stop the survey then had
    // nowhere to put the readings since the reload (review 11/12, round 3)
    if (svLog && !c && open.length) { looked = false; return; }
    const keep = svLog && c && open.length ? open[0] : null;
    for (const m of open) if (m !== keep) await Q.put({...m, stopped: true});
    if (keep && !rec) {
      const r = {...fromMeta(keep), c, slot: c.slot, last: null, acc: null, battery: null, charging: false, waiting: 0, follow: TOUCH, netMsg: "",
        msg: "Picked up again after the page reopened: the count carries on."};
      r.run.recording = true; rec = r;
      c.set(r.run, []); lock(true); r.timer = setInterval(() => tick(), REC.drainMs); status();
    }
    leftovers();
  }
  addEventListener("online", () => { if (rec) send(rec); leftovers(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && unfinished) leftovers(); });
  let lastTry = 0;
  setInterval(() => { if (unfinished && Date.now() - lastTry >= REC.retryMs) { lastTry = Date.now(); leftovers(); } }, 1000);
  let looked = false;
  // known before the first map: what waits from an earlier visit (the retry above sends it)
  earlier().catch(() => {});

  /* ---------- the screen stays on ---------- */
  let wl = null;
  async function lock(on){ try{ if (on && navigator.wakeLock && !wl) { wl = await navigator.wakeLock.request("screen"); wl.addEventListener?.("release", () => { wl = null; }); }
    if (!on && wl) { await wl.release(); wl = null; } }catch(e){ /* refused (battery saver): the app's own screen-on flag still holds */ } }
  document.addEventListener("visibilitychange", () => { if (rec && document.visibilityState === "visible") lock(true); });

  /* ---------- the dot and Follow me ---------- */
  // a plain marker that takes no clicks: a circleMarker in the marker pane made Leaflet put a canvas over the whole map there,
  // and it took every click meant for the Map tab's dots, during the recording and after (review 11/12)
  const meIcon = L.divIcon({className: "rf-sv-me", iconSize: [18, 18], iconAnchor: [9, 9], html: "<span></span>"});
  function dot(){
    for (const c of live.values()) { const m = c.map;
      if ((!rec || !rec.follow) && c.legFollow) { c.legFollow = 0; c.fitLegend(); }
      if (!rec || !rec.fix || cOf() !== c) { if (c._dot) { c._dot.remove(); c._dot = null; } continue; }
      const ll = L.latLng(rec.fix.lat, rec.fix.lon);
      if (!c._dot) c._dot = L.marker(ll, {icon: meIcon, interactive: false, keyboard: false, zIndexOffset: 2000}).addTo(m);
      else c._dot.setLatLng(ll);
      follow(c, ll); }
  }
  // the part of the map nothing covers: a results sheet or side panel, the top right corner's controls (the status line, the zoom
  // bar) and the open legend. Only the sheet and side panel came off, so on a phone the dot spent the drive under the status line
  // or the legend (review 11/12, round 2). Where the legend leaves too little, it's left in
  function freeBox(m, c){
    const s = m.getSize(), box = m.getContainer(), b0 = box.getBoundingClientRect(), v = box.querySelector(":scope > .rf-res"), b = {x0: 0, y0: 0, x1: s.x, y1: s.y};
    if (v && v.dataset.lay === "sheet") b.y1 = Math.max(80, s.y - v.offsetHeight - 6);
    else if (v && v.dataset.lay === "side") b.x1 = Math.max(80, s.x - v.offsetWidth - 10);
    for (const x of box.querySelectorAll(".leaflet-top.leaflet-right .leaflet-control")) { if (x.hidden || !x.offsetHeight) continue;
      b.y0 = Math.max(b.y0, x.getBoundingClientRect().bottom - b0.top + 8); }
    const leg = box.querySelector(".leaflet-bottom .rf-sv-leg");
    if (leg && !leg.hidden && leg.offsetHeight) { const at = () => { const r = leg.getBoundingClientRect(); return [r.top - b0.top - 8, r.bottom - b0.top + 8]; };
      // what Follow me takes from the legend is worked out afresh each time, from its full height: it grew every tick and was
      // only given back at Stop, so after a sheet had been up the legend stayed cut to its title row (review 11/12, round 3)
      if (c && c.legFollow) { c.legFollow = 0; c.fitLegend(); }
      let [top, bot] = at();
      // too little room under the status line (a phone with a sheet up): the legend gives Follow me 100 px, down to its header
      // row and scrolling inside (c.legFollow, apart from a note's c.legRoom)
      if (top - b.y0 < 100 && Math.max(0, b.y1 - bot) < 100 && c && c.fitLegend) { c.legFollow = Math.max(0, Math.min(leg.offsetHeight - 56, Math.ceil(100 - (top - b.y0))));
        if (c.legFollow) { c.fitLegend(); [top, bot] = at(); } }
      // the bigger strip clear of it, above or below (the legend can ride between the status line and a sheet); the dot is 18 px,
      // so 30 px holds it
      const above = top - b.y0, below = b.y1 - bot;
      if (above >= below && above >= 30) b.y1 = Math.min(b.y1, top); else if (below >= 30) b.y0 = Math.max(b.y0, bot); }
    if (b.y1 - b.y0 < 30) b.y0 = Math.max(0, b.y1 - 30);  // never pulled back over what it left out (80 put it back under the legend)
    return b;
  }
  // pans, never zooms, and only when the dot has left the middle 60% of the free part, to its middle; not while a square's viewer
  // is open (a sheet's top half left the dot behind the sheet, and panTo centred it there again: review 11/12)
  function follow(c, ll){
    if (!rec || !rec.follow) return; const m = c.map, v = window.RFResults && RFResults.get(m);
    if (v && /^sv:t:/.test(v.key)) return;
    const p = m.latLngToContainerPoint(ll), b = freeBox(m, c), w = b.x1 - b.x0, hh = b.y1 - b.y0;
    if (p.x < b.x0 + w * 0.2 || p.x > b.x1 - w * 0.2 || p.y < b.y0 + hh * 0.2 || p.y > b.y1 - hh * 0.2) m.panBy([p.x - (b.x0 + w / 2), p.y - (b.y0 + hh / 2)], {animate: true});
  }
  const off = why => { if (!rec || !rec.follow) return; rec.follow = false; status(); const c = cOf(); if (c && c.say) c.say(`Follow me is off: ${why}.`, ["Follow me", () => { if (rec) { rec.follow = true; status(); dot(); } }]); };

  /* ---------- the status line ---------- */
  function status(){
    for (const c of live.values()) {
      const m = c.map, mine = rec && cOf() === c;
      if (!mine) { if (c._recCtl) { c._recCtl.remove(); c._recCtl = null; } continue; }
      // a control in the top right corner, under the zoom bar: a phone's results sheet covers the bottom ones, a side panel moves
      // it aside as the map's other controls, and a saved map image leaves it out
      if (!c._recCtl) { const C = L.Control.extend({options: {position: "topright"}, onAdd(){ const el = L.DomUtil.create("div", "leaflet-control rf-sv-rec"); el.setAttribute("role", "status");
        L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el); return el; }}); c._recCtl = new C().addTo(m); }
      const el = c._recCtl.getContainer(), p = rec.last;
      const cell = p ? `${p.carrier || "?"} ${/NR|5G/i.test(p.tech || "") ? "5G" : "LTE"}${p.band ? ` ${/^n/i.test(p.band) ? p.band : `B${p.band}`}` : ""}${p.pci != null ? ` PCI ${p.pci}` : ""}${p.rsrp != null ? ` ${p.rsrp} dBm` : ""}` : "no serving cell yet";
      const note = rec.refused ? `Not kept on the server: ${rec.refused}. The readings stay on this phone.` : rec.netMsg || rec.msg || "";
      el.innerHTML = `<div class="l1"><span class="dot" aria-hidden="true"></span><b>REC</b> <span data-rt>${dur(Date.now() - rec.t0)}</span><span class="b"><button type="button" data-rfollow aria-pressed="${!!rec.follow}" title="Keep the dot in view: pans when it leaves the middle of the map, never zooms; a drag or pinch turns it off">Follow me: ${rec.follow ? "on" : "off"}</button><button type="button" data-rstop class="stop">■ Stop</button></span></div>
        <div class="l2"><span data-rn>${n0(rec.n)}</span> readings · ${h(cell)} · GPS ${rec.acc != null ? `±${Math.round(rec.acc)} m` : "searching"} · battery ${rec.battery != null ? `${rec.battery}%${rec.charging ? " (charging)" : ""}` : "?"} · <span data-rw>${n0(rec.waiting)}</span> waiting to upload${earlierN ? ` (and ${n0(earlierN)} from an earlier recording, going up now)` : ""}</div>
        ${note ? `<div class="warn">${h(note)}</div>` : ""}`;
      el.querySelector("[data-rstop]").onclick = ev => { L.DomEvent.stop(ev); stop(); };
      el.querySelector("[data-rfollow]").onclick = ev => { L.DomEvent.stop(ev); rec.follow = !rec.follow; status(); dot(); };
      // the legend under it fits again: the status line came (or grew a line) after the legend was fitted, and covered its foot
      if (c.fitLegend) c.fitLegend();
    }
  }
  setInterval(() => { const c = cOf(), t = c && c._recCtl && c._recCtl.getContainer().querySelector("[data-rt]"); if (rec && t) t.textContent = dur(Date.now() - rec.t0); }, 1000);
  const css = document.createElement("style");
  css.textContent = `.rf-sv-rec{width:min(330px,calc(100vw - 120px));box-sizing:border-box;padding:6px 10px;border-radius:12px;background:rgba(20,20,20,.92);color:#fff;
      font:12px/1.4 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.35)}
    .rf-sv-rec .l1{display:flex;gap:6px;align-items:center;font-size:13px}.rf-sv-rec .l2{opacity:.9}
    .rf-sv-rec .dot{width:10px;height:10px;border-radius:50%;background:#e5534b;animation:rfsvblink 1.2s infinite}.rf-sv-rec .warn{color:#ffb38a}
    .rf-sv-rec .b{display:flex;gap:6px;margin-left:auto}.rf-sv-rec .l2{margin-top:3px}.rf-sv-rec button{font:inherit;padding:3px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.4);background:transparent;color:#fff;cursor:pointer}
    .rf-sv-rec button.stop{background:#e5534b;border-color:#e5534b;font-weight:600}
    .rf-sv-me{pointer-events:none!important}.rf-sv-me span{display:block;width:13px;height:13px;margin:0;border-radius:50%;background:#1f6feb;border:2.5px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.35),0 1px 4px rgba(0,0,0,.35)}
    @keyframes rfsvblink{50%{opacity:.25}}@media (prefers-reduced-motion:reduce){.rf-sv-rec .dot{animation:none}}
    @media (pointer:coarse){.rf-sv-rec button{min-height:40px}}`;
  document.head.appendChild(css);

  const paint = c => { if (c && c.paint) c.paint(); };
  let dropAsk = null;  // the refused recording whose Discard was pressed once
  // the menu's earlier recordings: readings still going up, and the ones the server refused (a CSV of them, or discard them)
  const earlierHtml = () => `${earlierN ? `<div class="row"><span class="rf-sv-hint" style="margin:0">${n0(earlierN)} readings from an earlier recording wait to go up.</span><button type="button" data-svsend>Send now</button></div>` : ""}
    ${refusedList.map(m => `<div class="rf-sv-msg">“${h(m.run.name)}”: the server refused it (${h(m.refused)}). ${n0(m.waiting)} readings are on this phone only.
      <div class="row"><button type="button" data-svcsv="${h(m.lid)}">⇩ CSV of them</button><button type="button" data-svdrop="${h(m.lid)}">${dropAsk === m.lid ? "Press again to discard" : "Discard them"}</button></div></div>`).join("")}`;
  window.RFSurveyRec = {REC,
    section(c){
      const more = earlierHtml();
      if (!radio()) return `<div class="rf-sv-hint" style="margin-top:8px">● Record: recording needs DAStastic for Android (a reading every 2 s with GPS). On this computer, import a log instead. <button type="button" data-svhelp="android" title="Get the Android app and what it needs">Android app</button></div>${more}`;
      if (!surveyApp()) return `<div class="rf-sv-hint" style="margin-top:8px">● Record: ${h(OLD_APP)} <button type="button" data-svhelp="android">Android app</button></div>${more}`;
      if (!canPost()) return `<div class="rf-sv-hint" style="margin-top:8px">● Record: a view-only login can't record a survey (nor import one): ask whoever runs this copy.</div>${more}`;
      if (c.noServer) return `<div class="rf-sv-hint" style="margin-top:8px">● Record: this copy can't keep a survey run (${h(c.noServer)}), so it doesn't record. The sample still works.</div>${more}`;
      if (!rec && c.kept.keep && c.scope().scope === "scratch" && !c.site()) return `<div class="rf-sv-hint" style="margin-top:8px">● Record: “Keep only what's within 2 mi of the site” needs the site, and there's none here: pick an address first, or untick it.</div>${more}`;
      if (rec) return `<div class="row"><b>● Recording</b> <span class="rf-sv-hint" style="margin:0">into “${h(rec.run.name)}” · ${n0(rec.n)} readings</span><button type="button" data-svstop class="primary">■ Stop</button></div>${more}`;
      return `<div class="row"><button type="button" class="primary" data-svrec title="A reading every 2 s with GPS, kept with ${h(c.scope().name)}; the screen stays on; it stops at ${REC.lowBattery}% battery"${starting ? " disabled" : ""}>● Record</button>
        <span class="rf-sv-hint" style="margin:0">Drive or walk, then Stop. Keep DAStastic open.</span></div>${more}`; },
    wire(c, pn){
      const on = (q, fn) => pn.querySelectorAll(q).forEach(el => el.onclick = ev => { L.DomEvent.stop(ev); fn(el); });
      on("[data-svrec]", () => start(c)); on("[data-svstop]", () => stop()); on("[data-svsend]", () => leftovers());
      on("[data-svcsv]", async el => { const m = refusedList.find(x => x.lid === el.dataset.svcsv); if (!m) return;
        const rs = (await Q.all(m.lid)).flatMap(b => b.rs); c.download(`${m.run.name.replace(/[\\/:*?"<>|]+/g, "-")} (not on the server).csv`, SV.csv(rs, "android"), "text/csv;charset=utf-8"); });
      // asked twice, the first press kept here: the menu is drawn again whenever an earlier recording's count changes
      on("[data-svdrop]", async el => { const lid = el.dataset.svdrop; if (dropAsk !== lid) { dropAsk = lid; return paint(c); } dropAsk = null; await Q.drop(lid); earlier(); });
    },
    attach(c){
      live.set(c.slot, c);
      const m = c.map;
      // a drag or a pinch is the person taking the map: Follow me lets go (a pan of its own fires no dragstart)
      m.on("dragstart", () => { if (rec && cOf() === c) off("you moved the map"); });
      // Zoom to run, or a viewer's Zoom to: the person asked to see that, and Follow me's next pan undid it (review 11/12, round 2)
      m.on("rfzoomto", () => { if (rec && cOf() === c) off("you zoomed to something"); });
      m.getContainer().addEventListener("touchstart", e => { if (e.touches && e.touches.length > 1 && rec && cOf() === c) off("you pinched the map"); }, {passive: true});
      m.on("unload", () => { if (live.get(c.slot) === c) live.delete(c.slot); });
      if (rec && rec.slot === c.slot) { rec.c = c; status(); dot(); }
      if (!looked) { looked = true; setTimeout(resume, 3000); }  // resume sets looked back when it found no map to pick it up on
      earlier();
    },
    // the walk test asks before it takes the bridge's log: a survey recording, one starting, or a survey log the bridge runs (GPS on)
    owns: () => !!rec || (starting && !cancelStart) || surveyLog(),  // a start called off never starts the phone: the walk can take it
    state: () => rec ? {recording: true, n: rec.n, waiting: rec.waiting, earlier: earlierN, follow: !!rec.follow, runId: rec.runId, refused: rec.refused || null, battery: rec.battery, slot: rec.slot, lid: rec.lid, cap: rec.cap || REC.batch, stopping: stops.size > 0}
      : {recording: false, earlier: earlierN, refused: refusedList.length, stopping: stops.size > 0, unfinished},
    tick: () => tick(), stop: why => stop(why), upload: () => rec && send(rec), leftovers: () => leftovers(), resume: () => resume(), available: () => !!radio()};
})();
