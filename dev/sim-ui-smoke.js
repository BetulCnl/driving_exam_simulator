/* Headless smoke test of the UI glue (main/controls/lessons/audio) with a tiny fake DOM
 * and a stub PS.world. Catches runtime errors without a browser.
 * Usage: node dev/sim-ui-smoke.js
 */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var ROOT = path.join(__dirname, '..');

function ClassList() { this.s = new Set(); }
ClassList.prototype.add = function () { for (var i = 0; i < arguments.length; i++) this.s.add(arguments[i]); };
ClassList.prototype.remove = function () { for (var i = 0; i < arguments.length; i++) this.s.delete(arguments[i]); };
ClassList.prototype.toggle = function (c, f) { var on = f === undefined ? !this.s.has(c) : !!f; if (on) this.s.add(c); else this.s.delete(c); return on; };
ClassList.prototype.contains = function (c) { return this.s.has(c); };

function El(id, attrs) {
  this.id = id || ''; this.style = {}; this.classList = new ClassList(); this.listeners = {};
  this.innerHTML = ''; this.textContent = ''; this.attrs = attrs || {}; this.offsetTop = 0; this.offsetWidth = 100;
  this.tagName = 'DIV';
  var cn = '';
  Object.defineProperty(this, 'className', { get: function () { return cn; }, set: function (v) { cn = v; } });
}
El.prototype.addEventListener = function (t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); };
El.prototype.fire = function (t, ev) { var self = this; ev = ev || {}; ev.preventDefault = ev.preventDefault || function () {}; ev.target = ev.target || self; (this.listeners[t] || []).forEach(function (f) { f.call(self, ev); }); };
El.prototype.getAttribute = function (k) { return this.attrs[k] === undefined ? null : this.attrs[k]; };
El.prototype.setAttribute = function (k, v) { this.attrs[k] = v; };
El.prototype.closest = function () { return null; };
El.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, right: 348, bottom: 44, width: 340, height: 40 }; };
El.prototype.setPointerCapture = function () {};
El.prototype.blur = function () {};

var els = {};
function byId(id) { return els[id] || (els[id] = new El(id)); }
var slots = ['P', 'R', 'N', 'D'].map(function (g, i) { var e = new El('slot' + g, { 'data-g': g }); e.offsetTop = i * 41; return e; });
var modeBtns = ['learn', 'exam'].map(function (m) { return new El('mode' + m, { 'data-mode': m }); });
var scnBtns = ['parallel', 'perpendicular'].map(function (m) { return new El('scn' + m, { 'data-scn': m }); });
var radios = { scn: 'parallel', mode: 'learn' };
byId('gearGate').querySelectorAll = function () { return slots; };
byId('gearGate').querySelector = function (sel) { var g = /data-g="(\w)"/.exec(sel); return g ? slots['PRND'.indexOf(g[1])] : null; };

var winListeners = {}, docListeners = {};
var document = {
  readyState: 'complete', hidden: false,
  getElementById: byId,
  querySelectorAll: function (sel) { if (sel.indexOf('modeSeg') >= 0) return modeBtns; if (sel.indexOf('scnSeg') >= 0) return scnBtns; return []; },
  querySelector: function (sel) { var m = /name="(\w+)"/.exec(sel); return m ? { value: radios[m[1]] } : null; },
  addEventListener: function (t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
  documentElement: byId('html')
};
var rafQ = [];
var calls = {};
var worldStub = {};
['init', 'loadScenario', 'resize', 'render', 'setConeHit', 'highlightCones', 'setGuide', 'setPathPreview', 'setTopInsets'].forEach(function (n) {
  worldStub[n] = function () { calls[n] = (calls[n] || 0) + 1; calls['last_' + n] = Array.prototype.slice.call(arguments); };
});
worldStub.isConeVisibleInMirror = function () { return true; };

var win = {
  innerWidth: 1280, innerHeight: 720,
  addEventListener: function (t, f) { (winListeners[t] = winListeners[t] || []).push(f); },
  requestAnimationFrame: function (f) { rafQ.push(f); },
  THREE: {}, console: console
};
win.window = win;
var ctx = { window: win, document: document, console: console, Math: Math, setTimeout: function () { return 0; }, clearTimeout: function () {} };
vm.createContext(ctx);
function load(f) { vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }); }
load('js/config.js');
win.PS.world = worldStub;
['js/audio.js', 'js/physics.js', 'js/controls.js', 'js/lessons.js', 'js/main.js'].forEach(load);
var PS = win.PS;

