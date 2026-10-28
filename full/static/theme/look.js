// Look panel: one button in the top bar that opens the display settings for any dashboard tool on this kit, laid out
// like the Sales CRM's Settings page: skin cards (Match system and the five skins), accent colours, a backdrop
// photo, glass density, Reduce transparency and Motion. Back and Close sit beside the button.
// Load after skins.js (skins.js, then this file), then
//   DashLook.mount(document.querySelector('.topbar-right'), { onChange: (kind, value) => redrawCharts(),
//     keys: [['Ctrl K', 'Search everything']] });   // keys: the tool's own shortcuts, added to the Keyboard list
// Inlined into a single-file page, escape any closing script tag in the code first (the hub's glass.py does).
// The panel is a glass sheet. A pick applies and closes it (Cody, 10/28: "still gets stuck open"); so do its close
// button, Escape and any press outside it (caught before the page sees it, so pages that stop clicks still close it).
(function () {
  var css = '.dl-look-btn{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 12px;border-radius:999px;border:1px solid var(--g-border);border-color:var(--c-edges,var(--g-border));background:var(--wash);background-image:var(--c-fill,none);box-shadow:var(--c-depth,none);color:var(--ink);font:inherit;font-size:13px;cursor:pointer;transition:background-color var(--t-hover) ease,box-shadow var(--t-hover) ease,transform var(--t-hover) ease}'
    + '.dl-look-btn:hover{background-color:var(--wash-2)}.dl-look-btn:active{box-shadow:var(--c-press,none);transform:translateY(1px)}'
    + '.dl-nav{padding:0 11px}.dl-nav:disabled{opacity:.4;cursor:default}.dl-look-btn+.dl-look-btn,.dl-nav+.dl-look-btn{margin-left:6px}'
    + '.dl-hint{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:3001;padding:9px 14px;border-radius:999px;background:var(--inv);color:var(--inv-ink);font-size:13px;box-shadow:var(--g-shadow-up,var(--g-shadow))}'
    // the sheet
    + '.dl-look{position:fixed;z-index:3000;width:min(980px,calc(100vw - 16px));overflow-y:auto;overscroll-behavior:contain;padding:18px 20px 20px;border-radius:22px;display:flex;flex-direction:column;gap:18px;background:var(--g-strong);-webkit-backdrop-filter:var(--g-blur);backdrop-filter:var(--g-blur);border:1px solid var(--g-border);border-color:var(--g-edges,var(--g-border));box-shadow:var(--g-shadow-up,var(--g-shadow));color:var(--ink);text-align:left;font-size:14px;line-height:1.4}'
    + '.dl-look[hidden]{display:none!important}'  // the display:flex above beats the browser's own [hidden] rule: without this, closing left it open
    + '.dl-look b{font-weight:650}.dl-sub{display:block;color:var(--ink-2,var(--ink));font-size:12.5px;margin-top:2px}'
    + '.dl-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.dl-head b{font-size:17px}'
    + '.dl-x{flex:none;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;border:1px solid;border-color:var(--c-edges,var(--g-border));background:var(--wash);background-image:var(--c-fill,none);box-shadow:var(--c-depth,none);color:var(--ink);cursor:pointer}.dl-x:hover{background-color:var(--wash-2)}'
    + '.dl-sec{display:flex;flex-direction:column;gap:16px;padding-top:16px;border-top:1px solid var(--line)}'
    + '.dl-cols{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:28px}@media (max-width:820px){.dl-cols{grid-template-columns:1fr;gap:0}}'
    + '.dl-data{gap:0;margin-bottom:18px}.dl-data .dl-btns{margin-top:10px}.dl-keys{gap:10px}.dl-key{display:flex;align-items:center;gap:12px;color:var(--ink-2,var(--ink));font-size:13px}.dl-key>span{display:inline-flex;gap:4px;min-width:74px}'
    + '.dl-key kbd{font:600 11px/1 var(--font);padding:4px 6px;border-radius:6px;background:var(--wash-2);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line)}'
    + '.dl-skins{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:10px;margin-top:10px}'
    + '.dl-card{display:flex;flex-direction:column;gap:7px;padding:7px;border-radius:16px;border:0;box-shadow:inset 0 0 0 1.5px var(--line);background:var(--wash);cursor:pointer;text-align:left;color:var(--ink);font:inherit;transition:box-shadow var(--t-border) ease,transform var(--t-hover) ease}'
    + '.dl-card:hover{box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--ink) 35%,transparent)}.dl-card:active{transform:translateY(1px)}'
    + '.dl-card[aria-pressed="true"]{box-shadow:inset 0 0 0 2px var(--accent),0 12px 30px -16px var(--accent)}'
    + '.dl-card>span:last-child{padding:0 4px 3px;display:flex;flex-direction:column}.dl-card small{color:var(--ink-2,var(--ink));font-size:11.5px;line-height:1.3}'
    + '.dl-pv{height:66px;border-radius:11px;position:relative;overflow:hidden;background:linear-gradient(160deg,var(--p1),var(--p2));background-size:cover;background-position:center}'
    + '.dl-pv::before{content:"";position:absolute;left:9px;right:26px;top:10px;bottom:10px;border-radius:8px;background:var(--pg);box-shadow:inset 0 1px 0 rgba(255,255,255,.25),inset 0 0 0 1px rgba(255,255,255,.12)}'
    + '.dl-pv::after{content:"";position:absolute;right:9px;top:10px;width:12px;height:12px;border-radius:50%;background:var(--pa);box-shadow:0 0 10px var(--pa)}'
    + '.dl-pv.photo::before,.dl-pv.photo::after{display:none}'
    + '.dl-row{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}.dl-row>div:first-child{min-width:0;flex:1 1 220px}'
    + '.dl-sw{display:flex;gap:8px;flex-wrap:wrap;align-items:center}'
    + '.dl-swatch{width:30px;height:30px;border-radius:50%;border:2px solid transparent;cursor:pointer;background:linear-gradient(135deg,var(--sw),var(--sw2));box-shadow:0 1px 3px rgba(0,0,0,.3)}'
    + '.dl-swatch[aria-pressed="true"]{border-color:var(--ink)}.dl-swatch:hover{transform:scale(1.06)}'
    + '.dl-swatch.skin{width:auto;padding:0 12px;border-radius:999px;background:var(--wash-2);color:var(--ink);font:inherit;font-size:11.5px;font-weight:700;box-shadow:inset 0 0 0 1px var(--line)}'
    + '.dl-seg{display:flex;flex-wrap:wrap;gap:2px;padding:3px;border-radius:999px;background:var(--wash);box-shadow:inset 0 1px 3px rgba(0,0,0,.3),inset 0 0 0 1px var(--line,transparent)}'
    + ':root[data-skin="day"] .dl-seg{box-shadow:inset 0 1px 2px rgba(15,23,42,.12),inset 0 0 0 1px var(--line,transparent)}'
    + '.dl-seg button{border:0;border-radius:999px;padding:6px 12px;background:none;box-shadow:none;color:var(--ink-2,var(--ink));font:inherit;font-size:12.5px;cursor:pointer;transition:background var(--t-hover) ease,color var(--t-hover) ease}'
    + '.dl-seg button[aria-pressed="true"]{background:var(--ink);color:var(--bg);box-shadow:0 1px 2px rgba(0,0,0,.3)}'
    + '.dl-switch{width:46px;height:28px;border-radius:999px;border:0;box-shadow:inset 0 0 0 1px var(--line);background:var(--wash-2);cursor:pointer;position:relative;flex:none;transition:background var(--t-border) ease}'
    + '.dl-switch span{position:absolute;top:4px;left:4px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.3);transition:transform var(--t-border) var(--ease)}'
    + '.dl-switch[aria-checked="true"]{background:var(--accent)}.dl-switch[aria-checked="true"] span{transform:translateX(18px);background:var(--on-accent)}'
    + '.dl-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}'
    + '.dl-btn{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 13px;white-space:nowrap;position:relative;border-radius:999px;border:1px solid;border-color:var(--c-edges,var(--g-border));background:var(--wash);background-image:var(--c-fill,none);box-shadow:var(--c-depth,none);color:var(--ink);font:inherit;font-size:13px;cursor:pointer}'
    + '.dl-btn:hover{background-color:var(--wash-2)}.dl-btn:active{box-shadow:var(--c-press,none);transform:translateY(1px)}'
    + '.dl-file{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}'
    + '.dl-photo{display:grid;grid-template-columns:minmax(0,170px);margin-top:10px}'
    + '@media (max-width:600px){.dl-nav span{display:none}.dl-look{padding:14px 14px 16px}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var btn, panel, opts = {}, note = '';

  // skin cards: name, one line, and a small preview (backdrop gradient, a glass pane, the accent dot)
  var SKIN_INFO = {
    auto: ['Dark skin at night, Daylight by day', ['#2b231b', '#c8c3ff', 'rgba(255,255,255,.3)', '#f0a07a']],
    smoke: ['Warm glass, peach', ['#2b231b', '#6b563f', 'rgba(38,34,30,.75)', '#f0a07a']],
    haze: ['Clearest glass, smoky', ['#3a3734', '#8d877e', 'rgba(30,30,32,.28)', '#ece6dc']],
    dusk: ['Slate glass, lime', ['#3c4758', '#87695a', 'rgba(20,23,23,.5)', '#c4ef4f']],
    liquid: ['Beveled glass, blue', ['#2a1d6e', '#0f5c8a', 'rgba(26,26,36,.45)', '#3d8bfd']],
    day: ['Frosted white', ['#c8c3ff', '#bfe6ff', 'rgba(255,255,255,.6)', '#2a78d6']],
  };
  var I = {
    x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    up: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4M6 10l6-6 6 6M4 20h16"/></svg>',
    down: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12M6 10l6 6 6-6M4 20h16"/></svg>',
    layers: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="m3 13 9 5 9-5"/></svg>',
    chev: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    back: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  };
  function card(id, name) {
    var inf = SKIN_INFO[id], p = inf[1];
    return '<button type="button" class="dl-card" data-k="skin" data-v="' + id + '" aria-pressed="' + (DashSkin.choice() === id) + '"><span class="dl-pv" style="--p1:' + p[0] + ';--p2:' + p[1] + ';--pg:' + p[2] + ';--pa:' + p[3] + '"></span><span><b>' + esc(name) + '</b><small>' + esc(inf[0]) + '</small></span></button>';
  }
  function sw(on) { return '<button type="button" class="dl-switch" role="switch" aria-checked="' + on + '"'; }
  function html() {
    var dark = DashSkin.get() !== 'day', acc = DashSkin.accent(), photo = DashSkin.photo(), on = DashSkin.photoOn();
    var skins = card('auto', 'Match system') + DashSkin.list.map(function (s) { return card(s, DashSkin.names[s]); }).join('');
    var swatches = '<button type="button" class="dl-swatch skin" data-k="accent" data-v="skin" aria-pressed="' + (acc === 'skin') + '">Skin</button>' + DashSkin.accents.map(function (a) {
      var pr = dark ? a.d : a.l;
      return '<button type="button" class="dl-swatch" data-k="accent" data-v="' + a.id + '" aria-pressed="' + (acc === a.id) + '" aria-label="' + a.name + '" title="' + a.name + '" style="--sw:' + pr[0] + ';--sw2:' + pr[1] + '"></button>';
    }).join('');
    var file = '<input type="file" accept="image/*" class="dl-file" data-photo>';
    var photoUi = photo
      ? '<div class="dl-photo"><button type="button" class="dl-card" data-k="photo" data-v="' + (on ? 'off' : 'on') + '" aria-pressed="' + on + '"><span class="dl-pv photo" style="background-image:url(\'' + photo + '\')"></span><span><b>' + (on ? 'Your photo is on' : 'Use your photo') + '</b><small>' + (on ? 'Click to show the skin\'s backdrop' : 'Click to show it behind the glass') + '</small></span></button></div>'
        + '<div class="dl-btns"><label class="dl-btn">' + I.up + 'Change photo' + file + '</label><button type="button" class="dl-btn" data-k="photo" data-v="remove">Remove photo</button></div>'
      : '<div class="dl-btns"><label class="dl-btn">' + I.up + 'Upload a photo' + file + '</label></div>';
    var glass = '<div class="dl-seg" role="group" aria-label="Glass">' + DashSkin.glassLevels.map(function (g) {
      return '<button type="button" data-k="glass" data-v="' + g + '" aria-pressed="' + (DashSkin.glass() === g) + '">' + esc(DashSkin.glassNames[g]) + '</button>';
    }).join('') + '</div>';
    // Motion keeps all three: Auto follows Windows animation effects; On and Off override it
    var mo = DashSkin.motion();
    var motion = '<div class="dl-seg" role="group" aria-label="Motion">' + DashSkin.motionLevels.map(function (m) {
      return '<button type="button" data-k="motion" data-v="' + m + '" aria-pressed="' + (mo === m) + '">' + esc(DashSkin.motionNames[m]) + '</button>';
    }).join('') + '</div>';
    var motionSub = 'Counting numbers, growing charts and panel slides. '
      + (mo === 'auto' ? 'Auto follows Windows animation effects: ' + (DashSkin.systemReduced() ? 'off on this computer, so nothing moves. Pick On to see it.' : 'on.') : mo === 'on' ? 'On, whatever Windows says.' : 'Off everywhere.');
    // Data: the tool's own downloads (opts.downloads), then a CSV of every table showing on this view
    var dls = (opts.downloads || []).map(function (d, i) { return '<button type="button" class="dl-btn" data-dl="t' + i + '">' + I.down + esc(d.label) + '</button>'; })
      .concat(viewTables().map(function (t, i) { return '<button type="button" class="dl-btn" data-dl="v' + i + '" title="Download this table as CSV">' + I.down + esc(t.name) + ' CSV</button>'; }));
    var data = '<div class="dl-sec dl-data"><b>Data</b><span class="dl-sub">' + (dls.length ? 'Download what this page shows' : 'No tables on this view to download') + '</span>' + (dls.length ? '<div class="dl-btns">' + dls.join('') + '</div>' : '') + '</div>';
    var keys = [['Esc', 'Close a panel, menu or search'], ['Alt ←', 'Back'], ['Ctrl W', 'Close this window']].concat(opts.keys || []);
    var keyUi = keys.map(function (k) { return '<div class="dl-key"><span>' + k[0].split(' ').map(function (x) { return '<kbd>' + esc(x) + '</kbd>'; }).join('') + '</span>' + esc(k[1]) + '</div>'; }).join('');
    return '<div class="dl-head"><div><b>Display</b><span class="dl-sub">Saved in this browser' + (note ? ' · ' + esc(note) : '') + '</span></div><button type="button" class="dl-x" data-close aria-label="Close display settings">' + I.x + '</button></div>'
      + '<div><b>Skin</b><span class="dl-sub">The whole look: glass, colour and backdrop</span><div class="dl-skins">' + skins + '</div></div>'
      + '<div class="dl-cols"><div class="dl-sec">'
      + '<div class="dl-row"><div><b>Accent</b><span class="dl-sub">Buttons, highlights and the main chart line</span></div><div class="dl-sw">' + swatches + '</div></div>'
      + '<div><b>Backdrop photo</b><span class="dl-sub">Glass looks best over a photo. A room, a view, anything with light in it.</span>' + photoUi + '</div>'
      + '<div class="dl-row"><div><b>Glass</b><span class="dl-sub">How much the panels hide what is behind them</span></div>' + glass + '</div>'
      + '<div class="dl-row"><div><b>Reduce transparency</b><span class="dl-sub">Solid panels instead of glass. Easier to read on busy backdrops.</span></div>' + sw(DashSkin.solid()) + ' data-k="solid" aria-label="Reduce transparency"><span></span></button></div>'
      + '<div class="dl-row"><div><b>Motion</b><span class="dl-sub">' + esc(motionSub) + '</span></div>' + motion + '</div>'
      + '</div><div>' + data + '<div class="dl-sec dl-keys"><b>Keyboard</b>' + keyUi + '</div></div></div>';
  }
  // a heading's own words, without the counts, badges and buttons nested in it
  function headText(h) {
    var own = Array.prototype.filter.call(h.childNodes, function (n) { return n.nodeType === 3; }).map(function (n) { return n.textContent; }).join(' ').replace(/\s+/g, ' ').trim();
    return own || h.textContent.replace(/\s+/g, ' ').trim();
  }
  // the tables showing on this view, each named by its caption or the nearest heading above it
  function viewTables() {
    return Array.prototype.filter.call(document.querySelectorAll('table'), function (t) {
      return t.offsetParent !== null && t.rows.length > 1 && !(panel && panel.contains(t));
    }).slice(0, 8).map(function (t, i) {
      // the closest heading above the table: within the smallest section around it that has one
      var name = t.caption && t.caption.textContent.trim(), el = t.parentElement;
      while (!name && el && el !== document.body) {
        var hs = el.querySelectorAll('h1,h2,h3,h4,h5,h6');
        for (var j = hs.length - 1; j >= 0 && !name; j--) {
          if (!t.contains(hs[j]) && (hs[j].compareDocumentPosition(t) & 4)) name = headText(hs[j]);
        }
        el = el.parentElement;
      }
      return { table: t, name: (name || 'Table ' + (i + 1)).replace(/\s+/g, ' ').slice(0, 40) };
    });
  }
  function csvOf(t) {
    return Array.prototype.map.call(t.rows, function (row) {
      return Array.prototype.map.call(row.cells, function (c) { var v = c.innerText.replace(/\s+/g, ' ').trim(); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',');
    }).join('\r\n');
  }
  function save(name, text, type) {
    var a = document.createElement('a'), url = URL.createObjectURL(new Blob([text], { type: type || 'text/csv;charset=utf-8' }));
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function download(id) {
    if (id.charAt(0) === 't') { var d = (opts.downloads || [])[+id.slice(1)]; if (d && d.run) d.run(); note = d ? d.label + ' downloaded' : ''; }
    else {
      var t = viewTables()[+id.slice(1)]; if (!t) return;
      save(t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.csv', '\uFEFF' + csvOf(t.table));
      note = t.name + ' CSV downloaded';
    }
    if (note) hint(note);
    close(true);
  }
  function label() { var c = DashSkin.choice(); btn.innerHTML = I.layers + esc(c === 'auto' ? 'System' : DashSkin.names[c]) + I.chev; }
  function place() {
    var r = btn.getBoundingClientRect(), top = r.bottom + 8;
    panel.style.left = Math.max(8, Math.min(r.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8)) + 'px';
    panel.style.top = top + 'px';
    panel.style.maxHeight = Math.max(240, innerHeight - top - 12) + 'px';
  }
  function redraw() { var y = panel.scrollTop; panel.innerHTML = html(); panel.scrollTop = y; }
  function close(refocus) { if (!panel.hidden) { panel.hidden = true; note = ''; btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus(); } }
  function open() {
    panel.innerHTML = html(); panel.hidden = false; place();
    btn.setAttribute('aria-expanded', 'true');
    var first = panel.querySelector('.dl-card[aria-pressed="true"]') || panel.querySelector('.dl-card'); if (first) first.focus();
  }
  // a picked photo is scaled to 1920 px and kept as a JPEG in this browser
  function loadPhoto(f) {
    if (!f || !/^image\//.test(f.type)) { note = 'Pick an image file'; redraw(); return; }
    var url = URL.createObjectURL(f), img = new Image();
    img.onload = function () {
      var k = Math.min(1, 1920 / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      var kept = DashSkin.photo(c.toDataURL('image/jpeg', 0.82));
      hint(kept ? 'Photo set as the backdrop' : 'Photo set for this visit; too big to remember');
      close(true);
      if (opts.onChange) opts.onChange('photo', true);
    };
    img.onerror = function () { URL.revokeObjectURL(url); note = 'That image could not be read'; redraw(); };
    img.src = url;
  }
  function hint(text) {
    var h = document.createElement('div'); h.className = 'dl-hint'; h.setAttribute('role', 'status'); h.textContent = text;
    document.body.appendChild(h); setTimeout(function () { h.remove(); }, 2600);
  }
  function navButton(kind) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'dl-look-btn dl-nav dl-' + kind;
    if (kind === 'back') {
      b.innerHTML = I.back + '<span>Back</span>'; b.title = 'Back (Alt+Left)';
      var state = function () { b.disabled = history.length <= 1; };
      state(); window.addEventListener('popstate', state); window.addEventListener('hashchange', state);
      b.addEventListener('click', function () { if (history.length > 1) history.back(); });
    } else {
      b.innerHTML = I.x; b.title = 'Close this window (Ctrl+W)'; b.setAttribute('aria-label', 'Close this window');
      // a page may only close a window it opened, or one with no history; otherwise say how
      b.addEventListener('click', function () { window.close(); setTimeout(function () { if (!window.closed) hint('Press Ctrl+W to close this window'); }, 200); });
    }
    return b;
  }
  window.DashLook = {
    mount: function (container, o) {
      opts = o || {};
      btn = document.createElement('button'); btn.type = 'button'; btn.className = 'dl-look-btn'; btn.title = 'Display settings: skin, accent, glass, motion';
      btn.setAttribute('aria-haspopup', 'dialog'); btn.setAttribute('aria-expanded', 'false');
      panel = document.createElement('div'); panel.className = 'dl-look'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Display settings'); panel.hidden = true;
      // Back and Close: dashboards open in Chrome --app windows, which have no browser back button
      if (opts.nav !== false) container.appendChild(navButton('back'));
      container.appendChild(btn); document.body.appendChild(panel); label();
      if (opts.nav !== false) container.appendChild(navButton('close'));
      btn.addEventListener('click', function () { panel.hidden ? open() : close(); });
      panel.addEventListener('change', function (e) { if (e.target.matches('[data-photo]')) loadPhoto(e.target.files[0]); });
      panel.addEventListener('click', function (e) {
        e.stopPropagation();   // the panel redraws under the click; keep the outside-click check from closing it
        if (e.target.closest('[data-close]')) { close(true); return; }
        var dl = e.target.closest('[data-dl]'); if (dl) { download(dl.dataset.dl); return; }
        var b = e.target.closest('button[data-k]'); if (!b) return;
        var k = b.dataset.k, v = b.dataset.v;
        note = '';
        DashSkin.swap(function () {
          if (k === 'skin') DashSkin.set(v);
          else if (k === 'accent') DashSkin.accent(v);
          else if (k === 'glass') DashSkin.glass(v);
          else if (k === 'solid') DashSkin.solid(!DashSkin.solid());
          else if (k === 'motion') DashSkin.motion(v);
          else if (k === 'photo') { if (v === 'remove') DashSkin.photo(null); else DashSkin.photoOn(v === 'on'); }
          label(); close(true);
          if (opts.onChange) opts.onChange(k, k === 'skin' ? DashSkin.get() : v);
        });
      });
      // Match system: when the computer switches light and dark, the page follows; let the tool redraw
      document.addEventListener('dashskin', function () { if (btn) label(); if (opts.onChange && DashSkin.choice() === 'auto') opts.onChange('skin', DashSkin.get()); });
      document.addEventListener('pointerdown', function (e) { if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) close(); }, true);
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) close(true); });
      window.addEventListener('resize', function () { if (!panel.hidden) place(); });
    },
  };
})();
