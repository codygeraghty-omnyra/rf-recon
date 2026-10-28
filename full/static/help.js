"use strict";
/* RF Recon — Help window: "?" in the header, or press ? / F1. Opens on the section for the tab you're on. */

const HELP = [
  ["start", "Quick start", `
    <ol><li><b>Pick a place.</b> Type an address, town or county in the Pin box and choose a suggestion, paste a Google Maps link,
      type <span class="mono">lat, lon</span>, use ◎ GPS, or click the map. Set the radius.</li>
    <li><b>Search.</b> Everything licensed, every tower and every survey point inside the circle loads, nearest first.</li>
    <li><b>Narrow it.</b> Click the layer and signal-type chips; open <i>More filters</i> for category, band and station type.
      Filters apply on every tab.</li>
    <li><b>Read it.</b> <i>Area report</i> is the one-page answer; <i>Spectrum</i> and <i>Analyzer</i> go deep.</li>
    <li><b>Go there.</b> Make a mission, import what you collect, and the app tells you what's licensed, what's allowed and what's unexplained.</li></ol>
    <p>The address bar always holds the current view, so a bookmark or a copied link reopens exactly this.</p>`],
  ["search", "Searching", `
    <ul><li><b>Pin + radius</b>: address, place, county, coordinates or Maps link. Counties and towns resolve offline from the FCC data;
      street addresses need a connection (OpenStreetMap / Photon). Picking a county searches the whole county.</li>
    <li><b>County</b>: a state and county, exactly as the FCC records it.</li>
    <li><b>Nationwide</b>: licence search anywhere in the US by call sign, licensee, radio service or frequency (like the FCC ULS licence search).</li>
    <li><b>Search</b> box: licensee, call sign, city or address text. <b>Freq from / to</b>: MHz.</li>
    <li><b>FCC licence search fields</b>: presets (aviation, public safety, business, marine, paging, broadcast auxiliary), radio service
      codes, technology, emission designator, grant and expiry dates.</li>
    <li><b>Fixed sites only</b> hides mobile and area licences that have no transmitter location.</li></ul>`],
  ["map", "Map", `
    <ul><li>Every result as a dot, sized by how many entries share the site; towers outlined. Click a dot for what's there, then <i>Details</i>.</li>
    <li>Drag the green pin or click the map to move it; rings mark distance. <b>List</b> / <b>Table</b> switches the side list.</li>
    <li><b>Layers</b> (top right of the map): Street, USGS satellite / satellite + labels / topo / terrain relief, Esri hi-res satellite;
      overlays for county and state lines and live NEXRAD weather radar. Viewed tiles are kept for offline use.</li>
    <li><b>Heatmap</b>: predicted from licensed power (free-space, best case), measured from your captures and WiGLE, or density.
      ⇩ exports it as KMZ (Google Earth, ATAK) and GeoTIFF (QGIS, ArcGIS).</li></ul>`],
  ["report", "Area report", `
    <ul><li>One page for a pin and radius: a summary sentence, counts, every band with its range, licensees and technology mix,
      predicted coverage by band, technologies, and every licensed frequency by band.</li>
    <li><b>Coverage by band</b>: pick a band chip; <i>Show where the band is at least</i> sets the level drawn (free-space, so optimistic).</li>
    <li><b>Signals not on the FCC licence list</b>: every capture and crowd point, checked against licences within 40 mi and against bands where
      transmitting is allowed without a site licence. What's left is <b>Unlisted</b>, with what it could be from the Signal ID Wiki.</li>
    <li>⎙ prints it.</li></ul>`],
  ["analyzer", "Analyzer", `
    <ul><li>A Wireshark-style record list: display filters such as <span class="mono">type == "DMR" && dbm &gt; -80</span>,
      <span class="mono">freq &gt;= 450 && freq &lt; 470</span>, <span class="mono">licensee contains "county"</span>, or a preset.</li>
    <li>↑ / ↓ move through records; the field tree and raw panes show everything about the selected one. Statistics: hierarchy, endpoints, IO graph.</li></ul>`],
  ["dashboard", "Dashboard", `<ul><li>Counts, a map and charts (signal types, sources, bands, categories, levels, distances, activity over time).
    Click a bar to filter everything by it.</li></ul>`],
  ["topology", "Topology", `
    <ul><li><b>Logical</b>: licensee → licence → frequencies, repeater output → input. <b>Physical</b>: sites and towers where they are.
      <b>Co-channel</b>: frequencies shared by several licensees or sites (possible interference).</li>
    <li>Drag to pan. <b>Ctrl + wheel</b> or pinch zooms; the plain wheel scrolls the page. −, +, Fit, 1:1 and ⛶ full screen are in the toolbar.</li>
    <li><b>Find</b> jumps to a node and lights up its links. <b>Layout</b> and <b>Up to … nodes</b> change how much is drawn and how.</li></ul>`],
  ["profile", "Site profile", `<ul><li>A dossier of the area: counts, the mission's watch-list frequencies checked against everything,
    signal types, categories and the nearest sites. ⎙ Prep sheet prints it with a <i>Heard?</i> column for the field.</li></ul>`],
  ["agencies", "Agencies", `<ul><li>RadioReference-style: category → licensee → frequencies, with input frequencies, tones and your labels.
    Add alpha tags, tones and descriptions in any record's detail window, or import a RadioReference-style CSV in Data &amp; updates.</li></ul>`],
  ["spectrum", "Spectrum", `
    <ul><li>Every frequency in the results at its exact position; zoomed in, each signal is drawn at its real channel width.</li>
    <li><b>Range</b>: type From / To, pick a preset, use − + ◀ ▶, <b>drag</b> across the plot to zoom into it, <b>Ctrl + wheel</b> to zoom at the cursor,
      <b>Shift + drag</b> to pan. The strip underneath is the whole result: click or drag it to move the window.</li>
    <li><b>Scale</b>: Auto switches to a log axis when the range runs from HF to microwave. <b>Height</b>: entries, strongest predicted dBm or measured dBm.</li>
    <li><b>Band plan</b> and <b>Known signals</b> (Signal ID Wiki) strips sit above the plot; hover them.</li>
    <li><b>Markers</b>: click the plot (it snaps to a nearby signal) or type a frequency. Each shows the distance from M1, what's on it and what it could be;
      name it, centre on it, or add it to the mission's watch list.</li></ul>`],
  ["mission", "Mission", `
    <ul><li>A mission holds an area, targets (signal types, bands, watch-list frequencies), default layers and collection settings.
      Change anything during the mission: every change is logged with the time.</li>
    <li><b>Import field captures</b>: WiGLE / Kismet CSV, GPX tracks, rtl_power / hackrf_sweep, analyzer CSV, KML / KMZ.
      Import the GPS track first; later files without coordinates are placed from it by time.</li>
    <li><b>Field log</b>: a quick reading with GPS; it's identified against nearby licences, the band plan and the Signal ID Wiki.</li></ul>`],
  ["data", "Data &amp; updates", `
    <ul><li><b>Connection</b>: online / offline and the link type (a phone tether counts as cellular).</li>
    <li><b>Automatic updates</b>: one switch for all, <i>Only on Wi-Fi / Ethernet</i>, and per source: on / off, how often, Run now, last result.</li>
    <li><b>API keys</b> for WiGLE, OpenCelliD and RepeaterBook stay in your local database.</li>
    <li>Import your own map layer (CSV, KML, KMZ, GeoJSON) or RadioReference-style labels.</li></ul>`],
  ["mouse", "Mouse and keyboard", `
    <table><tbody>
    <tr><td><b>?</b> or <b>F1</b></td><td>This help, on the current tab's section</td></tr>
    <tr><td><b>Enter</b> in the Pin box</td><td>Take the highlighted suggestion (↑ / ↓ to move), or search coordinates</td></tr>
    <tr><td><b>Ctrl + wheel</b></td><td>Zoom the spectrum or topology at the cursor (the plain wheel scrolls the page)</td></tr>
    <tr><td><b>Drag</b> / <b>Shift + drag</b></td><td>Spectrum: zoom into a range / pan</td></tr>
    <tr><td><b>↑ / ↓</b></td><td>Analyzer: previous / next record</td></tr>
    <tr><td><b>Esc</b></td><td>Close a window or the suggestions</td></tr></tbody></table>`],
  ["sources", "Where the data comes from", `
    <ul><li><b>FCC ULS</b> licences (land mobile, paging, broadcast auxiliary, marine and aviation ground) and <b>FCC ASR</b> towers: authoritative, updated weekly by the FCC.</li>
    <li><b>Broadcast</b> AM, FM and TV stations (FCC Media Bureau), <b>NOAA Weather Radio</b> transmitters with the counties each warns, and
      <b>FAA aviation</b> frequencies: towers, ATIS, approach, CTAF, navaids and ILS (new FAA cycle every 28 days).</li>
    <li><b>Signal Identification Wiki</b> (sigidwiki.com): what a signal could be. Kept on this PC; open its pages for audio and decoding notes.</li>
    <li><b>Your captures</b>, and crowd layers with your own keys: <b>WiGLE</b> (non-commercial), <b>OpenCelliD</b> (CC BY-SA), <b>RepeaterBook</b> (personal use).</li>
    <li><b>RadioReference</b>: every licence's detail window links to its RadioReference call-sign page and the FCC's own record, and the Area report links to the state.
      Its data isn't copied in: its terms forbid that and its API needs Premium. Import its CSV exports as labels instead.</li>
    <li><b>Not in any public list</b>: federal users (NTIA's records aren't public) and cellular sites (licensed by market area, not by site).</li>
    <li>Predicted levels are <b>free-space</b>: best case, no terrain or buildings. Licensed doesn't mean on the air: mark what you hear.</li></ul>`],
  ["glossary", "Glossary", `
    <table><tbody>
    <tr><td><b>ERP</b></td><td>Effective radiated power: transmitter power times antenna gain, in watts.</td></tr>
    <tr><td><b>Emission designator</b></td><td>e.g. <span class="mono">8K10F1E</span>: 8.1 kHz wide, FM, digital voice (P25). The app decodes them in Details.</td></tr>
    <tr><td><b>Station class</b></td><td>FB base, FB2 repeater, MO mobile, FX fixed. Repeaters also list an input frequency.</td></tr>
    <tr><td><b>NAC / CC / tone</b></td><td>P25 network access code, DMR colour code, analog CTCSS / DCS tone: what separates users on one frequency.</td></tr>
    <tr><td><b>Part 15 / Part 95</b></td><td>Unlicensed devices (Wi-Fi, Bluetooth, ISM) / personal radio licensed by rule (FRS, GMRS, MURS, CB).</td></tr>
    <tr><td><b>Unlisted</b></td><td>A surveyed signal with no FCC licence nearby on its frequency and no allocation that allows it: worth a second look.</td></tr></tbody></table>`],
  ["files", "Where your files are", `
    <ul><li>The app and its docs are in the <b>RF Recon</b> folder in Google Drive; double-click <i>RF Recon (beta)</i> there to open it.</li>
    <li>FCC data and the database stay on this PC (<span class="mono">rf-recon\\data</span> in your Windows user folder): gigabytes that shouldn't sync or go over a phone connection.</li>
    <li>In a browser elsewhere (the web and phone versions), the data is a field pack from the Drive folder's <i>field packs</i>, kept in that browser.</li>
    <li>Your own work (missions, captures, labels, settings, not API keys) is backed up to <i>backups</i> in the Drive folder every 6 hours.</li></ul>`],
];

