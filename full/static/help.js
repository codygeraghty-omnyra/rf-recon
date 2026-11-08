"use strict";
/* DAStastic — Help window: "?" in the header, or press ? / F1. Opens on the section for the tab you're on. */

// DAStastic for Android (android/, built outside this repo): served by the 24/7 server; the public web version leaves it out
const RF_APK = (/github\.io$/.test(location.hostname) || location.protocol === "file:" ? "https://44-207-142-90.sslip.io/" : "") + "static/android/rf-recon-android.apk";
const HELP = [
  ["start", "Quick start", `
    <p><b>New to this?</b> The <i>Start</i> tab takes one job from an address to the AHJ package, a question at a time. It's the same job the DAS tab shows, and every other tab stays where it is.</p>
    <ol><li><b>Pick a place.</b> Type an address, town or county in the Pin box and choose a suggestion, paste a Google Maps link,
      type <span class="mono">lat, lon</span>, use ◎ GPS, or click the map. Set the radius.</li>
    <li><b>Search.</b> Everything licensed, every tower and every survey point inside the circle loads, nearest first.</li>
    <li><b>Narrow it.</b> The filter rail beside the results (on a phone, the <i>Filters</i> bar): switch sources, signal types,
      bands, categories and station types off, or press <i>only</i>. Filters apply on the tabs that list the rows: the rail shows on those and leaves the others.</li>
    <li><b>Read it.</b> <i>Area report</i> is the one-page answer; <i>Spectrum</i> and <i>Analyzer</i> go deep.</li>
    <li><b>Go there.</b> Make a mission, import what you collect, and the app tells you what's licensed, what's allowed and what's unexplained.</li></ol>
    <p>The address bar always holds the current view, so a bookmark or a copied link reopens exactly this.</p>`],
  ["search", "Searching", `
    <ul><li><b>Pin + radius</b>: address, place, county, coordinates or Maps link. Counties and towns resolve offline from the FCC data;
      street addresses need a connection (OpenStreetMap / Photon). Picking a county searches the whole county.</li>
    <li><b>County</b>: a state and county, exactly as the FCC records it.</li>
    <li><b>Nationwide</b>: licence search anywhere in the US by call sign, licensee, radio service or frequency (like the FCC ULS licence search).</li>
    <li><b>Search</b> box: licensee, call sign, city or address text. <b>Freq from / to</b>: MHz.</li>
    <li><b>FCC fields</b> (the licence search): presets (aviation, public safety, business, marine, paging, broadcast auxiliary), radio service
      codes, technology, emission designator, grant and expiry dates.</li>
    <li><b>Fixed sites only</b> hides mobile and area licences that have no transmitter location.</li></ul>`],
  ["filters", "Filters (the rail)", `
    <ul><li>The <b>filter rail</b> sits left of the results on Map, Area report, Analyzer, Dashboard, Topology, Site profile, Agencies and
      Spectrum: the tabs it changes. The other tabs don't use it, so it isn't there. On a wide screen it stays in view as you scroll;
      <b>‹</b> (or <b>L</b>) folds it to a strip that says how many filters are on, and it stays folded until you open it. From 700 to
      1,099 px wide the strip opens the rail over the results (Esc or a press outside closes it). On a phone, the <b>Filters</b> bar
      under the tabs opens it from the bottom at about 60% of the screen, so the map and list stay in view above; drag its handle up for
      more, and <b>Show N items</b> closes it.</li>
    <li>At the top: the count (items, frequencies and the radius they're within), <b>⇩ Export</b> (CSV, KML, ATAK package, ⎙ Prep sheet),
      <b>📡 Push to ATAK</b>, <b>Clear</b> (back to the defaults: the mission's sources, every value on), and a pill for each change
      (<i>Signal: only DMR</i>); press a pill to undo just that one.</li>
    <li><b>Sections</b>: Sources (licensed and registered, crowd and networks, your own; sources with nothing here fold into
      <i>+ n with nothing here</i>, which opens so you can switch them on before a search), Signal type, Band, Category and Station
      type. Press a section's name to fold or open it (remembered). Its head says what's changed (<i>1 off</i>, <i>only 1/6</i>,
      <i>2 hidden</i>) and its box switches the whole section: all on, or with everything on, all off.</li>
    <li><b>Rows</b>: the box in the map's colour is on (ticked) or off (an outline, the name faded); the number is how many items have
      it with the other filters on, and it stays when the row is off. Everything starts on: untick what you don't want.
      <b>only</b> (or <b>Alt + click</b>) shows that one alone; press it again for what was on before. A value a new search brings
      comes in on, and <i>only</i> holds through a pin move.</li>
    <li>The <b>Filter list</b> box finds a filter by name: sections with a match open, the rest say <i>0 matches</i>.</li>
    <li>Keys: <b>L</b> the rail (the sheet on a phone), <b>/</b> the filter box, <b>↑ / ↓</b> move through the rows, <b>Space</b> on / off,
      <b>O</b> only, <b>A</b> all on in that section, <b>← / →</b> fold / open it, <b>Esc</b> leave the rail.</li>
    <li>The filters are in the address bar too, so a reload or a copied link keeps them.</li></ul>`],
  ["map", "Map", `
    <ul><li>Every result as a dot, sized by how many entries share the site; towers outlined. Click a dot for what's there, then <i>Details</i>.</li>
    <li>Drag the pin (it takes the skin's colour) or click the map to move it; rings mark distance. <b>List</b> / <b>Table</b> switches the side list.</li>
    <li><b>Zoom bar</b> at the top right of every map (the layers button is top left): − and +, and 🔒, mouse-wheel zoom on or off for every map. It is locked whenever DAStastic opens, so the wheel scrolls the page; <b>hold the left mouse button (or Ctrl) and scroll</b> to zoom anyway. Click 🔒 to let the wheel zoom until DAStastic is opened again. Pinch still zooms.</li>
    <li><b>Layers</b> (top right of the map): Street, USGS satellite / satellite + labels / topo / terrain relief, Esri hi-res satellite;
      overlays for county and state lines, microwave backhaul links (FCC), live ships (AIS: the owner's personal build only) and live NEXRAD weather radar.
      USGS maps and county lines you view are kept by the copy serving the page (this PC, or the server), and a mission area's USGS maps are kept ahead
      (to zoom 16; shaded relief to 13). The web version and DAStastic lite keep the USGS map tiles you view in that browser; county lines aren't kept there.
      Street and Esri are for use with signal only (their terms): with no signal the map shows USGS Topo, and goes back to your map when signal returns.</li>
    <li><b>Boundaries</b> (in Layers): <i>State</i>, <i>County</i> and <i>City / town</i> lines, each on its own, or <i>All boundaries</i> for the three, from the Census Bureau's 1:500,000 boundary files (2025; cities, towns, villages, boroughs and census-designated places). They draw under every other layer and never take a click; counties load for the states in view from zoom 7, cities and towns from zoom 9. State and county names show where they fit; city and town names only on the satellite and relief maps, since the others name them already. In DAStastic lite they're under Layers and filters, and the web version and lite keep the ones you've seen for use with no signal.</li>
    <li><b>Heatmap</b>: <i>Predicted with terrain</i> (Okumura-Hata, suburban, from the 60 strongest licensed transmitters, with the hills counted for
      the 25 strongest where terrain is kept), <i>Predicted from licences</i> (free space: best case), <i>Measured</i> (your captures and WiGLE),
      <i>Carrier coverage</i> (the FCC Broadband Map, by carrier and technology) or <i>Density</i>.
      ⇩ exports it as KMZ (Google Earth, ATAK) and GeoTIFF (QGIS, ArcGIS).</li></ul>`],
  ["report", "Area report", `
    <ul><li>One page for a pin and radius: a summary sentence, counts, every band with its range, licensees and technology mix,
      predicted coverage by band, technologies, and every licensed frequency by band.</li>
    <li><b>Coverage by band</b>: pick a band chip; <i>Show where the band is at least</i> sets the level drawn. It's Okumura-Hata (suburban, handheld
      at 1.5 m) from the band's 60 strongest licensed transmitters, with the hills counted for the 25 strongest where terrain is kept.</li>
    <li><b>Signals not on the FCC licence list</b>: every capture and crowd point, checked against licences within 40 mi and against bands where
      transmitting is allowed without a site licence. What's left is <b>Unlisted</b>, with what it could be from the Signal ID Wiki (personal build).
      Each row has a <b>claim</b> (Confirmed, Probably true, Possibly true, Doubtful, Improbable, Can't judge: how many independent origins agree),
      the source's <b>grade</b> A to F (✓ when earned from its track record) and a <b>single source</b> tag when only one origin says it.</li>
    <li><b>Licensed, not heard</b>: licences loud enough here that your captures should have heard them, in bands they covered.
      <b>Carrier coverage vs your captures</b>: where a capture decoded cell IDs, the FCC map's claimed carriers against what was heard.
      <b>Track record</b>: how each source held up against your captures, pooled across missions.</li>
    <li>⎙ <b>Print report</b> prints the report as shown (the buttons and pickers left off).</li></ul>`],
  ["analyzer", "Analyzer", `
    <ul><li>A Wireshark-style record list: display filters such as <span class="mono">type == "DMR" && dbm &gt; -80</span>,
      <span class="mono">freq &gt;= 450 && freq &lt; 470</span>, <span class="mono">licensee contains "county"</span>, or a preset.
      <span class="mono">type</span> and <span class="mono">time</span> read what the Type and Time columns show.</li>
    <li><b>Alt + click</b> a source, type, frequency, ident or band cell to keep only that value; <b>Alt + Shift + click</b> drops it.
      A plain click or tap offers <i>Keep only this</i> and <i>Drop this</i> as buttons.</li>
    <li><b>Columns</b> turns columns on and off; <b>Order</b> sorts by time, distance, frequency or level (↑ / ↓ reverses); <b>Rows</b> sets how many show.</li>
    <li>↑ / ↓ move through records; the field tree and raw panes show everything about the selected one. Statistics: hierarchy, endpoints, IO graph.</li></ul>`],
  ["dashboard", "Dashboard", `<ul><li>Counts, a map and charts (signal types, sources, bands, categories, levels, distances, activity over time).
    A bar or slice in Signal types, Sources, Bands or Categories filters every tab by it (a Sources bar shows that source alone; the same bar again
    puts the layers back). A Top names bar shows its whole name; the histograms don't filter.</li></ul>`],
  ["topology", "Topology", `
    <ul><li><b>Logical</b>: licensee → licence → frequencies, repeater output → input. <b>Physical</b>: sites and towers where they are.
      <b>Co-channel</b>: frequencies shared by several licensees or sites (possible interference).</li>
    <li>Drag to pan. <b>Ctrl + wheel</b> or pinch zooms; the plain wheel scrolls the page. −, +, Fit, 1:1 and ⛶ full screen are in the toolbar.</li>
    <li><b>Find</b> jumps to a node and lights up its links. <b>Layout</b> and <b>Up to … nodes</b> change how much is drawn and how.</li></ul>`],
  ["profile", "Site profile", `<ul><li>A dossier of the area: counts, the mission's watch-list frequencies checked against everything,
    signal types, categories and the nearest sites. With filters on, the counts and lists follow them; Watch checks every result.</li>
    <li>⎙ <b>Prep sheet</b> (the filter rail's <i>Export</i>) prints the frequency checklist for the field: every frequency in the results with a <i>Heard?</i> box.</li></ul>`],
  ["agencies", "Agencies", `<ul><li>RadioReference-style: category → licensee → frequencies, with input frequencies, tones and your labels.
    Add alpha tags, tones and descriptions in any record's detail window, or import a RadioReference-style CSV in Data &amp; updates.</li></ul>`],
  ["spectrum", "Spectrum", `
    <ul><li>Every frequency in the results at its exact position; zoomed in, each signal is drawn at its real channel width.</li>
    <li><b>Range</b>: type From / To, pick a preset, use − + ◀ ▶, <b>drag</b> across the plot to zoom into it, <b>Ctrl + wheel</b> to zoom at the cursor,
      <b>Shift + drag</b> to pan. The strip underneath is the whole result: click or drag it to move the window.</li>
    <li><b>Scale</b>: Auto switches to a log axis when the range runs from HF to microwave. <b>Height</b>: entries, strongest predicted dBm or measured dBm.</li>
    <li><b>Band plan</b> strip above the plot: the allocations, named where a band is over 50 px wide. <b>Known signals</b> (Signal ID Wiki,
      personal build): hover the strip for what's on that frequency. <b>Channel widths</b> draws each licence at its emission's width.</li>
    <li><b>Markers</b>: click the plot (it snaps to a nearby signal) or type a frequency. Each shows the distance from M1, what's on it and what it could be;
      name it, centre on it, or add it to the mission's watch list.</li></ul>`],
  ["mission", "Mission", `
    <ul><li>A mission holds an area, targets (signal types, bands, watch-list frequencies), default layers and collection settings.
      Change anything during the mission: every change is logged with the time.</li>
    <li><b>Import field captures</b>: WiGLE / Kismet CSV, GPX tracks, rtl_power / hackrf_sweep, analyzer CSV (with lat / lon, or just time and
      readings), KML / KMZ. Import a timed GPS track first (GPX, KML with gx:Track, or a WiGLE file); later files without coordinates are
      placed from it by time, within the mission's track match (30 s by default). A KML line (LineString) has no times, so it can't place them.
      <i>Place un-positioned points at the mission pin</i> places the rest there. A file nothing can place is refused, with the reason.</li>
    <li><b>Receiver</b> beside the import: the instrument's model, whether it was calibrated, and when. A calibrated instrument's levels grade A,
      an uncalibrated one's C (relative only); ✎ on a capture sets it later.</li>
    <li><b>Field log</b>: a quick reading at your GPS position or the pin. With <i>Auto-identify</i> it's checked against the nearest active
      licence on the frequency (within ±6.25 kHz, in a 40 mi box), then the band plan and the Signal ID Wiki (personal build); with a Type
      chosen, the licence check is skipped.</li>
    <li>Below the mission: <b>Find a signal</b>, <b>Compare with another survey</b>, and <b>Replay</b> / <b>When heard</b> / <b>Lines of bearing</b>
      (sections of their own in this help).</li></ul>`],
  ["find", "Search (Ctrl+K)", `
    <ul><li>One box over everything DAStastic holds: places, licences (call sign, licensee or a frequency such as <span class="mono">851.7125</span>),
      towers (owner or ASR number), 911 call centres, broadcast, aviation and NOAA stations, microwave links, FCC equipment makers, your labels and
      talk groups, survey and crowd points, missions, DAS jobs and the DAS research. <b>Ctrl+K</b> (⌘K) opens it from anywhere.</li>
    <li>The buttons under the box limit it to one kind. A frequency finds every licence, broadcast, FAA and NOAA station on it, under
      <i>Licences &amp; frequencies</i> or <i>Broadcast, aviation, NOAA</i> alike.</li>
    <li>A place and kind words (<span class="mono">Charlotte fire</span>, <span class="mono">Arlington schools</span>) list the licences around
      that place by category: a city's fire radios are often licensed to the city.</li>
    <li>Results are grouped, nearest to the pin first, each with a way to go there. Licensee names are indexed once after each FCC
      update (about a minute); until then call signs and frequencies work. Team logins don't see personal-only sources (WiGLE, RepeaterBook).</li></ul>`],
  ["cells", "Cell sites", `
    <ul><li>The cells around the pin from OpenCelliD, your own captures and, in the owner's personal build, WiGLE; grouped into sites
      (one LTE eNB, 5G gNB or UMTS RNC each) with their global cell IDs and sectors.</li>
    <li>Each site is matched to the nearest FCC-registered tower (ASR) within 1 km: its owner, height and the licensees on it.
      A sector's direction is an estimate, from the tower toward the cell's crowd position.</li>
    <li><b>Operator</b>, <b>Technology</b> and the text box narrow the list; click a site for its sectors, estimated coverage and tower.</li>
    <li>Carrier coverage at the pin (FCC Broadband Map) and the speed checks and fixed wireless offered there show above, where loaded.</li>
    <li><b>Import an OpenCelliD download</b> (a free account's country file, 310 to 316 for the US) keeps the cells in the states set in Data &amp; updates.</li></ul>`],
  ["hunt", "Find a signal", `
    <ul><li>Mission › 🎯 <b>Find a signal</b>: walk toward a signal (a rogue booster, a stuck transmitter). Type what you're looking for (MHz) and how
      close a match counts (one channel up to 5 MHz; a rogue BDA rebroadcasts a whole band, so 1 MHz).</li>
    <li>At each stop: <b>📍 Use my location</b>, type the <b>level</b> you read off any receiver (72 means −72 dBm), and if you can, the
      <b>direction</b> it's strongest: the phone's compass, or a bearing typed in (magnetic off a hand compass, or true off a map).</li>
    <li><b>The steadiness gate</b>: a compass direction is saved only when the last half second of readings agree within 5° and the phone
      doesn't call its compass uncalibrated or rough (over ±20°). Save waits up to 4 s for that; if it doesn't settle, it says why
      (a figure 8 calibrates it) and offers <b>Save the level only</b>. The compass is turned to true north with NOAA's World Magnetic Model
      at your position; where it can't be (no position, or a date outside 2025-2030), the stop is saved as magnetic and says so.</li>
    <li>After each stop: where it probably is (from the levels, the directions, or both), how far and which way from you, ±how many metres,
      and warmer or colder than the stop before. <b>Put the pin there</b> moves the search pin to the best guess.</li>
    <li><b>Next stop</b>: after a few stops a purple ring on the map says where to stand next: round to another side of it so the levels pin it
      down, or off to the side of your lines so the directions cross wider. <b>The stop counter</b> counts toward 8 stops, then 10, and says
      how much tighter the next ones make the estimate.</li>
    <li>The estimate also uses the mission's imported readings on the frequency (counted apart from your stops); a sweep's levels are relative dB,
      so they never weigh in.</li></ul>`],
  ["replay", "Replay, When heard, Lines of bearing", `
    <ul><li>In an opened mission. <b>Replay</b>: the mission's readings on a map in time order, at 1 minute up to 6 hours a second, showing the
      last minute up to everything so far.</li>
    <li><b>When heard</b>: when signals are heard, by hour and weekday.</li>
    <li><b>Lines of bearing</b>: every reading with a direction (Find a signal stops, field log bearings, imported azimuth columns) drawn as a
      line, and where they cross.</li></ul>`],
  ["compare", "Compare with another survey", `
    <ul><li>In an opened mission: pick a <b>baseline</b> (another mission, the same place on another day) and how far a level must move to count as
      changed (3 to 15 dB). DAStastic lists what's <b>new</b> since the baseline, what's <b>gone</b>, and what <b>changed level</b>.</li>
    <li>Signals match by MAC or cell ID where there is one, else by 6.25 kHz channel and signal type.</li></ul>`],
  ["receivers", "Receivers and calibration", `
    <ul><li>Every capture can say what took it: the receiver's model, whether it was calibrated, and the calibration date (Mission › Import field
      captures, or ✎ on a capture).</li>
    <li>A calibrated instrument's levels grade A in the Area report's claims; an uncalibrated receiver's levels are relative only and grade C.</li>
    <li>For a phone in the DAS walk test, <b>Phone vs instrument</b> corrects the phone's readings against a calibrated instrument (Help › Android app).</li></ul>`],
  ["data", "Data &amp; updates", `
    <ul><li><b>Connection</b>: online / offline and the link type (a phone tether counts as cellular).</li>
    <li><b>Automatic updates</b>: one switch for all, which networks it may use (<i>All</i>, <i>Wi-Fi</i>, <i>Ethernet</i>, <i>Cellular / phone tether</i>), and per source: on / off, how often, Run now, last result. <b>■ Stop all downloads</b> stops every download at once (FCC licences, carrier coverage, prospect lists and the rest) and starts nothing again, automatic updates included, until <b>Resume downloads</b>; the data you had is kept.</li>
    <li><b>Ways in</b> (on Cody's PC, and on the server for the admin): every way people get DAStastic or its data (the 24/7 server, Cody's PC,
      DAStastic for Android, the remote link, the web version, DAStastic lite, field packs, the install kit, the Drive folder, exports, Push to ATAK),
      the version each runs, and which work with Cody's PC off. On the server, field packs and Push to ATAK are the admin's.</li>
    <li><b>DAS course: who has it</b> (wherever people sign in: the server, or Cody's PC with the remote link on): tick the accounts that have the course, and see each one's lessons, mastery,
      exams passed, current lesson and last use. They open it from the DAS tab; their progress saves to their sign-in.</li>
    <li><b>Server files</b> (on the server, for the admin): what the server keeps, with sizes and dates, and a copy of any job file, note, field pack
      or backup to download. Read only. App data lists sizes, and logins, keys and the sign-in secret never show.</li>
    <li><b>Data sources</b> are what DAStastic downloads; <b>Used live as you work</b> lists the maps, terrain, address search,
      building outlines, weather radar and live ships it reads as you go; <b>Other open and crowd sources</b> is the research: what else exists,
      what it costs and allows, and why it is or isn't in DAStastic.</li>
    <li><b>Your API keys</b> (WiGLE, OpenCelliD, aisstream, Mouser, Digi-Key, Shippo, FCC Broadband Map) are kept outside every database file:
      sealed for your Windows account on a PC, in a file only DAStastic's user reads on the server. No copy, kit or backup carries them.
      RepeaterBook's token isn't taken (its policy discourages tools that mix sources).</li>
    <li>Import your own map layer (CSV, KML, KMZ, GeoJSON) or RadioReference-style labels.</li></ul>`],
  ["notes", "Notes", `
    <ul><li>The <b>Note</b> button, bottom right on every screen (or the <b>N</b> key): a voice note, the screen recorded while you
      talk and point, a photo with a voice or written note, or just words. Each note keeps the time, the screen, the pin and the mission.</li>
    <li>On Cody's PC a note is a folder in <i>DAStastic › notes</i> in Drive (note.txt plus the recording or photo), so it opens there too.
      On the 24/7 server a note is kept on the server. From the PC's remote link a note goes to Cody's PC. In the web version and DAStastic lite
      it stays in that browser.</li>
    <li>To send one to Cody: <b>Share with Cody</b>, then <b>Send email now</b>. It's emailed from the page, numbered (report #1, #2 ...)
      with a short topic; the first time it asks for your send code, which is in the link Cody sent you. A note emailed once shows its report
      number in every browser, so it isn't sent twice.
      <b>Share another way</b> still opens the phone's share sheet.</li>
    <li>On a phone, record the screen with the phone's own screen recorder, then pick the video in <b>Record the screen</b>.</li></ul>`],
  ["mouse", "Mouse and keyboard", `
    <table><tbody>
    <tr><td><b>?</b> or <b>F1</b></td><td>This help, on the current tab's section</td></tr>
    <tr><td><b>N</b></td><td>Leave a note</td></tr>
    <tr><td><b>Ctrl + K</b> (⌘K)</td><td>Search, from anywhere</td></tr>
    <tr><td><b>L</b></td><td>Show or fold the filter rail (the Filters sheet on a phone)</td></tr>
    <tr><td><b>/</b></td><td>The filter rail's Filter list box</td></tr>
    <tr><td><b>↑ / ↓</b>, <b>Space</b>, <b>O</b>, <b>A</b>, <b>← / →</b>, <b>Esc</b></td><td>In the filter rail: move, on / off, only, all on in the section, fold / open the section, leave</td></tr>
    <tr><td><b>Enter</b> in the Pin box</td><td>Take the highlighted suggestion (↑ / ↓ to move), or search coordinates</td></tr>
    <tr><td><b>Ctrl + wheel</b></td><td>Zoom the spectrum or topology at the cursor (the plain wheel scrolls the page)</td></tr>
    <tr><td><b>Drag</b> / <b>Shift + drag</b></td><td>Spectrum: zoom into a range / pan</td></tr>
    <tr><td><b>↑ / ↓</b></td><td>Analyzer: previous / next record</td></tr>
    <tr><td><b>Esc</b></td><td>Close a window or the suggestions</td></tr>
    <tr><td><b>[</b> / <b>]</b></td><td>DAS: the previous / next floor (Design, Grid test, Screening)</td></tr>
    <tr><td><b>Ctrl + Z</b></td><td>DAS walk test: undo the last change</td></tr>
    <tr><td><b>Alt + click</b> / <b>Alt + Shift + click</b></td><td>Analyzer: keep only / drop a cell's value</td></tr>
    <tr><td colspan="2">On a DAS floor plan (Design, Antennas and coverage): see <i>Walls on floor plans</i> below.</td></tr></tbody></table>`],
  ["walls", "Walls on floor plans", `
    <p>DAS › a job › Design › <i>Antennas and coverage</i>. Walls change the predicted coverage by their measured loss.</p>
    <ul><li><b>Draw walls</b> (<b>W</b>): drag along a wall, or click its start and then its end. The pointer snaps to drawn walls' ends,
      the plan's own line ends and crossings, onto a plan line, and square to the plan; the marker says which. A drag that runs along one
      plan line locks onto it (blue preview), ending on a double-line wall puts the wall on its centre. <b>Shift</b> while drawing: square
      to the plan. <b>Ctrl</b> held: no snap for that wall. <b>X</b> turns snap off and on.</li>
    <li><b>Snip</b> (<b>S</b>): drag a box; the walls inside the plan are found at once, all as the wall type picked. <b>Smart</b>
      (<b>Shift+S</b>): each wall gets its own type from what DAStastic knows: a word beside it on the plan (CMU, CONC, GYP, CURTAIN WALL),
      a stair, elevator or shaft box, glazing drawn as three thin lines, a hatched (block) or solid (concrete) fill and the wall's thickness,
      outside walls from the job's other floors, its construction and the building type.</li>
    <li><b>Lasso</b> (<b>L</b>, <b>Shift+L</b> Smart): draw any loop, a circle too; it closes where you started.</li>
    <li>What's found is shown dashed: green sure (0.75 or more), amber check it, grey probably not a wall. Hover one for how sure and why.
      <b>Enter</b> adds the sure ones, <b>Shift+Enter</b> all, <b>Esc</b> discards; click one to leave it out; <b>M</b> or <b>1</b>-<b>9</b>
      over one changes its type. From a PDF whose every find is sure, the walls go straight in ("Added 14 walls · Ctrl+Z").</li>
    <li><b>Remove</b> (<b>E</b>): click a wall or antenna, or drag a box around several. In any other tool, hold <b>Shift</b> to remove;
      in Remove, hold Shift to draw. <b>Delete</b> removes what's under the pointer.</li>
    <li><b>Ctrl+Z</b> / <b>Ctrl+Shift+Z</b>: undo / redo, 30 steps per floor; a snip's walls are one step. <b>A</b> antennas, <b>M</b> /
      <b>Shift+M</b> next / previous wall type, <b>Ctrl+Y</b> redo too, <b>Backspace</b> removes like Delete, <b>1</b>-<b>9</b>, <b>0</b> the first ten, <b>B</b> / <b>F</b> next band / floor (Shift: back).</li>
    <li>The 💡 button names the best tool for this plan: <i>Smart snip</i> for a PDF with clean lines or a wall layer, <i>Snip, then review</i>
      for a mixed PDF, <i>Snip (detected): confirm</i> for a clear plan image, <i>Draw with snap</i> for a hard one, <i>Draw by hand</i>
      when no lines could be read (a photo). Click it to switch. Plans saved from a PDF (Plans) are read from the PDF itself: the best case.</li></ul>`],
  ["sources", "Where the data comes from", `
    <ul><li><b>FCC ULS</b> licences (land mobile, paging, broadcast auxiliary, marine and aviation ground) and <b>FCC ASR</b> towers: authoritative, updated weekly by the FCC.</li>
    <li><b>Broadcast</b> AM, FM and TV stations (FCC Media Bureau), <b>NOAA Weather Radio</b> transmitters with the counties each warns, and
      <b>FAA aviation</b> frequencies: towers, ATIS, approach, CTAF, navaids and ILS (new FAA cycle every 28 days).</li>
    <li><b>Signal Identification Wiki</b> (sigidwiki.com): what a signal could be. Personal build only; kept on this PC; open its pages for audio and decoding notes.</li>
    <li><b>Your captures</b>, and crowd layers with your own keys: <b>OpenCelliD</b> (CC BY-SA) in every build; <b>WiGLE</b> (non-commercial) and <b>RepeaterBook</b> (personal use) in the personal build only.</li>
    <li>Also: FCC microwave links and pending applications, satellite earth stations, 911 call centres (FCC PSAP registry), FCC Broadband Map carrier
      coverage, LoRaWAN (TTN, Helium), SatNOGS, Meshtastic, PSKReporter, WSPR (personal build), live ships (aisstream, personal build), Artemis
      (personal build) and the DAS sources (prospect lists, USFA fire departments, parts prices). Data &amp; updates › Data sources lists every one,
      with its terms and when it last ran.</li>
    <li><b>RadioReference</b>: every licence's detail window links to its RadioReference call-sign page and the FCC's own record, and the Area report links to the state.
      Its data isn't copied in: its terms forbid that and its API needs Premium. Import its CSV exports as labels instead.</li>
    <li><b>Not in any public list</b>: federal users (NTIA's records aren't public) and cellular sites (licensed by market area, not by site).</li>
    <li>Predicted levels: <i>Strongest signals</i>, Spectrum heights and <i>Licensed, not heard</i> are <b>free space</b> (best case, no terrain
      or buildings); the terrain heatmap, the Area report's coverage by band and an emitter's coverage are Okumura-Hata with the hills where terrain
      is kept. Licensed doesn't mean on the air: mark what you hear.</li></ul>`],
  ["credits", "Data credits and this build", () => {
    const b = S.build || {}, out = Object.entries(b.left_out || {});
    if (!b.build) return `<p class="hint">This copy didn't say which build it is (restart DAStastic to load it).</p>`;
    return `<p>This is the <b>${b.build === "personal" ? "personal" : "sold"} build</b>.
      ${b.build === "personal" ? "It carries every source, including ones whose terms allow personal use only. Don't sell or share what it shows from them."
        : "It leaves out every source whose terms bar commercial use or sharing:"}</p>
    ${out.length ? `<ul>${out.map(([k, why]) => `<li><b>${esc(k)}</b>: ${esc(why)}</li>`).join("")}</ul>` : ""}
    <ul>${Object.values(b.notices || {}).map(n => `<li>${esc(n)}</li>`).join("")}</ul>`; }],
  ["glossary", "Glossary", `
    <table><tbody>
    <tr><td><b>ERP</b></td><td>Effective radiated power: transmitter power times antenna gain, in watts.</td></tr>
    <tr><td><b>Emission designator</b></td><td>e.g. <span class="mono">8K10F1E</span>: 8.1 kHz wide, FM, digital voice (P25). The app decodes them in Details.</td></tr>
    <tr><td><b>Station class</b></td><td>FB base, FB2 repeater, MO mobile, FX fixed. Repeaters also list an input frequency.</td></tr>
    <tr><td><b>NAC / CC / tone</b></td><td>P25 network access code, DMR colour code, analog CTCSS / DCS tone: what separates users on one frequency.</td></tr>
    <tr><td><b>Part 15 / Part 95</b></td><td>Unlicensed devices (Wi-Fi, Bluetooth, ISM) / personal radio licensed by rule (FRS, GMRS, MURS, CB).</td></tr>
    <tr><td><b>Unlisted</b></td><td>A surveyed signal with no FCC licence nearby on its frequency and no allocation that allows it: worth a second look.</td></tr></tbody></table>`],
  ["android", "Android app", () => `
    <p>DAStastic for Android opens this DAStastic in a full-screen app and lets the DAS walk test read the phone's own LTE / 5G signal.
      On Wi-Fi it also pushes live markers into ATAK and listens on that Wi-Fi for the TAK team.
      Android 10 or newer. (iPhones can't: Apple gives no app the phone's signal readings.)</p>
    <p><a href="${RF_APK}" download="DAStastic (Android) 1.2.apk" style="display:inline-block;padding:8px 14px;border-radius:10px;background:var(--accent);color:var(--on-accent,#fff);font-weight:600;text-decoration:none">⇩ Download the Android app (1.2)</a>
      <span class="hint">Open this page on the phone and tap it there.</span></p>
    <ol><li>On the phone, tap the download to open it.</li>
    <li>The first time, Android says installs from that app are blocked: tap <b>Settings</b>, turn on <b>Allow from this source</b>, go back,
      tap <b>Install</b>. Once only. If Play Protect warns about an unknown app, tap <b>Install anyway</b>: it isn't on the Play Store.</li>
    <li>Open <b>DAStastic</b> and sign in as usual. The sign-in is kept.</li>
    <li><b>DAS › a job › Grid test › Walk › Point › Read the phone</b>, then tap where you stand: the spot takes the phone's serving cell.
      The first time, allow <b>location</b> (precise, while using the app): Android only gives signal readings to apps that have it,
      and the phone's Location must be on.</li>
    <li><b>Continuous › Start walk</b> logs the phone's signal as you go; tap your position as you walk, then <b>Stop</b>: the readings
      are placed on the walk by time. Keep the app open while walking (it keeps the screen on).</li>
    <li><b>Correct the phone against a calibrated instrument</b> (once per phone): <b>Point › Phone vs instrument</b>, then at 5 or more
      spots, strong signal and weak, tap where you stand and type what the instrument beside the phone reads for the same cell. The
      <i>Phone correction</i> table under the walk shows how far this phone reads off on each band (and how sure); from then on the
      phone's readings are corrected as they're taken, and <i>Correct this floor's earlier phone readings</i> fixes ones taken before.
      The table stays on the phone for later jobs.</li>
    <li><b>ATAK on the same Wi-Fi</b>: <b>📡 Push to ATAK</b> sends what's on the map as live markers to ATAK on this phone and to every
      ATAK, iTAK and WinTAK on the Wi-Fi the phone is on; pushing again updates them. The map's layer menu › <b>TAK team (this network)</b>
      shows the ATAK users on that Wi-Fi by callsign, and their markers. Off Wi-Fi, Push to ATAK saves the package instead.</li></ol>
    <ul><li>Phone readings are cellular only (no public-safety channels) and not calibrated: they show in the cellular view and never
      count toward a public-safety pass.</li>
    <li>Android gives a new reading every few seconds at most; on a dual-SIM phone only the default SIM is read; Android 10 doesn't
      report the 5G band.</li>
    <li>Back on the app's first page opens its menu: the server, the web version (no server), reload, exit.</li>
    <li>A new version installs over this one: tap its download the same way. Your sign-in stays, and jobs are on the server.</li></ul>`],
  ["files", "Where your files are", `
    <ul><li><b>The 24/7 server</b>: its FCC data, database, DAS jobs, field packs and notes are on the server.</li>
    <li><b>Cody's PC</b>: the app runs from its own folder (<span class="mono">rf-recon\\app</span> in the Windows user folder, outside Drive since 11/3);
      FCC data and the database stay on the PC (<span class="mono">rf-recon\\data</span>): gigabytes that shouldn't sync or go over a phone connection.
      The docs, field packs, backups (missions, captures, labels and settings, not API keys, every 6 hours) and notes are in the <b>DAStastic</b> folder in Google Drive.</li>
    <li><b>The web version and DAStastic lite</b>: the data is a state pack from the DAStastic site, or a field pack you load (from Drive or the server's
      admin), kept in that browser with everything you do there.</li></ul>`],
];

