"use strict";
/* RF Recon — a floor plan from an ASCII DXF (AutoCAD's drawing exchange format; DWG has to be saved as DXF first):
   LINE, LWPOLYLINE, POLYLINE / VERTEX, ARC, CIRCLE and INSERT (block references, with their scale, rotation and nesting)
   are read with their layers. The drawing becomes the floor's plan image at its true width, and the lines on wall layers
   become walls, each with a material from its layer name (the AIA / US National CAD Standard layer names: A-WALL,
   A-WALL-EXTR, A-GLAZ, S-COLS, S-WALL...), offered in the wall tools' review before anything is added.
   Group codes: Autodesk's DXF reference. No library: plain JavaScript. */
window.DXF = (() => {
// the DXF's own pairs: a code line, then a value line
function pairs(text){ const L=String(text).split(/\r\n|\r|\n/), out=[]; for(let i=0;i+1<L.length;i+=2) out.push([+L[i].trim(), L[i+1]]); return out; }
// units from $INSUNITS: drawing units to feet (0 = unitless: architectural drawings in the US are in inches)
const UNIT_FT = {0:1/12, 1:1/12, 2:1, 3:5280, 4:1/304.8, 5:1/30.48, 6:3.28084, 7:3280.84, 8:1/12000, 9:1/12000000, 10:3, 14:1/3.048};
const UNIT_NAME = {0:"unitless (taken as inches)", 1:"inches", 2:"feet", 3:"miles", 4:"millimetres", 5:"centimetres", 6:"metres", 7:"kilometres", 10:"yards", 14:"decimetres"};
// split the file into entities: [{type, codes:[[code,value]...]}] per section
function parse(text){
  const P=pairs(text), header={}, blocks={}, ents=[]; let sec=null, cur=null, blk=null, hk=null;
  const flush=()=>{ if(!cur) return; if(sec==="BLOCKS"&&blk&&cur.type!=="BLOCK"&&cur.type!=="ENDBLK") blk.ents.push(cur); else if(sec==="ENTITIES") ents.push(cur); cur=null; };
  for(const [c,vRaw] of P){ const v=vRaw.trim();
    if(c===0){ flush();
      if(v==="SECTION"){ sec="?"; continue; } if(v==="ENDSEC"){ sec=null; continue; } if(v==="EOF") break;
      if(sec==="BLOCKS"&&v==="BLOCK"){ blk={name:"", bx:0, by:0, ents:[]}; cur={type:"BLOCK", codes:[]}; continue; }
      if(sec==="BLOCKS"&&v==="ENDBLK"){ if(blk&&blk.name) blocks[blk.name]=blk; blk=null; cur={type:"ENDBLK", codes:[]}; continue; }
      cur={type:v, codes:[]}; continue; }
    if(c===2&&sec==="?"){ sec=v; continue; }
    if(sec==="HEADER"){ if(c===9) hk=v; else if(hk&&header[hk]===undefined) header[hk]=v; continue; }
    if(cur){ cur.codes.push([c,v]); if(cur.type==="BLOCK"&&blk){ if(c===2) blk.name=v; if(c===10) blk.bx=+v; if(c===20) blk.by=+v; } } }
  flush();
  // POLYLINE ... VERTEX ... SEQEND come as separate entities: gather the vertices onto their polyline
  const join=list=>{ const out=[]; let pl=null; for(const e of list){ if(e.type==="POLYLINE"){ pl={...e, verts:[]}; out.push(pl); }
      else if(e.type==="VERTEX"&&pl){ pl.verts.push(e); } else if(e.type==="SEQEND"){ pl=null; } else out.push(e); } return out; };
  for(const b of Object.values(blocks)) b.ents=join(b.ents);
  return {header, blocks, ents:join(ents)};
}
const g=(e,c,d=null)=>{ const x=e.codes.find(p=>p[0]===c); return x?x[1]:d; };
const gn=(e,c,d=0)=>{ const v=g(e,c); return v==null||v===""||isNaN(+v)?d:+v; };
// every entity as straight segments in drawing units, with its layer; blocks placed by their inserts
function segments(dxf, opt={}){
  const out=[], arcSteps=opt.arcSteps||16;
  const walk=(list, T, layer0, depth)=>{ for(const e of list){ let layer=g(e,8,"0"); if(layer==="0"&&layer0) layer=layer0;  // layer 0 in a block takes the insert's layer
      const add=(x1,y1,x2,y2)=>{ const a=T(x1,y1), b=T(x2,y2); if(a[0]===b[0]&&a[1]===b[1]) return; out.push({x1:a[0], y1:a[1], x2:b[0], y2:b[1], layer, type:e.type}); };
      if(e.type==="LINE") add(gn(e,10),gn(e,20),gn(e,11),gn(e,21));
      else if(e.type==="LWPOLYLINE"){ const xs=e.codes.filter(p=>p[0]===10).map(p=>+p[1]), ys=e.codes.filter(p=>p[0]===20).map(p=>+p[1]), closed=gn(e,70)&1;
        for(let i=0;i+1<xs.length;i++) add(xs[i],ys[i],xs[i+1],ys[i+1]); if(closed&&xs.length>2) add(xs[xs.length-1],ys[ys.length-1],xs[0],ys[0]); }
      else if(e.type==="POLYLINE"){ const v=(e.verts||[]).map(x=>[gn(x,10),gn(x,20)]), closed=gn(e,70)&1;
        for(let i=0;i+1<v.length;i++) add(v[i][0],v[i][1],v[i+1][0],v[i+1][1]); if(closed&&v.length>2) add(v[v.length-1][0],v[v.length-1][1],v[0][0],v[0][1]); }
      else if(e.type==="ARC"||e.type==="CIRCLE"){ const cx=gn(e,10), cy=gn(e,20), r=gn(e,40); let a0=e.type==="ARC"?gn(e,50):0, a1=e.type==="ARC"?gn(e,51):360; if(a1<=a0) a1+=360;
        const n=Math.max(2,Math.ceil(arcSteps*(a1-a0)/360)); let p=null;
        for(let k=0;k<=n;k++){ const a=(a0+(a1-a0)*k/n)*Math.PI/180, q=[cx+r*Math.cos(a), cy+r*Math.sin(a)]; if(p) add(p[0],p[1],q[0],q[1]); p=q; } }
      else if(e.type==="INSERT"&&depth<8){ const b=dxf.blocks[g(e,2)]; if(!b) continue;
        const ix=gn(e,10), iy=gn(e,20), sx=gn(e,41,1)||1, sy=gn(e,42,1)||1, rot=gn(e,50)*Math.PI/180, c=Math.cos(rot), s=Math.sin(rot);
        const Ti=(x,y)=>{ const u=(x-b.bx)*sx, w=(y-b.by)*sy; return T(ix+u*c-w*s, iy+u*s+w*c); };
        walk(b.ents, Ti, layer, depth+1); } } };
  walk(dxf.ents, (x,y)=>[x,y], null, 0);
  return out;
}
// a layer name -> a wall material key (planlines.js MAT keys), "skip" for doors and openings, or null (not a wall layer)
const LAYER_RULES = [  // the US National CAD Standard / AIA layer names, then the material words planlines.js reads in plan notes
  [/DOOR|OPNG|OPEN|WIND(?!OW\s*WALL)|FURN|EQPM|ANNO|TEXT|DIMS?\b|GRID|HATCH|PATT|IDEN|TTLB|SYMB|CLNG|ROOF|FLOR-(?!WALL)/i, "skip"],
  [/GLAZ|CURT|STOREFRONT|WINDOW\s*WALL/i, "glass"], [/S-COLS|COLS?\b/i, "rc8"], [/S-WALL|SHEAR|CONC/i, "conc8"], [/CMU|MASN|BLOCK|MASONRY/i, "cmu"],
  [/BRIC?K/i, "brick"], [/A-WALL-EXT|WALL-EXT|EXTR?\b|EXTERIOR/i, "ext"], [/FIRE|RATED|SHFT|SHAFT|CORE|STAIR|ELEV/i, "shaft"], [/WALL|PART|GYP|DRYWALL|STUD/i, "drywall"]];
function layerMaterial(name, extKey){
  for(const [re,k] of LAYER_RULES) if(re.test(name)){ if(k==="ext") return extKey||"conc8"; return k; }
  const w=window.PlanLines?.materialFromText?.(name); return w||null;
}
// the drawing's box (wall layers first: title blocks far away would shrink the plan)
function bounds(segs){ let x0=Infinity, y0=Infinity, x1=-Infinity, y1=-Infinity; for(const s of segs){ x0=Math.min(x0,s.x1,s.x2); x1=Math.max(x1,s.x1,s.x2); y0=Math.min(y0,s.y1,s.y2); y1=Math.max(y1,s.y1,s.y2); }
  return isFinite(x0)?{x0,y0,x1,y1,w:x1-x0,h:y1-y0}:null; }
// everything a floor needs from one DXF: the plan picture (PNG data URL), its width in feet, and the walls (fractions of
// the picture) with each one's layer and material
function toFloor(text, opt={}){
  const dxf=parse(text), segs=segments(dxf), u=+(dxf.header.$INSUNITS??0), ft=UNIT_FT[u]??1/12;
  if(!segs.length) throw new Error("No lines in this DXF (LINE, LWPOLYLINE, POLYLINE, ARC or block inserts).");
  const layers={}; for(const s of segs){ const k=s.layer; if(!layers[k]) layers[k]={name:k, n:0, mat:layerMaterial(k, opt.extKey)}; layers[k].n++; }
  const wallSegs=segs.filter(s=>{ const m=layers[s.layer].mat; return m&&m!=="skip"; });
  const B0=bounds(wallSegs.length?wallSegs:segs), pad=Math.max(B0.w,B0.h)*0.03||1, B={x0:B0.x0-pad, y0:B0.y0-pad, w:B0.w+2*pad, h:B0.h+2*pad};
  const W=opt.px||2000, H=Math.max(200,Math.round(W*B.h/B.w));
  const fx=x=>(x-B.x0)/B.w, fy=y=>1-(y-B.y0)/B.h;  // DXF y runs up; a picture's runs down
  let png=null;
  if(typeof document!=="undefined"&&opt.draw!==false){ const cv=document.createElement("canvas"); cv.width=W; cv.height=H; const c=cv.getContext("2d");
    c.fillStyle="#fff"; c.fillRect(0,0,W,H); c.lineCap="round";
    for(const s of segs){ const m=layers[s.layer].mat; c.strokeStyle=m&&m!=="skip"?"#222":"#9aa0a6"; c.lineWidth=m&&m!=="skip"?2:1;
      c.beginPath(); c.moveTo(fx(s.x1)*W, fy(s.y1)*H); c.lineTo(fx(s.x2)*W, fy(s.y2)*H); c.stroke(); }
    png=cv.toDataURL("image/png"); }
  // a wall drawn as its two faces becomes one wall on its centreline (planlines.js pairWalls: faces 2-16 in apart), so
  // its loss counts once; lines with no partner stay as they are
  const minFt=opt.minFt??1, PL=typeof window!=="undefined"?window.PlanLines:null, byLayer={};  // shorter than a foot: a jamb or a tick, not a wall
  for(const s of wallSegs) (byLayer[s.layer]||(byLayer[s.layer]=[])).push(s);
  let paired=0; const centre=[];
  for(const [layer, list] of Object.entries(byLayer)){
    if(PL&&PL.pairWalls&&list.length<=4000){ const k=ft*12;  // paired in inches (its gap tests are in those units)
      const ins=list.map((s,i)=>({x1:s.x1*k, y1:s.y1*k, x2:s.x2*k, y2:s.y2*k, w:0, i})), r=PL.pairWalls(ins, [2, 16]);
      const used=new Set(r.walls.flatMap(w=>(w.faces||[]).map(f=>f.i)));
      paired+=r.walls.length; for(const w of r.walls) centre.push({x1:w.x1/k, y1:w.y1/k, x2:w.x2/k, y2:w.y2/k, layer, paired:true});
      list.forEach((s,i)=>{ if(!used.has(i)) centre.push({...s, layer}); }); }
    else for(const s of list) centre.push({...s, layer}); }
  const walls=centre.filter(s=>Math.hypot(s.x2-s.x1, s.y2-s.y1)*ft>=minFt)
    .map(s=>({x1:fx(s.x1), y1:fy(s.y1), x2:fx(s.x2), y2:fy(s.y2), layer:s.layer, mat:layers[s.layer].mat, paired:!!s.paired}));
  return {png, W, H, width_ft:+(B.w*ft).toFixed(2), units:UNIT_NAME[u]||`code ${u}`, unitsCode:u, layers:Object.values(layers).sort((a,b)=>b.n-a.n), walls, paired, segs:segs.length};
}
return {parse, segments, layerMaterial, toFloor, LAYER_RULES, UNIT_FT};
})();
