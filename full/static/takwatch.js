"use strict";
/* RF Recon — the TAK team on our own map (Cody 11/6, the TAK layer he picked). One more overlay in the map's layer menu,
   "TAK team (this network)": while it's on, the PC listens on the TAK multicast Push to ATAK sends on and draws what ATAK,
   iTAK and WinTAK users share: people as blue dots with their callsign, their markers as small diamonds, a stale one grey.
   Turning the layer off stops the listening (takwatch.py); nothing is kept on disk. The server copy isn't on anyone's local
   network, so there the layer says so and draws nothing. */
(() => {
  if (typeof OVERLAYS === "undefined" || typeof L === "undefined") return;
  const NAME = "TAK team (this network)";
  const ago = s => s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  const esc2 = s => (typeof esc === "function" ? esc(s) : String(s ?? ""));
  OVERLAYS[NAME] = () => {
    const layer = L.layerGroup(), marks = new Map();
    let timer = null, box = null, map = null;
    const note = t => { if (box) box.getContainer().innerHTML = t; };
    const draw = r => {
      const seen = new Set();
      for (const x of r.items || []) {
        seen.add(x.uid);
        const team = x.kind === "team", col = x.is_stale ? "#8b949e" : team ? "#1f6feb" : "#d29922";
        const tip = `<b>${esc2(x.callsign || x.uid)}</b>${x.group ? ` · ${esc2(x.group)}` : ""}${x.role ? ` (${esc2(x.role)})` : ""}<br><span class="hint">${team ? "ATAK user" : "ATAK marker"} · ${ago(x.age_s)}${x.is_stale ? " · stale" : ""}${x.ce != null ? ` · ±${Math.round(x.ce)} m` : ""}</span>${x.remarks ? `<br>${esc2(x.remarks)}` : ""}`;
        let m = marks.get(x.uid);
        if (!m) {
          m = team ? L.circleMarker([x.lat, x.lon], { radius: 7, weight: 2, color: "#fff", fillColor: col, fillOpacity: .95 })
            : L.marker([x.lat, x.lon], { icon: L.divIcon({ className: "tak-mk", html: `<span style="display:block;width:12px;height:12px;transform:rotate(45deg);background:${col};border:2px solid #fff"></span>`, iconSize: [16, 16] }) });
          if (team) m.bindTooltip(esc2(x.callsign || "ATAK"), { permanent: true, direction: "right", offset: [8, 0], className: "tak-tip" });
          m.bindPopup(tip); m.addTo(layer); marks.set(x.uid, m);
        } else { m.setLatLng([x.lat, x.lon]); m.setPopupContent(tip); if (team && m.setStyle) m.setStyle({ fillColor: col }); }
      }
      for (const [uid, m] of marks) if (!seen.has(uid)) { layer.removeLayer(m); marks.delete(uid); }
      const people = (r.items || []).filter(x => x.kind === "team" && !x.is_stale).length, other = (r.items || []).length - people;
      note(r.error ? `<b>TAK:</b> ${esc2(r.error)}` : `<b>TAK:</b> ${r.listening ? `listening on ${r.networks} network${r.networks === 1 ? "" : "s"}` : "not listening"} · ${people} ${people === 1 ? "person" : "people"}, ${other} marker${other === 1 ? "" : "s"}`);
    };
    const poll = async () => {
      try { const r = await fetch("/api/tak/feed"), j = await r.json(); if (!r.ok) { note(`<b>TAK:</b> ${esc2(j.error || `HTTP ${r.status}`)}`); stopPoll(); return; } draw(j); }
      catch (e) { note(`<b>TAK:</b> ${esc2(e.message)}`); }
    };
    const stopPoll = () => { if (timer) clearInterval(timer); timer = null; };
    layer.onAdd = function (m) {
      L.LayerGroup.prototype.onAdd.call(this, m); map = m;
      box = L.control({ position: "bottomleft" }); box.onAdd = () => { const d = L.DomUtil.create("div", "tak-box"); d.style.cssText = "background:var(--panel,#fff);padding:4px 8px;border-radius:8px;font-size:12px;max-width:320px"; return d; };
      box.addTo(m);
      if (document.body.classList.contains("remote") || (window.S && S.me && S.me.server)) { note("<b>TAK:</b> the TAK team layer runs on the PC only: the server isn't on your local network."); return; }
      note("<b>TAK:</b> listening…"); poll(); timer = setInterval(poll, 5000);
    };
    layer.onRemove = function (m) {
      stopPoll(); if (box) { box.remove(); box = null; }
      L.LayerGroup.prototype.onRemove.call(this, m); marks.clear(); this.clearLayers();
      if (!document.body.classList.contains("remote")) fetch("/api/tak/feed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: false }) }).catch(() => {});
    };
    return layer;
  };
  document.head.insertAdjacentHTML("beforeend", `<style>.tak-tip{background:#1f6feb;color:#fff;border:0;font-weight:600;padding:1px 5px}.tak-tip::before{display:none}</style>`);
})();
