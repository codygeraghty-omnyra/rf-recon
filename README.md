# RF Recon (beta), web and phone apps

- **Phone:** open https://codygeraghty-omnyra.github.io/rf-recon/ and add it to the home screen. FCC licences,
  towers, broadcast stations, NOAA Weather Radio and FAA facilities for an area: map, list, area report, and a
  field log of signals you hear that checks each one against the licences.
- **Computer:** https://codygeraghty-omnyra.github.io/rf-recon/full/ is the desktop RF Recon's own screens in a
  browser: search, map layers, area report, analyzer, dashboard, topology, site profile, agencies, spectrum,
  heatmaps and exports.
- **ATAK / iTAK / WinTAK:** both make a TAK data package of what's on screen (a marker per site with its frequencies,
  the search ring, and the coverage heatmap when one is on).

Both work with no signal once a data pack is loaded, and share packs in the same browser.

This repo holds code only. It contains no FCC data and no data packs. Packs are made by the desktop RF Recon and
shared through Google Drive; the apps load them through the file picker and keep them in that browser. Nothing is
uploaded anywhere.

Built with [Leaflet](https://leafletjs.com) (BSD-2-Clause), [sql.js](https://github.com/sql-js/sql.js) (MIT) and
[Cytoscape.js](https://js.cytoscape.org) (MIT); their licences are in `vendor/` and `full/static/vendor/`. Maps:
USGS The National Map (public domain), Esri, US Census TIGERweb, NEXRAD via Iowa Environmental Mesonet, and
OpenStreetMap contributors.
