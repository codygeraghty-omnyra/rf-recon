// Dashboard skins. Load in <head> so the skin is set before first paint.
// Match system is the default (Cody, 10/28): the last light skin picked (Daylight unless another was) by day, the
// last dark skin (Smoke unless another was) at night. A skin picked in the Display settings is saved per browser and
// wins. DashSkin.set('haze') / .get().
// Colour skins (Cody, 11/2) sit on a base skin: data-skin holds the base (Smoke for dark ones, Daylight for light
// ones) and data-tint the colour skin, so DashSkin.get() and a tool's own data-skin checks still see 'day' or not.
// DashSkin.shown() is the skin showing, colour skins included.
// Also kept here: the accent colour, texture, light and shadow, glass density, reduce transparency, motion and a
// backdrop photo. look.js is the settings panel for all of them.
(function () {
  var KEY = 'dash.skin', DARK_KEY = 'dash.skin.dark', LIGHT_KEY = 'dash.skin.light', PICKED = 'dash.skin.picked';
  var SKINS = ['smoke', 'haze', 'dusk', 'liquid', 'ember', 'moss', 'tide', 'midnight', 'rose', 'graphite', 'day', 'sand', 'mint', 'lilac'];
  var BASE = { ember: 'smoke', moss: 'smoke', tide: 'smoke', midnight: 'smoke', rose: 'smoke', graphite: 'smoke', sand: 'day', mint: 'day', lilac: 'day' };
  var NAMES = { smoke: 'Smoke', haze: 'Haze', dusk: 'Dusk', liquid: 'Liquid', ember: 'Ember', moss: 'Moss', tide: 'Tide', midnight: 'Midnight',
    rose: 'Rosé', graphite: 'Graphite', day: 'Daylight', sand: 'Sand', mint: 'Mint', lilac: 'Lilac', auto: 'Match system' };
  var ACCENT = { smoke: '#f0a07a', haze: '#ece6dc', dusk: '#c4ef4f', liquid: '#3d8bfd', day: '#2a78d6', ember: '#ff8a57', moss: '#a6db8f',
    tide: '#52dcd5', midnight: '#f2c14e', rose: '#f5a0b9', graphite: '#9cc4ff', sand: '#b5562e', mint: '#0f8a62', lilac: '#6a4fd6' };
  function base(s) { return BASE[s] || s; }
  function isLight(s) { return base(s) === 'day'; }
  // accent choices: a dark-skin pair and a Daylight pair each (accent, second accent); 'skin' keeps the skin's own
  var ACCENTS = [
    { id: 'peach', name: 'Peach', l: ['#c4562b', '#a8432a'], d: ['#f0a07a', '#e2795a'] },
    { id: 'lime', name: 'Lime', l: ['#4d7a0f', '#2f7a3a'], d: ['#c4ef4f', '#7fd17a'] },
    { id: 'blue', name: 'Blue', l: ['#2a78d6', '#6250d6'], d: ['#3d8bfd', '#8b7cf6'] },
    { id: 'violet', name: 'Violet', l: ['#6250d6', '#b03a78'], d: ['#9085e9', '#d55181'] },
    { id: 'aqua', name: 'Aqua', l: ['#0f8a62', '#2a78d6'], d: ['#2fd0a0', '#3d8bfd'] },
    { id: 'magenta', name: 'Magenta', l: ['#c03b70', '#6250d6'], d: ['#f08ab3', '#9085e9'] },
    { id: 'gold', name: 'Gold', l: ['#9a6b00', '#c4562b'], d: ['#f2c14e', '#f0a07a'] },
    { id: 'coral', name: 'Coral', l: ['#c43c3c', '#c4562b'], d: ['#ff7b72', '#ffb347'] },
    { id: 'ember', name: 'Ember', l: ['#b84a12', '#9a6b00'], d: ['#ff8a57', '#ffb347'] },
    { id: 'sky', name: 'Sky', l: ['#0b6fa8', '#0f8a62'], d: ['#6cc7ff', '#52dcd5'] },
    { id: 'sage', name: 'Sage', l: ['#3f7a52', '#8a6a1f'], d: ['#a6db8f', '#e3c770'] },
    { id: 'rose', name: 'Rose', l: ['#b0346a', '#6a4fd6'], d: ['#f5a0b9', '#c9a0ff'] },
    { id: 'silver', name: 'Silver', l: ['#4b5563', '#2a78d6'], d: ['#d6dbe2', '#9cc4ff'] },
  ];
  var ACCENT_KEY = 'dash.accent', SOLID_KEY = 'dash.solid', PHOTO_KEY = 'dash.photo', PHOTO_ON_KEY = 'dash.photo.on';
  var r = document.documentElement, dq = matchMedia('(prefers-color-scheme: dark)');
  // the type most of the studied dashboards use (Urbanist): loads without blocking; the system font shows until it
  // arrives, and offline. Tools already name it first in --font.
  if (!document.querySelector('link[data-dash-font]')) {
    var fl = document.createElement('link'); fl.rel = 'stylesheet'; fl.setAttribute('data-dash-font', '');
    fl.href = 'https://fonts.googleapis.com/css2?family=Urbanist:wght@400;500;600;700;800&display=swap';
    document.head.appendChild(fl);
  }
  function onColor(hex) {
    var n = parseInt(hex.slice(1), 16), c = [n >> 16 & 255, n >> 8 & 255, n & 255].map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.3 ? '#14100c' : '#ffffff';
  }
  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* this visit only */ } }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function forget(k) { try { localStorage.removeItem(k); } catch (e) { /* nothing stored */ } }
  function lastDark() { var d = read(DARK_KEY); return d && SKINS.indexOf(d) >= 0 && !isLight(d) ? d : 'smoke'; }
  function lastLight() { var d = read(LIGHT_KEY); return d && SKINS.indexOf(d) >= 0 && isLight(d) ? d : 'day'; }
  function findAccent(id) { for (var i = 0; i < ACCENTS.length; i++) if (ACCENTS[i].id === id) return ACCENTS[i]; return null; }

  var cur, shown, choice, accent = findAccent(read(ACCENT_KEY)) ? read(ACCENT_KEY) : 'skin';
  function paintAccent() {
    var a = findAccent(accent);
    if (a) {
      var pair = cur === 'day' ? a.l : a.d;
      r.style.setProperty('--accent-o', pair[0]); r.style.setProperty('--accent-2-o', pair[1]); r.style.setProperty('--on-accent', onColor(pair[0]));
    } else {
      r.style.removeProperty('--accent-o'); r.style.removeProperty('--accent-2-o'); r.style.setProperty('--on-accent', onColor(ACCENT[shown]));
    }
  }
  // remember: only a skin someone picked is saved; loading a page saves nothing, so the default can change
  function apply(c, remember) {
    if (c !== 'auto' && SKINS.indexOf(c) < 0) c = 'auto';
    var s = c === 'auto' ? (dq.matches ? lastDark() : lastLight()) : c;
    r.dataset.skin = base(s);
    if (BASE[s]) r.dataset.tint = s; else delete r.dataset.tint;
    if (remember) { if (c !== 'auto') store(isLight(s) ? LIGHT_KEY : DARK_KEY, s); store(KEY, c); store(PICKED, '1'); }
    choice = c; cur = base(s); shown = s;
    paintAccent();
    document.dispatchEvent(new CustomEvent('dashskin', { detail: cur }));
    return cur;
  }
  apply(read(PICKED) === '1' ? read(KEY) : 'auto');
  // Match system follows the computer's light or dark setting as it changes
  var onScheme = function () { if (choice === 'auto') apply('auto'); };
  if (dq.addEventListener) dq.addEventListener('change', onScheme); else if (dq.addListener) dq.addListener(onScheme);

  // glass density: clear (default) to heavy, each step more opaque; reduce transparency (data-solid) is the solid end
  var GLASS = ['clear', 'frosted', 'dense', 'heavy'], GLASS_KEY = 'dash.glass';
  var GLASS_NAMES = { clear: 'Clear', frosted: 'Frosted', dense: 'Dense', heavy: 'Heavy' };
  var glass;
  function applyGlass(g) {
    if (GLASS.indexOf(g) < 0) g = 'clear';
    if (g === 'clear') delete r.dataset.glass; else r.dataset.glass = g;
    store(GLASS_KEY, g);
    glass = g;
    return g;
  }
  applyGlass(read(GLASS_KEY) || 'clear');
  var solid;
  function applySolid(on) { solid = !!on; if (solid) r.setAttribute('data-solid', ''); else r.removeAttribute('data-solid'); store(SOLID_KEY, solid ? '1' : '0'); return solid; }
  applySolid(read(SOLID_KEY) === '1');
  // motion: auto follows the system's reduce-motion setting (Windows "Animation effects"); on and off override it
  var MOTION = ['auto', 'on', 'off'], MOTION_KEY = 'dash.motion';
  var MOTION_NAMES = { auto: 'Auto', on: 'On', off: 'Off' };
  var motion;
  function applyMotion(m) {
    if (MOTION.indexOf(m) < 0) m = 'auto';
    if (m === 'auto') delete r.dataset.motion; else r.dataset.motion = m;
    store(MOTION_KEY, m);
    motion = m;
    return m;
  }
  applyMotion(read(MOTION_KEY) || 'auto');
  // texture and light and shadow (Cody, 11/2): grain and bevel are the look as it was, so they set no attribute
  var TEXTURES = ['smooth', 'grain', 'film', 'frost', 'linen', 'brushed', 'dots'], TEXTURE_KEY = 'dash.texture';
  var TEXTURE_NAMES = { smooth: 'Smooth', grain: 'Grain', film: 'Film', frost: 'Frost', linen: 'Linen', brushed: 'Brushed', dots: 'Dots' };
  var LIGHTS = ['bevel', 'soft', 'flat', 'float', 'glow'], LIGHT_STYLE_KEY = 'dash.light';
  var LIGHT_NAMES = { bevel: 'Bevel', soft: 'Soft', flat: 'Flat', float: 'Float', glow: 'Glow' };
  var texture, light;
  function applyTexture(t) {
    if (TEXTURES.indexOf(t) < 0) t = 'grain';
    if (t === 'grain') delete r.dataset.texture; else r.dataset.texture = t;
    store(TEXTURE_KEY, t); texture = t; return t;
  }
  function applyLight(l) {
    if (LIGHTS.indexOf(l) < 0) l = 'bevel';
    if (l === 'bevel') delete r.dataset.light; else r.dataset.light = l;
    store(LIGHT_STYLE_KEY, l); light = l; return l;
  }
  applyTexture(read(TEXTURE_KEY) || 'grain');
  applyLight(read(LIGHT_STYLE_KEY) || 'bevel');
  function reduced() { return matchMedia('(prefers-reduced-motion: reduce)').matches; }

  // backdrop photo: a data URL kept in this browser; the backdrop shows it blurred instead of its scene
  var photo = read(PHOTO_KEY), photoOn = !!photo && read(PHOTO_ON_KEY) !== '0';
  function paintPhoto() {
    var b = document.getElementById('backdrop'); if (!b) return;
    var p = b.querySelector('.photo'), use = photoOn && photo;
    if (p) p.style.backgroundImage = use ? 'url("' + photo + '")' : '';
    b.classList.toggle('has-photo', !!use);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paintPhoto); else paintPhoto();

  window.DashSkin = {
    motionLevels: MOTION.slice(), motionNames: MOTION_NAMES,
    motion: function (m) { return m === undefined ? motion : applyMotion(m); },
    nextMotion: function () { return applyMotion(MOTION[(MOTION.indexOf(motion) + 1) % MOTION.length]); },
    systemReduced: reduced,
    moving: function () { return motion === 'on' || (motion === 'auto' && !reduced()); },
    // run a theme, skin or glass change as a short cross-fade when motion is allowed (the studied dashboards never snap)
    swap: function (fn) {
      var still = motion === 'off' || (motion !== 'on' && reduced());
      if (!still && document.startViewTransition) return document.startViewTransition(fn);
      fn();
    },
    list: SKINS.slice(), names: NAMES,
    get: function () { return cur; },            // the base skin showing now (one of the five; 'day' means a light skin)
    shown: function () { return shown; },       // the skin showing now, colour skins included
    choice: function () { return choice; },     // what was picked: a skin, or 'auto'
    set: function (c) { return apply(c, true); },
    base: base, isLight: isLight,
    lastDark: lastDark, lastLight: lastLight,
    nextDark: function () { var dark = SKINS.filter(function (s) { return !isLight(s); }); return apply(dark[(dark.indexOf(shown) + 1) % dark.length], true); },
    textures: TEXTURES.slice(), textureNames: TEXTURE_NAMES,
    texture: function (t) { return t === undefined ? texture : applyTexture(t); },
    lights: LIGHTS.slice(), lightNames: LIGHT_NAMES,
    light: function (l) { return l === undefined ? light : applyLight(l); },
    glassLevels: GLASS.slice(), glassNames: GLASS_NAMES,
    glass: function (g) { return g === undefined ? glass : applyGlass(g); },
    nextGlass: function () { return applyGlass(GLASS[(GLASS.indexOf(glass) + 1) % GLASS.length]); },
    accents: ACCENTS.slice(),
    accent: function (id) { if (id === undefined) return accent; accent = findAccent(id) ? id : 'skin'; store(ACCENT_KEY, accent); paintAccent(); return accent; },
    solid: function (on) { return on === undefined ? solid : applySolid(on); },
    photo: function (url) {                      // no argument: the stored photo; null: remove it; a data URL: use it
      if (url === undefined) return photo;
      var kept = true;
      if (url === null) { photo = null; photoOn = false; forget(PHOTO_KEY); store(PHOTO_ON_KEY, '0'); }
      else { photo = url; photoOn = true; try { localStorage.setItem(PHOTO_KEY, url); } catch (e) { kept = false; } store(PHOTO_ON_KEY, '1'); }
      paintPhoto();
      return kept;
    },
    photoOn: function (on) { if (on === undefined) return photoOn && !!photo; photoOn = !!on && !!photo; store(PHOTO_ON_KEY, photoOn ? '1' : '0'); paintPhoto(); return photoOn; },
  };
})();
