"use strict";
/* RF Recon: ATAK / iTAK / WinTAK export. A TAK data package (a zip with MANIFEST/manifest.xml) holding one
   Cursor-on-Target marker per site, coloured by its main signal type, with the site's frequencies in the marker's
   remarks; the search pin and ring as KML; and the coverage heatmap as a KMZ ground overlay when one is showing.
   In ATAK: Import, then pick the .zip (or share it to ATAK); WinTAK: drag it onto the map. Shared by the PC app,
   the full web version and the phone app; built from the rows on screen, in the browser. */
(() => {
const enc = new TextEncoder();
const x = s => String(s ?? "").replace(/[<>&'"]/g, c => ({"<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;"}[c]));
const freqText = f => f == null ? "" : Number(f).toFixed(5).replace(/0{1,2}$/, "");

/* ---------- a stored (uncompressed) zip ---------- */
const CRC = (() => { const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t; })();
const crc32 = u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zip(files) {  // [{name, data: Uint8Array | string}] -> Uint8Array
  const d = new Date(), time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const local = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = typeof f.data === "string" ? enc.encode(f.data) : f.data, crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, time, 2], [12, date, 2], [14, crc, 4], [18, data.length, 4],
      [22, data.length, 4], [26, name.length, 2], [28, 0, 2]].forEach(([o, v, n]) => n === 4 ? h.setUint32(o, v, true) : h.setUint16(o, v, true));
    local.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, time, 2], [14, date, 2], [16, crc, 4], [20, data.length, 4],
      [24, data.length, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, off, 4]]
      .forEach(([o, v, n]) => n === 4 ? c.setUint32(o, v, true) : c.setUint16(o, v, true));
    central.push(new Uint8Array(c.buffer), name);
    off += 30 + name.length + data.length;
  }
  const size = central.reduce((n, p) => n + p.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, off, true);
  const parts = [...local, ...central, new Uint8Array(end.buffer)], out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

/* ---------- the package ---------- */
const argb = hex => { const n = parseInt((hex || "#8c959f").slice(1, 7), 16); return (0xFF000000 + n) | 0; };  // TAK colours: signed ARGB
const MAX_SITES = 3000;

