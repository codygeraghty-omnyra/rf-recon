"use strict";
/* DAStastic: the DAS fault isolation chart (Cody 11/5: "so refined that anyone could use it and run a DAS job start to
   finish"). Three ways in: run the job by stage, start from what's wrong, or the signal path. One step at a time with the
   drawn chart beside it; a failed check goes to its fault chart and comes back when it's fixed. On a job it opens at the
   job's stage and type, and a step can jump to the place in the job that does it and save what was done to the job's Log.
   Steps run quickest safe check first, never a claim about what's likely: no source ranks causes. A "Stop" box is where no
   source has a number: it names who to call, and it won't guess. Content: dasfi_data.js. Needs core.js. */
(() => {
  const FI = () => window.DAS_FI;
  const TREES = () => new Map(FI().trees.map(t => [t.id, t]));
  const KIND = { test: ["Check", "--fk-test"], do: ["Do this", "--fk-do"], fix: ["Fix", "--fk-fix"], stop: ["Stop", "--fk-stop"], done: ["Done", "--fk-done"] };
  const STAGES = ["Lead", "Pre-survey", "Design", "Install", "Commission", "Acceptance", "In service", "Closed"];
  const STAGE_LINE = ["The building, the AHJ, the scope", "Which systems, how strong inside", "Prove it on paper, get it approved", "Build it, test as you go", "Set the booster, step by step", "The grid test and the report", "Annual tests, alarms, renewals", "Hand over, or say why it ended"];
  const PAGES = [["run", "Run the job"], ["fault", "Something's wrong"], ["path", "Signal path"], ["limits", "Limits"], ["charts", "All charts"], ["about", "How it works"]];
  const SUB = { Overview: "overview", "Pre-survey": "presurvey", Plans: "plans", Requirements: "require", Design: "design", Materials: "materials", Commissioning: "commission", "Grid test": "grid", Screening: "screen", Report: "report", Files: "files", Log: "log", "Existing system": "audit" };
  const F = () => S.dasFi || (S.dasFi = { page: "run", tree: null, step: null, path: [], stack: [], tp: "TP3", scope: "e", stage: 1, jobId: null });
  let ROOT = null, JOB = null;

  const inScope = t => F().scope === "b" || t.scope === "both" || t.scope === F().scope;
  const runFor = n => FI().trees.filter(t => t.kind === "run" && t.stage === n && (t.scope === "both" || F().scope === "b" || t.scope === F().scope));
  const GRE = () => new RegExp(`\\b(${Object.keys(FI().glossary).join("|")})\\b`, "g");
  const gloss = s => { const seen = new Set(); return esc(s || "").replace(GRE(), m => { if (seen.has(m)) return m; seen.add(m); return `<abbr title="${esc(FI().glossary[m])}">${m}</abbr>`; }); };
  const isTree = id => TREES().has(id), nameOf = id => TREES().get(id)?.title || id;
  const go = (tree, step) => { const f = F(); f.page = "walk"; f.tree = tree; f.step = step || null; draw(); ROOT?.scrollIntoView({ block: "nearest" }); };
  const branches = n => n.opts ? n.opts.map(o => ({ l: o.l, to: o.to }))
    : n.k === "test" ? [{ l: "Yes", to: n.yes, c: "fi-yes" }, { l: "No", to: n.no, c: "fi-no" }]
    : n.next ? [{ l: n.k === "stop" ? "Sorted, carry on" : "Done, next", to: n.next, c: "primary" }] : [];

  /* the drawn chart: the longest branch runs straight down, side branches to the right. An edge to a step already drawn, or
     to another chart, ends in a labelled chip, so a chart never turns into spaghetti */
  function layout(t) {
    const by = new Map(t.nodes.map(n => [n.id, n])), drawn = new Set(), num = new Map();
    t.nodes.forEach((n, i) => num.set(n.id, i + 1));
    const build = (id, lab, after) => {
      if (isTree(id)) return { go: id, lab, kids: after ? [build(after, "")] : [] };
      if (drawn.has(id)) return { back: id, lab, kids: [] };
      drawn.add(id); const n = by.get(id), kids = [];
      for (const b of branches(n)) kids.push(build(b.to, n.k === "test" ? b.l : "", n.then));
      if (n.k === "done" && n.stage) kids.push({ go: `stage:${n.stage}`, lab: "", kids: [] });
      if (n.k !== "test" && kids.length === 1 && kids[0].back) return { n, lab, kids: [], ret: kids[0].back };
      return { n, lab, kids };
    };
    return { root: build(t.start, ""), num };
  }
  function chart(host, t, walked = new Set(), now = null, click = null) {
    const { root, num } = layout(t), W = 210, GX = 26, GY = 44, c = document.createElement("div"), all = [];
    c.className = "fi-chart"; host.innerHTML = ""; host.append(c);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); c.append(svg);
    const mk = v => { const el = document.createElement("button"); el.type = "button";
      if (v.n) { el.className = "fi-nd"; el.style.setProperty("--c", `var(${KIND[v.n.k][1]})`);
        el.innerHTML = `<span class="fi-num">${num.get(v.n.id)} · ${KIND[v.n.k][0]}</span>${esc(v.n.t)}${v.ret ? `<span class="fi-rt">Then back to step ${num.get(v.ret)}</span>` : ""}`; el.dataset.id = v.n.id;
        if (walked.has(v.n.id)) el.classList.add("walked"); if (now === v.n.id) el.classList.add("now"); }
      else if (v.go) { el.className = "fi-nd fi-go"; const st = String(v.go).startsWith("stage:") ? STAGES[+v.go.slice(6) - 1] : null; el.textContent = st ? `Next stage: ${st}` : `${v.go}: ${nameOf(v.go)}`; el.dataset.go = v.go; }
      else { el.className = "fi-nd fi-back"; el.textContent = `Back to step ${num.get(v.back)}`; el.dataset.id = v.back; }
      v.el = el; c.append(el); all.push(v); v.kids.forEach(mk); };
    mk(root);
    all.forEach(v => { v.w = v.el.offsetWidth || W; v.h = v.el.offsetHeight || 40; });
    const size = v => v.size ??= 1 + v.kids.reduce((n, k) => n + size(k), 0), tall = v => v.tall ??= 1 + Math.max(0, ...v.kids.map(tall));
    const main = v => v.kids.reduce((b, k) => !b || size(k) > size(b) ? k : b, null), occ = [], depthH = [];
    const spine = (v0, col, d0) => { const sides = []; let v = v0, d = d0;
      while (v) { v.col = col; v.depth = d; occ[d] = Math.max(occ[d] ?? -1, col); depthH[d] = Math.max(depthH[d] || 0, v.h);
        const m = main(v); v.kids.forEach(k => { if (k !== m) sides.push([k, d + 1]); }); v = m; d++; }
      sides.reverse().forEach(([k, dd]) => { let cc = col; for (let i = dd; i < dd + tall(k); i++) cc = Math.max(cc, occ[i] ?? -1); spine(k, cc + 1, dd); }); };
    spine(root, 0, 0);
    const ys = []; let y = 12; depthH.forEach((h, i) => { ys[i] = y; y += h + GY; });
    const cols = Math.max(...all.map(v => v.col)) + 1, width = cols * (W + GX) - GX + 24, height = y - GY + 12;
    all.forEach(v => v.cx = 12 + v.col * (W + GX) + W / 2);
    c.style.width = width + "px"; c.style.height = height + "px"; svg.setAttribute("width", width); svg.setAttribute("height", height); svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    all.forEach(v => { v.el.style.left = v.cx - v.w / 2 + "px"; v.el.style.top = ys[v.depth] + "px"; });
    let paths = "";
    all.forEach(v => v.kids.forEach(k => { const x1 = v.cx, y1 = ys[v.depth] + v.h, x2 = k.cx, y2 = ys[k.depth], my = y1 + (y2 - y1) / 2, r = Math.min(10, Math.abs(x2 - x1) / 2), s = x2 > x1 ? 1 : -1;
      const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}V${my - r}Q${x1} ${my} ${x1 + s * r} ${my}H${x2 - s * r}Q${x2} ${my} ${x2} ${my + r}V${y2}`;
      const on = v.n && walked.has(v.n.id) && ((k.n && walked.has(k.n.id)) || (k.back && walked.has(k.back)));
      paths += `<path d="${d}"${on ? ' class="walked"' : ""}/>`;
      if (k.lab) { const l = document.createElement("span"); l.className = "fi-lab"; l.textContent = k.lab; l.style.left = x2 + "px"; l.style.top = y2 - 12 + "px"; c.append(l); } }));
    svg.innerHTML = paths;
    if (click) c.addEventListener("click", e => { const b = e.target.closest(".fi-nd"); if (b) click(b.dataset.id, b.dataset.go); });
    return { width, height, el: c, ys, depthH };
  }

  const KEY = `<div class="fi-key"><span style="--c:var(--fk-test)"><i></i>Check</span><span style="--c:var(--fk-do)"><i></i>Do this</span><span style="--c:var(--fk-fix)"><i></i>Fix</span><span style="--c:var(--fk-stop)"><i></i>Stop: call someone</span><span style="--c:var(--fk-done)"><i></i>Done</span><span>Dashed: another chart. It brings you back when it's fixed.</span></div>`;
  function pageRun() { const f = F(), here = f.stage;
    return `<p class="hint" style="margin:0 0 10px;max-width:90ch">Pick the stage. Each one walks you through it a step at a time, and sends you to the right fault chart when something fails.</p>
    ${JOB && window.dasWalkOpen ? `<button class="primary" id="fiGuide" style="margin-bottom:10px" title="Checks what's on file, picks up where the job stands, and moves you to each place">Walk me through this job</button>` : ""}
    <div class="fi-stages">${STAGES.map((s, i) => `<button class="fi-stage${here === i + 1 ? " here" : ""}" data-stage="${i + 1}"><span class="fi-num">${i + 1}</span><b>${s}</b><p>${STAGE_LINE[i]}</p></button>`).join("")}</div>
    ${runFor(here).map(t => `<div class="panel"><h3>${esc(t.title)}</h3><p style="margin:0 0 8px">${gloss(t.goal)}</p>
      <dl class="fi-dl"><dt>Who</dt><dd>${gloss(t.who)}</dd><dt>Tools</dt><dd>${gloss(t.tools)}</dd><dt>Done when</dt><dd>${gloss(t.gate)}</dd></dl>
      <button class="primary" data-walk="${t.id}">Start ${esc(t.title)}</button></div>`).join("")}
    ${KEY}${runFor(here).map(t => `<div class="panel" style="padding:10px"><div class="fi-wrap" data-chart="${t.id}"></div></div>`).join("")}`; }
  function pageFault() { const list = FI().trees.filter(t => t.kind === "fault" && inScope(t)), gs = [...new Set(list.map(t => t.group))];
    return `<p class="hint" style="margin:0 0 10px;max-width:90ch">Pick what you're seeing. Each chart runs quickest safe check first. That order saves you time: it isn't a claim about what's most likely.</p>
    <input id="fiFind" placeholder="Search: oscillation, grey reading, low battery" style="width:min(460px,100%);margin-bottom:6px"><div id="fiHits"></div>
    ${gs.map(g => `<div class="fi-group">${esc(g)}</div><div class="fi-grid">${list.filter(t => t.group === g).map(t => `<button class="fi-card" data-walk="${t.id}"><span class="fi-id">${t.id}</span><b>${esc(t.title)}</b><span>${gloss(t.see)}</span></button>`).join("")}</div>`).join("")}`; }
  function pagePath() { const f = F(), key = f.scope === "c" ? "c" : "e", tps = [...FI().tps, ...FI().tpsLow], tp = tps.find(x => x.id === f.tp) || tps[3];
    const block = (b, y, w = 124, h = 76) => { const long = b.name.length > 15, w1 = long ? b.name.split(" ").slice(0, 2).join(" ") : b.name, w2 = long ? b.name.split(" ").slice(2).join(" ") : "";
      return `<g class="fi-blk${b.id === tp.id ? " on" : ""}" data-tp="${b.id}" tabindex="0" role="button" aria-label="${esc(b.name)}"><rect x="${b.x - w / 2}" y="${y}" width="${w}" height="${h}" rx="12"/><text x="${b.x}" y="${y + 26}" text-anchor="middle">${esc(w1)}</text>${w2 ? `<text x="${b.x}" y="${y + 43}" text-anchor="middle">${esc(w2)}</text>` : ""}<text class="tp" x="${b.x}" y="${y + h - 7}" text-anchor="middle">${b.id}</text></g>`; };
    const top = 56, mid = top + 38, lines = FI().tps.slice(0, -1).map((b, i) => { const n = FI().tps[i + 1], air = i === 0 || i === FI().tps.length - 2; return `<line ${air ? 'class="air" ' : ""}x1="${b.x + 62}" y1="${mid}" x2="${n.x - 62}" y2="${mid}"/>`; }).join("");
    return `<p class="hint" style="margin:0 0 10px;max-width:90ch">Every DAS is this chain. Press a block for what to measure there. Measure in the middle first: if the middle is good, the fault is downstream. If it's bad, it's upstream. Halve it again until you're on it.</p>
    <div class="panel fi-sig"><svg viewBox="0 0 1020 286" role="img" aria-label="Signal path from the agency site to the radio on the floor"><text class="sm" x="20" y="30">Downlink: left to right. Uplink: right to left.</text>${lines}<polyline points="500,${top + 76} 500,190"/><polyline points="410,190 590,190"/>${FI().tps.map(b => block(b, top)).join("")}${FI().tpsLow.map(b => block(b, 190, 156)).join("")}</svg></div>
    <div class="panel"><h3>${tp.id}: ${esc(tp.name)}</h3><p class="hint" style="margin:0 0 8px">${esc(tp.t)}</p><p style="margin:0 0 12px">${gloss(key === "c" ? tp.c : tp.e)}</p><div class="row" style="gap:8px;flex-wrap:wrap">${tp.f.map(x => `<button class="sm" data-walk="${x}">${x}: ${esc(nameOf(x))}</button>`).join("")}</div></div>`; }
  function pageLimits() { const tb = g => `<div class="panel"><h3>${esc(g.h)}</h3><div class="tw"><table><thead><tr><th>Item</th><th>Default</th><th>Where it differs</th></tr></thead><tbody>${g.rows.map(r => `<tr><td>${gloss(r[0])}</td><td>${gloss(r[1])}</td><td>${gloss(r[2])}</td></tr>`).join("")}</tbody></table></div></div>`;
    return `<p class="hint" style="margin:0 0 10px;max-width:90ch">DAStastic's defaults, and where AHJs differ. The job's AHJ profile always wins.</p><div class="fi-two">${FI().limits.map(tb).join("")}
    <div class="panel"><h3>Test instruments</h3><div class="tw"><table><thead><tr><th>Instrument</th><th>Accuracy</th><th>Note</th></tr></thead><tbody>${FI().instruments.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${gloss(r[2])}</td></tr>`).join("")}</tbody></table></div></div>
    <div class="panel"><h3>Who does what</h3><div class="tw"><table><tbody>${FI().people.map(r => `<tr><td>${gloss(r[0])}</td><td>${gloss(r[1])}</td></tr>`).join("")}</tbody></table></div></div></div>`; }
  function pageCharts() { const list = FI().trees.filter(inScope);
    return `<p class="hint" style="margin:0 0 10px">Every chart, drawn. Print gives one sheet per chart for the binder, plus the numbered steps.</p><button class="primary" id="fiPrintAll" style="margin-bottom:10px">Print all ${list.length}</button><div class="fi-grid">${list.map(t => `<button class="fi-card" data-walk="${t.id}"><span class="fi-id">${t.id}</span><b>${esc(t.title)}</b><span>${t.nodes.length} steps</span></button>`).join("")}</div>`; }
  function pageAbout() { return `<div class="fi-two"><div class="panel"><h3>Using it</h3><ol style="margin:0;padding-left:20px"><li>Answer one step at a time. The chart beside it shows where you are.</li><li>If you can't do a step, press Can't do this. It tells you who to call.</li><li>When a fault is fixed, it brings you back to where you left off.</li><li>On a job, Go there opens the right place, and Save to the job's Log keeps what you did.</li></ol></div>
    <div class="panel"><h3>What the tags mean</h3><p style="margin:0 0 6px"><b>DAStastic:</b> the app enforces it or records it.</p><p style="margin:0 0 6px"><b>Rule:</b> a code, FCC rule or AHJ document, read second-hand through a named document, never the paid standard itself.</p><p style="margin:0 0 6px"><b>Research:</b> a vendor or industry source.</p><p style="margin:0"><b>Confirm:</b> field practice with no source in our research.</p></div>
    <div class="panel"><h3>What no source covers</h3><div class="tw"><table><tbody>${FI().gaps.map(r => `<tr><td>${esc(r[0])}</td><td>${gloss(r[1])}</td></tr>`).join("")}</tbody></table></div></div></div>`; }

  function pageWalk() { const f = F(), t = TREES().get(f.tree); if (!t) { f.page = "run"; return pageRun(); }
    const n = t.nodes.find(x => x.id === f.step) || t.nodes.find(x => x.id === t.start), i = t.nodes.indexOf(n) + 1; f.step = n.id;
    const row = (k, v) => v ? `<dt>${k}</dt><dd>${gloss(v)}</dd>` : "", ret = f.stack[f.stack.length - 1], sub = JOB && (n.at || "").match(/^Job > ([A-Za-z -]+?)(,|$)/)?.[1];
    const done = n.k === "done" ? (n.stage ? runFor(n.stage).map(r => `<button class="primary" data-goto="${r.id}">${esc(r.title)}</button>`).join("") : ret ? `<button class="primary" data-return="1">Back to ${esc(nameOf(ret.tree))}</button>` : `<button class="primary" data-home="1">Finish</button>`) : "";
    const stuck = n.k === "stop" && !n.next && ret ? `<button data-return="1">Fixed. Back to ${esc(nameOf(ret.tree))}</button>` : "";
    return `<div class="fi-crumb"><button class="sm" data-home="1">${t.kind === "run" ? "Run the job" : "Something's wrong"}</button>${f.stack.map(s => `<span>${esc(nameOf(s.tree))}</span>`).join("<span>then</span>")}${f.stack.length ? "<span>then</span>" : ""}<b>${esc(t.title)}</b><span>Step ${i} of ${t.nodes.length}</span></div>
    <div class="fi-walk"><div class="panel fi-step" id="fiStep"><span class="fi-kind" style="--c:var(${KIND[n.k][1]})"><i></i>${KIND[n.k][0]}</span><h3 class="fi-q">${gloss(n.t)}</h3>${n.warn ? `<div class="fi-warn">${gloss(n.warn)}</div>` : ""}
      <dl class="fi-dl">${row("How", n.how)}${row("Good is", n.good)}${row("Tool", n.tool)}${row("Who", n.who)}${row("In DAStastic", n.at)}</dl>
      <div class="fi-ans">${branches(n).map(b => `<button class="${b.c || ""}" data-to="${esc(b.to)}" data-l="${esc(b.l)}">${esc(b.l)}${isTree(b.to) ? ` <span class="hint">(${b.to})</span>` : ""}</button>`).join("")}${done}${stuck}</div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:8px"><button class="sm" id="fiBack"${f.path.length ? "" : " disabled"}>Back a step</button>${n.k === "test" || n.k === "do" ? `<button class="sm" id="fiStuck">Can't do this</button>` : ""}${sub && SUB[sub] ? `<button class="sm" data-sub="${SUB[sub]}">Go there</button>` : ""}<button class="sm" id="fiCopy">${JOB ? "Save to the job's Log" : "Copy what I did"}</button></div>
      <div class="fi-tags">${(n.src || []).map(s => `<span class="fi-tag ${s[0] === "p" ? "p" : ""}">${esc(s[0] === "a" ? "DAStastic: " + s[1] : s[0] === "p" ? s[1] + ": confirm" : s[1])}</span>`).join("")}</div>
      ${f.path.length ? `<h4 style="margin:12px 0 4px">So far</h4><ol class="fi-log">${f.path.slice(-6).map(p => `<li>${esc(p.t)} <span class="hint">${esc(p.a)}</span></li>`).join("")}</ol>` : ""}</div>
    <div class="panel" style="padding:10px"><div class="fi-wrap" id="fiHost"></div></div></div>`; }
  const answer = (to, label) => { const f = F(), t = TREES().get(f.tree), n = t.nodes.find(x => x.id === f.step);
    f.path.push({ tree: f.tree, step: n.id, t: n.t, a: label, title: t.title });
    if (isTree(to)) { f.stack.push({ tree: f.tree, step: n.then || n.id }); go(to); } else go(f.tree, to); };
  const logText = () => F().path.map((p, i) => `${i + 1}. [${p.title}] ${p.t} ${p.a}`).join("\n");

  // print: each chart sliced at row boundaries at a readable size, then the numbered steps, tech-manual style
  const stepNo = (t, id) => isTree(id) ? id : `${t.nodes.findIndex(n => n.id === id) + 1}`;
  const thenText = (t, n) => n.opts ? n.opts.map(o => `${esc(o.l)}: ${stepNo(t, o.to)}`).join("<br>") : n.k === "test" ? `Yes: ${stepNo(t, n.yes)}<br>No: ${stepNo(t, n.no)}` : n.next ? stepNo(t, n.next) : n.k === "done" ? (n.stage ? `Next stage: ${STAGES[n.stage - 1]}` : "End") : `Call ${esc(n.who || t.call)}`;
  function printAll(list) {
    const root = document.getElementById("fiPrint") || Object.assign(document.createElement("div"), { id: "fiPrint" }); document.body.append(root); root.innerHTML = ""; root.classList.add("m");
    for (const t of list) { const intro = `${esc(t.goal || t.see)}${t.tools ? ` Tools: ${esc(t.tools)}.` : ""} Stuck: call ${esc(t.call)}.`, probe = document.createElement("section"); probe.className = "fi-sheet"; root.append(probe);
      const r = chart(probe, t), k = Math.min(1, 960 / r.width), pageH = 610 / k, slices = []; let from = 0;
      r.ys.forEach((y, i) => { if (y + r.depthH[i] - from > pageH) { slices.push([from, y - 8]); from = y - 8; } }); slices.push([from, r.height]); probe.remove();
      slices.forEach(([y0, y1], i) => { const sh = document.createElement("section"); sh.className = "fi-sheet";
        sh.innerHTML = `<h2>${t.id}: ${esc(t.title)}${slices.length > 1 ? ` (chart ${i + 1} of ${slices.length})` : ""}</h2><p>${intro}</p><div class="fi-win" style="height:${(y1 - y0) * k}px;width:${r.width * k}px"><div class="fi-scaler" style="transform:scale(${k});margin-top:${-y0 * k}px"></div></div>`;
        root.append(sh); chart(sh.querySelector(".fi-scaler"), t); });
      const tb = document.createElement("section"); tb.className = "fi-sheet fi-steps";
      tb.innerHTML = `<h2>${t.id}: ${esc(t.title)}: the steps</h2><table><thead><tr><th>Step</th><th>What to do</th><th>Good is</th><th>Tool</th><th>Then</th></tr></thead><tbody>${t.nodes.map((n, i) => `<tr><td>${i + 1}<br>${KIND[n.k][0]}</td><td><b>${esc(n.t)}</b>${n.how ? `<br>${esc(n.how)}` : ""}${n.warn ? `<br><b>Warning:</b> ${esc(n.warn)}` : ""}</td><td>${esc(n.good || "")}</td><td>${esc(n.tool || n.who || "")}</td><td>${thenText(t, n)}</td></tr>`).join("")}</tbody></table>`;
      root.append(tb); }
    root.classList.remove("m"); document.body.classList.add("fi-printing");
    const off = () => { document.body.classList.remove("fi-printing"); window.removeEventListener("afterprint", off); }; window.addEventListener("afterprint", off);
    if (!window.__noPrint) setTimeout(() => window.print(), 50);
  }

  function draw() { const f = F(); if (!ROOT || !FI()) return;
    const walking = f.page === "walk";
    ROOT.innerHTML = `<div class="fi-top"><div class="seg" id="fiPages">${PAGES.map(([k, l]) => `<button data-page="${k}" class="${f.page === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <span style="margin-left:auto" class="seg" id="fiScope">${[["e", "Public safety"], ["c", "Cellular"], ["b", "Both"]].map(([k, l]) => `<button data-scope="${k}" class="${f.scope === k ? "on" : ""}">${l}</button>`).join("")}</span></div>
      <div id="fiBody">${walking ? pageWalk() : ({ run: pageRun, fault: pageFault, path: pagePath, limits: pageLimits, charts: pageCharts, about: pageAbout }[f.page] || pageRun)()}</div>`;
    ROOT.querySelectorAll("[data-chart]").forEach(h => { const id = h.dataset.chart; chart(h, TREES().get(id), new Set(), null, (s, g) => { f.path = []; f.stack = []; if (g && !String(g).startsWith("stage:")) go(g); else go(id, s); }); });
    const host = ROOT.querySelector("#fiHost");
    if (host) { const t = TREES().get(f.tree), walked = new Set(f.path.filter(p => p.tree === f.tree).map(p => p.step));
      chart(host, t, walked, f.step, (id, g) => { if (g) { if (String(g).startsWith("stage:")) { const r = runFor(+g.slice(6))[0]; if (r) go(r.id); } else go(g); } else if (id) go(f.tree, id); });
      const now = host.querySelector(".fi-nd.now"); if (now) host.scrollTo({ top: Math.max(0, now.offsetTop - host.clientHeight / 2 + 40), left: Math.max(0, now.offsetLeft - host.clientWidth / 2 + 100) }); }
    const find = ROOT.querySelector("#fiFind");
    if (find) find.oninput = () => { const w = find.value.toLowerCase().split(/\s+/).filter(Boolean), out = ROOT.querySelector("#fiHits"); if (!w.length) { out.innerHTML = ""; return; }
      const hits = FI().trees.flatMap(t => inScope(t) ? [{ t, n: null, s: `${t.title} ${t.see || ""}` }, ...t.nodes.map(n => ({ t, n, s: `${n.t} ${n.how || ""} ${n.good || ""}` }))] : []).filter(x => { const s = x.s.toLowerCase(); return w.every(y => s.includes(y)); }).slice(0, 10);
      out.innerHTML = hits.length ? hits.map(x => `<button class="fi-hit" data-open="${x.t.id}" data-at="${x.n?.id || ""}">${esc(x.n ? x.n.t : x.t.title)} <span class="hint">${x.t.id}: ${esc(x.t.title)}</span></button>`).join("") : '<p class="hint">Nothing matches. Try one plain word.</p>'; };
  }
  function onClick(e) { const b = e.target.closest("button,[data-tp]"); if (!b || !ROOT.contains(b)) return; const d = b.dataset, f = F();
    if (d.page) { f.path = []; f.stack = []; f.page = d.page; draw(); }
    else if (d.scope) { f.scope = d.scope; draw(); }
    else if (d.stage) { f.stage = +d.stage; f.page = "run"; draw(); }
    else if (d.walk) { f.path = []; f.stack = []; go(d.walk); }
    else if (d.open) { f.path = []; f.stack = []; go(d.open, d.at || null); }
    else if (d.goto) { f.stack = []; go(d.goto); }
    else if (d.to) answer(d.to, d.l);
    else if (d.return) { const r = f.stack.pop(), t = f.tree; f.path.push({ tree: t, step: f.step, t: `${nameOf(t)}: cleared.`, a: "", title: nameOf(t), ret: r }); go(r.tree, r.step); }
    else if (d.home) { const k = TREES().get(f.tree)?.kind; f.page = k === "fault" ? "fault" : "run"; draw(); }
    else if (d.tp) { f.tp = d.tp; draw(); }
    else if (d.sub) { S.das.sub = d.sub; render(); }
    else if (b.id === "fiGuide") window.dasWalkOpen(JOB.id);
    else if (b.id === "fiPrintAll") printAll(FI().trees.filter(inScope));
    else if (b.id === "fiBack") { const p = f.path.pop(); if (p) { if (p.ret) f.stack.push(p.ret); else if (p.tree !== f.tree && f.stack.length) f.stack.pop(); go(p.tree, p.step); } }
    else if (b.id === "fiStuck") { const t = TREES().get(f.tree), a = ROOT.querySelector(".fi-ans"); if (a && !ROOT.querySelector("#fiStuckNote")) a.insertAdjacentHTML("beforebegin", `<div class="fi-warn" id="fiStuckNote">Stop here. Don't guess. Note what you measured, then call ${gloss(t.call)}.</div>`); }
    else if (b.id === "fiCopy") { const text = logText() || "Nothing yet.";
      if (JOB) post(`/api/das/jobs/${JOB.id}/note`, { text: `Fault chart:\n${text}` }).then(() => dasSay("Saved to the job's Log.", true)).catch(er => dasSay("Not saved: " + er.message));
      else navigator.clipboard?.writeText(text).then(() => dasSay("Copied.", true)).catch(() => dasSay("Copy failed: your browser blocked it.")); } }

  window.dasFiParts = { TREES, STAGES, SUB, KIND, branches, isTree, nameOf, gloss };  // Walk me through runs on these same charts (dasguide.js)
  window.dasFaultOpen = (tree, job) => { F().want = { tree, job }; };  // Start's failed-grid box: the chart opens at that fault when the job's tab draws
  document.fonts?.addEventListener?.("loadingdone", () => { if (ROOT?.isConnected) draw(); });  // the lines are measured off the boxes: the web font changes their size
  window.dasFaultChart = (el, opts = {}) => { const f = F(), j = opts.job || null;
    ROOT = el; JOB = j; el.classList.add("fi"); el.onclick = onClick;
    el.onkeydown = e => { if ((e.key === "Enter" || e.key === " ") && e.target.dataset?.tp) { e.preventDefault(); f.tp = e.target.dataset.tp; draw(); } };
    if (j && f.jobId !== j.id) { const sc = typeof dasScope === "function" ? dasScope(j.data || {}) : { ps: true }; f.jobId = j.id; f.scope = sc.cell && sc.ps ? "b" : sc.cell ? "c" : "e"; f.stage = Math.max(1, STAGES.indexOf(j.stage) + 1); f.page = "run"; f.path = []; f.stack = []; }
    if (!j && f.jobId != null) { f.jobId = null; f.page = "run"; f.path = []; f.stack = []; }
    if (j && f.want?.job === j.id) { const t = f.want.tree; f.want = null; f.path = []; f.stack = []; return go(t); }
    draw(); };
})();
