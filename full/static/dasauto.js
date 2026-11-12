"use strict";
/* DAStastic: Run it for me (Cody 11/5: "can we do the walk me through - just auto? so the user can just check after?"). One press does
   every desk step it can on the job, the free look-ups a person would otherwise press one at a time, then hands over a list to check.
   It only fills what's empty. Each step's own button stays where it is, and these are the same routes.
   A fact it chose for someone (the AHJ, the channel plan) stays open until a person says it looks right: data.auto.open. An open fact
   doesn't clear a stage gate (codecheck.py), so nothing moves forward on a guess. Every step keeps what it replaced and what it left,
   so it can be undone where nobody has changed it since.
   It writes emails and sends none: they wait on the job's one list for a person's press. Physical steps stay with people.
   Runs in the page, on routes that already check the login. Close the page and it stops where it got to. Needs core.js, das.js, dasmail.js, dasx.js. */
(() => {
  const floorsFrom = n => Array.from({ length: Math.min(200, n) }, (_, i) => ({ name: String(i + 1), grids: DAS.grids }));
  const none = said => ({ state: "none", said }), skip = said => ({ state: "skip", said });

  // a value's fingerprint: what a step left, kept on its row so Undo can tell whether anyone changed it since. Keys in order, so a
  // merge on the server that moves a key doesn't read as a change
  const canon = v => v === undefined ? "~" : JSON.stringify(v, (k, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(n => [n, x[n]])) : x);
  const fp = v => { const s = canon(v); let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return `${s.length}.${h.toString(36)}`; };
  const get = (d, path) => path.split(".").reduce((o, k) => o == null ? undefined : o[k], d);
  // the channel plan's fingerprint is what a person chooses in it, the call sign and channels of each entry, never its estimates (review
  // 11/11: re-saving the Pre-survey rebuilds the plan with fresh outdoor estimates, so the run's own plan read as changed, a partial
  // Undo or the closing save dropped its mark, and the guess cleared the gate). "c:" marks one taken this way; a row from before has none
  const CHOICE = { "presurvey.plan": v => "c:" + fp((Array.isArray(v) ? v : []).map(e => [e && e.call_sign, e && e.downlink_mhz, e && e.uplink_mhz])) };
  const mark = (p, v) => CHOICE[p] ? CHOICE[p](v) : fp(v);
  // the key still holds what the step left: on its fingerprint as the row has it
  const left = (p, v, was) => (CHOICE[p] && /^c:/.test(was || "") ? CHOICE[p](v) : fp(v)) === was;
  // a step's Undo, key by key: before = each key's value before the step, after = the fingerprint of what the step left there
  const change = (d, vals) => { const before = {}, after = {};
    for (const [p, v] of Object.entries(vals)) { const was = get(d, p); if (mark(p, was) === mark(p, v)) continue; before[p] = was; after[p] = mark(p, v); }
    return { before, after }; };
  // the facts a person confirms, by the key that holds each: the mark is about this value
  const FACT = { ahj: "ahj", plan: "presurvey.plan" };

  // a change worked out on the job as the server has it now (dasrev.js dasJobPatch), saved as of that copy: the guide, the Overview and
  // Start each confirm facts from their own copy, and a stale one put back a mark a person had already cleared (review, 11/10).
  // fn(cur) returns the data patch, or false for nothing to change. Every save here goes under Run it for me's own client id
  // (dasrev.js DASREV.auto), so a view on this page drawn before it merges with what it wrote, or asks, instead of writing over it
  // (dasrev.js DASREV.auto), and a clash is worked out again on the job as it is then, never asked: each step's "only into what's
  // empty", and Undo's "only where it still holds what the run left", see the other person's change and leave it (review round 5)
  const AUTO = () => typeof DASREV !== "undefined" && DASREV.auto ? { client: DASREV.auto, redo: true } : {};
  const patchJob = (id, fn, opts) => window.dasJobPatch ? window.dasJobPatch(id, fn, { ...AUTO(), ...(opts || {}) })
    : api(`/api/das/jobs/${id}`, { dasRaw: true }).then(async cur => { const p = await fn(cur); return p === false ? cur : post(`/api/das/jobs/${id}`, { data: p, rev: cur.rev }); });

  window.dasAutoRun = async (id, tick = () => {}) => {
    // a read, not a redraw: the page keeps the revision it was drawn from, so its own saves still ask about a change made since (review 11/10)
    let j = await api(`/api/das/jobs/${id}`, { dasRaw: true });
    const d = () => j.data || {}, first = d(), scope = dasScope(first), rows = [], wrote = new Set(), by = (S.me && S.me.user) || "";
    // a step's save, worked out on the job as it is now and saved as of that copy (review 11/10: the run's saves went as of the page's
    // revision, so a person's own AHJ typed while it looked one up was overwritten). fn(cur data) returns { patch, said, before,
    // after, open } (or a promise of them) or false when the job has it already. The step's row goes onto the auto record in the same
    // save, its mark too: a run cut off part way never leaves a guess counting as a person's
    const put = async (key, label, fn) => {
      let out = null;
      // out is the attempt that saves: a clash worked out again that finds the job has it now leaves none (review round 6)
      j = await patchJob(id, async cur => { out = null; const cd = cur.data || {}, r = await fn(cd); if (!r) return false; out = r;
        const a = { ...(cd.auto || {}) }, row = { key, label, said: r.said, before: r.before || null, after: r.after || null, open: !!r.open, at: today() };
        a.did = [...(a.did || []).filter(x => x.key !== key), row];
        if (r.open) a.open = [...new Set([...(a.open || []), key])];
        // floors go as a fill the server makes only into an empty list (dasfloors.py; review round 6: every floor writer works by
        // operation on the job as it is), in the same save as the step's row and mark
        const { floors, ...rest } = r.patch;
        return { ...rest, ...(floors ? { floorOps: [{ op: "fill", above: floors.length }] } : {}), auto: { ...a, at: today(), by } }; });
      if (out) wrote.add(key);
      return out;
    };
    const step = async (key, label, run) => {
      const row = { key, label, state: "working" }; rows.push(row); tick(rows);
      try { Object.assign(row, await run(fn => put(key, label, fn))); } catch (e) { Object.assign(row, { state: "failed", said: e.message }); }
      tick(rows); return row;
    };
    const lat = first.lat, lon = first.lon;
    if (lat == null) throw new Error("Set the building's location first.");

    await Promise.all([
      step("building", "Building outline", async save => {
        if (d().building) return skip("Already on the job.");
        const b = await api(`/api/das/building?lat=${lat}&lon=${lon}`);
        const said = [b.footprint_sqft && `${Number(b.footprint_sqft).toLocaleString()} sq ft footprint`, b.levels && `${b.levels} floors`, b.source].filter(Boolean).join(" · ");
        return await save(cd => cd.building ? false : { patch: { building: b }, said, ...change(cd, { building: b }) }) ? { state: "done", said } : skip("Already on the job.");
      }),
      step("nsi", "National Structure Inventory", async save => {
        if (d().nsi) return skip("Already on the job.");
        const n = await api(`/api/das/nsi?lat=${lat}&lon=${lon}&job=${id}`);
        const said = [n.sqft && `${Number(n.sqft).toLocaleString()} sq ft`, n.stories && `${n.stories} stories`].filter(Boolean).join(" · ") || "Record saved";
        return await save(cd => cd.nsi ? false : { patch: { nsi: n }, said, ...change(cd, { nsi: n }) }) ? { state: "done", said } : skip("Already on the job.");
      }),
      step("ahj", "The AHJ", async save => {
        if ((d().ahj || "").trim()) return skip(`Already named: ${d().ahj}.`);
        const r = await api(`/api/das/x/ahj/${id}`), x = (r.suggestions || [])[0];
        if (!x) return none("No fire department found for this address. Ask the city or county.");
        const said = `${x.name}${x.why ? ` · ${x.why}` : ""}`;
        // only into an AHJ still empty as it saves: one a person typed or picked while this looked it up stays theirs. The same for the
        // AHJ contact: one a person picked on People stays (review 11/11: it was replaced by the run's own whenever the name was
        // empty), and the firm's contact is found or made only once the save will use it (a person's AHJ meanwhile left one unused)
        const done = await save(async cd => { if ((cd.ahj || "").trim()) return false;
          const mine = (cd.contacts || {}).ahj != null && (cd.contacts || {}).ahj !== "", c = mine ? null : await window.dasAhjContact(x);
          const vals = { ahj: x.name, ...(c ? { "contacts.ahj": c.id } : {}) };
          return { patch: { ahj: x.name, ...(c ? { contacts: { ...(cd.contacts || {}), ahj: c.id } } : {}) }, said, open: true, ...change(cd, vals) }; });
        return done ? { state: "done", said } : skip(`Already named: ${d().ahj}.`);
      }),
    ]);

    // floors and floor area, once both records are in, so the answer can't depend on which server replied first. A person's answer
    // beats a mapped building, and that beats a modelled estimate. The inventory's floor area is the whole building's; an outline's is one floor's
    const facts = dd => {
      const b = dd.building || {}, n = dd.nsi || {}, ans = dd.guided?.answers?.floors_up || "", told = /^\d+$/.test(ans) ? +ans : null, has = Array.isArray(dd.floors) && dd.floors.length > 0;
      // a range answer ("7 to 12") still says what the building is: a record outside it isn't quietly believed (3 floors for a 7 to 12, live 11/6)
      const m = ans.match(/^(\d+)(?: to (\d+)| or more)$/), fits = x => !m || (x >= +m[1] && (!m[2] || x <= +m[2]));
      const records = [[b.levels, "OpenStreetMap"], [n.stories, "the National Structure Inventory"]].filter(r => r[0]), hit = told ? [told, "your answer"] : records.find(r => fits(r[0]));
      const area = n.sqft || b.footprint_sqft, patch = {}, said = [];
      if (!has && hit) { patch.floors = floorsFrom(hit[0]); said.push(`${hit[0]} floors, from ${hit[1]}`); }  // put() sends it as a fill: floor-ops-ok
      else if (!has && records.length) said.push(`Floors left empty: you said ${ans}, and the records say ${records.map(r => r[0]).join(" and ")}. Set them on the Overview tab`);
      if (dd.area_sqft == null && area) { patch.area_sqft = area; said.push(`${Number(area).toLocaleString()} sq ft, from ${n.sqft ? "the National Structure Inventory" : "the outline's footprint"}`); }
      return { patch, said: said.join(" · ") };
    };
    await step("facts", "Floors and floor area", async save => {
      const f = facts(d());
      if (!f.said) return skip("Already on the job, or nothing was found.");
      if (!Object.keys(f.patch).length) return none(f.said);
      const done = await save(cd => { const g = facts(cd); return Object.keys(g.patch).length ? { patch: g.patch, said: g.said, ...change(cd, g.patch) } : false; });
      return done ? { state: "done", said: done.said } : skip("Already on the job, or nothing was found.");
    });

    let chosen = [];
    if (scope.ps) {
      await step("plan", "Channel plan", async save => {
        const ps = d().presurvey || {};
        if ((ps.plan || []).length) return skip("Already saved.");
        const radius = ps.radius || 15, threshold = ps.threshold || -95, env = ps.env || "suburban";
        const r = await api(`/api/das/presurvey?lat=${lat}&lon=${lon}&radius=${radius}&job=${id}&threshold=${threshold}&env=${env}`);
        // the building's own systems (start.js startSystems), and a person adds the rest. Ticks on a job begun outside Start are a person's: they stay
        const a = await api(`/api/das/x/ahj/${id}`).catch(() => ({})), own = window.startSystems(r.systems || [], a).map(s => s.call_sign);
        const done = await save(cd => { const cps = cd.presurvey || {}; chosen = [];
          if ((cps.plan || []).length) return false;
          const include = (cps.include || []).length && !cd.guided ? cps.include : own, set = new Set(include);
          chosen = (r.systems || []).filter(s => set.has(s.call_sign)); if (!chosen.length) return false;
          const plan = window.dasPlanOf(chosen), others = (r.systems || []).length - chosen.length;
          // the defaults it searched with fill only what's empty; Undo puts back the plan and the ticks
          return { patch: { presurvey: { ...cps, include, plan, radius: cps.radius || radius, threshold: cps.threshold || threshold, env: cps.env || env } }, open: true,
            said: `${chosen.length} system${chosen.length === 1 ? "" : "s"}, ${plan.length} channels${others > 0 ? `. ${others} others within ${radius} miles left off: add the ones the AHJ requires on the Pre-survey` : ""}`,
            ...change(cd, { "presurvey.plan": plan, "presurvey.include": include }) }; });
        if (!done) return (d().presurvey?.plan || []).length ? skip("Already saved.") : none("No systems to carry were found. Check the Pre-survey tab.");
        return { state: "done", said: done.said };
      });
      await step("terrain", "Terrain paths", async save => {
        const list = chosen.filter(s => dasDonorSite(s)).slice(0, 20); if (!list.length) return skip("No donor sites to check.");
        const res = await post("/api/das/terrain", { lat, lon, roof_m: dasRoof(d()), sites: list.map(s => { const st = dasDonorSite(s); return { key: s.call_sign, lat: st.lat, lon: st.lon, height_m: st.height_m, freq: s.real?.freq || s.down[0]?.freq }; }) });
        const done = await save(cd => { const ps = cd.presurvey || {}, terrain = { ...(ps.terrain || {}) }; let n = 0;
          for (const s of list) { const x = res.paths?.[s.call_sign], st = dasDonorSite(s); if (x && !x.error) { terrain[s.call_sign] = { ...x, site: `${st.lat},${st.lon}`, roof_m: dasRoof(cd) }; n++; } }
          return n ? { patch: { presurvey: { ...ps, terrain } }, said: `${n} of ${list.length} paths checked` } : false; });
        return done ? { state: "done", said: done.said } : none("No terrain data for these paths yet. It comes with a terrain download.");
      });
    }
    if (scope.cell) await step("cells", "Cell sites", async () => {
      let c = await api(`/api/cells?lat=${lat}&lon=${lon}&radius=5`);
      if ((c.sites || []).length) return skip(`${c.sites.length} already known here.`);
      await post("/api/cells/fetch", { lat, lon });  // the crowd's cells for this area, kept: a daily limit applies, so it's asked once per area
      c = await api(`/api/cells?lat=${lat}&lon=${lon}&radius=5`);
      return (c.sites || []).length ? { state: "done", said: `${c.sites.length} sites found` } : none("None mapped here yet.");
    });
    if (window.rfMail) await step("mail", "Emails", async () => {
      const r = await api(`/api/mail/job/${id}`), more = await window.dasJobMailRows(j, r).catch(() => ({ rows: [] })), n = r.items.length + more.rows.length;
      return n ? { state: "done", said: `${n} written. None sent: they wait for your press.` } : none("None needed yet.");
    });

    // the closing save, on the auto record as it is now: the rows of steps that saved nothing on the job (cell sites), and a fact this
    // run marked whose value isn't the run's any more (a person changed it while this ran) loses its mark and its Undo: it's theirs
    const rest = rows.filter(r => r.state === "done" && r.key !== "mail" && !wrote.has(r.key)).map(({ key, label, said }) => ({ key, label, said, before: null, after: null, open: false, at: today() }));
    j = await patchJob(id, cur => { const cd = cur.data || {}, a = { ...(cd.auto || {}) };
      const theirs = Object.keys(FACT).filter(k => wrote.has(k) && (a.did || []).some(x => x.key === k && x.open && x.after && x.after[FACT[k]] && !left(FACT[k], get(cd, FACT[k]), x.after[FACT[k]])));
      if (!rest.length && !theirs.length) return false;
      a.did = (a.did || []).filter(x => !rest.some(r => r.key === x.key)); theirs.forEach(k => theirsNow(a, cd, k)); a.did = [...a.did, ...rest];
      return { auto: { ...a, at: today(), by } }; });
    return { rows, job: j };
  };

  // a confirm, a person's own pick, an Undo: worked out on the job as it is now. The guide's panel, when it's open on this job, shows the
  // answer (review 11/11: an AHJ typed on the Overview left the panel offering Looks right on the old guess until something redrew it)
  const revise = (j, fn, opts) => patchJob(j.id, cur => { const cd = cur.data || {}, a = { ...(cd.auto || {}) }, patch = fn(a, cd);
    return patch === false ? false : { ...(patch || {}), auto: a }; }, opts).then(out => { if (window.dasGuideSaw) window.dasGuideSaw(out); return out; });
  // a fact a person made their own: its mark goes, and its row keeps only what else the run set there that still holds the run's
  // value (the AHJ contact it attached), so that can still be undone (review 11/11: typing another AHJ dropped the whole row, and the
  // contact the run made for the department the person didn't pick stayed on the job with no Undo). Nothing left: the row goes
  const theirsNow = (a, cd, key, also = []) => {
    a.open = (a.open || []).filter(k => k !== key);
    a.did = (a.did || []).flatMap(x => { if (x.key !== key) return [x];
      const ps = Object.keys(x.after || {}).filter(p => p !== FACT[key] && !also.includes(p) && left(p, get(cd, p), x.after[p]));
      if (!ps.length) return [];
      const pick = o => Object.fromEntries(ps.filter(p => o && p in o).map(p => [p, o[p]])), w = words(ps);
      return [{ ...x, label: w[0].toUpperCase() + w.slice(1), open: false, before: pick(x.before), after: pick(x.after) }]; });
  };
  // a person has looked at it: it counts from here
  window.dasAutoOk = (j, key) => revise(j, a => { if (!(a.open || []).includes(key) && !(a.did || []).some(x => x.key === key && x.open)) return false;
    a.open = (a.open || []).filter(k => k !== key); a.did = (a.did || []).map(x => x.key === key ? { ...x, open: false, checked: today() } : x); });
  // a person chose it themselves (typed it, or picked it from a list): it isn't Run it for me's any more, so its mark and its Undo of
  // it go, or Undo would put back what was there before and erase the person's own choice (review, 11/10). is: the value the person
  // saved, needed: only once the job holds it (a save that failed, or a clash settled with Keep theirs, leaves the guess still waiting;
  // review 11/11: a caller that left it out cleared the mark whatever the job held)
  // o.also: the other keys the person set with it (Use as AHJ and This one set the AHJ's contact too: review round 5, the row left for
  // the contact then offered an Undo that erased the person's own pick); only the typed name leaves the run's contact its Undo
  window.dasAutoMine = (j, key, is, o = {}) => revise(j, (a, cd) => { if (is == null || !FACT[key]) return false;
    if (!(a.open || []).includes(key) && !(a.did || []).some(x => x.key === key)) return false;
    if (String(get(cd, FACT[key]) ?? "").trim() !== String(is).trim()) return false;
    theirsNow(a, cd, key, o.also || []); });

  // back as it was, key by key and only where the job still holds what the run left there, worked out on the job as it is now. A key
  // someone changed since stays as it is, and the page says so (review 11/10: Undo put back whole sections, and with them erased the
  // People list, a floor's plan and the Pre-survey's ticks set since, a person's own or another's, with no word)
  const WORDS = { building: "the building outline", nsi: "the NSI record", ahj: "the AHJ", "contacts.ahj": "the AHJ contact", floors: "the floors",
    area_sqft: "the floor area", "presurvey.plan": "the channel plan", "presurvey.include": "the ticked systems" };
  const MANY = new Set(["floors", "presurvey.include"]);
  const words = ps => { const w = ps.map(p => WORDS[p] || p); return w.length > 1 ? `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}` : w[0]; };
  const stays = kept => { const many = kept.length > 1 || MANY.has(kept[0]); return [many, `changed since Run it for me, so ${many ? "they stay as they are" : "it stays as it is"}`]; };
  const undoneSaid = (x, key, kept) => { const [many, why] = stays(kept); return kept.length ? `Undone, except ${words(kept)}: ${many ? "they" : "it"} ${why}.` : `Undone: ${x.label || key}.`; };
  window.dasAutoUndo = async (j, key) => {
    let said = "", sent = null;
    const out = await revise(j, (a, cd) => {
      const x = (a.did || []).find(r => r.key === key), ps = Object.keys((x && x.after) || {});
      if (!ps.length) { said = "Nothing to undo there now."; return false; }
      const back = ps.filter(p => left(p, get(cd, p), x.after[p])), kept = ps.filter(p => !back.includes(p));
      if (!back.length) { said = `Not undone: ${words(kept)} ${stays(kept)[1]}.`; a.did = a.did.map(r => r === x ? { ...r, before: null, after: null } : r); return {}; }
      sent = { x, back, kept };
      const patch = {};
      for (const p of back) { const v = (x.before || {})[p], [top, sub] = p.split(".");
        if (!sub) { patch[top] = v === undefined ? null : v; continue; }
        patch[top] = patch[top] || { ...(cd[top] || {}) }; if (v === undefined) delete patch[top][sub]; else patch[top][sub] = v; }
      a.open = (a.open || []).filter(k => k !== key); a.did = (a.did || []).filter(r => r !== x);
      said = undoneSaid(x, key, kept);
      return patch; });
    // said from what saved: a clash settled with Keep theirs (another person's change landed between the read and the save) keeps
    // theirs, and the page says so (review 11/11: it said "Undone: The AHJ." with their AHJ on the job)
    if (sent && out) { const nul = v => v === undefined ? null : v, also = sent.back.filter(p => mark(p, nul(get(out.data || {}, p))) !== mark(p, nul((sent.x.before || {})[p])));
      if (also.length) { const kept = [...sent.kept, ...also]; said = also.length === sent.back.length ? `Not undone: ${words(kept)} ${stays(kept)[1]}.` : undoneSaid(sent.x, key, kept); } }
    if (said && window.dasSay) dasSay(said, /^Undone/.test(said));
    return out;
  };
})();
