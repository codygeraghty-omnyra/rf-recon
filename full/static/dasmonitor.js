"use strict";
/* DAStastic: BDA monitoring on a DAS job's Overview (snmpwatch.py, lane D 11/4). The job's BDAs (address, community or an
   SNMPv3 user (11/6), quiet hours), their open alarms in NFPA 1225 18.14's words, BDAs gone quiet, and the traps as they came in, with a
   way to map a maker's OID to a code signal. The server listens only after an admin switches monitoring on here. */
(() => {
  const NFPA = "https://oci.georgia.gov/document/document/nfpa-1225-chapter-18/download";
  const IFC = "https://www.oswegofire.com/wp-content/uploads/2025/11/2021_ifc_510-Comm-Coverage.pdf";
  const rid = () => Math.random().toString(36).slice(2, 10);
  const when = t => (t || "").slice(0, 16);
  const V3_AUTH = [["sha", "SHA-1 (most BDAs)"], ["sha224", "SHA-224"], ["sha256", "SHA-256"], ["sha384", "SHA-384"], ["sha512", "SHA-512"], ["md5", "MD5 (old: use SHA if the BDA has it)"], ["none", "None (no authentication)"]];
  const v3Cell = (b, s) => { const v = b.v3 || {}, k = (s.v3 || {}).keys || [], lab = (V3_AUTH.find(a => a[0] === (v.auth || "sha")) || [])[1] || v.auth;
    const need = [(v.auth || "sha") !== "none" && "auth_pass", (v.priv || "aes") === "aes" && (v.auth || "sha") !== "none" && "priv_pass"].filter(Boolean), missing = need.filter(x => !k.includes(x));
    return `v3 · ${esc(v.user)} · ${esc(String(lab).split(" (")[0])}${(v.priv || "aes") === "aes" && (v.auth || "sha") !== "none" ? " + AES-128" : ""}${missing.length ? ` <b style="color:var(--warn)">passphrase not saved</b>` : ""}`; };

  async function panel(el, j, save) {
    if (!el) return;
    el.style.display = "";
    let st, js;
    try { [st, js] = await Promise.all([api("/api/das/monitor"), api(`/api/das/monitor/jobs/${j.id}`)]); }
    catch (e) { el.innerHTML = `<h3>Monitoring</h3><p class="status err">${esc(e.message)}</p>`; return; }
    if (!el.isConnected) return;
    const d = j.data || {}, M = d.monitor || {}, bdas = M.bdas || [], S0 = st.settings, on = S0.on;
    const sig = Object.fromEntries(st.signals.map(s => [s.key, s])), byId = Object.fromEntries(js.bdas.map(b => [b.id, b]));
    const open = js.bdas.flatMap(b => b.open.map(a => ({ ...a, bda: b.name || "BDA" }))), quiet = js.bdas.filter(b => b.quiet);
    const what = r => r.signal ? `${esc(sig[r.signal]?.label || r.signal)}${r.state === "clear" ? " <b style=\"color:var(--good)\">cleared</b>" : ""}`
      : r.state === "info" ? "information" : r.state === "ignored" ? "ignored" : `<span style="color:var(--warn)">not mapped</span> <span class="mono hint">${esc(r.trap_oid)}</span>`;
    const mapOpts = `<option value="">Map to…</option>${st.signals.map(s => `<option value="${s.key}">${esc(s.label)}</option><option value="${s.key}:clear">${esc(s.label)}: cleared</option>`).join("")}<option value="info">Information only</option><option value="ignore">Ignore</option>`;
    el.innerHTML = `<h3>Monitoring <span class="hint">· BDA alarms by SNMP trap, in the code's words (NFPA 1225 18.14)</span></h3>
      <p style="margin:0 0 6px" id="mnState">${on && st.running ? `<b style="color:var(--good)">On</b> · listening on UDP ${esc(st.listening)} · ${st.counts.filed || 0} traps filed since ${esc(when(st.since))}`
        : on ? `<b style="color:var(--bad)">Switched on, not listening</b>` : `<b>Off</b> on this server: nothing listens for traps until an admin switches it on.`}</p>
      ${st.error ? `<p class="status err" style="margin:0 0 6px">${esc(st.error)}</p>` : ""}
      ${st.admin ? `<div class="row" style="gap:8px;align-items:end;flex-wrap:wrap;margin-bottom:6px"><label>UDP port<input id="mnPort" type="number" min="1" max="65535" value="${esc(S0.port)}" style="width:100px"></label>
        <button id="mnOn" class="${on ? "" : "primary"}">${on ? "Switch off" : "Switch on"}</button><span class="hint" style="flex:1 1 220px">${esc(st.firewall)}</span></div>` : ""}
      ${open.length || quiet.length ? `<div id="mnOpen" style="margin:6px 0">${open.map(a => `<div class="row" style="justify-content:space-between;gap:8px;border-top:1px solid var(--line);padding:4px 0">
          <span><b style="color:var(--bad)">${esc(a.label)}</b> · ${esc(a.bda)}<div class="hint">${esc(a.section)}; ${esc(a.ifc)}${a.text ? ` · the BDA said "${esc(a.text.slice(0, 120))}"` : ""}</div></span>
          <span class="mono" style="white-space:nowrap">since ${esc(when(a.since))}</span></div>`).join("")}
        ${quiet.map(b => `<div class="row" style="justify-content:space-between;gap:8px;border-top:1px solid var(--line);padding:4px 0"><span><b style="color:var(--warn)">Not heard from in ${esc(b.quiet_hours)} hours</b> · ${esc(b.name || "BDA")}
          <div class="hint">A BDA that goes quiet may have lost power, its network or its monitor: check it.</div></span><span class="mono" style="white-space:nowrap">${b.last ? `last ${esc(when(b.last))}` : "no trap yet"}</span></div>`).join("")}</div>`
        : bdas.length && on ? `<p class="hint" style="margin:6px 0" id="mnOpen">No open alarms.</p>` : ""}
      <h4 style="margin:8px 0 4px">BDAs on this job</h4>
      ${bdas.length ? `<div class="tw"><table><thead><tr><th>Name</th><th>Address</th><th>Community / v3 user</th><th>Quiet after</th><th>Last heard</th><th></th></tr></thead><tbody>${bdas.map((b, i) => { const s = byId[b.id] || {};
        return `<tr data-mb="${i}"><td>${esc(b.name || "")}</td><td class="mono">${esc(b.address || "")}</td><td class="mono"${b.v3?.user ? ' style="white-space:normal;min-width:150px"' : ""}>${b.v3?.user ? v3Cell(b, s) : esc(b.community || "")}</td><td>${esc(b.quiet_hours || st.quiet_hours)} h</td>
          <td class="hint">${s.last ? esc(when(s.last)) : "nothing yet"}${s.count ? ` · ${s.count} traps` : ""}</td><td><button class="sm" data-mdel="${i}" title="Stop monitoring this BDA (its traps stay)">✕</button></td></tr>`; }).join("")}</tbody></table></div>`
        : '<p class="hint" style="margin:0">None yet.</p>'}
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:end;margin-top:6px">
        <label class="grow">Name<input id="mnName" placeholder="e.g. Main BDA, 2nd floor riser" style="min-width:160px"></label>
        <label>Address<input id="mnAddr" placeholder="203.0.113.10 or a range /24" style="width:180px"></label>
        <label>SNMP<select id="mnVer"><option value="v2c">v2c</option><option value="v3">v3</option></select></label>
        <label id="mnComL">Community<input id="mnCom" value="rfr-${j.id}-${rid()}" style="width:170px"></label>
        <label>Quiet after (h)<input id="mnQuiet" type="number" min="1" value="${esc(st.quiet_hours)}" style="width:80px"></label></div>
      <div class="row" id="mnV3" style="gap:8px;flex-wrap:wrap;align-items:end;margin-top:6px;display:none">
        <label>v3 user<input id="mnUser" value="rfr-${j.id}" style="width:130px" autocomplete="off"></label>
        <label>Authentication<select id="mnAuth">${V3_AUTH.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select></label>
        <label>Auth passphrase<input id="mnAuthP" type="password" autocomplete="new-password" placeholder="8 characters or more" style="width:170px"></label>
        <label>Privacy<select id="mnPriv"><option value="aes">AES-128</option><option value="none">None</option></select></label>
        <label>Privacy passphrase<input id="mnPrivP" type="password" autocomplete="new-password" placeholder="8 characters or more" style="width:170px"></label></div>
      <div class="row" style="margin-top:6px"><button id="mnAdd">Add BDA</button></div>
      <p class="hint" style="margin:4px 0 0">Set the BDA (or its monitoring unit) to send SNMP traps to this server, UDP ${esc(S0.port)}. v2c: with the community above; a trap is filed when its source address or its community matches, and a shared community (public, private) needs the address. v3 (CISA advises v3 only): the BDA's user, SHA or SHA-2 and AES-128 (authPriv); a trap is filed when its key checks out. The passphrases go to this server's sealed key file and never show again. v3 informs and DES privacy aren't read: an older BDA that offers only DES (some Bird models) sends v3 with authentication only (SHA, no privacy), or v2c. DAStastic only listens; it never sends a BDA a command.</p>
      ${js.recent.length ? `<h4 style="margin:10px 0 4px">Traps <span class="hint">· newest first</span></h4><div class="tw"><table id="mnTraps"><thead><tr><th>When</th><th>BDA</th><th>Signal</th><th>The BDA said</th></tr></thead><tbody>${js.recent.map(r => `<tr>
          <td class="mono">${esc(when(r.ts))}</td><td>${esc(bdas.find(b => b.id === r.bda)?.name || r.bda || "")}</td><td style="white-space:normal">${what(r)}${r.state === "unmapped" ? `<div><select data-mmap="${esc(r.trap_oid)}" data-mbda="${esc(r.bda || "")}" style="max-width:260px">${mapOpts}</select></div>` : ""}</td>
          <td class="hint" style="white-space:normal;max-width:320px">${esc((r.text || "").slice(0, 200))}</td></tr>`).join("")}</tbody></table></div>` : ""}
      <details style="margin-top:8px"><summary>Why this, and its limits</summary>
        <p class="hint">The code requires the system to send supervisory signals (<a href="${NFPA}" target="_blank" rel="noopener">NFPA 1225 (2022) 18.14.1.2</a>; <a href="${IFC}" target="_blank" rel="noopener">IFC 2021 510.4.2.5</a>): ${st.signals.map(s => `${esc(s.label)} (${esc(s.section)})`).join("; ")}. These go to the fire alarm panel; this panel watches the same signals from the BDA's own SNMP traps, from any maker. A trap with no readable words shows its OID until you map it.</p>
        <p class="hint">OCSD's guideline asks for it: "${esc(st.ocsd.text)}" (<a href="${esc(st.ocsd.source)}" target="_blank" rel="noopener">${esc(st.ocsd.section)}</a>). ${esc(st.ocsd.also)}</p>
        <p class="hint">DAStastic never sends SNMP to a BDA: no replies to informs, no GET, no SET. Remote RF shut-off stays with the licensee. Alarm emails wait in Mail › Ready to send for a click.</p></details>`;
    const redraw = nj => panel(el, nj || j, save);
    const keep = async bl => { const nj = await save({ monitor: { ...M, bdas: bl } }); redraw(nj); };
    const ver = el.querySelector("#mnVer");
    ver.onchange = () => { const v3 = ver.value === "v3"; el.querySelector("#mnV3").style.display = v3 ? "" : "none"; el.querySelector("#mnComL").style.display = v3 ? "none" : ""; };
    el.querySelector("#mnAuth").onchange = el.querySelector("#mnPriv").onchange = () => {
      const a = el.querySelector("#mnAuth").value, p = el.querySelector("#mnPriv");
      if (a === "none") p.value = "none";
      el.querySelector("#mnAuthP").disabled = a === "none"; el.querySelector("#mnPrivP").disabled = a === "none" || p.value === "none"; };
    el.querySelector("#mnAdd").onclick = async () => {
      const name = el.querySelector("#mnName").value.trim(), address = el.querySelector("#mnAddr").value.trim(), community = el.querySelector("#mnCom").value.trim();
      if (ver.value === "v3") {
        const user = el.querySelector("#mnUser").value.trim(), auth = el.querySelector("#mnAuth").value, priv = auth === "none" ? "none" : el.querySelector("#mnPriv").value;
        const auth_pass = el.querySelector("#mnAuthP").value, priv_pass = el.querySelector("#mnPrivP").value;
        if (!user) { dasSay("Give the v3 user the BDA sends as."); return; }
        if (auth !== "none" && auth_pass.length < 8) { dasSay("The auth passphrase is 8 characters or more (RFC 3414)."); return; }
        if (priv === "aes" && priv_pass.length < 8) { dasSay("The privacy passphrase is 8 characters or more (RFC 3414)."); return; }
        if (bdas.some(b => b.v3?.user === user)) { dasSay(`This job already has a BDA sending as v3 user ${user}: give each BDA its own user.`); return; }
        const t = new Date(), added = `${ymd(t)} ${t.toTimeString().slice(0, 8)}`, id = rid();
        const nj = await save({ monitor: { ...M, bdas: [...bdas, { id, name: name || `BDA ${bdas.length + 1}`, address, community: "", v3: { user, auth, priv },
          quiet_hours: +el.querySelector("#mnQuiet").value || st.quiet_hours, added, map: {} }] } });
        if (auth !== "none") await post(`/api/das/monitor/jobs/${j.id}/v3`, { bda: id, auth_pass, ...(priv === "aes" ? { priv_pass } : {}) }).catch(e => dasSay(e.message));
        redraw(nj);
        return;
      }
      if (!address && !community) { dasSay("Give the BDA's address or a community string."); return; }
      if (!address && /^(public|private)$/i.test(community)) { dasSay("A shared community (public, private) needs the BDA's address too."); return; }
      const t = new Date(), added = `${ymd(t)} ${t.toTimeString().slice(0, 8)}`;
      keep([...bdas, { id: rid(), name: name || `BDA ${bdas.length + 1}`, address, community, quiet_hours: +el.querySelector("#mnQuiet").value || st.quiet_hours, added, map: {} }]);
    };
    el.querySelectorAll("[data-mdel]").forEach(b => b.onclick = () => { const bl = [...bdas]; bl.splice(+b.dataset.mdel, 1); keep(bl); });
    el.querySelectorAll("[data-mmap]").forEach(s => s.onchange = async () => {
      if (!s.value) return;
      const bl = bdas.map(b => b.id === s.dataset.mbda ? { ...b, map: { ...(b.map || {}), [s.dataset.mmap]: s.value } } : b);
      const nj = await save({ monitor: { ...M, bdas: bl } });
      await post(`/api/das/monitor/jobs/${j.id}/reclassify`).catch(e => dasSay(e.message));
      redraw(nj);
    });
    const sw = el.querySelector("#mnOn");
    if (sw) sw.onclick = async () => {
      const port = +el.querySelector("#mnPort").value;
      if (!on && !confirm(`Listen for SNMP traps on UDP ${port}?\n\nNothing reaches it from outside until the server's firewall lets UDP ${port} in.`)) return;
      sw.disabled = true;
      try { await post("/api/das/monitor/settings", { on: !on, port }); } catch (e) { dasSay(e.message); }
      redraw();
    };
  }
  window.dasMonitor = panel;
})();
