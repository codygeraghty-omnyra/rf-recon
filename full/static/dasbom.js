/* RF Recon: the bill of materials on a DAS job's Materials tab (11/5). fieldref.js dasMaterials draws the panels and hands
   this the job; dasbom.py does the thinking (groups, wrong-part warnings, what's missing, the outputs, the workbook) and
   answers /api/das/jobs/<id>/bomreview. Here: the grouped list, the part number lookup, the three outputs on screen, what's
   missing with one click to add it, the iBwave import, kits, revisions, and the check of a part in someone's hand. */
document.head.insertAdjacentHTML("beforeend", `<style>
#dmBomT td{vertical-align:top}#dmBomT .bm-long{max-width:158px;white-space:normal;overflow-wrap:anywhere;line-height:1.3;margin-top:2px}#dmBomT .bm-item{white-space:normal;min-width:18em;max-width:34em;overflow-wrap:anywhere}
#dmBomT .bm-item .hint{line-height:1.35}#dmBomT input.bm-pn{width:158px}
tr.bm-g td{background:var(--wash);font-weight:600;white-space:normal;padding-top:7px;padding-bottom:7px}tr.bm-g .bm-gt{float:right;font-weight:700}
tr.bm-g button{all:unset;cursor:pointer;display:inline-block;padding:2px 8px 2px 0;min-width:1.2em}tr.bm-g button:focus-visible{outline:2px solid var(--accent)}
#dmBomT select{max-width:124px}
tr.bm-sub td{font-weight:600;border-top:1px solid var(--line)}
tr.bm-w td{white-space:normal;padding-top:0;padding-bottom:7px;border-top:0}tr.bm-l.has-w td{border-bottom:0}
.bm-warn{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap;margin:3px 0;line-height:1.4;overflow-wrap:anywhere}.bm-warn .tag{flex:none}
.bm-sum{display:flex;gap:6px 14px;flex-wrap:wrap;align-items:center;margin:0 0 8px}
.bm-rule{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;padding:8px 0;border-top:1px solid var(--line);align-items:start}
.bm-rule .bm-acts{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}.bm-rule select{max-width:170px}
.bm-hits{display:flex;flex-direction:column;gap:4px;margin:6px 0 0}.bm-hit{display:flex;gap:6px 10px;flex-wrap:wrap;text-align:left;align-items:baseline;white-space:normal;height:auto;padding:6px 10px}
.bm-hit b{overflow-wrap:anywhere}.bm-ok{color:var(--good)}.bm-bad{color:var(--bad);font-weight:600}
.bm-hand{display:flex;gap:6px 10px;flex-wrap:wrap;align-items:end;margin:8px 0}.bm-hand label{flex:0 1 280px}
.bm-out td{white-space:normal;overflow-wrap:break-word}.bm-out td.n{white-space:nowrap}.bm-out .bm-big input{width:22px;height:22px}
.bm-tot{margin:8px 0 0 auto;width:max-content;max-width:100%;border-collapse:collapse}.bm-tot td{padding:2px 0 2px 18px}.bm-tot tr:last-child td{font-weight:700;border-top:1px solid var(--line);padding-top:5px}
.bm-sheet h4{margin:0 0 2px}
@media (max-width:699px){
  #dmBomT{display:block}#dmBomT thead{display:none}#dmBomT tbody{display:block}
  #dmBomT tr{display:block}#dmBomT tr.bm-l{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px 8px;padding:8px 10px 6px;border-top:1px solid var(--line)}
  #dmBomT tr.bm-l td{display:block;border:0;padding:0;min-width:0;white-space:normal}#dmBomT tr.bm-l td.n{text-align:left}
  #dmBomT tr.bm-l td[data-l]::before{content:attr(data-l);display:block;font-size:11px;color:var(--muted);line-height:1.3}
  #dmBomT tr.bm-l td.bm-item,#dmBomT tr.bm-l td.bm-wide{grid-column:1 / -1;max-width:none;min-width:0}#dmBomT tr.bm-l td.bm-half{grid-column:span 2}
  #dmBomT tr.bm-l td.bm-three{grid-column:span 3}#dmBomT tr.bm-l td.bm-no,#dmBomT tr.bm-l td.bm-unit{display:none}
  #dmBomT tr.bm-l td input:not([type=checkbox]),#dmBomT tr.bm-l td select{width:100%;max-width:none;padding-left:6px;padding-right:4px}#dmBomT tr.bm-l td.bm-rm{align-self:end;justify-self:end}
  #dmBomT .bm-long{max-width:none}#dmBomT tr.bm-w{display:block;padding:0 10px 8px}#dmBomT tr.bm-w td{display:block;padding:0}#dmBomT tr.bm-g td{display:block}#dmBomT tr.bm-w td:empty{display:none}
  .bm-rule{grid-template-columns:minmax(0,1fr)}.bm-rule .bm-acts{justify-content:flex-start}
  .bm-out thead{display:none}.bm-out,.bm-out tbody{display:block}.bm-out tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;padding:8px 2px;border-top:1px solid var(--line)}
  .bm-out tr.bm-g{display:block;padding:0}.bm-out td{display:block;border:0;padding:0;min-width:0}.bm-out td.bm-wide{grid-column:1 / -1}.bm-out td.n{text-align:left}
  .bm-out td[data-l]::before{content:attr(data-l) ": ";color:var(--muted);font-size:12px}.bm-out td[data-l]:empty{display:none}.bm-out td.bm-wide:empty{display:none}
  .bm-tech tr:not(.bm-g){grid-template-columns:34px minmax(0,1fr) auto;align-items:start}.bm-tech td.bm-big{grid-row:1 / span 5}.bm-tech td.bm-no{display:none}
  .bm-tech td.bm-pt{grid-column:2;grid-row:1;overflow-wrap:anywhere}.bm-tech td.bm-q{grid-column:3;grid-row:1}.bm-tech td.bm-wide{grid-column:2 / -1}
}
@media print{ #dasPrint .bm-noprint{display:none}
  body.print-das #dasPrint.bm-sheet td,body.print-das #dasPrint.bm-sheet th{overflow-wrap:break-word}
  body.print-das #dasPrint.bm-sheet td.n,body.print-das #dasPrint.bm-sheet th{white-space:nowrap} }
</style>`);