function sitesOf(rows) {
  const m = new Map();
  for (const r of rows) {
    if (r.lat == null || r.lon == null) continue;
    const k = `${(+r.lat).toFixed(5)}_${(+r.lon).toFixed(5)}`;
    if (!m.has(k)) m.set(k, {key: k, lat: +r.lat, lon: +r.lon, rows: [], dist: r.dist_mi ?? 1e9});
    m.get(k).rows.push(r);
  }
  return [...m.values()].sort((a, b) => a.dist - b.dist);
}
function cot(site, o, now, stale) {
  const radios = [], seen = new Set();
  for (const r of site.rows) {
    if (r.layer === "towers") continue;
    const k = `${r.call_sign || r.ident || r.fid}|${freqText(r.freq_mhz)}`;
    if (!seen.has(k)) { seen.add(k); radios.push(r); }
  }
  radios.sort((a, b) => (a.freq_mhz || 0) - (b.freq_mhz || 0));
  const tower = site.rows.find(r => r.layer === "towers");
  const counts = new Map();
  for (const r of radios) counts.set(o.typeOf(r), (counts.get(o.typeOf(r)) || 0) + 1);
  const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const color = radios.length ? o.colorOf(radios.find(r => o.typeOf(r) === main)) : "#57606a";
  const who = radios.length ? (radios[0].ov_alpha_tag || radios[0].licensee || radios[0].label || "") : (tower?.owner || "Tower");
  const callsign = (radios.length ? `${freqText(radios[0].freq_mhz)}${radios.length > 1 ? ` +${radios.length - 1}` : ""} ${who}`
    : `Tower ${tower?.overall_agl_m != null ? Math.round(tower.overall_agl_m) + " m " : ""}${who}`).slice(0, 60);
  const lines = radios.slice(0, 40).map(r => [`${freqText(r.freq_mhz)} MHz`, o.typeOf(r), r.call_sign || r.ident, r.ov_alpha_tag || r.licensee || r.label,
    r.est_rx_dbm != null ? `est ${Math.round(r.est_rx_dbm)} dBm` : ""].filter(Boolean).join(" · "));
  if (radios.length > 40) lines.push(`+${radios.length - 40} more frequencies here`);
  if (tower) lines.push(`Tower ASR ${tower.reg}: ${[tower.struct_type, tower.overall_agl_m != null ? `${tower.overall_agl_m} m` : "", tower.owner].filter(Boolean).join(", ")}`);
  if (site.dist < 1e9) lines.push(`${site.dist.toFixed(2)} mi ${site.rows[0].compass || ""} of the search pin`);
  lines.push(`RF Recon (beta) · licensed sites from FCC data${o.fccDate ? ` of ${o.fccDate}` : ""}, not measurements`);
  const elev = site.rows.find(r => r.ground_elev_m != null)?.ground_elev_m, uid = `RFRecon.${site.key}`, c = argb(color);
  return {uid, xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<event version="2.0" uid="${uid}" type="b-m-p-s-m" time="${now}" start="${now}" stale="${stale}" how="h-g-i-g-o">
<point lat="${site.lat}" lon="${site.lon}" hae="${elev != null ? elev : "9999999.0"}" ce="9999999.0" le="9999999.0"/>
<detail><contact callsign="${x(callsign)}"/><color argb="${c}"/><usericon iconsetpath="COT_MAPPING_SPOTMAP/b-m-p-s-m/${c}"/>
<remarks>${x(lines.join("\n"))}</remarks><archive/></detail>
</event>
`};
}
function areaKml(o) {
  const parts = [`<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${x(o.name)}</name>`];
  if (o.center) {
    const [lat, lon] = o.center, d = o.radius * 1.609344 / 6371.0088, la1 = lat * Math.PI / 180, ring = [];
    for (let i = 0; i <= 72; i++) {
      const b = i * 5 * Math.PI / 180, la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
      const lo2 = lon * Math.PI / 180 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
      ring.push(`${(lo2 * 180 / Math.PI).toFixed(6)},${(la2 * 180 / Math.PI).toFixed(6)},0`);
    }
    parts.push(`<Placemark><name>Search pin</name><Point><coordinates>${lon},${lat},0</coordinates></Point></Placemark>`,
      `<Placemark><name>${o.radius} mi search radius</name><Style><LineStyle><color>ff7aa0f0</color><width>3</width></LineStyle></Style>`
      + `<LineString><tessellate>1</tessellate><coordinates>${ring.join(" ")}</coordinates></LineString></Placemark>`);
  }
  if (o.outline?.points?.length) {  // a building outline: [[lat, lon], ...]
    parts.push(`<Placemark><name>${x(o.outline.name || "Outline")}</name><Style><LineStyle><color>ff20a0f0</color><width>3</width></LineStyle>`
      + `<PolyStyle><color>4020a0f0</color></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>`
      + `${o.outline.points.map(([la, lo]) => `${lo},${la},0`).join(" ")}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`);
  }
  parts.push("</Document></kml>");
  return parts.join("");
}
function heatKmz(heat) {  // heat: {png (base64), bounds [[s, w], [n, e]], desc}
  const [[s, w], [n, e]] = heat.bounds, png = Uint8Array.from(atob(heat.png), ch => ch.charCodeAt(0));
  const kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>RF coverage</name>
<GroundOverlay><name>${x(heat.desc || "RF coverage")}</name><color>c8ffffff</color><Icon><href>coverage.png</href></Icon>
<LatLonBox><north>${n}</north><south>${s}</south><east>${e}</east><west>${w}</west></LatLonBox></GroundOverlay></Document></kml>`;
  return zip([{name: "doc.kml", data: kml}, {name: "coverage.png", data: png}]);
}
function build(o) {
  const sites = sitesOf(o.rows), use = sites.slice(0, MAX_SITES), now = new Date(), stale = new Date(now.getTime() + 365 * 864e5);
  const t = d => d.toISOString().replace(/\.\d+Z$/, ".000Z");
  const files = [], content = [];
  for (const s of use) {
    const {uid, xml} = cot(s, o, t(now), t(stale));
    files.push({name: `${uid}/${uid}.cot`, data: xml});
    content.push(`<Content ignore="false" zipEntry="${uid}/${uid}.cot"><Parameter name="uid" value="${uid}"/></Content>`);
  }
  if (o.center || o.outline) {
    files.push({name: "RFRecon.area/rf_recon_area.kml", data: areaKml(o)});
    content.push('<Content ignore="false" zipEntry="RFRecon.area/rf_recon_area.kml"><Parameter name="contentType" value="KML"/></Content>');
  }
  if (o.heat?.png) {
    files.push({name: "RFRecon.coverage/rf_recon_coverage.kmz", data: heatKmz(o.heat)});
    content.push('<Content ignore="false" zipEntry="RFRecon.coverage/rf_recon_coverage.kmz"><Parameter name="contentType" value="KMZ"/></Content>');
  }
  const uid = (crypto.randomUUID ? crypto.randomUUID() : `rfrecon-${Date.now()}`);
  files.unshift({name: "MANIFEST/manifest.xml", data: `<MissionPackageManifest version="2"><Configuration><Parameter name="uid" value="${uid}"/>`
    + `<Parameter name="name" value="${x(o.name)}"/><Parameter name="onReceiveDelete" value="true"/></Configuration>`
    + `<Contents>${content.join("")}</Contents></MissionPackageManifest>`});
  const fname = `${o.name.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80)} (ATAK).zip`;
  return {bytes: zip(files), name: fname, sites: use.length, skipped: sites.length - use.length, heat: !!o.heat?.png};
}
async function save(o) {
  const pkg = build(o), file = new File([pkg.bytes], pkg.name, {type: "application/zip"});
  // on a phone, hand it to the share sheet (ATAK, iTAK, Files, Drive); on a computer, download it
  if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({files: [file]})) {
    try { await navigator.share({files: [file], title: pkg.name}); return pkg; } catch (e) { if (e.name === "AbortError") return pkg; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file); a.download = pkg.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return pkg;
}
// the same markers as live CoT events for Push to ATAK: they fade in ATAK a day after the last push unless pushed again
function events(o, staleHours = 24) {
  const now = new Date(), stale = new Date(now.getTime() + staleHours * 36e5), t = d => d.toISOString().replace(/\.\d+Z$/, ".000Z");
  return sitesOf(o.rows).slice(0, MAX_SITES).map(s => cot(s, o, t(now), t(stale)).xml);
}
window.RFTak = {build, save, zip, events};

/* the PC app and the full web version: the ⇩ ATAK button beside CSV and KML exports what's on screen */
const btn = document.getElementById("takBtn");
if (btn && typeof filtered === "function") btn.onclick = async () => {
  const rows = filtered(), st = document.getElementById("status");
  if (!rows.length) { st.textContent = "Nothing to send to ATAK: search an area first."; return; }
  const fcc = (/FCC data ([\d-]+ [\d:]+)/.exec(document.getElementById("meta")?.textContent || "") || [])[1];
  const area = S.mode === "county" ? `${document.getElementById("county").value || "all counties"} ${document.getElementById("state").value}`
    : S.mode === "nationwide" ? "licence search" : S.center ? `${S.center[0].toFixed(4)}, ${S.center[1].toFixed(4)} ${S.radius} mi` : "area";
  const pkg = await save({rows, center: S.mode === "point" ? S.center : null, radius: S.radius, name: `RF Recon - ${S.mission?.name || area}`,
    colorOf, typeOf, fccDate: fcc, heat: S.heat?.kind !== "off" ? S.heatImg : null});
  st.textContent = `Saved ${pkg.name}: ${pkg.sites.toLocaleString()} sites${pkg.skipped ? ` (the nearest ${pkg.sites.toLocaleString()}; ${pkg.skipped.toLocaleString()} more left out)` : ""}`
    + `${pkg.heat ? " and the coverage heatmap" : ""}. In ATAK or iTAK: Import, then the file. WinTAK: drag it onto the map.`;
};

/* Push to ATAK: on the PC, the markers go live into every TAK app on this network (and a TAK Server, if set) and
   WinTAK opens; on a phone or in the web version, the share sheet hands ATAK the package and ATAK opens on import */
const push = document.getElementById("takPush");
if (push && typeof filtered === "function") push.onclick = async () => {
  const rows = filtered(), st = document.getElementById("status");
  if (!rows.length) { st.textContent = "Nothing to push to ATAK: search an area first."; return; }
  const fcc = (/FCC data ([\d-]+ [\d:]+)/.exec(document.getElementById("meta")?.textContent || "") || [])[1];
  const o = {rows, colorOf, typeOf, fccDate: fcc};
  if (!matchMedia("(pointer: coarse)").matches) {
    st.textContent = "Pushing to ATAK…";
    try {
      const r = await post("/api/tak/push", {events: events(o), open: true});
      st.textContent = `Pushed ${r.sent.toLocaleString()} markers into ATAK${r.via.length ? ` via ${r.via.join(" and ")}` : ""}: every ATAK, iTAK and WinTAK on this network shows them now.`
        + ` ${r.wintak ? "WinTAK is opening." : "WinTAK isn't installed on this PC (free at tak.gov); phones running ATAK on the same Wi-Fi get the markers."}`
        + `${r.errors.length ? " " + r.errors.join(" ") : ""}`;
      return;
    } catch (e) {
      if (!/PC only|not found/i.test(e.message)) { st.textContent = "Push to ATAK: " + e.message; return; }
    }
  }
  const area = S.center ? `${S.center[0].toFixed(4)}, ${S.center[1].toFixed(4)} ${S.radius} mi` : "area";
  const pkg = await save({rows, center: S.mode === "point" ? S.center : null, radius: S.radius, name: `RF Recon - ${S.mission?.name || area}`,
    colorOf, typeOf, fccDate: fcc, heat: S.heat?.kind !== "off" ? S.heatImg : null});
  st.textContent = matchMedia("(pointer: coarse)").matches ? `Pick ATAK (or iTAK) in the share sheet: it opens and imports ${pkg.sites.toLocaleString()} sites.`
    : `Saved ${pkg.name}. Open it with ATAK or WinTAK (drag it onto the map); live push runs from RF Recon on the PC.`;
};
})();
