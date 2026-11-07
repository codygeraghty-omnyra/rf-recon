"use strict";
/* RF Recon: what a PDF's own words propose. Three readers: a plan set (its floors, which page is which floor, the scale and the critical
   areas), a spec sheet (a part's code fields) and a certificate (a calibration certificate's serial and dates, or a credential's expiry).
   Pure: no page needed, so node runs it too (tests/readers_check.mjs reads generated PDFs through the same pdf.js the app ships).
   Rules for everything here:
     every value carries the words it came from, so a person can check it against the sheet;
     a blank is a right answer: when the words don't say it plainly, nothing is proposed;
     nothing here fills anything. plans.js and dasread.js show the proposals, and only a press writes, and only into an empty field.
   Words come from pdf.js through planlines.js (textWords, scaleOfText). No words: "scan: needs a person". Text recognition isn't in here. */
(() => {
const PL = () => (typeof window !== "undefined" && window.PlanLines) || (typeof require === "function" ? require("./planlines.js") : null);
const SCAN_CHARS = 30;  // as intake.py read_pdf: under this, a PDF has no words worth reading
const squeeze = s => String(s ?? "").replace(/\s+/g, " ").trim();
const clip = (s, n = 90) => { const t = squeeze(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// the words around a match, cut at a word: a long table row shouldn't fill the screen
function around(line, m, n = 90) {
  const t = squeeze(line); if (t.length <= n) return t;
  const at = Math.max(0, t.toLowerCase().indexOf(String(m || "").toLowerCase().slice(0, 12))), from = Math.max(0, at - 24), bit = t.slice(from, from + n);
  return `${from ? "…" : ""}${bit.replace(/^\S*\s/, from ? "" : "$&")}${from + n < t.length ? "…" : ""}`;
}

/* ---------- words into lines ---------- */
// a page's words as lines, in reading order. gap: how far apart (in text heights) two words on a row can be and still be one line.
// Infinity keeps a whole table row together (a spec sheet's "FCC ID ... ABC-123"); a plan's labels need the row split (rooms side by side)
function linesOf(words, gap = 1.6) {
  const by = new Map(), out = [];
  for (const w of words || []) { const r = ((w.rot || 0) % 360 + 360) % 360; if (!by.has(r)) by.set(r, []); by.get(r).push(w); }
  for (const [r, list] of by) {
    const uv = w => r === 90 ? [w.y, -w.x] : r === 180 ? [-w.x, -w.y] : r === 270 ? [-w.y, w.x] : [w.x, w.y];
    const on = list.map(w => { const [u, v] = uv(w); return {w, u, v}; }).sort((a, b) => a.v - b.v || a.u - b.u);
    let row = null; const rows = [];
    for (const t of on) {
      if (!row || Math.abs(t.v - row.v) > 0.55 * Math.max(t.w.h, row.h)) { row = {v: t.v, h: t.w.h, items: []}; rows.push(row); }
      row.items.push(t); row.h = Math.max(row.h, t.w.h);
    }
    for (const q of rows) {
      q.items.sort((a, b) => a.u - b.u);
      let cur = null;
      for (const t of q.items) {
        const w = t.w.w || t.w.s.length * t.w.h * 0.5, x0 = t.u - w / 2, x1 = t.u + w / 2;
        if (!cur || x0 - cur.end > gap * Math.max(cur.h, t.w.h)) { cur = {parts: [], end: x1, h: t.w.h, rot: r, xs: [], ys: [], x0}; out.push(cur); }
        // pieces of one word, as some exports cut them, join with no space
        if (cur.parts.length && x0 - cur.end < 0.1 * Math.max(cur.h, t.w.h)) cur.parts[cur.parts.length - 1] += t.w.s; else cur.parts.push(t.w.s);
        cur.end = Math.max(cur.end, x1); cur.h = Math.max(cur.h, t.w.h); cur.xs.push(t.w.x); cur.ys.push(t.w.y);
      }
    }
  }
  for (const l of out) { l.s = squeeze(l.parts.join(" ")); l.x = l.xs.reduce((a, b) => a + b, 0) / l.xs.length; l.y = l.ys.reduce((a, b) => a + b, 0) / l.ys.length; delete l.xs; delete l.ys; delete l.parts; }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}
const charsOf = pages => (pages || []).reduce((n, p) => n + (p.words || []).reduce((a, w) => a + w.s.replace(/\s/g, "").length, 0), 0);
// every row of every page, top to bottom: what the spec sheet and certificate readers work from
const rowsOf = pages => (pages || []).flatMap(p => linesOf(p.words, Infinity).map(l => l.s));
const scanOf = pages => charsOf(pages) < SCAN_CHARS;

/* ---------- floors ---------- */
const ORD_WORD = {FIRST: 1, SECOND: 2, THIRD: 3, FOURTH: 4, FIFTH: 5, SIXTH: 6, SEVENTH: 7, EIGHTH: 8, NINTH: 9, TENTH: 10, ELEVENTH: 11, TWELFTH: 12, THIRTEENTH: 13, FOURTEENTH: 14,
  FIFTEENTH: 15, SIXTEENTH: 16, SEVENTEENTH: 17, EIGHTEENTH: 18, NINETEENTH: 19, TWENTIETH: 20};
const CARD_WORD = {ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9, TEN: 10};
const ORD = `(?:\\d{1,3}(?:ST|ND|RD|TH)|${Object.keys(ORD_WORD).join("|")})`;
const ordNum = s => ORD_WORD[s] || parseInt(s, 10);
const TO = "\\s*(?:-|–|—|TO|THRU|THROUGH)\\s*";
const FL = "(?:FLOORS?|FLRS?\\.?|LEVELS?|LVLS?\\.?)";
// the floors a title names, as short names: "1", "12", "B1", "P2", "G", "M", "PH". Ranges come first and are taken out of the text, so
// LEVELS 3-5 isn't also level 3. A roof isn't a floor: a grid isn't walked on it from a plan sheet
function floorsIn(text) {
  let t = ` ${String(text || "").toUpperCase().replace(/[’']/g, "").replace(/\s+/g, " ")} `;
  const out = [], add = x => { if (!out.includes(x)) out.push(x); };
  const span = (a, b) => { if (!(b >= a && b - a < 200)) return false; for (let i = a; i <= b; i++) add(String(i)); return true; };
  t = t.replace(new RegExp(`\\b${FL}\\s+(\\d{1,3})${TO}(\\d{1,3})\\b(?![\\d/.'"])`, "g"), (all, a, b) => span(+a, +b) ? " " : all);
  t = t.replace(new RegExp(`\\b(${ORD})\\s*${FL}?${TO}(${ORD})\\s*${FL}\\b`, "g"), (all, a, b) => span(ordNum(a), ordNum(b)) ? " " : all);
  t = t.replace(new RegExp(`\\b${FL}\\s+(\\d{1,3}(?:\\s*(?:,|&|AND)\\s*\\d{1,3})+)\\b`, "g"), (_, l) => { l.split(/,|&|AND/).forEach(x => add(String(+x))); return " "; });
  t = t.replace(new RegExp(`\\b(${ORD})\\s*(?:,|&|AND)\\s*(${ORD})\\s*${FL}\\b`, "g"), (_, a, b) => { add(String(ordNum(a))); add(String(ordNum(b))); return " "; });
  t = t.replace(new RegExp(`\\b(${ORD})\\s+BASEMENT\\b`, "g"), (_, a) => { add(`B${ordNum(a)}`); return " "; });
  t = t.replace(/\bSUB-?\s?BASEMENT\b/g, () => { add("B2"); return " "; });
  t = t.replace(/\b(?:BASEMENT|CELLAR|LOWER LEVEL)(?:\s+(?:LEVEL|FLOOR))?(?:\s+#?(\d))?\b/g, (_, n) => { add(`B${n || 1}`); return " "; });
  t = t.replace(/\b(?:PARKING|GARAGE)(?:\s+(?:LEVEL|DECK|FLOOR))?(?:\s+P?(\d))?(?=\s+(?:FLOOR\s+)?PLAN\b|\s*$)/g, (_, n) => { add(`P${n || 1}`); return " "; });
  t = t.replace(/\b(?:FLOOR|LEVEL)\s+([BP])-?(\d)\b/g, (_, a, n) => { add(`${a}${n}`); return " "; });
  t = t.replace(/\bGROUND\s+(?:FLOOR|LEVEL)\b/g, () => { add("G"); return " "; });
  t = t.replace(/\bMAIN\s+(?:FLOOR|LEVEL)\b/g, () => { add("1"); return " "; });
  t = t.replace(/\bMEZZ(?:ANINE)?\b\.?/g, () => { add("M"); return " "; });
  t = t.replace(/\bPENTHOUSE\b/g, () => { add("PH"); return " "; });
  t = t.replace(new RegExp(`\\b(${ORD})\\s+(?:FLOOR|FLR\\.?|LEVEL|STORY|STOREY)\\b`, "g"), (_, a) => { add(String(ordNum(a))); return " "; });
  t = t.replace(/\b(?:FLOOR|FLR\.?|LEVEL|LVL\.?|LEV\.)\s*(?:#|NO\.?\s*)?(\d{1,3})\b/g, (_, n) => { add(String(+n)); return " "; });
  t = t.replace(new RegExp(`\\b(?:FLOOR|LEVEL)\\s+(${Object.keys(CARD_WORD).join("|")})\\b`, "g"), (_, w) => { add(String(CARD_WORD[w])); return " "; });
  if (/\bPLANS?\b/.test(t)) for (const m of t.matchAll(/(?:^|\s)([LBP])(\d{1,2})(?=\s)/g)) add(m[1] === "L" ? String(+m[2]) : `${m[1]}${+m[2]}`);
  return out;
}
// a job's own floor name in the same terms ("Level 3", "3", "Ground"), so a sheet finds the floor the job already has
function floorKey(name) {
  const t = squeeze(name);
  if (/^\d{1,3}$/.test(t)) return String(+t);
  if (/^[BP]-?\d{1,2}$/i.test(t)) return t.toUpperCase().replace("-", "");
  if (/^(G|GF)$/i.test(t)) return "G";
  if (/^(M|PH)$/i.test(t)) return t.toUpperCase();
  return floorsIn(`${t} FLOOR`)[0] || floorsIn(t)[0] || t.toUpperCase();
}
const floorRank = k => { if (/^\d+$/.test(k)) return +k; const m = /^([BP])(\d+)$/.exec(k); return m ? (m[1] === "B" ? -m[2] : -50 - +m[2]) : k === "G" ? 0 : k === "M" ? 1.5 : k === "PH" ? 500 : 900; };
const sortFloors = list => [...list].sort((a, b) => floorRank(floorKey(a.name ?? a)) - floorRank(floorKey(b.name ?? b)));
// new floors into a job's list, each where it belongs; the job's own floors keep their order and everything on them
function addFloors(list, names, grids) {
  const out = [...list];
  for (const name of names) {
    if (out.some(f => f.name === name)) continue;
    const r = floorRank(floorKey(name)), at = out.findIndex(f => floorRank(floorKey(f.name)) > r);
    out.splice(at < 0 ? out.length : at, 0, {name, grids});
  }
  return out;
}

/* ---------- one sheet ---------- */
const DRAWN = /\bPLANS?\b|\bELEVATIONS?\b|\bSECTIONS?\b|\bDETAILS?\b|\bSCHEDULES?\b|\bNOTES\b|\bCOVER\b|\bINDEX\b|\bLEGEND\b|\bDIAGRAMS?\b/;
const FLOOR_ISH = /\b(?:FLOORS?|FLRS?|LEVELS?|LVLS?|BASEMENT|CELLAR|MEZZANINE|MEZZ|PENTHOUSE|GARAGE|PARKING|L\d{1,2})\b/;
const INDEX_WORDS = /\b(?:SHEET|DRAWING)\s+(?:INDEX|LIST)\b|\bINDEX OF (?:SHEETS|DRAWINGS)\b|\bLIST OF (?:SHEETS|DRAWINGS)\b|\bDRAWING SCHEDULE\b|\bCOVER SHEET\b|\bTITLE SHEET\b/;
// sheets that name a floor and aren't the floor plan: 0 never offered as the floor's plan, 1 only when there's nothing better
const NOT_THE_PLAN = [[/\bREFLECTED\b|\bRCP\b|\bCEILING\b/, 0], [/\bDEMO(?:LITION)?\b/, 0], [/\bENLARGED\b|\bPARTIAL\b|\bBLOW.?UP\b|\bKEY PLAN\b|\bTOILET\b|\bRESTROOM\b/, 0],
  [/\bELECTRICAL\b|\bLIGHTING\b|\bPOWER\b|\bLOW VOLTAGE\b|\bTELECOM\w*\b/, 1], [/\bMECHANICAL\b|\bHVAC\b|\bDUCT\w*\b/, 1], [/\bPLUMBING\b/, 1], [/\bFIRE ALARM\b/, 1],
  [/\bFIRE PROTECTION\b|\bSPRINKLER\b/, 1], [/\bSTRUCTURAL\b|\bFRAMING\b|\bFOUNDATION\b/, 1], [/\bFINISH\w*\b|\bFURNITURE\b|\bFURNISHING\w*\b/, 1], [/\bLIFE SAFETY\b|\bEGRESS\b/, 2], [/\bAREA [A-Z0-9]\b|\bSECTOR\b|\bWING\b|\bZONE\b/, 2]];
const SHEET_NO = /^(?:(?:SHEET|DWG|DRAWING)(?:\s*(?:NO\.?|NUMBER|#))?\s*:?\s*)?([A-Z]{1,3}[-.]?\d{1,3}(?:\.\d{1,3})?[A-Z]?)$/;
const corner = (l, W, H) => l.x / W >= 0.62 && l.y / H >= 0.55;
const titleZone = (l, W, H) => corner(l, W, H) || l.y / H >= 0.86 || l.x / W >= 0.86;
const OFFICE = /\b(?:ST|STREET|AVE|AVENUE|SUITE|STE|BLVD|ROAD|RD|TEL|FAX|PHONE)\b|\d{3}[-.]\d{3}/;

function sheetNumber(lines, W, H) {
  const hit = lines.map(l => [l, SHEET_NO.exec(l.s.toUpperCase())]).filter(x => x[1]);
  const pick = list => list.sort((a, b) => b[0].h - a[0].h)[0];
  const best = pick(hit.filter(x => corner(x[0], W, H))) || pick(hit.filter(x => titleZone(x[0], W, H)));
  return best ? best[1][1] : null;
}
// the sheet's title: in the title block when there's one, else the biggest drawing title on the page. A title often breaks over two rows
function sheetTitles(lines, W, H) {
  const out = [];
  for (const l of lines) {
    const t = squeeze(l.s.replace(/^(?:sheet|drawing)\s*(?:title|name)\s*:?\s*/i, "")), U = t.toUpperCase();
    if (!t || t.length > 70 || !DRAWN.test(U) || /\bSEE\b|\bREFER\b|\bMATCH\s?LINE\b/.test(U)) continue;  // a pointer to another sheet isn't this sheet's title
    let s = t, fl = floorsIn(U);
    if (!fl.length && /\bPLANS?\b/.test(U)) {  // the floor on the row above or below
      const near = lines.find(o => o !== l && o.rot === l.rot && Math.hypot(o.x - l.x, o.y - l.y) < Math.max(4 * l.h, 0.5 * (l.end - l.x0)) && o.s.length < 30 && !OFFICE.test(o.s.toUpperCase()) && floorsIn(o.s).length);
      if (near) { s = near.y < l.y ? `${near.s} ${t}` : `${t} ${near.s}`; fl = floorsIn(s); }
    }
    const U2 = s.toUpperCase();
    out.push({s, h: l.h, zone: titleZone(l, W, H), floors: fl, plan: /\bPLANS?\b/.test(U2) && (FLOOR_ISH.test(U2) || fl.length > 0), roof: /\bROOF\b/.test(U2) && !fl.includes("PH")});
  }
  return out;
}
const titleScore = (c, big) => (c.zone ? 3 : 0) + (c.floors.length ? 3 : 0) + (c.plan ? 2 : 0) + c.h / big;

// the scale bar: three or more numbers along a row, spaced as their values, with a unit or the word SCALE beside them. Its points per foot
// survive a reduced print, which a written scale doesn't
function barScale(lines, words) {
  const nums = (words || []).filter(w => (w.rot || 0) === 0 && /^\d{1,4}\s*['’′]?$|^\d{1,4}\s*(?:FT|FEET|M)$/i.test(w.s)).map(w => ({w, v: parseInt(w.s, 10)}));
  const rows = [];
  for (const n of nums.sort((a, b) => a.w.y - b.w.y)) { const r = rows.find(q => Math.abs(q.y - n.w.y) < 0.6 * n.w.h); if (r) r.list.push(n); else rows.push({y: n.w.y, h: n.w.h, list: [n]}); }
  for (const r of rows) {
    const L = r.list.sort((a, b) => a.w.x - b.w.x);
    if (L.length < 3 || L[0].v !== 0) continue;
    if (!L.every((n, i) => !i || n.v > L[i - 1].v)) continue;
    const span = L[L.length - 1].w.x - L[0].w.x, feet = L[L.length - 1].v, k = span / feet;
    if (!(span > 0) || L.some(n => Math.abs(L[0].w.x + n.v * k - n.w.x) > 0.04 * span)) continue;  // the ticks must sit where their values say
    const near = lines.filter(l => Math.abs(l.y - r.y) < 5 * r.h && l.x > L[0].w.x - 8 * r.h && l.x < L[L.length - 1].w.x + 16 * r.h).map(l => l.s).join(" ").toUpperCase();
    const unit = /\bMETERS?\b|\bMETRES?\b|\d\s*M\b/.test(near) ? "m" : /\bFEET\b|\bFT\b|'|’/.test(near) ? "ft" : /\bSCALE\b/.test(near) ? "ft?" : null;
    if (!unit) continue;
    return {ptPerFt: unit === "m" ? k * 0.3048 : k, how: "bar", words: clip(`${/GRAPHIC SCALE/.test(near) ? "GRAPHIC SCALE " : ""}${L.map(n => n.v).join(" ")} ${unit === "m" ? "METERS" : unit === "ft" ? "FEET" : ""}`), noUnit: unit === "ft?"};
  }
  return null;
}
const inchSay = k => { const r = k / 72, tbl = [[1, 96], [1, 64], [1, 48], [3, 32], [1, 32], [1, 16], [3, 16], [1, 8], [1, 4], [3, 8], [1, 2], [3, 4], [1, 1]];
  const m = tbl.find(([a, b]) => Math.abs(a / b - r) / r < 0.02); return m ? `${m[1] === 1 ? m[0] : `${m[0]}/${m[1]}`} in = 1 ft` : r > 0 ? `1 in = ${Math.round(1 / r * 10) / 10} ft` : ""; };
function pageScale(lines, words, title, W, H) {
  const notes = [], written = [];
  for (const l of lines) {
    if (l.s.length > 90) continue;
    const k = PL().scaleOfText(l.s); if (!k) continue;
    const U = l.s.toUpperCase();
    if (/\bKEY PLAN\b|\bDETAIL\b|\bENLARGED\b|\bSECTION\b|\bELEVATION\b/.test(U)) continue;  // not the floor plan's own scale
    written.push({ptPerFt: k, how: "written", words: clip(l.s), hasTitle: !!title && U.includes(title.toUpperCase()), zone: titleZone(l, W, H)});
  }
  const bar = barScale(lines, words);
  const kinds = [...new Set(written.map(x => Math.round(x.ptPerFt * 100)))];
  const pick = written.find(x => x.hasTitle) || written.find(x => x.zone) || written[0] || null;
  if (kinds.length > 1) notes.push(`This sheet shows ${kinds.length} scales. The one read is ${pick.words}: check it's the floor plan's.`);
  let best = pick;
  if (bar && pick && Math.abs(bar.ptPerFt - pick.ptPerFt) / pick.ptPerFt > 0.05) {
    notes.push(`The sheet says ${inchSay(pick.ptPerFt)} but its scale bar works out to ${inchSay(bar.ptPerFt)}. This copy was probably printed smaller or larger, so the bar is used.`);
    best = bar;
  } else if (bar && !pick) best = bar;
  if (best && best.how === "bar" && best.noUnit) notes.push("The scale bar has no unit on it: it was taken as feet.");
  if (best && best.how === "written" && !bar && Math.max(W, H) <= 1296) notes.push(`This page is ${Math.round(W / 72)} x ${Math.round(H / 72)} in. If it's a reduced print, its written scale is wrong: check one dimension.`);
  if (best && !(W / best.ptPerFt >= 15 && W / best.ptPerFt <= 5000)) return {scale: null, notes: []};
  return {scale: best, notes};
}

/* ---------- critical areas ---------- */
// DAS.critical_areas's names (das.js), and the room labels that mean each. Labels only: a short line on a floor plan, not a sentence in the notes
const AREA_WORDS = [["Fire command center", /\bFIRE (?:COMMAND|CONTROL)(?: (?:CENTER|CENTRE|ROOM|STATION))?\b|\bF\.C\.C\.?(?:\s|$)|^FCC(?:\s+(?:RM\.?|ROOM|\d{1,4}))?$/],
  ["Fire pump room", /\bFIRE PUMP\b/], ["Elevator lobbies", /\bELEV(?:ATOR)?\.?\s+LOB(?:BY|\.)?(?:\s|$)/],
  ["Elevators (cars)", /\bELEVATORS?\b(?!\s+(?:MACHINE|EQUIP|PIT|LOBBY|LOB\b))|\bELEV\.?(?:\s*#?\d{1,2}|\s+[A-D])?$/], ["Exit stairs", /\b(?:EXIT\s+)?STAIR(?:S|WAY|WELL)?\b/],
  ["Exit passageways", /\bEXIT PASSAGE(?:WAY)?S?\b/], ["Standpipe cabinets", /\bSTANDPIPE\b|\bF\.H\.C\.?(?:\s|$)|^FHC(?:\s+\d{1,4})?$|\bFIRE HOSE CAB/],
  ["Sprinkler sectional valve locations", /\bSECTIONAL VALVE\b|\bFLOOR CONTROL VALVE\b|^FCV(?:\s+\d{1,4})?$|\bZONE CONTROL VALVE\b/],
  ["Fire protection equipment rooms (NY)", /\bFIRE PROTECTION (?:EQUIPMENT )?ROOM\b|\bSPRINKLER (?:RISER )?ROOM\b/]];
const NOT_A_ROOM = /\bDETAILS?\b|\bSECTIONS?\b|\bNOTES?\b|\bSEE\b|\bSCHEDULE\b|\bRAILING\b|\bTREADS?\b|^T\.?O\.?\b|^FIN\b|^TOP\b|\bELEVATION\b|\bPLANS?\b/;
function roomLabels(lines, W, H, areas) {
  const out = [];
  for (const l of lines) {
    const t = l.s, U = t.toUpperCase();
    if (t.length > 40 || t.split(" ").length > 6 || NOT_A_ROOM.test(U) || titleZone(l, W, H) && l.x / W >= 0.86) continue;
    const a = AREA_WORDS.find(([name, re]) => (!areas || areas.includes(name)) && re.test(U));
    if (a) out.push({area: a[0], s: t, x: l.x / W, y: l.y / H});
  }
  return out;
}

/* ---------- a plan set ---------- */
function readSheet(p, areas) {
  const lines = linesOf(p.words), W = p.W, H = p.H;
  const sheet = sheetNumber(lines, W, H), cands = sheetTitles(lines, W, H), text = lines.map(l => l.s).join("\n").toUpperCase();
  const big = Math.max(1, ...cands.map(c => c.h));
  // the title block says what the sheet is. A drawing's own title only speaks when there's no title block to read
  const zone = cands.filter(c => c.zone), best = [...(zone.length ? zone : cands)].sort((a, b) => titleScore(b, big) - titleScore(a, big))[0] || null;
  const planned = cands.filter(c => c.plan && c.floors.length), nameFloors = new Set(planned.flatMap(c => c.floors));
  const sheetIs = {n: p.n, W, H, sheet, title: best ? clip(best.s, 70) : "", words: 0, kind: "other", rank: 0, floors: [], labels: [], scale: null, notes: []};
  sheetIs.words = (p.words || []).length;
  const isIndex = (INDEX_WORDS.test(text) && nameFloors.size >= 2) || nameFloors.size >= 4 || (best && /\bCOVER\b/.test(best.s.toUpperCase()) && nameFloors.size >= 1);
  if (isIndex) { sheetIs.kind = "index"; return sheetIs; }
  if (!best) return sheetIs;
  const U = best.s.toUpperCase();
  if (best.roof) { sheetIs.kind = "roof"; return sheetIs; }
  let floors = best.plan ? best.floors : [];
  const named = floors.length > 0;
  if (!named) floors = [...nameFloors];  // a title block that says FLOOR PLANS, over named drawings on the sheet: the floor's own sheet beats it
  if (!best.plan && !floors.length) return sheetIs;
  const hit = NOT_THE_PLAN.find(([re]) => re.test(U));
  const prefix = sheet ? /^[A-Z]+/.exec(sheet)[0] : "";
  sheetIs.kind = "plan"; sheetIs.floors = floors;
  sheetIs.rank = hit ? hit[1] : prefix && !/^(A|AE|AR|D|G)$/.test(prefix) ? 1 : named ? 3 : 1;
  sheetIs.title = clip(best.plan ? best.s : (planned[0] || best).s, 70);
  const {scale, notes} = pageScale(lines, p.words, best.s, W, H);
  sheetIs.scale = scale; sheetIs.notes = notes;
  sheetIs.labels = roomLabels(lines, W, H, areas);
  if (floors.length > 1 && floors.length < 4 && !/\bTYPICAL\b|\bTYP\b/.test(U) && planned.length > 1) sheetIs.notes.push(`This one sheet shows ${floors.length} floors. Each floor's grid sits on the whole sheet until you move it.`);
  return sheetIs;
}
// pages: [{n, W, H, words}] from plans.js pdfWords. opts.areas: the critical areas to look for (das.js's list)
function planSet(pages, opts = {}) {
  const read = (pages || []).map(p => readSheet(p, opts.areas));
  const out = {pages: read, read: read.length, wordless: (pages || []).filter(p => !(p.words || []).length).map(p => p.n), scan: scanOf(pages), floors: [], critical: [], notes: []};
  if (out.scan) return out;
  // a ground floor with no first floor over it is floor 1
  const named = new Set(read.flatMap(s => s.floors));
  if (named.has("G") && !named.has("1")) for (const s of read) s.floors = s.floors.map(f => f === "G" ? "1" : f);
  const by = new Map();
  for (const s of read) for (const f of s.floors) { if (!by.has(f)) by.set(f, []); by.get(f).push(s); }
  for (const [key, list] of by) {
    const usable = list.filter(s => s.rank > 0).sort((a, b) => b.rank - a.rank || a.n - b.n), s = usable[0];
    if (!s) continue;  // only a ceiling or a demolition plan: nothing to put under a grid
    out.floors.push({key, page: s.n, sheet: s.sheet, title: s.title, scale: s.scale ? {...s.scale, label: inchSay(s.scale.ptPerFt)} : null, width_ft: s.scale ? Math.round(s.W / s.scale.ptPerFt) : null,
      shared: s.floors.length > 1, also: usable.slice(1).map(x => x.n), labels: s.labels, W: s.W, H: s.H});
  }
  // one sheet called just FLOOR PLAN, nothing else: the sheet doesn't say which floor, and there's only the one to pick
  const plain = read.filter(s => s.kind === "plan" && !s.floors.length && s.rank > 0);
  if (!out.floors.length && plain.length === 1) { const s = plain[0];
    out.floors.push({key: "1", page: s.n, sheet: s.sheet, title: s.title, scale: s.scale ? {...s.scale, label: inchSay(s.scale.ptPerFt)} : null, width_ft: s.scale ? Math.round(s.W / s.scale.ptPerFt) : null,
      shared: false, also: [], labels: s.labels, W: s.W, H: s.H, unnamed: true}); }
  out.floors.sort((a, b) => floorRank(a.key) - floorRank(b.key));
  const seen = new Map();
  for (const f of out.floors) for (const l of f.labels) { if (!seen.has(l.area)) seen.set(l.area, []); seen.get(l.area).push({floor: f.key, page: f.page, sheet: f.sheet, s: l.s}); }
  out.critical = [...seen].map(([area, where]) => ({area, where}));
  for (const f of out.floors) { const s = read.find(x => x.n === f.page); for (const t of s ? s.notes : []) out.notes.push({page: f.page, sheet: f.sheet, text: t}); }
  return out;
}
// the set's floors joined to the job's: {floor: the job's name for it, or the set's when the job hasn't got it, isNew}
function matchFloors(read, jobNames) {
  const have = new Map((jobNames || []).map(n => [floorKey(n), n]));
  return (read.floors || []).map(f => { const name = have.get(f.key) ?? (f.key === "1" ? have.get("G") : undefined); return {...f, floor: name ?? f.key, isNew: name == null}; });
}

/* ---------- a spec sheet ---------- */
const CHAIN = /((?:\d+(?:\.\d+)?\s*(?:-|–|—|to)\s*\d+(?:\.\d+)?\s*(?:\/|,|&|and)?\s*)+)(MHz|GHz)/i;  // dasbom.py _CHAIN: what's proposed there must read back
const PAIR = /(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)/gi;
const CONNECTORS = [["4.3-10", /4\.3[-/ ]?10/i], ["NEX10", /nex\s?10/i], ["7/16 DIN", /7[-/]16/i], ["QMA", /\bqma\b/i], ["SMA", /\bsma\b/i], ["TNC", /\btnc\b/i], ["BNC", /\bbnc\b/i],
  ["F-type", /\bf[- ]type\b|\btype[- ]f\b|\bf connector\b/i], ["N-type", /\bn[- ]?(?:type|male|female)\b|\btype[- ]n\b/i]];  // dasbom.py CONNECTOR_WORDS
const CLAIM = /\b(?:complies?|compliant|compliance|conforms?|designed (?:to|for)|meets?|intended|capable|ready)\b/i, NOT_YET = /\b(?:pending|in process|submitted|planned|applied for|anticipated|tbd)\b/i;
const SPEC_READ = {
  fcc_id(row) { const m = /\bFCC\s*(?:ID|I\.D\.|IDENTIFIER)\s*(?:NO\.?|NUMBER|#)?\s*[:#.\-]?\s*([A-Z0-9]{3,5}-?[A-Z0-9][A-Z0-9-]{1,13})\b/i.exec(row);
    if (!m || !/\d/.test(m[1]) || /^(PENDING|NUMBER|APPLIED)/i.test(m[1])) return null; return {v: m[1].toUpperCase()}; },
  ul2524(row) { if (!/\bUL\s*-?\s*2524\b/i.test(row)) return null;
    const ed = /\b(3rd|third|2nd|second|1st|first)\s+ed(?:ition|\.)?\b/i.exec(row) || /\bed(?:ition)?\.?\s*([123])\b/i.exec(row), file = /\bE\d{5,7}\b/.exec(row);
    if (NOT_YET.test(row)) return {v: "", warn: "The sheet says the listing isn't done yet, so nothing is proposed. Pending isn't a listing."};
    const say = ed ? {1: "1st", 2: "2nd", 3: "3rd", first: "1st", second: "2nd", third: "3rd"}[ed[1].toLowerCase()] || ed[1].toLowerCase() : "";
    const bits = [say ? `${say} ed.` : "", file ? file[0] : ""].filter(Boolean);
    const claim = CLAIM.test(row) && !/\blisted\b/i.test(row);
    return {v: bits.length ? bits.join(", ") : claim ? "sheet says compliant, listing not shown" : "listed, edition not on the sheet", warn: claim ? "The sheet says it complies, not that it's listed. Check the listing." : ""}; },
  nema(row) { const m = /\bNEMA\s*(?:TYPE|TYP\.?)?\s*[-:]?\s*(\d{1,2}[A-Z]{0,2}(?:\s*[/,]\s*\d{1,2}[A-Z]{0,2})*)\b(?!\s*[-–]\s*\d)/i.exec(row) || /\bTYPE\s+(\d{1,2}X?)\s+(?:ENCLOSURE|CABINET|RATED)\b/i.exec(row);
    return m ? {v: m[1].replace(/\s+/g, "").toUpperCase()} : null; },
  rating_2h(row) { const hours = /\b(?:2|two)[\s-]*(?:hour|hr)s?\b/i.test(row), ul = /\bUL\s*-?\s*2196\b/i.test(row);
    if (/batter|back-?up|stand-?by|run\s?-?time|charg|autonomy/i.test(row)) return null;
    if (hours && (ul || /\bfire\b|\brated\b|\brating\b|survivab|circuit integrity|\bCI\b|\bpathway\b|\benclosure\b/i.test(row))) return {v: `${ul ? "UL 2196 " : ""}2 h`};
    return ul ? {v: "UL 2196, hours not on the sheet"} : null; },
  booster_class(row) { const m = /\bClass\s*(A|B)\b/.exec(row); if (!m) return null;
    if (/Part\s*15|digital device|emission|\bEMC\b|\bEMI\b|fire alarm|\bwiring\b|\bcircuit\b|amplifier class/i.test(row)) return null;
    return /signal booster|\bbooster\b|90\.219|Part\s*90|\bBDA\b|bi-?directional|industrial|repeater/i.test(row) ? {v: m[1]} : null; },
  pim(row) { if (!/\bPIM\b|passive intermod|\bIM3\b|intermodulation/i.test(row)) return null;
    const m = /([-−–]\s?\d{3}(?:\.\d)?)\s*dBc/i.exec(row); if (!m) return null;
    const at = /(?:@|\bat\b|\bwith\b)\s*(2\s*[x×]\s*\+?\d{2}(?:\.\d)?\s*dBm)/i.exec(row);
    return {v: `${m[1].replace(/[−–\s]/g, c => c === " " ? "" : "-")} dBc${at ? ` @ ${at[1].replace(/\s+/g, "").replace("×", "x").replace("dBm", " dBm")}` : ""}`}; },
  freq(row) { const m = CHAIN.exec(row); if (!m) return null;
    const k = /ghz/i.test(m[2]) ? 1000 : 1, bits = [...m[1].matchAll(PAIR)].filter(p => { const a = +p[1] * k, b = +p[2] * k; return a >= 1 && a < b && b <= 100000; }).map(p => `${p[1]}-${p[2]}`);
    return bits.length ? {v: `${bits.join(", ")} ${/ghz/i.test(m[2]) ? "GHz" : "MHz"}`} : null; },
  connector(row) { if (!/connector|interface|termination|\bports?\b/i.test(row)) return null;
    const c = CONNECTORS.find(([, re]) => re.test(row)); if (!c) return null;
    const g = /\b(female|male)\b/i.exec(row) || /\b(?:4\.3-10|N|7\/16(?: DIN)?)[- ]?([FM])\b/.exec(row);
    return {v: `${c[0]}${g ? ` ${/^f/i.test(g[1]) ? "female" : "male"}` : ""}`}; },
  power(row) { if (!/\b(?:average|avg\.?|rated|max(?:imum)?|continuous|cw)\b.{0,24}\bpower\b|\bpower\s+(?:rating|handling)\b/i.test(row)) return null;
    if (/consumption|\bdraw\b|dissipat|input voltage|\bvac\b/i.test(row)) return null;
    const m = /(\d+(?:\.\d+)?)\s*(?:W|watts?)\b/i.exec(row); return m ? {v: `${m[1]} W`} : null; },
};
// the rows that say each field. Where a row names the part, its value wins: a sheet can list several models. {fields: {key: {v, words, also, warn}}, namesPart, scan}
function specSheet(pages, part = {}) {
  if (scanOf(pages)) return {fields: {}, scan: true};
  const rows = rowsOf(pages), number = squeeze(part.part || "").toLowerCase().replace(/[^a-z0-9]/g, ""), flat = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const out = {};
  for (const key of Object.keys(SPEC_READ)) {
    const hits = [];
    for (const row of rows) { const r = SPEC_READ[key](row); if (r) hits.push({...r, row}); }
    if (!hits.length) continue;
    const good = hits.filter(h => h.v), mine = number.length >= 4 ? good.filter(h => flat(h.row).includes(number)) : [];
    const best = mine[0] || (key === "freq" ? good.find(h => /frequen|\bbands?\b/i.test(h.row)) : null) || good[0] || hits[0];
    const also = [...new Set(good.map(h => h.v))].filter(v => v !== best.v);
    out[key] = {v: best.v, words: around(best.row, best.v || key === "ul2524" && "UL"), also, warn: best.warn || (also.length ? `The sheet also shows ${also.slice(0, 3).join(", ")}. Check which one is this part.` : "")};
  }
  const all = flat(rows.join(" "));
  return {fields: out, namesPart: number.length >= 4 ? all.includes(number) : null, scan: false};
}

/* ---------- a certificate ---------- */
const MONTH = {jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12};
const pad = n => String(n).padStart(2, "0");
const realDate = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : ""; };
// intake.py to_date's spellings, a few more seen on lab paper (15-Mar-2026), and a day-first date when the first number can't be a month
const DATE_RE = "(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{2,4}|\\d{1,2}-\\d{1,2}-\\d{4}|[A-Za-z]{3,9}\\.? \\d{1,2},? \\d{4}|\\d{1,2}[ -][A-Za-z]{3,9}\\.?[ -]\\d{2,4})";
function toDate(s) {
  const t = squeeze(s).replace(/,/g, " ").replace(/\s+/g, " ");
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t); if (m) return realDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(t);
  if (m) { const y = +m[3] + (m[3].length === 2 ? 2000 : 0), a = +m[1], b = +m[2]; return a > 12 ? realDate(y, b, a) : realDate(y, a, b); }
  m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}) (\d{4})$/.exec(t); if (m && MONTH[m[1].toLowerCase()]) return realDate(+m[3], MONTH[m[1].toLowerCase()], +m[2]);
  m = /^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*\.?[ -](\d{2,4})$/.exec(t);
  if (m && MONTH[m[2].toLowerCase()]) return realDate(+m[3] + (m[3].length === 2 ? 2000 : 0), MONTH[m[2].toLowerCase()], +m[1]);
  return "";
}
const CAL_WORDS = "(?:calibration date|date of calibration|date calibrated|calibrated(?: on)?|cal\\.? date|last calibrat\\w+)";
const DUE_WORDS = "(?:calibration due(?: date)?|cal\\.? due(?: date)?|due date|next calibration(?: date| due)?|next cal\\.?(?: date)?|recalibration(?: date| due)?|recal\\.? (?:date|due)|due|expires|expiration(?: date)?|valid (?:until|through))";
const EXP_WORDS = "(?:expires?(?: on)?|expiration(?: date)?|exp\\.?(?: date)?|valid (?:until|through|thru)|active (?:through|until)|good (?:through|until)|renewal date|renew by)";
const LABEL_AT = (words) => new RegExp(`\\b${words}\\s*[:#.\\-]?\\s*${DATE_RE}`, "i");
const SERIAL = /(?:serial(?:\s*(?:no\.?|number|#))?|s\/n|\bsn)\s*[:#.]?\s*([A-Za-z0-9][A-Za-z0-9-]{2,})/i;
const MODEL_OF = word => new RegExp(`\\b${word}\\s*[:#.]\\s*([^:]{2,40}?)(?=\\s{2,}|\\s+(?:serial|s/n|manufacturer|asset|cal|date)\\b|$)`, "i");
const MODEL = [MODEL_OF("model(?:\\s*(?:no\\.?|number|#))?"), MODEL_OF("(?:instrument|unit under test|uut|description)")];
const STANDARDS = /\bstandards? used\b|\breference standards?\b|\btraceab\w+ to\b|\btest equipment used\b|\bequipment used\b|\bstandards? (?:list|table)\b/i;
const CRED = [["nicet_expires", /\bNICET\b|National Institute for Certification/i, "NICET"], ["b03_expires", /\bB-?03\b|Certificate of Fitness/i, "FDNY B-03"],
  ["", /\bGROL\b|General Radiotelephone|commercial (?:radio )?operator licen[cs]e/i, "FCC GROL"],
  ["mfr_expires", /certificate of (?:completion|training|achievement)|training certificate|certified (?:installer|technician|operator)|operator(?:'s)? certif|\bcertif(?:ies|y) that\b/i, "Manufacturer certificate"]];
const seek = (rows, re) => { for (const row of rows) { const m = re.exec(row); if (m) return {m, row}; } return null; };
// month and year only ("EXPIRES 03/2028", "March 2028"): NICET ends on the first day of that month, and the first day is the safe read for the rest
function monthYear(rows) {
  const r = seek(rows, new RegExp(`\\b${EXP_WORDS}\\s*[:#.\\-]?\\s*(?:(\\d{1,2})[/-](\\d{4})|([A-Za-z]{3,9})\\.?,? (\\d{4}))\\b`, "i"));
  if (!r) return null;
  const mo = r.m[1] ? +r.m[1] : MONTH[String(r.m[3]).slice(0, 3).toLowerCase()], y = +(r.m[2] || r.m[4]);
  const v = mo && mo <= 12 ? realDate(y, mo, 1) : ""; return v ? {v, row: r.row, monthOnly: true} : null;
}
function certificate(pages) {
  if (scanOf(pages)) return {scan: true, kind: null};
  const rows = rowsOf(pages), text = rows.join("\n");
  const cut = rows.findIndex(r => STANDARDS.test(r)), head = cut > 0 ? rows.slice(0, cut) : rows;  // past here the serials and due dates are the lab's own standards'
  const cred = /calibrat/i.test(text) ? null : CRED.find(([, re]) => re.test(text));
  const said = r => r ? around(r.row, r.m ? r.m[1] : r.v) : "";
  if (cred) {
    const e = seek(rows, LABEL_AT(EXP_WORDS)), mo = e ? null : monthYear(rows), v = e ? toDate(e.m[1]) : mo ? mo.v : "";
    return {kind: "credential", field: cred[0], label: cred[2], life: !cred[0], expires: v ? {v, words: said(e || mo), monthOnly: !!mo} : null, text: text.slice(0, 20000)};
  }
  if (!/calibrat|\bcal\b/i.test(text)) {
    const e = seek(rows, LABEL_AT(EXP_WORDS));
    return {kind: null, expires: e && toDate(e.m[1]) ? {v: toDate(e.m[1]), words: said(e)} : null, text: text.slice(0, 20000)};
  }
  const pick = (re, fix = x => x) => { const r = seek(head, re); const v = r ? fix(r.m[1]) : ""; return v ? {v, words: said(r)} : null; };
  const serialHit = head.map(row => [SERIAL.exec(row), row]).find(([m]) => m && /\d/.test(m[1])), serial = serialHit ? {v: serialHit[0][1], words: around(serialHit[1], serialHit[0][1])} : null;
  const model = pick(MODEL[0], squeeze) || pick(MODEL[1], squeeze), cal = pick(LABEL_AT(CAL_WORDS), toDate), due = pick(LABEL_AT(DUE_WORDS), toDate);
  return {kind: "cal", serial, model, cal, expires: due, notes: cal && due && due.v <= cal.v ? ["The due date isn't after the calibration date: check them on the certificate."] : [], text: text.slice(0, 20000)};
}

const api = {linesOf, rowsOf, scanOf, floorsIn, floorKey, floorRank, sortFloors, addFloors, planSet, matchFloors, specSheet, certificate, toDate, inchSay, AREA_WORDS};
if (typeof window !== "undefined") window.Readers = api;
if (typeof module !== "undefined") module.exports = api;
})();