(function helpUi() {
  const hdrBtn = document.getElementById("themeBtn");
  const b = document.createElement("button");
  b.className = "hbtn"; b.id = "helpBtn"; b.title = "Help (? or F1)"; b.textContent = "?";
  hdrBtn.parentNode.insertBefore(b, hdrBtn);
  b.onclick = () => openHelp(S.tab);
  document.addEventListener("keydown", e => {
    const typing = window.RFKeys ? RFKeys.typing() : /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");  // keys.js: one rule for every shortcut
    const dialog = [...document.querySelectorAll("dialog[open]")].some(d => d.id !== "dlg" || !$("#helpQ"));  // another window is open
    if (dialog) return;  // keys.js: shortcuts wait while a dialog is open; F1 still opens Help while typing (it types nothing)
    if (e.key === "F1" || (e.key === "?" && !typing)) { e.preventDefault(); openHelp(S.tab); }
  });
})();

function openHelp(section) {
  $("#dlgTitle").textContent = "Help: DAStastic (beta)";
  $("#dlgBody").innerHTML = `<p style="margin:0 0 8px"><a href="static/release-notes.html" target="_blank" rel="noopener"><b>What's new:</b> release notes: every change in order, then what the current build does</a></p>
    <input id="helpQ" placeholder="Search help…" style="width:100%;margin-bottom:8px">
    <div class="chips" style="margin-bottom:8px">${HELP.map(([id, t]) => `<span class="chip" data-hjump="${id}">${t}</span>`).join("")}</div>
    <div id="helpBody">${HELP.map(([id, t, body]) => (body = typeof body === "function" ? body() : body, `<div class="sec" id="help-${id}" data-text="${esc((t + " " + body.replace(/<[^>]+>/g, " ")).toLowerCase())}"><h3>${t}</h3>${body}</div>`)).join("")}</div>`;
  $("#dlgBody").querySelectorAll("[data-hjump]").forEach(c => c.onclick = () => $("#help-" + c.dataset.hjump)?.scrollIntoView({behavior: "smooth", block: "start"}));
  $("#helpQ").oninput = e => {
    const q = e.target.value.trim().toLowerCase();
    $("#helpBody").querySelectorAll(".sec").forEach(s => { s.hidden = q && !s.dataset.text.includes(q); });
  };
  $("#dlg").showModal();
  const target = $("#help-" + section) || $("#help-start");
  setTimeout(() => target.scrollIntoView({block: "start"}), 30);
}
document.addEventListener("click", e => { const a = e.target.closest?.("[data-help]");
  if (a) { e.preventDefault(); openHelp(a.dataset.help); } });
// the shared dialog (Help, details) closes on a press outside it, like every other layer; Escape already did (11/3)
document.getElementById("dlg")?.addEventListener("click", e => {
  const d = e.currentTarget, r = d.getBoundingClientRect();
  if (e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) d.close();
});
