// Dashboard skins. Load in <head> so the skin is set before first paint.
// Smoke is the default; the choice is saved per browser. window.DashSkin.set('haze') / .next() / .get().
(function () {
  var KEY = 'dash.skin', DARK_KEY = 'dash.skin.dark';
  var SKINS = ['smoke', 'haze', 'dusk', 'liquid', 'day'];
  var NAMES = { smoke: 'Smoke', haze: 'Haze', dusk: 'Dusk', liquid: 'Liquid', day: 'Daylight' };
  var ACCENT = { smoke: '#f0a07a', haze: '#ece6dc', dusk: '#c4ef4f', liquid: '#3d8bfd', day: '#2a78d6' };
  function onColor(hex) {
    var n = parseInt(hex.slice(1), 16), c = [n >> 16 & 255, n >> 8 & 255, n & 255].map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.3 ? '#14100c' : '#ffffff';
  }
  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* this visit only */ } }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  var cur;
  function apply(s) {
    if (SKINS.indexOf(s) < 0) s = 'smoke';
    var r = document.documentElement;
    r.dataset.skin = s;
    r.style.setProperty('--on-accent', onColor(ACCENT[s]));
    if (s !== 'day') store(DARK_KEY, s);
    store(KEY, s);
    cur = s;
    document.dispatchEvent(new CustomEvent('dashskin', { detail: s }));
    return s;
  }
  apply(read(KEY) || 'smoke');
  // glass density: clear (default) to heavy, each step more opaque; reduce-transparency (data-solid) is the solid end
  var GLASS = ['clear', 'frosted', 'dense', 'heavy'], GLASS_KEY = 'dash.glass';
  var GLASS_NAMES = { clear: 'Clear', frosted: 'Frosted', dense: 'Dense', heavy: 'Heavy' };
  var glass;
  function applyGlass(g) {
    if (GLASS.indexOf(g) < 0) g = 'clear';
    if (g === 'clear') delete document.documentElement.dataset.glass; else document.documentElement.dataset.glass = g;
    store(GLASS_KEY, g);
    glass = g;
    return g;
  }
  applyGlass(read(GLASS_KEY) || 'clear');
  window.DashSkin = {
    list: SKINS.slice(), names: NAMES,
    get: function () { return cur; },
    set: apply,
    lastDark: function () { var d = read(DARK_KEY); return d && d !== 'day' ? d : 'smoke'; },
    nextDark: function () { var dark = SKINS.filter(function (s) { return s !== 'day'; }); return apply(dark[(dark.indexOf(cur) + 1) % dark.length]); },
    glassLevels: GLASS.slice(), glassNames: GLASS_NAMES,
    glass: function (g) { return g === undefined ? glass : applyGlass(g); },
    nextGlass: function () { return applyGlass(GLASS[(GLASS.indexOf(glass) + 1) % GLASS.length]); },
  };
})();
