/* Where to shop (partshop.py; Cody 11/8: "just ranking sites over all having the customers pick your high ranked ones",
   "just say whose website you should look at"). In a DAS job's Materials: pick a line and its suppliers sit side by side,
   the ones you buy from first, each opening a search of that supplier's own site for the part; below, every DAS supplier
   ranked by one score from public facts (the reasons on the score), with a tick for the ones you buy from. DAStastic
   copies no supplier's prices for this: you see them on the supplier's own site. */
(function () {
  const KIND = {bda: "BDAs and repeaters", das: "DAS head-ends and remotes", coax: "Coax", connector: "Connectors",
    passive: "Splitters, couplers, filters", antenna: "Antennas", surge: "Surge protection", power: "Backup power",
    alarm: "Annunciators and alarms", cellbooster: "Cell boosters (consumer)", enclosure: "Enclosures and racks", mounting: "Mounting", fiber: "Fiber", test: "Test gear"};
  const PRICES = {"yes": "Prices on the site", "partial": "Some prices on the site", "login": "Prices after you sign in",
    "quote only": "By quote", "": "Prices not known"};
  const S = {all: null, kind: "", q: "", line: ""};
  const lineText = x => `${x.cat ? x.cat + ": " : ""}${x.item || ""}${x.part ? ` (${x.part})` : ""}`;

  window.dasShop = async (el, bom) => {
    if (!el) return;
    const lines = (bom || []).filter(x => x.part || x.item);
    el.innerHTML = `<h3>Where to shop <span class="hint">· every DAS supplier we know of, ranked from public facts about each · tick the ones you buy from</span></h3>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:end">
        <label class="grow">For a line on this job<select id="dsLine"><option value="">${lines.length ? "Pick a line…" : "Add lines to the bill of materials first"}</option>
          ${lines.map((x, i) => `<option value="${i}" ${String(i) === S.line ? "selected" : ""}>${esc(lineText(x))}</option>`).join("")}</select></label></div>
      <div id="dsWhere"></div>
      <details id="dsAllBox" style="margin-top:8px"><summary id="dsSum">All suppliers, ranked</summary>
        <div class="row" style="gap:8px;flex-wrap:wrap;align-items:end;margin-top:6px">
          <label>Carries<select id="dsKind"><option value="">Any kind of part</option>${Object.entries(KIND).map(([k, t]) => `<option value="${k}" ${S.kind === k ? "selected" : ""}>${t}</option>`).join("")}</select></label>
          <label class="grow">Find<input id="dsQ" placeholder="supplier, brand or kind of part" value="${esc(S.q)}"></label></div>
        <div id="dsAll"></div>
        <p class="hint" style="margin:6px 0">The score is out of 100: DAS range up to 40 (how many kinds of DAS part it carries), public safety lines 15,
          prices on its site 20 (some 12, after a sign-in 6, by quote 0), a distributor or online store 10 (a reseller 7, a maker 5), US 10 (Canada 6,
          ships here from overseas 3), an official API 5. Hold the pointer on a score for its reasons. Each supplier's facts were read on its own site on the date shown.</p>
      </details>`;
    const sel = el.querySelector("#dsLine");
    sel.onchange = () => { S.line = sel.value; where(lines[+sel.value]); };
    el.querySelector("#dsKind").onchange = e => { S.kind = e.target.value; all(); };
    let t; el.querySelector("#dsQ").oninput = e => { clearTimeout(t); t = setTimeout(() => { S.q = e.target.value; all(); }, 200); };
    await all();
    if (S.line !== "" && lines[+S.line]) where(lines[+S.line]);
    else if (!S.all || !S.all.picked.length) el.querySelector("#dsAllBox").open = true;  // nothing ticked yet: the ranking is the place to start
  };

  async function all() {
    const box = document.getElementById("dsAll"); if (!box) return;
    let r;
    try { r = await api(`/api/das/shop?kind=${encodeURIComponent(S.kind)}&q=${encodeURIComponent(S.q)}`); }
    catch (e) { box.innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }
    S.all = r;
    const sum = document.getElementById("dsSum");
    if (sum) sum.textContent = `All suppliers, ranked (${r.total}) · ${r.picked.length} you buy from`;
    box.innerHTML = !r.suppliers.length ? `<p class="hint">No supplier matches.</p>` : `<div class="tw" style="max-height:420px"><table id="dsT">
      <thead><tr><th title="Tick the suppliers you buy from: they come first for each line">Buy from</th><th class="n">Rank</th><th>Supplier</th><th class="n">Score</th>
        <th>Kind</th><th>Based</th><th>Carries</th><th>Prices</th><th>Site</th></tr></thead><tbody>
      ${r.suppliers.map(s => `<tr><td><input type="checkbox" data-dspick="${esc(s.id)}" ${s.picked ? "checked" : ""} aria-label="Buy from ${esc(s.name)}"></td>
        <td class="n">${s.rank}</td><td style="white-space:normal;min-width:12em"><b>${esc(s.name)}</b>${s.ps ? ` <span class="tag" title="${esc(s.public_safety)}">public safety</span>` : ""}${s.flag ? ` <span class="tag warn" title="${esc(s.flag)}">check: FCC Covered List</span>` : ""}</td>
        <td class="n" title="${esc((s.score_why || []).join("; "))}">${s.score}</td><td>${esc(s.kind)}</td><td>${esc(s.country)}</td>
        <td style="white-space:normal;min-width:14em">${esc(s.kinds.map(k => KIND[k] || k).join(", "))}</td><td>${esc(PRICES[s.prices] || s.prices)}</td>
        <td>${s.site ? `<a href="${esc(s.site)}" target="_blank" rel="noopener">${esc(s.host)} ↗</a>` : ""} <span class="hint">${esc(s.checked)}</span></td></tr>`).join("")}
      </tbody></table></div>`;
    box.querySelectorAll("[data-dspick]").forEach(c => c.onchange = async () => {
      try { await post("/api/das/shop/pick", {id: c.dataset.dspick, on: c.checked}); }
      catch (e) { c.checked = !c.checked; alert(e.message); return; }
      const sel = document.getElementById("dsLine");
      await all();
      if (sel && sel.value !== "") sel.onchange();
    });
  }

  async function where(line) {
    const box = document.getElementById("dsWhere"); if (!box) return;
    if (!line) { box.innerHTML = ""; return; }
    box.innerHTML = `<p class="hint">Finding where to look…</p>`;
    const q = new URLSearchParams({cat: line.cat || "", item: line.item || "", part: line.part || "", maker: line.maker || "", note: line.note || "", n: "8"});
    let r;
    try { r = await api(`/api/das/shop/where?${q}`); } catch (e) { box.innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }
    const mine = r.sites.filter(s => s.picked).length;
    box.innerHTML = `<p class="hint" style="margin:6px 0">${r.kind ? `${esc(KIND[r.kind] || r.kind)}: ` : ""}${mine ? `${mine} of yours first, then the best of the rest.` : "The best ranked for it. Tick the ones you buy from in the list below and they come first."}
        Each opens a search of that supplier's own site for ${line.part ? `<b>${esc(line.part)}</b>` : "it"}.</p>
      <div class="ds-cards">${r.sites.map(s => `<div class="ds-card${s.picked ? " ds-mine" : ""}">
        <div class="ds-h"><b>${esc(s.name)}</b>${s.picked ? ` <span class="tag">you buy here</span>` : ""}${s.flag ? ` <span class="tag warn" title="${esc(s.flag)}">check: FCC Covered List</span>` : ""}</div>
        <div class="hint">#${s.rank} · score ${s.score} · ${esc(s.country)} · ${esc(PRICES[s.prices] || s.prices)}${s.public_safety ? " · public safety" : ""}</div>
        ${s.seen ? `<div class="ds-seen"><a href="${esc(s.seen.url)}" target="_blank" rel="noopener" title="Read on their own site at night by DAStastic; check it there before you order">Their site: <b>$${(+s.seen.price).toLocaleString(undefined, {minimumFractionDigits: 2})}</b>${s.seen.unit ? ` / ${esc(s.seen.unit)}` : ""}</a> <span class="hint">read ${esc(s.seen.at)}${s.seen.stock ? ` · ${esc(s.seen.stock)}` : ""}</span></div>` : ""}
        <div class="row" style="gap:6px;margin-top:6px"><a class="btn" href="${esc(s.search)}" target="_blank" rel="noopener">Search their site ↗</a>
          ${s.site ? `<a class="hint" href="${esc(s.site)}" target="_blank" rel="noopener">site ↗</a>` : ""}</div></div>`).join("")}</div>`;
  }
})();
