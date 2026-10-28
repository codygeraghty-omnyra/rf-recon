# RF Recon (beta), phone app

Open https://codygeraghty-omnyra.github.io/rf-recon/ on a phone and add it to the home screen. It shows the FCC
licences, towers, broadcast stations, NOAA Weather Radio and FAA facilities for one area, and keeps a field log of
signals you hear, all without signal once loaded.

This repo holds the app's code only. It contains no FCC data and no data packs. A pack is made by the desktop
RF Recon app and shared through Google Drive; the app loads it from the phone's file picker and keeps it on the
phone. Nothing is uploaded anywhere.

Built with [Leaflet](https://leafletjs.com) (BSD-2-Clause) and [sql.js](https://github.com/sql-js/sql.js) (MIT);
their licences are in `vendor/`. Maps: USGS The National Map (public domain) and OpenStreetMap contributors.