function key(code, down) { (winListeners[down ? 'keydown' : 'keyup'] || []).forEach(function (f) { f({ code: code, preventDefault: function () {}, target: {} }); }); }
var T = 0;
function frames(sec, fps) { fps = fps || 60; var n = Math.round(sec * fps); for (var i = 0; i < n; i++) { T += 1000 / fps; var q = rafQ; rafQ = []; q.forEach(function (f) { f(T); }); } }
function stepTxt() { var m = /Adım (\d+) \/ (\d+)/.exec(byId('panelBody').innerHTML); return m ? m[1] + '/' + m[2] : '?'; }
var fails = 0;
function assert(c, msg) { console.log((c ? 'OK   ' : 'FAIL ') + msg); if (!c) fails++; }

frames(0.2);
assert(calls.init === 1 && calls.loadScenario >= 1, 'world.init + loadScenario called');
byId('btnStart').fire('click');
frames(0.2);
assert(stepTxt() === '1/10', 'learn mode starts at step 1/10 (got ' + stepTxt() + ')');

// ---------------- hold-to-look ----------------
(function lookTests() {
  var C = PS.controls, scene = byId('scene'), DEGR = 180 / Math.PI;
  function hd() { return { y: C.head.yaw * DEGR, p: C.head.pitch * DEGR }; }
  function pe(t, x, y, extra) { var e = { pointerId: 1, button: 0, buttons: t === 'pointerup' ? 0 : 1, clientX: x, clientY: y }; for (var k in (extra || {})) e[k] = extra[k]; scene.fire(t, e); }
  C.resetHead(); frames(0.1);
  // bare cursor movement (no button) anywhere: view must not move
  for (var x = 0; x <= 1280; x += 40) { pe('pointermove', x, 650, { buttons: 0 }); (winListeners.mousemove || []).forEach(function (f) { f({ clientX: x, clientY: 650, target: scene }); }); }
  frames(0.3);
  assert(hd().y === 0 && hd().p === 0, 'cursor moving without a button leaves the head straight');
  assert(scene.style.cursor === 'grab', 'cursor is grab over the driver view');
  pe('pointermove', 600, 200, { buttons: 0 });
  assert(scene.style.cursor === 'default', 'cursor is default over the bird\'s-eye view');
  // click without movement (< 4 px) does nothing
  pe('pointerdown', 640, 600); pe('pointermove', 642, 601); pe('pointerup', 642, 601); frames(0.3);
  assert(hd().y === 0 && hd().p === 0, 'press + 2 px jitter + release does not turn the head');
  // drag left 25 % of the width (= 0.25/0.45 * 120 deg = 66.7 deg) -> look left (+yaw)
  pe('pointerdown', 640, 600);
  for (var i = 1; i <= 8; i++) pe('pointermove', 640 - i * 40, 600);
  assert(byId('html').classList.contains('look-drag') && scene.style.cursor === 'grabbing', 'grabbing cursor while dragging');
  frames(0.15);
  var exp = 320 / (1280 * 0.45) * 120;
  assert(Math.abs(hd().y - exp) < 1.5, 'drag left 320 px -> yaw +' + exp.toFixed(1) + ' deg (got ' + hd().y.toFixed(1) + ')');
  // responsiveness: within 80 ms the head covers >= 85 % of a fresh step
  var y0 = hd().y; pe('pointermove', 280, 600); frames(0.08);
  var stepD = 40 / (1280 * 0.45) * 120;
  assert((hd().y - y0) / stepD > 0.85, 'head follows a drag step within 80 ms (' + Math.round((hd().y - y0) / stepD * 100) + ' %)');
  pe('pointerup', 280, 600); frames(0.8);
  var held = hd().y;
  assert(Math.abs(held - (exp + stepD)) < 0.5 && !byId('html').classList.contains('look-drag'), 'release keeps the pose (' + held.toFixed(1) + ' deg)');
  pe('pointermove', 1200, 700, { buttons: 0 }); frames(0.3);
  assert(hd().y === held, 'moving the cursor after release keeps the pose');
  // clamp at +120 deg, drag up = look up, clamp at +20 deg pitch
  pe('pointerdown', 1200, 700); pe('pointermove', 0, 380); pe('pointerup', 0, 380); frames(0.5);
  assert(Math.abs(hd().y - 120) < 0.2 && Math.abs(hd().p - 20) < 0.2, 'yaw clamps at +120, pitch at +20 (got ' + hd().y.toFixed(1) + ', ' + hd().p.toFixed(1) + ')');
  // drag right = look right (-yaw), relative from the current pose
  pe('pointerdown', 100, 400); pe('pointermove', 1270, 720); frames(0.5);
  assert(Math.abs(hd().y + 120) < 0.2 && hd().p < 0, 'drag right/down -> yaw clamps at -120, looks down (got ' + hd().y.toFixed(1) + ', ' + hd().p.toFixed(1) + ')');
  scene.fire('pointercancel', { pointerId: 1, clientX: 1270, clientY: 720 }); frames(0.1);
  // double-click recentres smoothly (~0.25 s)
  scene.fire('dblclick', { clientX: 640, clientY: 600 }); frames(0.1);
  var mid = hd().y;
  frames(0.2);
  assert(mid < -20 && Math.abs(hd().y) < 7 && Math.abs(hd().p) < 2, 'double-click recentres smoothly (' + mid.toFixed(0) + ' -> ' + hd().y.toFixed(1) + ')');
  frames(0.5);
  assert(hd().y === 0 && hd().p === 0, 'recentre settles at exactly 0');
  // Space recentres
  pe('pointerdown', 640, 600); pe('pointermove', 400, 600); pe('pointerup', 400, 600); frames(0.3);
  assert(hd().y > 30, 'look left again');
  key('Space', true); key('Space', false); frames(0.6);
  assert(hd().y === 0, 'Space recentres');
  // "Öne bak" button
  pe('pointerdown', 640, 600); pe('pointermove', 900, 600); pe('pointerup', 900, 600); frames(0.3);
  byId('btnLook').fire('click'); frames(0.6);
  assert(hd().y === 0, '"Öne bak" button recentres');
  // top half drag does nothing
  pe('pointerdown', 640, 200); pe('pointermove', 100, 100); pe('pointerup', 100, 100); frames(0.3);
  assert(hd().y === 0 && hd().p === 0, 'drag in the bird\'s-eye half does nothing');
  // right button also looks; window blur ends the drag
  pe('pointerdown', 640, 600, { button: 2, buttons: 2 }); pe('pointermove', 500, 600, { buttons: 2 });
  (winListeners.blur || []).forEach(function (f) { f({}); });
  pe('pointermove', 100, 600, { buttons: 0 }); frames(0.3);
  assert(hd().y > 20 && hd().y < 35, 'right-button drag looks, window blur ends it (' + hd().y.toFixed(1) + ')');
  C.resetHead();
  // a drag starting on the gear knob does not rotate (scene never sees the pointerdown)
  byId('gearKnob').fire('pointerdown', { pointerId: 2, button: 0, clientX: 1200, clientY: 600 });
  pe('pointermove', 800, 650, { pointerId: 2 });
  byId('gearKnob').fire('pointermove', { pointerId: 2, clientX: 800, clientY: 602 });
  byId('gearKnob').fire('pointerup', { pointerId: 2, clientX: 800, clientY: 602 });
  frames(0.3);
  assert(hd().y === 0 && hd().p === 0 && !C.isBusy(), 'drag starting on the gear widget does not turn the head');
  // pedal bars
  assert(typeof C.setPedalUI === 'function', 'setPedalUI exists');
  C.setPedalUI({ gas: 0.333, brake: 1 });
  assert(byId('pedGasFill').style.width === '34%' && byId('pedBrakeFill').style.width === '100%', 'setPedalUI draws fill bars (' + byId('pedGasFill').style.width + ', ' + byId('pedBrakeFill').style.width + ')');
  byId('pedGasFill').style.width = 'x'; C.setPedalUI({ gas: 0.335, brake: 1 });
  assert(byId('pedGasFill').style.width === 'x', 'setPedalUI skips the DOM when the rounded value is unchanged');
  C.setPedalUI({ gas: 0, brake: 0 }); C.setPedalUI(null); C.setPedalUI({});
  assert(byId('pedGasFill').style.width === '0%', 'setPedalUI tolerates empty input');
})();

