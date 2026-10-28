// Look panel: one button that opens Skin, Glass and Motion settings, for any dashboard tool on this kit.
// Load after skins.js. DashLook.mount(container) puts the button in that element (a top bar), e.g.
//   <script src="skins.js"></script><script src="look.js"></script>
//   DashLook.mount(document.querySelector('.topbar-right'), { onChange: () => redrawCharts() });
// The panel is a glass popover; Escape or a click outside closes it. Changes cross-fade (DashSkin.swap).
(function () {
  var css = '.dl-look-btn{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 12px;border-radius:999px;border:1px solid var(--g-border);background:var(--wash);color:var(--ink);font:inherit;font-size:13px;cursor:pointer;transition:background var(--t-hover) ease}'
    + '.dl-look-btn:hover{background:var(--wash-2)}'
    + '.dl-look{position:fixed;z-index:3000;padding:14px 16px;border-radius:18px;display:flex;flex-direction:column;gap:12px;max-width:calc(100vw - 16px);background:var(--g-strong);-webkit-backdrop-filter:var(--g-blur);backdrop-filter:var(--g-blur);border:1px solid var(--g-border);box-shadow:var(--g-shadow);color:var(--ink)}'
    + '.dl-look h5{margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}'
    + '.dl-seg{display:flex;flex-wrap:wrap;gap:2px;padding:3px;border-radius:999px;background:var(--wash)}'
    + '.dl-seg button{border:0;border-radius:999px;padding:6px 11px;background:none;color:var(--ink-2,var(--ink));font:inherit;font-size:12.5px;cursor:pointer;transition:background var(--t-hover) ease,color var(--t-hover) ease}'
    + '.dl-seg button[aria-pressed="true"]{background:var(--ink);color:var(--bg)}'
    + '.dl-note{max-width:320px;margin-top:6px;font-size:12px;line-height:1.4;color:var(--muted)}.dl-note b{color:var(--ink)}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var btn, panel, opts = {};
  function row(k, label, cur, list, names, note) {
    return '<div><h5>' + label + '</h5><div class="dl-seg" role="group" aria-label="' + label + '">' + list.map(function (v) {
      return '<button type="button" data-k="' + k + '" data-v="' + v + '" aria-pressed="' + (v === cur) + '">' + esc(names[v]) + '</button>';
    }).join('') + '</div>' + (note ? '<div class="dl-note">' + note + '</div>' : '') + '</div>';
  }
  function html() {
    var mo = DashSkin.motion();
    var note = mo === 'auto' ? 'Follows Windows animation effects: ' + (DashSkin.systemReduced() ? '<b>off on this PC</b>, so nothing moves. Pick On to see the motion.' : 'on.') : mo === 'on' ? 'On, whatever Windows says.' : 'Off everywhere.';
    return row('skin', 'Skin', DashSkin.get(), DashSkin.list, DashSkin.names) + row('glass', 'Glass', DashSkin.glass(), DashSkin.glassLevels, DashSkin.glassNames) + row('motion', 'Motion', mo, DashSkin.motionLevels, DashSkin.motionNames, note);
  }
  var LAYERS = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="m3 13 9 5 9-5"/></svg>';
  var CHEV = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  function label() { btn.innerHTML = LAYERS + esc(DashSkin.names[DashSkin.get()]) + CHEV; }
  function close(refocus) { if (!panel.hidden) { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus(); } }
  function open() {
    panel.innerHTML = html(); panel.hidden = false;
    var r = btn.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(r.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8)) + 'px';
    panel.style.top = (r.bottom + 6) + 'px';
    btn.setAttribute('aria-expanded', 'true');
  }
  window.DashLook = {
    mount: function (container, o) {
      opts = o || {};
      btn = document.createElement('button'); btn.type = 'button'; btn.className = 'dl-look-btn'; btn.title = 'Skin, glass and motion';
      btn.setAttribute('aria-haspopup', 'dialog'); btn.setAttribute('aria-expanded', 'false');
      panel = document.createElement('div'); panel.className = 'dl-look'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Look'); panel.hidden = true;
      container.appendChild(btn); document.body.appendChild(panel); label();
      btn.addEventListener('click', function () { panel.hidden ? open() : close(); });
      panel.addEventListener('click', function (e) {
        e.stopPropagation();   // the panel redraws under the click; keep the outside-click check from closing it
        var b = e.target.closest('button[data-k]'); if (!b) return;
        var k = b.dataset.k, v = b.dataset.v;
        DashSkin.swap(function () {
          if (k === 'skin') DashSkin.set(v); else if (k === 'glass') DashSkin.glass(v); else DashSkin.motion(v);
          label(); panel.innerHTML = html();
          close(true);   // a pick closes the panel (Cody, 10/28); it fades out with the cross-fade
          if (opts.onChange) opts.onChange(k, v);
        });
      });
      document.addEventListener('click', function (e) { if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) close(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) close(true); });
    },
  };
})();
