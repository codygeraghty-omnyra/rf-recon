"use strict";
/* DAStastic: what the job's file says is next, on the board and the job (nextstep.py), and the retest and its dates (retest.py).
   The server reads the file: nothing here works anything out. What a person typed in Next step wins, and a stage move or a date is a
   proposal: it only happens when a person presses, and a stage press goes through the gate (dascode.js dasMoveStage).
   Needs core.js, das.js, dascode.js. */
(() => {
  const stand = j => j.standing || {};
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  /* ---------- the board ---------- */
  window.dasNextText = j => (stand(j).next || {}).text || j.next_step || "";
  window.dasCardNext = j => { const s = stand(j), n = s.next, m = s.move, due = j.due || (n && n.due);
    return `${n ? `<div class="ds-next" style="font-size:12px;margin-top:4px" title="${n.from === "typed" ? "Typed on the job's Overview" : "Worked out from the job's file"}">Next: ${esc(n.text)}${due ? ` · <span class="mono">${esc(due)}</span>` : ""}</div>` : ""}
      ${m ? `<button class="sm" data-move="${j.id}" data-to="${esc(m.to)}" style="margin-top:6px" title="Nothing moves until you press this. The gate checks it again">Move to ${esc(m.to)}</button>` : ""}`; };
  // lines for Needs you: [text, sort, what the row carries]
  window.dasNextNeeds = j => { const s = stand(j), r = s.retest, out = [];
    if (s.error) out.push([`DAStastic couldn't read this job's next step: ${s.error}`, 0, {}]);
    if (r && r.proposals.length) out.push([`${r.name}: ${plural(r.proposals.length, "date")} waiting on your press`, -1e4, {}]);
    else if (r && r.held) out.push([`${r.name}: ${r.held}`, -1e4, {}]);
    if (s.move) out.push([`Ready for ${s.move.to}`, 0, { move: s.move.to }]);
    return out; };
  window.dasMoveWire = root => root.querySelectorAll("[data-move]").forEach(b => b.addEventListener("click", e => { e.stopPropagation(); b.disabled = true; window.dasMoveStage(+b.dataset.move, b.dataset.to, () => render()); }));

  /* ---------- the job ---------- */
  const when = r => !r.due ? "" : r.state === "overdue" ? `Was due ${r.due}, ${plural(-r.days, "day")} ago.` : `Due ${r.due}, in ${plural(r.days, "day")}.`;
  const stepRow = (done, title, said, btn) => `<li class="${done ? "ok" : ""}"><b>${done ? "✓ " : ""}${esc(title)}</b> <span class="hint">${esc(said)}</span>${btn || ""}</li>`;
  function retestHtml(r) {
    const seal = r.sealed, inst = r.offered || [];
    return `<div class="panel" id="doRetest"><h3 style="margin:0 0 4px">${esc(r.name)} <span class="hint">· ${r.open ? "opened by itself" : "open on this job"}</span></h3>
      <p style="margin:0 0 6px">${esc(when(r))} The first acceptance stays as it is: this test goes beside it. Same floors, squares and critical list as the last test.</p>
      ${inst.length ? `<p class="hint" style="margin:0 0 6px" id="rtInst">Taken last time with: ${inst.map(i => `${esc(i.name)} (${esc(i.why)}${i.ok ? "" : ", so its readings won't count"})`).join("; ")}.${inst.some(i => !i.ok) ? " Add a calibrated one under Testing on this page." : ""}</p>` : ""}
      <ol class="dg-where" id="rtSteps">
        ${stepRow(r.walked > 0, "Walk it", r.walked ? `${plural(r.walked, "reading")} so far` : "The pass is ready on the Grid test's Walk", `<button class="sm" data-rtgo="grid" style="margin-left:6px">Open the Walk</button>`)}
        ${stepRow(!!seal, "Seal the report", seal ? `Sealed ${seal.at.slice(0, 10)}, code ${seal.code}, ${seal.result}` : "Report tab, Print as final", seal ? "" : `<button class="sm" data-rtgo="report" style="margin-left:6px">Open the Report</button>`)}
        ${stepRow(!!r.sent, "Send it to the AHJ", r.sent ? `Sent ${r.sent.day}` : "Report tab, email the AHJ with the PDF attached", seal && !r.sent ? `<button class="sm" data-rtgo="report" style="margin-left:6px">Open the Report</button>` : "")}
      </ol>
      ${r.held ? `<p class="status err" style="margin:6px 0 0" id="rtHeld">${esc(r.held)}</p>` : ""}
      ${r.proposals.length ? `<h4 style="margin:10px 0 4px">Dates to set <span class="hint">· nothing changes until you press. Change a date first if it's wrong</span></h4>
        <div id="rtDates">${r.proposals.map(p => `<div class="row" data-prop="${esc(p.key)}" style="gap:8px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--line);padding:6px 0"><span style="flex:1 1 200px"><b>${esc(p.label)}</b><div class="hint">From ${esc(p.from)}</div></span>
          <input type="date" value="${esc(p.date)}" aria-label="${esc(p.label)}"><button class="primary" data-take="${esc(p.key)}">Set it</button><button data-no="${esc(p.key)}">Not this</button></div>`).join("")}</div>` : ""}</div>`;
  }
  window.dasNextPanel = (el, j) => { if (!el) return;
    const s = stand(j), n = s.next, r = s.retest, on = s.done || {}, w = s.worked;
    const typedOver = n && n.from === "typed" && w && w.text !== n.text;
    el.innerHTML = `${n || s.move ? `<div class="panel no-print" id="doNextLine" style="margin:0 0 10px"><div class="row" style="gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between">
        <span>${n ? `<b>Next:</b> ${esc(n.text)}` : ""}${n && n.from === "typed" ? ` <span class="hint">· typed below</span>` : on.of ? ` <span class="hint">· ${esc(j.stage)}: ${on.on} of ${on.of} on file</span>` : ""}</span>
        <span class="row" style="gap:6px">${n && n.sub && n.sub !== "overview" ? `<button class="sm" data-rtgo="${esc(n.sub)}">Go there</button>` : ""}${s.move ? `<button class="sm primary" data-move="${j.id}" data-to="${esc(s.move.to)}">Move to ${esc(s.move.to)}</button>` : ""}</span></div>
        ${typedOver ? `<div class="hint" style="margin-top:2px">The job's file says: ${esc(w.text)}</div>` : ""}</div>` : ""}${r ? retestHtml(r) : ""}`;
    el.querySelectorAll("[data-rtgo]").forEach(b => b.onclick = () => { S.das.sub = b.dataset.rtgo; if (b.dataset.rtgo === "grid") S.das.mark = "walk"; render(); });
    window.dasMoveWire(el);
    el.querySelectorAll("[data-take],[data-no]").forEach(b => b.onclick = async () => { const take = b.dataset.take, row = b.closest("[data-prop]"); b.disabled = true;
      try { await post(`/api/das/x/retest/${j.id}`, take ? { take, date: row.querySelector("input").value } : { no: b.dataset.no }); render(); }
      catch (e) { b.disabled = false; dasSay("Not saved: " + e.message); } });
  };
  // what the Report's email calls the report: the pass the grid uses says which test it is
  window.dasReportWord = d => { let kind = "acceptance"; try { kind = (wkPasses(d).find(p => p.id === wkGraded(d)) || {}).kind || kind; } catch (e) { /* no walk code on this page */ }
    return kind === "annual" ? "annual test report" : kind === "five_year" ? "five-year test report" : "acceptance test report"; };
})();