// shift without brake -> refused
slots[3].fire('pointerdown');
assert(PS.controls && byId('gearBig').textContent === 'P', 'shift P->D without brake refused');
key('KeyQ', true); frames(0.1);
slots[3].fire('pointerdown'); frames(0.1);
assert(byId('gearBig').textContent === 'D', 'shift P->D with brake works');
// stalk: click ▲ = right, click again = off, drag down = left, click middle = off, then ▲ again for the lesson
byId('stalkHitUp').fire('pointerdown'); frames(0.05);
assert(PS.debug.sim.signal === 'right' && byId('stalkHitUp').classList.contains('on'), 'stalk ▲ click -> right signal');
byId('stalkHitUp').fire('pointerdown'); frames(0.05);
assert(PS.debug.sim.signal === 'off', 'stalk ▲ click again -> off');
byId('stalkArea').fire('pointerdown', { pointerId: 3, button: 0, clientX: 60, clientY: 640 });
byId('stalkArea').fire('pointermove', { pointerId: 3, clientX: 60, clientY: 680 });
byId('stalkArea').fire('pointerup', { pointerId: 3, clientX: 60, clientY: 680 }); frames(0.05);
assert(PS.debug.sim.signal === 'left', 'stalk drag down -> left signal');
byId('stalkArea').fire('pointerdown', { pointerId: 3, button: 0, clientX: 60, clientY: 640 });
byId('stalkArea').fire('pointerup', { pointerId: 3, clientX: 60, clientY: 640 }); frames(0.05);
assert(PS.debug.sim.signal === 'off', 'stalk middle click -> off');
byId('stalkArea').fire('pointerdown', { pointerId: 3, button: 0, clientX: 60, clientY: 640 });
byId('stalkArea').fire('pointermove', { pointerId: 3, clientX: 60, clientY: 600 });
byId('stalkArea').fire('pointerup', { pointerId: 3, clientX: 60, clientY: 600 }); frames(0.05);
assert(PS.debug.sim.signal === 'right' && PS.controls.head.yaw === 0, 'stalk drag up -> right signal, head unchanged');
frames(0.3);
assert(stepTxt() === '2/10', 'step 1 (prep) completes after D + right signal (got ' + stepTxt() + ')');
key('KeyQ', false);
// drive forward until the panel says DUR
var stopped = false;
for (var i = 0; i < 60 * 30 && !stopped; i++) {
  frames(1 / 60);
  if (/DUR!/.test(byId('lsStatus').innerHTML)) { key('KeyQ', true); stopped = true; assert(/ŞİMDİ DUR/.test(byId('cue').innerHTML) && /stop/.test(byId('cue').className), 'cue bar shows ŞİMDİ DUR (green) when the zone is entered'); }
}
frames(1.0);
assert(stopped && stepTxt() === '3/10', 'step 2 (pass) completes after DUR + brake (got ' + stepTxt() + ')');
slots[1].fire('pointerdown'); frames(0.1);
key('KeyD', true); frames(1.6); key('KeyD', false); frames(0.2);
assert(byId('steerTxt').textContent === '1,5 tur SAĞ', 'HUD shows 1,5 tur SAĞ (got ' + byId('steerTxt').textContent + ')');
assert(stepTxt() === '4/10', 'step 3 (R + full right) completes (got ' + stepTxt() + ')');
assert(calls.render > 100, 'world.render called every frame (' + calls.render + ')');
var st = calls.last_render[0];
assert(st && st.car && typeof st.car.steerAngle === 'number' && st.head && typeof st.blinkOn === 'boolean', 'state object shape ok');
// exam mode, knock a cone
modeBtns[1].fire('click'); frames(0.2);
assert(/Sınav/.test(byId('panelBody').innerHTML), 'exam panel shown');
assert(calls.last_setPathPreview[0] === false && calls.last_setGuide[0] === null, 'exam disables guide + path preview');
key('KeyQ', true); frames(0.1); slots[3].fire('pointerdown'); frames(0.1); key('KeyQ', false);
key('KeyD', true); frames(0.5); key('KeyD', false);
key('KeyW', true);
for (var j = 0; j < 60 * 40 && byId('resultCard').classList.contains('hidden'); j++) frames(1 / 60);
key('KeyW', false);
assert(!byId('resultCard').classList.contains('hidden'), 'exam ends with result card on a fault');
console.log('  result: ' + byId('resultHead').innerHTML.replace(/<[^>]+>/g, ' '));
byId('btnToLearn').fire('click'); frames(0.2);
assert(stepTxt() === '1/10', 'back to learn mode');
setScn: {
  scnBtns[1].fire('click'); frames(0.2);
  assert(stepTxt() === '1/7', 'perpendicular lesson has 7 steps (got ' + stepTxt() + ')');
}
// gear selector re-sync after reset while in R
key('KeyQ', true); frames(0.1); slots[3].fire('pointerdown'); frames(0.05); slots[1].fire('pointerdown'); frames(0.05); key('KeyQ', false);
assert(byId('gearBig').textContent === 'R', 'in R before reset');
key('KeyR', true); key('KeyR', false); frames(0.02);
assert(slots[0].classList.contains('on') && !slots[1].classList.contains('on') && byId('gearKnob').style.top === '0px', 'reset re-syncs gear selector to P immediately');
frames(0.1);
// low-fps real-time: 5 fps for 4 s of wall time must advance ~4 s of sim time
var t0 = PS.debug.sim.time; frames(4, 5);
assert(Math.abs((PS.debug.sim.time - t0) - 4) < 0.1, 'physics runs in real time at 5 fps (advanced ' + (PS.debug.sim.time - t0).toFixed(2) + ' s in 4 s)');
// debug hook
assert(PS.debug && typeof PS.debug.getState === 'function' && typeof PS.debug.setPose === 'function' && PS.debug.setTimeScale(2) === 2, 'PS.debug hook present');
PS.debug.setTimeScale(1);
// heading error is not folded
var H = PS.physics.headingErrorRad;
assert(Math.abs(Math.abs(H({ heading: Math.PI / 2 + Math.PI / 3 }, { heading: Math.PI }) * 180 / Math.PI) - 30) < 1e-6, 'reverse bay: 60° off approach = 30° error');
assert(Math.abs(Math.abs(H({ heading: Math.PI / 2 }, { heading: Math.PI }) * 180 / Math.PI) - 90) < 1e-6, 'reverse bay: 90° off = 90° (not folded)');
assert(Math.abs(Math.abs(H({ heading: -Math.PI / 2 }, { heading: Math.PI / 2 }) * 180 / Math.PI) - 180) < 1e-6, 'parallel: facing the wrong way = 180°');
assert(stepTxt() === '1/7', 'R resets');
console.log(fails ? fails + ' FAILURES' : 'UI SMOKE TEST PASSED');
process.exitCode = fails ? 1 : 0;