(function helpUi() {
  const hdrBtn = document.getElementById("themeBtn");
  const b = document.createElement("button");
  b.className = "hbtn"; b.id = "helpBtn"; b.title = "Help (? or F1)"; b.textContent = "?";
  hdrBtn.parentNode.insertBefore(b, hdrBtn);
  b.onclick = () => openHelp(S.tab);
  document.addEventListener("keydown", e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
    if (e.key === "F1" || (e.key === "?" && !typing)) { e.preventDefault(); openHelp(S.tab); }
  });
})();

function openHelp(section) {
  $("#dlgTitle").textContent = "Help: RF Recon (beta)";
  $("#dlgBody").innerHTML = `<input id="helpQ" placeholder="Search help…" style="width:100%;margin-bottom:8px">
    <div class="chips" style="margin-bottom:8px">${HELP.map(([id, t]) => `<span class="chip" data-hjump="${id}">${t}</span>`).join("")}</div>
    <div id="helpBody">${HELP.map(([id, t, body]) => `<div class="sec" id="help-${id}" data-text="${esc((t + " " + body.replace(/<[^>]+>/g, " ")).toLowerCase())}"><h3>${t}</h3>${body}</div>`).join("")}</div>`;
  $("#dlgBody").querySelectorAll("[data-hjump]").forEach(c => c.onclick = () => $("#help-" + c.dataset.hjump)?.scrollIntoView({behavior: "smooth", block: "start"}));
  $("#helpQ").oninput = e => {
    const q = e.target.value.trim().toLowerCase();
    $("#helpBody").querySelectorAll(".sec").forEach(s => { s.hidden = q && !s.dataset.text.includes(q); });
  };
  $("#dlg").showModal();
  const target = $("#help-" + section) || $("#help-start");
  setTimeout(() => target.scrollIntoView({block: "start"}), 30);
}