const BM_FIELD={freq:"Frequency", connector:"Connector", rating:"Rating", design:"Design", unit:"Unit", maker:"Maker"};
const bmSrc=s=>!s?"":s.url?`<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)} ↗</a>`:`<span class="tag">${esc(s.label)}</span>`;
const bmPn=s=>String(s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
const bmToday=()=>today();  // das.js: the local date (a UTC one is tomorrow after 7 PM)
// the place a redraw should leave you: the same field, the same spot on the page (a save redraws the tab)
window.dasBomHold=()=>{ const a=document.activeElement, k=a&&[...a.attributes].find(x=>/^data-b/.test(x.name)); S.das.bomHold={sel:k?`[${k.name}="${CSS.escape(k.value)}"]`:null, y:window.scrollY}; };
window.dasBomBack=()=>{ const h=S.das.bomHold; if(!h) return; S.das.bomHold=null; window.scrollTo(0,h.y); if(h.sel) document.querySelector(h.sel)?.focus({preventScroll:true}); };

function dasBom(c){
  const {j, d, bom, rv, byId, money, specCell, keep, save}=c, D=S.das, R=rv&&!rv.err?rv:null;
  const L=(R?.lines||[]).slice().sort((a,b)=>a.no-b.no), by=new Map(L.map(l=>[l.i,l]));
  const set=R?.settings||{}, GL=R?.group_list||[];
  const view=()=>D.bomView&&D.bomView!=="list"&&R?D.bomView:"list";
  const groupSel=(x,l)=>`<select data-bg="${l.i}" aria-label="Group, line ${l.no}">${GL.map(g=>`<option value="${g.key}" ${g.key===l.group?"selected":""}>${esc(g.short||g.label)}</option>`).join("")}</select>`;
  const lineAt=l=>bom[l.i];
  // a long list on a phone opens folded to its groups and their subtotals
  D.bomFold=D.bomFold&&D.bomFold.job===j.id?D.bomFold:{job:j.id, set:new Set(bom.length>12&&matchMedia("(max-width:699px)").matches?GL.map(g=>g.key):[])};
  const folded=k=>D.bomFold.set.has(k);
  const warnCount=L.filter(l=>l.warn.length).length, movedN=L.filter(l=>l.moved&&!l.moved.unpriced).length;
  const few=(n,one,many)=>n?`${n} ${n===1?one:many}`:"";
  const quiet=[few(L.filter(l=>l.price_old).length,`price is over ${R?.price_old_days} days old`,`prices are over ${R?.price_old_days} days old`), few(L.filter(l=>l.not_in_catalogue).length,"line isn't in the catalogue","lines aren't in the catalogue"),
    few(L.filter(l=>l.no_part).length,"line has no part number","lines have no part number"), few(L.filter(l=>l.no_qty).length,"line has no quantity","lines have no quantity")].filter(Boolean);

  /* ---------- the list ---------- */
  const lineRow=l=>{ const x=lineAt(l), i=l.i, pid=x.pid||l.pid, p=pid&&byId.get(+pid), sub=[x.cat, l.maker, x.supplier].filter(Boolean).map(esc).join(" · ");
    const below=belowRow(x,l);
    return `<tr class="bm-l${below?" has-w":""}" data-li="${i}"><td class="n hint bm-no">${l.no}</td>
      <td class="bm-item"><b>${esc(x.item||"")}</b>${sub?`<div class="hint">${sub}</div>`:""}${x.note?`<div class="hint">${esc(x.note)}</div>`:""}</td>
      <td class="bm-wide" data-l="Part number"><input class="mono bm-pn" data-bpn="${i}" value="${esc(x.part||"")}" placeholder="no part number yet" aria-label="Part number, line ${l.no}">${String(x.part||"").length>17?`<div class="hint mono bm-long">${esc(x.part)}</div>`:""}</td>
      <td class="n" data-l="Qty${x.unit?` (${esc(x.unit)})`:""}"><input data-bq="${i}" type="number" step="any" value="${esc(x.qty??"")}" placeholder="qty" style="width:70px" aria-label="Quantity, line ${l.no}"></td><td class="bm-unit">${esc(x.unit||"")}</td>
      <td class="bm-half" data-l="Location"><input data-bloc="${i}" list="dmLocs" value="${esc(x.loc||"")}" style="width:122px" aria-label="Location, line ${l.no}">${String(x.loc||"").length>13?`<div class="hint bm-long">${esc(x.loc)}</div>`:""}</td>
      <td class="n" data-l="Price"><input data-bp="${i}" type="number" step="0.01" value="${esc(x.price??"")}" style="width:84px" aria-label="Price, line ${l.no}">${x.price_at?`<div class="hint" ${l.price_old?`title="${l.price_age} days old"`:""}>${esc(x.price_at)}</div>`:""}</td>
      <td class="n" data-l="Total">${money(l.total)}</td>
      <td class="n" data-l="Install h"><input data-bh="${i}" type="number" step="any" min="0" value="${esc(x.labor_h??"")}" style="width:58px" title="Hours to install one" aria-label="Install hours each, line ${l.no}"></td>
      <td data-l="Spec sheet">${specCell({...x, pid})}</td>
      <td class="bm-three" data-l="Code fields" style="white-space:normal;min-width:10em">${p?`${pcSum(p)} <button class="sm" data-bcode="${pid}">Code fields</button>`:'<span class="hint">not from the catalogue</span>'}</td>
      <td class="bm-half" data-l="Group">${groupSel(x,l)}</td><td class="bm-rm"><button data-rmb="${i}" aria-label="Remove this line">✕</button></td></tr>${below}`; };
  const belowRow=(x,l)=>{ const t=[];
    for(const w of l.warn) t.push(`<div class="bm-warn"><span class="tag w">${esc(BM_FIELD[w.field]||"Check")}</span><span>${esc(w.text)}</span>${bmSrc(w.source)}</div>`);
    const m=l.moved;
    if(m&&m.unpriced) t.push(`<div class="bm-warn"><span class="tag">Price</span><span>The catalogue has ${money(m.now)}${m.supplier?` from ${esc(m.supplier)}`:""}.</span><button class="sm" data-buse="${l.i}">Use ${money(m.now)}</button></div>`);
    else if(m) t.push(`<div class="bm-warn"><span class="tag w">Price moved</span><span>This line holds ${money(m.was)}${x.price_at?` from ${esc(x.price_at)}`:""}. The catalogue is now ${money(m.now)}, ${m.diff>0?"up":"down"} ${money(Math.abs(m.diff))}${m.pct!=null?` (${Math.abs(m.pct)}%)`:""}${m.at?` as of ${esc(m.at)}`:""}${m.supplier?` from ${esc(m.supplier)}`:""}.</span><button class="sm" data-buse="${l.i}">Use ${money(m.now)}</button></div>`);
    if(l.api_price) t.push(`<div class="bm-warn"><span class="tag w">Price</span><span>From a distributor's online API. Their terms keep it off a customer document, so the Customer sheet leaves it blank until a supplier's quote replaces it.</span></div>`);
    return t.length?`<tr class="bm-w"><td></td><td colspan="12">${t.join("")}</td></tr>`:""; };
  const listView=()=>{ if(!bom.length) return `<div class="tw"><table><tbody><tr><td class="hint" style="white-space:normal">Nothing yet: add your standard parts, pick from the catalogue or the research list, import an iBwave equipment list, or type a line below. What the list is missing, further down, shows what a job needs.</td></tr></tbody></table></div>`;
    if(!R) return `<p class="status err">The grouped list didn't load: ${esc(rv?.err||"")}. Your lines are safe. Reload the page.</p>`;
    return `<div class="tw"><table id="dmBomT"><thead><tr><th class="n">Line</th><th>Item</th><th>Part number</th><th class="n">Qty</th><th>Unit</th><th>Location</th><th class="n">Price</th><th class="n">Total</th><th class="n" title="Hours to install one, for the labor on the Customer sheet">Install h</th><th>Spec sheet</th><th>Code fields</th><th>Group</th><th></th></tr></thead><tbody>
      ${R.groups.map(g=>{ const f=folded(g.key); return `<tr class="bm-g"><td colspan="13"><span class="bm-gt">${money(g.total)}</span><button data-bfold="${g.key}" aria-expanded="${!f}" aria-label="${f?"Open":"Fold"} ${esc(g.label)}">${f?"▸":"▾"}</button>${esc(g.label)} <span class="hint">· ${g.lines} line${g.lines===1?"":"s"}${g.unpriced?`, ${g.unpriced} with no price`:""}</span></td></tr>${f?"":L.filter(l=>l.group===g.key).map(lineRow).join("")}`; }).join("")}</tbody></table></div>
      <datalist id="dmLocs">${(R.locations||[]).map(x=>`<option value="${esc(x)}">`).join("")}</datalist>`; };

  /* ---------- the three outputs ---------- */
  const O=R?.outputs, H=O?.head;
  const sheetHead=(title,extra="")=>`<h4>${esc(title)}</h4><p class="hint" style="margin:0 0 6px">${[H.job,H.address,extra,H.rev?`Rev ${H.rev}, ${H.rev_at}`:""].filter(Boolean).map(esc).join(" · ")}</p>`;
  const custView=()=>{ const C=O.customer;
    return `${sheetHead("Bill of materials")}<div class="tw"><table class="bm-out"><thead><tr><th class="n">Item</th><th>Description</th><th>Part number</th><th>Maker</th><th class="n">Qty</th><th class="n">Unit price</th><th class="n">Total</th></tr></thead><tbody>
      ${C.groups.map(g=>`<tr class="bm-g"><td colspan="7"><span class="bm-gt">${money(g.subtotal)}</span>${esc(g.label)}</td></tr>${g.lines.map(x=>`<tr><td class="n hint">${x.no}</td><td class="bm-wide"><b>${esc(x.item)}</b></td><td class="mono bm-wide">${esc(x.part)}</td><td data-l="Maker">${esc(x.maker)}</td><td class="n" data-l="Qty">${esc(x.qty)} ${esc(x.unit)}</td><td class="n" data-l="Unit price">${money(x.price)}</td><td class="n" data-l="Total"><b>${money(x.total)}</b></td></tr>`).join("")}`).join("")}</tbody></table></div>
      <table class="bm-tot"><tbody><tr><td>Equipment</td><td class="n">${money(C.equipment)}</td></tr>${C.labor?`<tr><td>Installation labor${C.labor_hours?`, ${C.labor_hours} hours`:""}</td><td class="n">${money(C.labor)}</td></tr>`:""}${C.tax_pct?`<tr><td>Sales tax, ${C.tax_pct}% on equipment</td><td class="n">${money(C.tax)}</td></tr>`:""}<tr><td>Total</td><td class="n">${money(C.total)}</td></tr></tbody></table>`; };
  const techView=()=>{ const T=O.technician;
    return `${sheetHead("Pick list")}<div class="tw"><table class="bm-out bm-tech"><thead><tr><th>Pick</th><th class="n">Line</th><th>Part number</th><th>Description</th><th class="n">Qty</th><th>Location</th><th>Note</th></tr></thead><tbody>
      ${T.groups.map(g=>`<tr class="bm-g"><td colspan="7">${esc(g.label)}</td></tr>${g.lines.map(x=>`<tr><td class="bm-big"><input type="checkbox" data-bpick="${x.i}" ${x.picked?"checked":""} aria-label="Picked: line ${x.no}, ${esc(x.part||x.item)}"></td><td class="n hint bm-noprint bm-no">${x.no}</td><td class="mono bm-pt"><b>${esc(x.part||"no part number")}</b></td><td class="bm-wide">${esc(x.item)}${x.maker?` <span class="hint">· ${esc(x.maker)}</span>`:""}</td><td class="n bm-q"><b>${esc(x.qty)} ${esc(x.unit)}</b></td><td data-l="Location" class="bm-wide">${esc(x.loc)}</td><td data-l="Note" class="bm-wide">${esc(x.note)}</td></tr>`).join("")}`).join("")}</tbody></table></div>
      <p class="hint" style="margin:6px 0 0"><span id="bmPicked">${T.picked}</span> of ${T.lines} lines picked.</p>`; };
  const ahjView=()=>{ const A=O.ahj;
    return `${sheetHead("Bill of materials for AHJ review", H.ahj?`AHJ: ${H.ahj}`:"")}<div class="tw"><table class="bm-out"><thead><tr><th class="n">Item</th><th>Group</th><th>Description</th><th>Part number</th><th>Maker</th><th class="n">Qty</th><th>UL 2524 listing</th><th>FCC ID</th><th>Class</th><th>NEMA</th><th>2-hour rating</th><th>Spec sheet</th></tr></thead><tbody>
      ${A.lines.map(x=>`<tr><td class="n hint">${x.no}</td><td data-l="Group">${esc(x.group)}</td><td class="bm-wide"><b>${esc(x.item)}</b></td><td class="mono bm-wide">${esc(x.part)}</td><td data-l="Maker">${esc(x.maker)}</td><td class="n" data-l="Qty">${esc(x.qty)} ${esc(x.unit)}</td><td data-l="UL 2524">${esc(x.ul2524)}</td><td data-l="FCC ID" class="mono">${esc(x.fcc_id)}</td><td data-l="Class">${esc(x.booster_class)}</td><td data-l="NEMA">${esc(x.nema)}</td><td data-l="2-hour">${esc(x.rating_2h)}</td><td data-l="Spec sheet" class="bm-wide">${/^https?:/i.test(x.spec_url||"")&&!/^Spec sheets/.test(x.spec)?`<a href="${esc(x.spec_url)}" target="_blank" rel="noopener">link ↗</a>`:esc(x.spec)||'<span class="hint">not gathered yet</span>'}</td></tr>`).join("")}</tbody></table></div>`; };
  const xl=(q,lab,title="")=>`<a class="btn" href="/api/das/jobs/${j.id}/bomxlsx?sheets=${q}" download title="${esc(title)}" style="display:inline-block;white-space:nowrap">⇩ ${esc(lab)}</a>`;
  const pct=+set.price_pct||0;
  const outBar=()=>{ const v=view(), C=O.customer;
    return `<div class="row bm-noprint" style="gap:6px 10px;flex-wrap:wrap;align-items:end;margin:0 0 8px">
      ${v==="customer"?`<label>Price by<select id="bmMode"><option value="markup" ${set.price_mode!=="margin"?"selected":""}>Markup on cost</option><option value="margin" ${set.price_mode==="margin"?"selected":""}>Margin on the price</option></select></label>
        <label>Percent<input id="bmPct" type="number" step="any" min="0" max="95" value="${esc(set.price_pct??"")}" style="width:80px"></label>
        <label>Labor rate per hour<input id="bmRate" type="number" step="any" min="0" value="${esc(set.labor_rate??"")}" style="width:100px"></label>
        <label>Sales tax %<input id="bmTax" type="number" step="any" min="0" value="${esc(set.tax_pct??"")}" style="width:80px"></label>`:""}
      ${xl(v, v==="customer"?"Customer sheet (xlsx)":v==="technician"?"Pick list (xlsx)":"AHJ sheet (xlsx)")}
      ${xl("customer,technician,ahj","Workbook, all three (xlsx)","One workbook with a sheet per output and live totals. The Customer sheet is in it: send the AHJ the AHJ sheet.")}
      <button id="bmPrint">⎙ Print this</button></div>
      ${v==="customer"&&C.no_markup?'<p class="status pr-warn" style="margin:0 0 6px">No markup is set: the customer sees your cost. Set a percent above.</p>':""}
      ${v==="customer"&&C.unpriced?`<p class="hint" style="margin:0 0 6px">${C.unpriced} line${C.unpriced===1?" has":"s have"} no price and show${C.unpriced===1?"s":""} blank.${C.api_held?` ${C.api_held} of them came from a distributor's API, which can't go on a customer document.`:""}</p>`:""}`; };
  const outView=()=>({customer:custView, technician:techView, ahj:ahjView}[view()]||(()=>""))();

  /* ---------- the panel's top ---------- */
  const seg=()=>R?`<div class="seg" id="dmView" role="group" aria-label="Show the list as">${[["list","The list"],["customer","Customer"],["technician","Technician"],["ahj","AHJ"]].map(([k,t])=>`<button data-bv="${k}" class="${view()===k?"on":""}">${t}</button>`).join("")}</div>`:"";
  const summary=()=>{ if(!R) return ""; const k=R.check;
    return `<div class="bm-sum">${seg()}
      ${bom.length?`<span class="hint">${bom.length} line${bom.length===1?"":"s"} in ${R.groups.length} group${R.groups.length===1?"":"s"}</span>`:""}
      ${warnCount?`<span class="tag w">${warnCount} line${warnCount===1?"":"s"} to check</span>`:""}
      ${movedN?`<span class="tag w">${movedN} price${movedN===1?"":"s"} moved</span> <button class="sm" id="bmUseAll">Use the catalogue's prices</button>`:""}
      ${k.open?`<a class="tag w" href="#dmCheck">${k.open} missing</a>`:bom.length?'<span class="tag" style="background:var(--good);color:#fff">Nothing missing</span>':""}
      ${R.revs.length?`<span class="tag">Rev ${esc(R.revs[R.revs.length-1].rev)}</span>`:""}</div>
      ${quiet.length?`<p class="hint" style="margin:0 0 8px">${quiet.join(" · ")}</p>`:""}
      ${(R.job_warn||[]).map(w=>`<div class="bm-warn"><span class="tag w">${esc(BM_FIELD[w.field]||"Check")}</span><span>${esc(w.text)}</span>${bmSrc(w.source)}</div>`).join("")}`; };
  const hand=()=>bom.length?`<div class="bm-hand"><label>Check a part in your hand<input id="dmHand" autocomplete="off" placeholder="Type or scan its part number"></label><span id="dmHandMsg" class="hint" style="flex:1 1 240px;padding-bottom:9px">It says whether this job's list has that part, and where it goes.</span></div>`:"";
  // the catalogue-backed add line: the part number box and what it finds
  const addExtras=()=>`<label>Maker<input id="dmMaker" style="width:130px"></label><label>Location<input id="dmLoc" list="dmLocs" style="width:122px"></label>
    <label>Group<select id="dmGroup"><option value="">From what it is</option>${GL.map(g=>`<option value="${g.key}">${esc(g.label)}</option>`).join("")}</select></label>
    <label title="Pulls what the part cost on this day, from its price history">Price on<input id="dmAsOf" type="date"></label>`;

  /* ---------- what's missing, and revisions ---------- */
  const ruleRow=r=>`<div class="bm-rule" data-rule="${esc(r.id)}"><div><b>${esc(r.title)}</b>${r.status==="missing"&&r.need>1?` <span class="hint">· needs ${r.need} ${esc(r.unit)}, has ${r.have}</span>`:""}
      <div class="hint">${esc(r.why)}</div><div class="hint">${esc(r.group_label)} · ${bmSrc(r.source)}</div></div>
    <div class="bm-acts">${r.status==="missing"?`<button class="sm" data-cadd="${esc(r.id)}">+ Add${r.add.qty!==""?` ${r.add.qty} ${esc(r.unit)}`:""}</button>
      <select data-cskip="${esc(r.id)}" aria-label="Not needed: ${esc(r.title)}"><option value="">Not needed…</option>${R.check.skip_reasons.map(x=>`<option>${esc(x)}</option>`).join("")}</select>`
      :r.status==="skipped"?`<span class="hint">${esc(r.skip?.why||"")}</span><button class="sm" data-cundo="${esc(r.id)}">Undo</button>`:""}</div></div>`;
  const checkPanel=()=>{ if(!R) return ""; const k=R.check, of=s=>k.rows.filter(r=>r.status===s), open=of("missing"), done=of("skipped"), ok=of("ok"), na=of("na");
    const revs=R.revs||[], next=String.fromCharCode(65+revs.length), ch=R.changes;
    return `<div class="panel" style="margin-top:10px" id="dmCheck"><h3>What the list is missing <span class="hint">· ${k.open} open, ${k.met} met${k.skipped?`, ${k.skipped} marked not needed`:""}${k.na?`, ${k.na} that don't apply`:""}</span></h3>
      <p class="hint" style="margin:0 0 6px">Each row says why it's needed and where that comes from. Counts come from this job's design first: ${esc(k.context.donors)} donor path${k.context.donors===1?"":"s"}, ${esc(k.context.antennas)} server antenna${k.context.antennas===1?"":"s"}, ${esc(k.context.passives)} splitters and couplers, so ${esc(k.context.runs)} cable runs. A row marked Rule of thumb has no code or research behind it.</p>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:end;margin-bottom:6px"><label>Spare connectors, %<input id="bmSpare" type="number" step="any" min="0" value="${esc(set.spare_pct??"")}" style="width:90px"></label>
        ${open.length?`<button class="primary" id="bmAddAll">+ Add all ${open.length}</button>`:""}</div>
      ${open.map(ruleRow).join("")||'<p class="hint">Nothing open.</p>'}
      ${done.length?`<details><summary style="cursor:pointer"><b>Marked not needed (${done.length})</b></summary>${done.map(ruleRow).join("")}</details>`:""}
      ${ok.length?`<details><summary style="cursor:pointer"><b>Met (${ok.length})</b></summary>${ok.map(ruleRow).join("")}</details>`:""}
      ${na.length?`<details><summary style="cursor:pointer"><b>Doesn't apply to this job (${na.length})</b></summary>${na.map(ruleRow).join("")}</details>`:""}
      <div style="border-top:1px solid var(--line);margin-top:10px;padding-top:10px"><h3 style="margin:0 0 6px">Revisions <span class="hint">· a dated copy of the list: the sheets print its letter, and what changes after it is listed here</span></h3>
        <div class="row" style="gap:8px;flex-wrap:wrap;align-items:end"><label class="grow">What this revision is<input id="bmRevNote" placeholder="e.g. Issued for permit"></label>
          ${open.length?`<label class="grow">${open.length} still open: why issue anyway?<input id="bmRevWhy"></label>`:""}<button id="bmIssue" ${bom.length?"":"disabled"}>Issue Rev ${next}</button></div>
        <p class="hint" id="bmRevMsg" style="margin:6px 0 0"></p>
        ${revs.length?`<div class="tw" style="margin-top:6px"><table><thead><tr><th>Rev</th><th>Date</th><th>By</th><th>Note</th></tr></thead><tbody>${revs.slice().reverse().map(r=>`<tr><td><b>${esc(r.rev)}</b></td><td>${esc((r.at||"").slice(0,16))}</td><td>${esc(r.by||"")}</td><td style="white-space:normal">${esc(r.note||"")}${r.override?` <span class="tag w">issued with items open: ${esc(r.override)}</span>`:""}</td></tr>`).join("")}</tbody></table></div>`:""}
        ${ch?`<p style="margin:8px 0 2px"><b>Since Rev ${esc(ch.rev)}</b> <span class="hint">· ${ch.added.length} added, ${ch.removed.length} removed, ${ch.changed.length} changed · cost ${ch.cost_change>=0?"up":"down"} ${money(Math.abs(ch.cost_change))||"0.00"}</span></p>
          ${[...ch.added.map(x=>`<div class="hint">Added: ${esc(x.part||x.item)}, ${esc(x.qty)} ${esc(x.unit)}</div>`), ...ch.removed.map(x=>`<div class="hint">Removed: ${esc(x.part||x.item)}, ${esc(x.qty)} ${esc(x.unit)}</div>`), ...ch.changed.map(x=>`<div class="hint">${esc(x.part||x.item)}: ${esc(x.field)} ${esc(x.was)} → ${esc(x.now)}</div>`)].join("")}`:""}</div></div>`; };
  const tools=()=>`<div class="row" style="gap:6px;flex-wrap:wrap;align-items:end;margin-bottom:6px">
      <label class="inl" title="An equipment list exported from iBwave, CSV or Excel. Columns are found by their names, and nothing is added until you say so.">Import an iBwave list <input type="file" id="dmIbw" accept=".csv,.tsv,.txt,.xlsx,.xls,.json,.html,.htm"></label>
      <label>Kit<select id="dmKit" style="max-width:220px"><option value="">Pick a kit…</option></select></label><button id="dmKitAdd" disabled>Add the kit</button>
      <label>Save as a kit<select id="dmKitFrom"><option value="">All lines</option>${(R?.groups||[]).map(g=>`<option value="${g.key}">${esc(g.label)}</option>`).join("")}</select></label><button id="dmKitSave" ${bom.length?"":"disabled"}>Save…</button>
      <button id="dmOrders" ${bom.length?"":"disabled"} title="What to buy from whom, at your cost. For the firm only: its own file, never a sheet in the workbook.">⇩ Order by supplier (xlsx)</button></div>
    <div id="dmIbwRes"></div>`;

  /* ---------- the wiring ---------- */
  const wire=()=>{ const el=$("#dmBomBody"); if(!el) return;
    const patch=(n,p)=>keep(bom.map((x,ix)=>ix===n?{...x,...p}:x));
    $("#dmView")?.addEventListener("click", e=>{ const b=e.target.closest("[data-bv]"); if(b){ D.bomView=b.dataset.bv; window.dasBomHold(); render(); } });
    el.querySelectorAll("[data-bfold]").forEach(b=>b.onclick=()=>{ const k=b.dataset.bfold, on=D.bomFold.set; on.has(k)?on.delete(k):on.add(k); window.dasBomHold(); render(); });
    el.querySelectorAll("[data-bq],[data-bp]").forEach(i=>i.onchange=()=>{ const q=i.dataset.bq!=null, n=+(i.dataset.bq??i.dataset.bp);
      patch(n, q?{qty:i.value}:{price:i.value, price_at:i.value===""?"":bmToday(), price_by:"typed"}); });
    el.querySelectorAll("[data-bh]").forEach(i=>i.onchange=()=>patch(+i.dataset.bh,{labor_h:i.value}));
    el.querySelectorAll("[data-bloc]").forEach(i=>i.onchange=()=>patch(+i.dataset.bloc,{loc:i.value.trim()}));
    el.querySelectorAll("[data-bg]").forEach(s=>s.onchange=()=>{ const n=+s.dataset.bg, l=by.get(n); patch(n,{group:s.value===l.group_auto?undefined:s.value}); });
    el.querySelectorAll("[data-rmb]").forEach(b=>b.onclick=()=>keep(bom.filter((_,i)=>i!==+b.dataset.rmb)));
    el.querySelectorAll("[data-buse]").forEach(b=>b.onclick=()=>{ const n=+b.dataset.buse, m=by.get(n).moved; patch(n,{price:m.now, price_at:m.at||bmToday(), price_by:"catalogue"}); });
    $("#bmUseAll")&&($("#bmUseAll").onclick=()=>keep(bom.map((x,i)=>{ const m=by.get(i)?.moved; return m&&!m.unpriced?{...x, price:m.now, price_at:m.at||bmToday(), price_by:"catalogue"}:x; })));
    el.querySelectorAll("[data-bcode]").forEach(b=>b.onclick=()=>{ const p=byId.get(+b.dataset.bcode); if(p) pcEditor($("#dmCodeEd"), p, c.std.code_fields||[], {closed:ch=>{ if(ch) render(); }}); });
    // a part number on a line: filled from the catalogue, or kept as typed and marked not in the catalogue
    el.querySelectorAll("[data-bpn]").forEach(i=>i.onchange=async()=>{ const n=+i.dataset.bpn, v=i.value.trim(); if(v===(bom[n].part||"")) return;
      const r=await api(`/api/das/parts/lookup?part=${encodeURIComponent(v)}&supplier=${encodeURIComponent(bom[n].supplier||"")}`).catch(()=>({matches:[]}));
      if(!v||!r.matches.length) return patch(n,{part:v, pid:undefined});
      const pick=p=>patch(n,bmFill(p,bom[n]));
      if(r.matches.length===1) return pick(r.matches[0]);
      bmChooser($("#dmLinePick"), r, pick, `line ${by.get(n).no}`); });
    el.querySelectorAll("[data-bpick]").forEach(b=>b.onchange=async()=>{ const n=+b.dataset.bpick; bom[n]={...bom[n], picked:b.checked?bmToday():undefined}; await save({bom}); const s=$("#bmPicked"); if(s) s.textContent=bom.filter(x=>x.picked).length; });
    const setKeep=p=>save({bom_settings:{...(d.bom_settings||{}), ...p}}).then(()=>{ window.dasBomHold(); render(); });
    [["#bmPct","price_pct"],["#bmRate","labor_rate"],["#bmTax","tax_pct"]].forEach(([s,k])=>{ if($(s)) $(s).onchange=e=>{ let v=e.target.value; if(k==="price_pct"&&$("#bmMode").value==="margin"&&+v>=100) v=95; setKeep({[k]:v===""?null:+v}); }; });
    if($("#bmMode")) $("#bmMode").onchange=e=>setKeep({price_mode:e.target.value});
    if($("#bmPrint")) $("#bmPrint").onclick=()=>dasPrintCopy($("#dasPrint"));
    // what's missing
    const box=$("#dmCheck"), rows=R?.check?.rows||[], row=id=>rows.find(r=>r.id===id);
    const addLines=rs=>{ const fresh=rs.map(r=>{ const {rule,...a}=r.add; return a; }); keep([...bom, ...fresh]); };
    box?.querySelectorAll("[data-cadd]").forEach(b=>b.onclick=()=>addLines([row(b.dataset.cadd)]));
    $("#bmAddAll")&&($("#bmAddAll").onclick=()=>addLines(rows.filter(r=>r.status==="missing")));
    box?.querySelectorAll("[data-cskip]").forEach(s=>s.onchange=()=>{ if(!s.value) return; setKeep({skip:{...(set.skip||{}), [s.dataset.cskip]:{why:s.value, at:bmToday()}}}); });
    box?.querySelectorAll("[data-cundo]").forEach(b=>b.onclick=()=>{ const {[b.dataset.cundo]:_, ...rest}=set.skip||{}; setKeep({skip:rest}); });
    if($("#bmSpare")) $("#bmSpare").onchange=e=>setKeep({spare_pct:e.target.value===""?0:+e.target.value});
    if($("#bmNoPrices")) $("#bmNoPrices").onchange=e=>setKeep({packet_no_prices:e.target.checked});
    if($("#bmIssue")) $("#bmIssue").onclick=async e=>{ const b=e.currentTarget; b.disabled=true;
      try{ await post(`/api/das/jobs/${j.id}/bomissue`,{note:$("#bmRevNote").value, override:$("#bmRevWhy")?.value||""}); window.dasBomHold(); render(); }
      catch(err){ $("#bmRevMsg").textContent=err.message; b.disabled=false; } };
    // the part in someone's hand
    if($("#dmHand")) $("#dmHand").oninput=$("#dmHand").onchange=e=>{ const t=bmPn(e.target.value), m=$("#dmHandMsg"); if(!t){ m.className="hint"; m.textContent="It says whether this job's list has that part, and where it goes."; return; }
      const hit=L.filter(l=>bmPn(lineAt(l).part)===t);
      if(hit.length){ m.className="bm-ok"; m.innerHTML=hit.map(l=>{ const x=lineAt(l); return `Right part: line ${l.no}, ${esc(R.group_list.find(g=>g.key===l.group)?.label||"")}, ${esc(x.qty)} ${esc(x.unit||"")}${x.loc?`, ${esc(x.loc)}`:""}.`; }).join(" "); return; }
      if(t.length<3) return;
      const near=L.map(l=>{ const p=bmPn(lineAt(l).part); let k=0; while(k<p.length&&k<t.length&&p[k]===t[k]) k++; return {l, k, p}; }).filter(x=>x.p&&x.k>=Math.min(4,t.length)).sort((a,b)=>b.k-a.k).slice(0,3);
      m.className="bm-bad"; m.textContent=`Not on this job's list.${near.length?` Close to: ${near.map(x=>lineAt(x.l).part).join(", ")}.`:""}`; };
    // iBwave
    if($("#dmIbw")) $("#dmIbw").onchange=async e=>{ const f=e.target.files[0]; if(!f) return; const out=$("#dmIbwRes"); out.innerHTML=`<p class="hint">Reading ${esc(f.name)}…</p>`;
      try{ const r=await api(`/api/das/jobs/${j.id}/bomimport?name=${encodeURIComponent(f.name)}`,{method:"POST", body:await f.arrayBuffer()});
        const have=new Set(bom.map(x=>`${bmPn(x.part||x.item)}|${x.loc||""}`)), fresh=r.lines.filter(x=>!have.has(`${bmPn(x.part||x.item)}|${x.loc||""}`));
        out.innerHTML=`<div class="panel" style="margin:6px 0"><h3 style="margin:0 0 4px">${esc(f.name)} <span class="hint">· ${r.lines.length} line${r.lines.length===1?"":"s"} read${r.sheet&&r.format==="excel"?` from sheet ${esc(r.sheet)}`:""}, headings on row ${r.header_row}</span></h3>
          <p class="hint" style="margin:0 0 4px">Columns read: ${Object.entries(r.columns).map(([k,h])=>`${esc(k)} = ${esc(h)}`).join(", ")}.${r.not_read.length?` Not read: ${r.not_read.map(esc).join(", ")}.`:""}</p>
          <p style="margin:0 0 4px"><b>${r.matched}</b> matched the catalogue. <b>${r.unmatched.length}</b> didn't${r.unmatched.length?`: ${r.unmatched.slice(0,12).map(x=>esc(x.part||x.item)).join(", ")}${r.unmatched.length>12?` and ${r.unmatched.length-12} more`:""}`:""}.
            ${r.lines.length-fresh.length?` ${r.lines.length-fresh.length} already on the list: left as they are.`:""}${r.joined?` ${r.joined} repeated row${r.joined===1?"":"s"} joined into one line.`:""}${r.no_group?` ${r.no_group} went to Accessories because their type wasn't recognised.`:""}${r.unit_guessed?` ${r.unit_guessed} cable line${r.unit_guessed===1?"":"s"} had no unit: set to ft, check them.`:""}</p>
          <p class="hint" style="margin:0 0 4px">By group: ${r.groups.map(g=>`${esc(g.label)} ${g.lines}`).join(" · ")}.${r.labor_cost?` Construction cost read: ${money(r.labor_cost)}, added to the Customer sheet's labor.`:""}</p>
          ${r.skipped.length?`<p class="hint" style="margin:0 0 4px">Rows left out: ${r.skipped.slice(0,6).map(x=>`row ${x.row} (${esc(x.why)}${x.text?`: ${esc(x.text)}`:""})`).join("; ")}${r.skipped.length>6?` and ${r.skipped.length-6} more`:""}.</p>`:""}
          <div class="row" style="gap:6px"><button class="primary" id="dmIbwAdd" ${fresh.length?"":"disabled"}>Add ${fresh.length} line${fresh.length===1?"":"s"}</button><button id="dmIbwNo">Close</button></div></div>`;
        $("#dmIbwNo").onclick=()=>{ out.innerHTML=""; };
        $("#dmIbwAdd").onclick=()=>keep([...bom, ...fresh.map(({group_label,...x})=>x)]); }
      catch(err){ out.innerHTML=`<p class="status err">${esc(err.message)}</p>`; } e.target.value=""; };
    // kits
    api("/api/das/kits").then(r=>{ const s=$("#dmKit"); if(!s) return; c.kits=r.kits; s.innerHTML=`<option value="">${r.kits.length?"Pick a kit…":"No kits saved yet"}</option>${r.kits.map(k=>`<option value="${k.id}">${esc(k.name)} (${k.lines.length} line${k.lines.length===1?"":"s"})</option>`).join("")}`; }).catch(()=>{});
    if($("#dmKit")) $("#dmKit").onchange=e=>{ $("#dmKitAdd").disabled=!e.target.value; };
    if($("#dmKitAdd")) $("#dmKitAdd").onclick=()=>{ const k=(c.kits||[]).find(x=>x.id===+$("#dmKit").value); if(k) keep([...bom, ...k.lines]); };
    if($("#dmKitSave")) $("#dmKitSave").onclick=async()=>{ const g=$("#dmKitFrom").value, lines=bom.filter((_,i)=>!g||by.get(i)?.group===g).map(x=>({...x, group:x.group||by.get(bom.indexOf(x))?.group})), name=prompt(`A name for this kit of ${lines.length} line${lines.length===1?"":"s"}`,""); if(!name) return;
      try{ const r=await post("/api/das/kits",{name, lines}); c.kits=r.kits; const s=$("#dmKit"); s.innerHTML=`<option value="">Pick a kit…</option>${r.kits.map(k=>`<option value="${k.id}">${esc(k.name)} (${k.lines.length} line${k.lines.length===1?"":"s"})</option>`).join("")}`; $("#dmCatMsg").textContent=`Kit ${name} saved with ${lines.length} line${lines.length===1?"":"s"}.`; }
      catch(err){ alert(err.message); } };
    if($("#dmOrders")) $("#dmOrders").onclick=()=>{ const a=document.createElement("a"); a.href=`/api/das/jobs/${j.id}/bomxlsx?sheets=orders`; a.download=""; document.body.appendChild(a); a.click(); a.remove(); };
  };
  return {summary, listView, outBar, outView, view, hand, addExtras, checkPanel, tools, wire, R};
}
// a catalogue part onto a line, or a typed line: what the lookup fills
function bmFill(p, was={}){ const then=p.price_then;
  return {...was, pid:p.id, part:p.part||was.part||"", item:p.item||was.item||"", maker:p.maker||"", supplier:p.supplier||"", cat:p.cat||was.cat||"", unit:p.unit||was.unit||"ea",
    price:then?then.price:p.price??was.price??"", price_at:then?then.at:p.price_at||"", price_by:"catalogue"}; }
function bmChooser(box, r, pick, what=""){ if(!box) return;
  box.innerHTML=`<p class="hint" style="margin:6px 0 2px">${r.matches.length} suppliers carry ${esc(r.query)}${what?` for ${esc(what)}`:""}. Pick one:</p><div class="bm-hits">${r.matches.map((p,i)=>`<button class="bm-hit" data-hit="${i}"><b class="mono">${esc(p.part)}</b> <span>${esc(p.item||"")}</span> <span class="hint">${esc(p.maker||"")}${p.supplier?` · ${esc(p.supplier)}`:""}</span> <b>${p.price!=null?(+p.price).toFixed(2):""}</b>${p.price_at?` <span class="hint">${esc(p.price_at)}</span>`:""}</button>`).join("")}</div>`;
  box.querySelectorAll("[data-hit]").forEach(b=>b.onclick=()=>{ box.innerHTML=""; pick(r.matches[+b.dataset.hit]); }); }
// the Part number box on the add row: as you type, what the catalogue has; Enter or a pick fills the row
function bmAddLookup(fill){ const box=$("#dmHits"), inp=$("#dmPart"), asOf=$("#dmAsOf"); if(!inp||!box) return;
  const show=async()=>{ const v=inp.value.trim(); if(!v){ box.innerHTML=""; fill(null); return; }
    const r=await api(`/api/das/parts/lookup?part=${encodeURIComponent(v)}&as_of=${encodeURIComponent(asOf?.value||"")}`).catch(e=>({err:e.message, matches:[], near:[]}));
    if(inp.value.trim()!==v) return;  // typed on since
    if(r.err){ box.innerHTML=`<p class="status err">${esc(r.err)}</p>`; return; }
    if(r.found&&r.matches.length===1){ const p=r.matches[0]; fill(p);
      const then=r.as_of?(p.price_then?` On ${esc(r.as_of)} it was ${(+p.price_then.price).toFixed(2)} (dated ${esc(p.price_then.at)}).`:` No price kept on or before ${esc(r.as_of)}: its history starts later.`):"";
      box.innerHTML=`<p class="hint" style="margin:6px 0 0">Found: <b>${esc(p.part)}</b>, ${esc(p.maker||"no maker kept")}${p.supplier?`, ${esc(p.supplier)}`:""}${p.price!=null?`, ${(+p.price).toFixed(2)} as of ${esc(p.price_at||"")}`:""}.${then}${p.spec_url||p.spec_file?" Spec sheet kept.":""}</p>`; return; }
    if(r.found){ bmChooser(box, r, p=>fill(p)); return; }
    fill(null);
    box.innerHTML=`<p class="hint" style="margin:6px 0 0"><b>${esc(v)} isn't in the catalogue.</b> You can still add the line: fill in the rest by hand.</p>${r.near.length?`<div class="bm-hits">${r.near.slice(0,6).map((p,i)=>`<button class="bm-hit" data-near="${i}"><b class="mono">${esc(p.part)}</b> <span>${esc((p.item||"").slice(0,90))}</span> <span class="hint">${esc(p.maker||"")}</span></button>`).join("")}</div>`:""}`;
    box.querySelectorAll("[data-near]").forEach(b=>b.onclick=()=>{ inp.value=r.near[+b.dataset.near].part; show(); }); };
  inp.oninput=()=>{ clearTimeout(bmAddLookup.t); bmAddLookup.t=setTimeout(show,260); };
  if(asOf) asOf.onchange=show; }
// a part's price now and its dated history, under the catalogue
async function bmPriceHistory(box, id){ box.innerHTML='<p class="hint">Reading its prices…</p>';
  try{ const h=await api(`/api/das/parts/${id}/prices`), f=v=>v==null?"":(+v).toFixed(2);
    box.innerHTML=`<div style="border-top:1px solid var(--line);margin-top:10px;padding-top:10px"><h3 style="margin:0 0 6px">Prices · <span class="mono">${esc(h.part||h.item||"")}</span> <span class="hint">${esc(h.maker||"")}</span></h3>
      <p style="margin:0 0 6px">Now <b>${f(h.price)||"no price"}</b>${h.unit?` per ${esc(h.unit)}`:""}${h.supplier?` from ${esc(h.supplier)}`:""}. <span class="hint">Every price comes from your own dated price lists or was typed here.</span></p>
      ${h.history.length?`<div class="tw"><table><thead><tr><th>Date</th><th>Supplier</th><th class="n">Price</th><th class="n">Change</th><th>Last seen</th><th>From</th></tr></thead><tbody>${h.history.map(x=>`<tr><td>${esc((x.at||"").slice(0,10))}</td><td>${esc(x.supplier||"")}</td><td class="n">${f(x.price)}</td><td class="n">${x.pct==null?"":`${x.pct>0?"+":""}${x.pct}%`}</td><td>${esc((x.seen_at||"").slice(0,10))}</td><td>${esc(x.source||"")}</td></tr>`).join("")}</tbody></table></div>`:'<p class="hint">No dated price yet: the next price list or a typed price starts its history.</p>'}
      <button id="dmHistClose" style="margin-top:6px">Close</button></div>`;
    $("#dmHistClose").onclick=()=>{ box.innerHTML=""; }; box.scrollIntoView({block:"nearest"}); }
  catch(e){ box.innerHTML=`<p class="status err">${esc(e.message)}</p>`; } }
