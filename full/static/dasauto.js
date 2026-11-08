"use strict";
/* DAStastic: Run it for me (Cody 11/5: "can we do the walk me through - just auto? so the user can just check after?"). One press does
   every desk step it can on the job, the free look-ups a person would otherwise press one at a time, then hands over a list to check.
   It only fills what's empty. Each step's own button stays where it is, and these are the same routes.
   A fact it chose for someone (the AHJ, the channel plan) stays open until a person says it looks right: data.auto.open. An open fact
   doesn't clear a stage gate (codecheck.py), so nothing moves forward on a guess. Every step keeps what it replaced, so it can be undone.
   It writes emails and sends none: they wait on the job's one list for a person's press. Physical steps stay with people.
   Runs in the page, on routes that already check the login. Close the page and it stops where it got to. Needs core.js, das.js, dasmail.js, dasx.js. */
(() => {
  const floorsFrom = n => Array.from({ length: Math.min(200, n) }, (_, i) => ({ name: String(i + 1), grids: DAS.grids }));
  const none = said => ({ state: "none", said }), skip = said => ({ state: "skip", said });

  window.dasAutoRun = async (id, tick = () => {}) => {
    let j = await api(`/api/das/jobs/${id}`);
    const d = () => j.data || {}, first = d(), scope = dasScope(first), rows = [], open = new Set((first.auto || {}).open || []);
    const save = async patch => { j = await post(`/api/das/jobs/${id}`, { data: patch }); };
    const hasFloors = () => Array.isArray(d().floors) && d().floors.length > 0;
    const step = async (key, label, run) => {
      const row = { key, label, state: "working" }; rows.push(row); tick(rows);
      try { Object.assign(row, await run()); } catch (e) { Object.assign(row, { state: "failed", said: e.message }); }
      tick(rows); return row;
    };
    const lat = first.lat, lon = first.lon;
    if (lat == null) throw new Error("Set the building's location first.");

    await Promise.all([
      step("building", "Building outline", async () => {
        if (d().building) return skip("Already on the job.");
        const b = await api(`/api/das/building?lat=${lat}&lon=${lon}`);
        await save({ building: b });
        return { state: "done", said: [b.footprint_sqft && `${Number(b.footprint_sqft).toLocaleString()} sq ft footprint`, b.levels && `${b.levels} floors`, b.source].filter(Boolean).join(" · "), before: { building: null } };
      }),
      step("nsi", "National Structure Inventory", async () => {
        if (d().nsi) return skip("Already on the job.");
        const n = await api(`/api/das/nsi?lat=${lat}&lon=${lon}&job=${id}`);
        await save({ nsi: n });
        return { state: "done", said: [n.sqft && `${Number(n.sqft).toLocaleString()} sq ft`, n.stories && `${n.stories} stories`].filter(Boolean).join(" · ") || "Record saved", before: { nsi: null } };
      }),
      step("ahj", "The AHJ", async () => {
        if ((d().ahj || "").trim()) return skip(`Already named: ${d().ahj}.`);
        const r = await api(`/api/das/x/ahj/${id}`), x = (r.suggestions || [])[0];
        if (!x) return none("No fire department found for this address. Ask the city or county.");
        const c = await window.dasAhjContact(x);
        const contacts = d().contacts || {}, before = { ahj: d().ahj ?? null, contacts };
        await save({ ahj: x.name, contacts: { ...contacts, ahj: c.id } });
        open.add("ahj");
        return { state: "done", said: `${x.name}${x.why ? ` · ${x.why}` : ""}`, before, open: true };
      }),
    ]);

    // floors and floor area, once both records are in, so the answer can't depend on which server replied first. A person's answer
    // beats a mapped building, and that beats a modelled estimate. The inventory's floor area is the whole building's; an outline's is one floor's
    await step("facts", "Floors and floor area", async () => {
      const dd = d(), b = dd.building || {}, n = dd.nsi || {}, ans = dd.guided?.answers?.floors_up || "", told = /^\d+$/.test(ans) ? +ans : null;
      // a range answer ("7 to 12") still says what the building is: a record outside it isn't quietly believed (3 floors for a 7 to 12, live 11/6)
      const m = ans.match(/^(\d+)(?: to (\d+)| or more)$/), fits = x => !m || (x >= +m[1] && (!m[2] || x <= +m[2]));
      const records = [[b.levels, "OpenStreetMap"], [n.stories, "the National Structure Inventory"]].filter(r => r[0]), hit = told ? [told, "your answer"] : records.find(r => fits(r[0]));
      const area = n.sqft || b.footprint_sqft, patch = {}, before = {}, said = [];
      if (!hasFloors() && hit) { patch.floors = floorsFrom(hit[0]); before.floors = dd.floors ?? null; said.push(`${hit[0]} floors, from ${hit[1]}`); }
      else if (!hasFloors() && records.length) said.push(`Floors left empty: you said ${ans}, and the records say ${records.map(r => r[0]).join(" and ")}. Set them on the Overview tab`);
      if (dd.area_sqft == null && area) { patch.area_sqft = area; before.area_sqft = null; said.push(`${Number(area).toLocaleString()} sq ft, from ${n.sqft ? "the National Structure Inventory" : "the outline's footprint"}`); }
      if (!said.length) return skip("Already on the job, or nothing was found.");
      if (!Object.keys(patch).length) return none(said.join(" · "));
      await save(patch);
      return { state: "done", said: said.join(" · "), before };
    });

    let chosen = [];
    if (scope.ps) {
      await step("plan", "Channel plan", async () => {
        const ps = d().presurvey || {};
        if ((ps.plan || []).length) return skip("Already saved.");
        const radius = ps.radius || 15, threshold = ps.threshold || -95, env = ps.env || "suburban";
        const r = await api(`/api/das/presurvey?lat=${lat}&lon=${lon}&radius=${radius}&job=${id}&threshold=${threshold}&env=${env}`);
        // the building's own systems (start.js startSystems), and a person adds the rest. Ticks on a job begun outside Start are a person's: they stay
        const a = await api(`/api/das/x/ahj/${id}`).catch(() => ({})), own = window.startSystems(r.systems || [], a).map(s => s.call_sign);
        const include = (ps.include || []).length && !d().guided ? ps.include : own, set = new Set(include);
        chosen = (r.systems || []).filter(s => set.has(s.call_sign));
        if (!chosen.length) return none("No systems to carry were found. Check the Pre-survey tab.");
        const plan = window.dasPlanOf(chosen);
        await save({ presurvey: { ...ps, include, plan, radius, threshold, env } });
        open.add("plan");
        const others = (r.systems || []).length - chosen.length;
        return { state: "done", said: `${chosen.length} system${chosen.length === 1 ? "" : "s"}, ${plan.length} channels${others > 0 ? `. ${others} others within ${radius} miles left off: add the ones the AHJ requires on the Pre-survey` : ""}`, before: { presurvey: ps }, open: true };
      });
      await step("terrain", "Terrain paths", async () => {
        const list = chosen.filter(s => dasDonorSite(s)).slice(0, 20); if (!list.length) return skip("No donor sites to check.");
        const res = await post("/api/das/terrain", { lat, lon, roof_m: dasRoof(d()), sites: list.map(s => { const st = dasDonorSite(s); return { key: s.call_sign, lat: st.lat, lon: st.lon, height_m: st.height_m, freq: s.real?.freq || s.down[0]?.freq }; }) });
        const ps = d().presurvey || {}, terrain = { ...(ps.terrain || {}) }; let n = 0;
        for (const s of list) { const x = res.paths?.[s.call_sign], st = dasDonorSite(s); if (x && !x.error) { terrain[s.call_sign] = { ...x, site: `${st.lat},${st.lon}`, roof_m: dasRoof(d()) }; n++; } }
        if (!n) return none("No terrain data for these paths yet. It comes with a terrain download.");
        await save({ presurvey: { ...ps, terrain } });
        return { state: "done", said: `${n} of ${list.length} paths checked` };
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

    const did = [...(((j.data || {}).auto || {}).did || []).filter(x => !rows.some(r => r.key === x.key && r.state === "done")),
      ...rows.filter(r => r.state === "done" && r.key !== "mail").map(({ key, label, said, before, open: o }) => ({ key, label, said, before: before || null, open: !!o, at: today() }))];
    await save({ auto: { at: today(), by: (S.me && S.me.user) || "", did, open: [...open] } });
    return { rows, job: j };
  };

  async function revise(j, fn) {
    const a = { ...((j.data || {}).auto || {}) }, patch = fn(a) || {};
    return post(`/api/das/jobs/${j.id}`, { data: { ...patch, auto: a } });
  }
  // a person has looked at it: it counts from here
  window.dasAutoOk = (j, key) => revise(j, a => { a.open = (a.open || []).filter(k => k !== key); a.did = (a.did || []).map(x => x.key === key ? { ...x, open: false, checked: today() } : x); });
  // back as it was, and off the list
  window.dasAutoUndo = (j, key) => revise(j, a => { const x = (a.did || []).find(r => r.key === key); a.open = (a.open || []).filter(k => k !== key); a.did = (a.did || []).filter(r => r.key !== key); return (x && x.before) || {}; });
})();
