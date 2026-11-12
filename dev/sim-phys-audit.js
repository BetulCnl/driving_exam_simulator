/* Headless physics audit: prints the measured behaviour of the car and asserts it is realistic.
 * Usage: node dev/sim-phys-audit.js
 * Everything goes through the real input path: boolean keys -> sim.step (pedal travel inside physics),
 * with the frame clock PS.physics.frameDt that main.js uses.
 */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var ROOT = path.join(__dirname, '..');
var ctx = { window: {}, console: console, Math: Math };
ctx.window.window = ctx.window;
vm.createContext(ctx);
['js/config.js', 'js/physics.js'].forEach(function (f) { vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }); });
var PS = ctx.window.PS, P = PS.physics, cfg = PS.config, car = cfg.car, D = cfg.drive;
var DEG = 180 / Math.PI, KMH = 3.6, FPS = 60, DT = 1 / FPS;

var fails = 0;
function ok(cond, msg) { console.log((cond ? '  OK   ' : '  FAIL ') + msg); if (!cond) fails++; }
function f2(v) { return v.toFixed(2); }
function head(t) { console.log('\n== ' + t + ' =='); }

// open flat test ground (no kerbs, no cones, far bounds)
var FLAT = { id: 'flat', start: { x: 0, z: 0, heading: Math.PI / 2 }, cones: [], curbs: [], box: { corners: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }, { x: 0, z: 1 }], heading: Math.PI / 2 },
  road: { xMin: -500, xMax: 500, zMin: -500, zMax: 500 } };
function newSim(sc) { var s = P.create(cfg, sc || FLAT); return s; }
var K = function (o) { return { gas: !!(o && o.gas), brake: !!(o && o.brake), left: !!(o && o.left), right: !!(o && o.right) }; };
function shift(sim, g) { var r = sim.requestGear(g, true); if (!r.ok) throw new Error('shift to ' + g + ' refused: ' + r.reason); }
function run(sim, sec, keys, cb) { var n = Math.round(sec * FPS); for (var i = 0; i < n; i++) { sim.step(DT, typeof keys === 'function' ? keys(sim) : keys); if (cb && cb(sim) === true) return true; } return false; }

// ---------------------------------------------------------------- pedals
head('Pedal travel (keys are binary, pedals move)');
(function () {
  var s = newSim(); var t = [];
  var pAt = {};
  for (var i = 0; i < 240; i++) { s.step(1 / 240, K({ brake: true })); var tt = (i + 1) / 240; [0.15, 0.3, 0.5, 0.8].forEach(function (q) { if (Math.abs(tt - q) < 1e-6) pAt[q] = s.pedals.brake; }); }
  console.log('  brake pedal: 0,15 s -> ' + f2(pAt[0.15]) + ', 0,3 s -> ' + f2(pAt[0.3]) + ', 0,5 s -> ' + f2(pAt[0.5]) + ', 0,8 s -> ' + f2(pAt[0.8]));
  ok(Math.abs(pAt[0.15] - 0.25) < 0.02 && pAt[0.8] > 0.99, 'brake bite ≈0,25 after 0,15 s, full after 0,8 s');
  var rel = 0; while (s.pedals.brake > 0) { s.step(1 / 240, K()); rel += 1 / 240; }
  ok(rel <= 0.16, 'brake release from full in ' + f2(rel) + ' s');
  var g = 0; while (s.pedals.gas < 1) { s.step(1 / 240, K({ gas: true })); g += 1 / 240; }
  ok(Math.abs(g - 1) < 0.02, 'gas pedal 0 -> 1 in ' + f2(g) + ' s');
  console.log('  brake decel at pedal 0,1/0,25/0,5/0,75/1: ' + [0.1, 0.25, 0.5, 0.75, 1].map(function (p) { return f2(s.brakeDecel(p)); }).join(' / ') + ' m/s²');
})();

// ---------------------------------------------------------------- creep
head('Idle creep (no pedals, flat)');
var creep = {};
['D', 'R'].forEach(function (g) {
  var s = newSim(); shift(s, g);
  var t90 = null, tReach = null, vEnd, target = g === 'D' ? D.creepForward : D.creepReverse;
  run(s, 12, K(), function (q) { var v = Math.abs(q.state.speed); if (t90 === null && v >= 0.9 * target) t90 = q.time; if (tReach === null && v >= 0.97 * target) tReach = q.time; });
  vEnd = Math.abs(s.state.speed);
  creep[g] = vEnd;
  console.log('  ' + g + ': steady ' + f2(vEnd * KMH) + ' km/h, 90 % after ' + f2(t90) + ' s, 97 % after ' + f2(tReach) + ' s, direction ' + (s.state.speed > 0 ? 'forward' : 'reverse'));
  ok(vEnd * KMH > (g === 'D' ? 5.5 : 4.5) && vEnd * KMH < (g === 'D' ? 6.6 : 5.6), g + ' creep speed realistic');
  ok(t90 > 1.5 && t90 < 3.2, g + ' creep reached (90 %) in 1,5–3,2 s');
  ok(g === 'D' ? s.state.speed > 0 : s.state.speed < 0, g + ' moves the right way');
});

// ---------------------------------------------------------------- acceleration
head('Throttle');
(function () {
  var s = newSim(); shift(s, 'D'); var t30 = null, t10 = null;
  run(s, 12, K({ gas: true }), function (q) { var v = q.state.speed * KMH; if (t10 === null && v >= 10) t10 = q.time; if (t30 === null && v >= 30) { t30 = q.time; return true; } });
  console.log('  D full pedal from rest: 0–10 km/h ' + f2(t10) + ' s, 0–30 km/h ' + f2(t30) + ' s');
  ok(t30 >= 3.8 && t30 <= 5.2, '0–30 km/h in 4–5 s');
  var r = newSim(); shift(r, 'R'); run(r, 15, K({ gas: true }));
  console.log('  R full pedal top speed: ' + f2(-r.state.speed * KMH) + ' km/h');
  ok(-r.state.speed * KMH > 13 && -r.state.speed * KMH < 16, 'reverse capped ≈15 km/h');
  // coast-down in D from 30 km/h
  var c = newSim(); shift(c, 'D'); run(c, 12, K({ gas: true }), function (q) { return q.state.speed * KMH >= 30; });
  var v0 = c.state.speed; run(c, 1, K());
  console.log('  coasting in D at 30 km/h (off the gas): ' + f2(v0 - c.state.speed) + ' m/s² average over 1 s');
  ok(v0 - c.state.speed > 0.3 && v0 - c.state.speed < 0.9, 'engine braking + rolling resistance 0,3–0,9 m/s²');
  run(c, 40, K());
  console.log('  …and it settles at creep: ' + f2(c.state.speed * KMH) + ' km/h');
  ok(Math.abs(c.state.speed - D.creepForward) < 0.05, 'coasts down to creep, not to 0');
})();

// ---------------------------------------------------------------- braking
head('Braking (Q held from pedal = 0, pedal travel included)');
(function () {
  var s = newSim(); shift(s, 'D'); run(s, 12, K({ gas: true }), function (q) { return q.state.speed * KMH >= 30; });
  var x0 = s.state.x, t0 = s.time;
  run(s, 10, K({ brake: true }), function (q) { return q.state.speed === 0; });
  var d30 = s.state.x - x0, tt = s.time - t0;
  console.log('  from 30 km/h: ' + f2(d30) + ' m, ' + f2(tt) + ' s (reaction time not included)');
  ok(d30 > 4 && d30 < 8, 'stopping distance from 30 km/h 4–8 m (pedal travel 0,8 s included; reaction time not)');
  ['D', 'R'].forEach(function (g) {
    var c = newSim(); shift(c, g); run(c, 8, K());
    var p0 = { x: c.state.x }, t1 = c.time;
    run(c, 5, K({ brake: true }), function (q) { return q.state.speed === 0; });
    console.log('  from ' + g + ' creep (' + f2(creep[g] * KMH) + ' km/h): ' + f2(Math.abs(c.state.x - p0.x)) + ' m, ' + f2(c.time - t1) + ' s');
    ok(Math.abs(c.state.x - p0.x) < 0.8, g + ' creep stop distance < 0,8 m');
    var xs = c.state.x; var moved = false;
    run(c, 10, K({ brake: true }), function (q) { if (q.state.speed !== 0 || q.state.x !== xs) moved = true; });
    ok(!moved, g + ': brake held at standstill holds the car (no creep, no jitter) for 10 s');
  });
})();

// ---------------------------------------------------------------- feathering
head('Brake feathering: steady crawl with Q pulses (on/off seconds), after 8 s of settling');
var feather = [];
['D', 'R'].forEach(function (g) {
  [[0.10, 0.30], [0.20, 0.30], [0.30, 0.30], [0.35, 0.25], [0.40, 0.20], [0.50, 0.20], [0.60, 0.15]].forEach(function (pc) {
    var s = newSim(); shift(s, g);
    var per = pc[0] + pc[1], t = 0, sum = 0, n = 0, vmin = 99, vmax = 0;
    var x0 = 0;
    for (var i = 0; i < FPS * 20; i++) {
      var ph = (t % per) < pc[0];
      s.step(DT, K({ brake: ph })); t += DT;
      if (t > 8) { var v = Math.abs(s.state.speed) * KMH; sum += v; n++; vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); if (x0 === 0) x0 = s.distance; }
    }
    var avg = sum / n;
    feather.push({ g: g, on: pc[0], off: pc[1], avg: avg });
    console.log('  ' + g + ' ' + pc[0].toFixed(2) + ' on / ' + pc[1].toFixed(2) + ' off (duty ' + Math.round(pc[0] / per * 100) + ' %): avg ' + f2(avg) + ' km/h (min ' + f2(vmin) + ', max ' + f2(vmax) + ')');
  });
});
ok(feather.some(function (f) { return f.g === 'D' && f.avg > 0.8 && f.avg < 1.6; }) && feather.some(function (f) { return f.g === 'D' && f.avg > 2.2 && f.avg < 3.3; }),
  'D: pulsing Q can hold any crawl between ~1 and ~3 km/h');
ok(feather.some(function (f) { return f.g === 'R' && f.avg > 0.8 && f.avg < 1.6; }) && feather.some(function (f) { return f.g === 'R' && f.avg > 2.0 && f.avg < 3.3; }),
  'R: pulsing Q can hold any crawl between ~1 and ~3 km/h');
(function () {
  var mono = true;
  ['D', 'R'].forEach(function (g) { var a = feather.filter(function (f) { return f.g === g; }); for (var i = 1; i < a.length; i++) if (a[i].avg > a[i - 1].avg + 0.05) mono = false; });
  ok(mono, 'more brake duty = slower (monotonic)');
})();

// ---------------------------------------------------------------- steering geometry
head('Turning circle at full lock (measured by driving a full circle at creep)');
(function () {
  var s = newSim(); shift(s, 'D');
  run(s, 2, K({ right: true, brake: true }));
  ok(s.state.steer === 1, 'full right lock reached (1,5 turns) with Q held');
  var pts = { axle: [], outerWheel: [], body: [] };
  var tr = car.trackWidth / 2, tw = car.tyreWidth / 2;
  run(s, 40, K(), function (q) {
    var pose = q.pose();
    pts.axle.push({ x: pose.x, z: pose.z });
    var ak = P.ackermann(car, q.state.steerAngle);
    // outer (left) front tyre: outer sidewall edge, contact patch centre
    pts.outerWheel.push(P.toWorld(pose, tr + tw, car.wheelbase));
    P.carOutline(car, pose, 6).forEach(function (p) { pts.body.push(p); });
    return Math.abs(q.state.heading - Math.PI / 2) > 2 * Math.PI + 0.2;
  });
  function diam(a) { var mx = -1e9, mn = 1e9, mz = -1e9, nz = 1e9; a.forEach(function (p) { mx = Math.max(mx, p.x); mn = Math.min(mn, p.x); mz = Math.max(mz, p.z); nz = Math.min(nz, p.z); }); return ((mx - mn) + (mz - nz)) / 2; }
  var R = car.wheelbase / Math.tan(car.maxSteerDeg / DEG);
  var ak = P.ackermann(car, car.maxSteerDeg / DEG);
  var anaKerb = 2 * Math.sqrt(Math.pow(R + tr + tw, 2) + car.wheelbase * car.wheelbase);
  console.log('  rear-axle centre: ' + f2(diam(pts.axle)) + ' m (analytic 2·L/tan35° = ' + f2(2 * R) + ' m)');
  console.log('  outer front tyre (kerb-to-kerb): ' + f2(diam(pts.outerWheel)) + ' m (analytic ' + f2(anaKerb) + ' m; Clio IV 10,6 m, i20 10,2 m)');
  console.log('  outer body corner (wall-to-wall): ' + f2(diam(pts.body)) + ' m');
  console.log('  Ackermann wheel angles at lock: inner ' + f2(ak.right * DEG) + '°, outer ' + f2(ak.left * DEG) + '°');
  ok(Math.abs(diam(pts.axle) - 2 * R) < 0.08, 'rear-axle circle matches the bicycle model');
  ok(diam(pts.outerWheel) > 10.0 && diam(pts.outerWheel) < 10.9, 'kerb-to-kerb turning circle 10,0–10,9 m (B-segment)');
  ok(diam(pts.body) > 10.8 && diam(pts.body) < 11.8, 'wall-to-wall 10,8–11,8 m');
})();

head('Direction × steer: all four combinations turn like a real car (start facing +X, right = +Z)');
(function () {
  [['D', 'right'], ['D', 'left'], ['R', 'right'], ['R', 'left']].forEach(function (c) {
    var s = newSim(); shift(s, c[0]);
    var k = {}; k[c[1]] = true; k.brake = true;
    run(s, 2, K(k));
    var rear0 = P.toWorld(s.pose(), 0, -car.rearOverhang), front0 = P.toWorld(s.pose(), 0, car.wheelbase + car.frontOverhang);
    run(s, 2.5, K());
    var rear1 = P.toWorld(s.pose(), 0, -car.rearOverhang), front1 = P.toWorld(s.pose(), 0, car.wheelbase + car.frontOverhang);
    var lead = c[0] === 'D' ? { a: front0, b: front1 } : { a: rear0, b: rear1 };
    var dz = lead.b.z - lead.a.z, dx = lead.b.x - lead.a.x;
    var want = c[1] === 'right' ? 1 : -1;
    var txt = c[0] + ' + ' + c[1] + ': ' + (c[0] === 'D' ? 'nose' : 'rear') + ' moved dx=' + f2(dx) + ' dz=' + f2(dz) + ', heading ' + f2((s.state.heading - Math.PI / 2) * DEG) + '°';
    ok(Math.sign(dz) === want && (c[0] === 'D' ? dx > 0 : dx < 0), txt + ' -> ' + (c[0] === 'D' ? 'nose' : 'REAR') + ' goes ' + c[1].toUpperCase());
  });
})();

head('Steering hand speed and self-aligning');
(function () {
  var s = newSim(); shift(s, 'D'); var t = 0;
  while (s.state.steer < 1) { s.step(1 / 240, K({ right: true, brake: true })); t += 1 / 240; }
  console.log('  centre -> full lock: ' + f2(t) + ' s (' + Math.round(car.steeringWheelLockDeg / t) + '°/s at the wheel)');
  ok(t >= 1.3 && t <= 1.55, 'one full lock in 1,3–1,5 s');
  // at lock, creep 6 s: must stay at lock
  run(s, 6, K());
  ok(s.state.steer >= 0.995, 'released at full lock, creeping 6 s: wheel stays at lock (steer ' + s.state.steer.toFixed(3) + ')');
  // standstill: none
  var z = newSim(); shift(z, 'D'); run(z, 0.7, K({ right: true, brake: true })); var s0 = z.state.steer; run(z, 5, K({ brake: true }));
  ok(z.state.steer === s0, 'standstill: no self-aligning (steer stays ' + s0.toFixed(2) + ')');
  // half lock at 5, 15, 30 km/h (speed held artificially to measure the rate)
  [5, 10, 15, 30].forEach(function (kmh) {
    var q = newSim(); shift(q, 'D'); q.state.steer = 0.5; q.state.steerAngle = 0.5 * car.maxSteerDeg / DEG;
    var st0 = q.state.steer;
    for (var i = 0; i < 240; i++) { q.state.speed = kmh / KMH; q.substep(1 / 240, K()); }
    var rate = (st0 - q.state.steer) * car.steeringWheelLockDeg;
    console.log('  half lock (270°) released at ' + kmh + ' km/h: wheel returns ' + rate.toFixed(1) + '°/s');
    if (kmh === 5) ok(rate > 0.5 && rate < 6, '5 km/h: only a few °/s');
    if (kmh === 15) ok(rate > 20, '15 km/h: clearly stronger');
  });
  // a held key always wins
  var h = newSim(); shift(h, 'D'); h.state.speed = 8; h.state.steer = 0.5;
  for (var j = 0; j < 120; j++) { h.state.speed = 8; h.substep(1 / 240, K({ right: true })); }
  ok(h.state.steer > 0.5, 'self-aligning never fights a held key (steer ' + h.state.steer.toFixed(2) + ')');
})();

// ---------------------------------------------------------------- clock
head('Sim time vs wall time through PS.physics.frameDt (same as main.js)');
(function () {
  [10, 30, 60, 144, 'jitter 20-144'].forEach(function (fps) {
    var s = newSim(); shift(s, 'D');
    var wall = 0, frames = 0, seed = 7;
    function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    while (wall < 30 - 1e-9) {
      var raw = typeof fps === 'number' ? 1 / fps : 1 / (20 + rnd() * 124);
      if (wall + raw > 30) raw = 30 - wall;
      wall += raw; frames++;
      s.step(P.frameDt(raw, 1), K());
    }
    var err = s.time - wall;
    console.log('  ' + fps + ' fps: wall ' + wall.toFixed(3) + ' s, sim ' + s.time.toFixed(3) + ' s (error ' + (err * 1000).toFixed(1) + ' ms), frames ' + frames);
    ok(Math.abs(err) <= (D.substep + 1e-6), fps + ' fps: sim time = wall time (±1 sub-step)');
  });
  var s2 = newSim(); s2.step(P.frameDt(3.0, 1), K());
  ok(s2.time <= 0.26, 'a 3 s stall (tab hidden) is dropped, not replayed (advanced ' + s2.time.toFixed(3) + ' s) – no spiral of death');
})();

// ---------------------------------------------------------------- standstill
head('Standstill stability');
(function () {
  [['D', K({ brake: true })], ['R', K({ brake: true })], ['P', K()], ['N', K()], ['P', K({ gas: true })], ['N', K({ gas: true })]].forEach(function (c) {
    var s = newSim(); if (c[0] !== 'P') shift(s, c[0]);
    if (c[0] === 'D' || c[0] === 'R') run(s, 1, K({ brake: true }));
    var x0 = s.state.x, z0 = s.state.z, nz = 0;
    run(s, 10, c[1], function (q) { if (q.state.speed !== 0) nz++; });
    ok(s.state.x === x0 && s.state.z === z0 && nz === 0, c[0] + (c[1].brake ? ' + brake' : '') + (c[1].gas ? ' + gas (revving)' : '') + ': no drift, no jitter over 10 s');
  });
  // N rolls only with rolling resistance
  var n = newSim(); shift(n, 'D'); run(n, 6, K()); var v0 = n.state.speed; n.requestGear('N', false); var x0 = n.state.x;
  run(n, 30, K(), function (q) { return q.state.speed === 0; });
  console.log('  N from creep ' + f2(v0 * KMH) + ' km/h rolls ' + f2(n.state.x - x0) + ' m before stopping (rolling resistance only)');
  ok(Math.abs((n.state.x - x0) - v0 * v0 / (2 * D.rollResist)) < 0.3, 'N coast distance = v²/(2·a_roll)');
  // brake beats creep, then re-release
  var b = newSim(); shift(b, 'D'); run(b, 4, K()); var flips = 0, last = b.state.speed;
  run(b, 3, K({ brake: true }), function (q) { if (q.state.speed * last < 0) flips++; last = q.state.speed; });
  ok(b.state.speed === 0 && flips === 0, 'brake beats creep: stops without overshooting backwards');
  run(b, 0.5, K({ brake: true, gas: true }));
  ok(b.state.speed === 0, 'full brake also beats a 0,5 s blip of throttle');
})();

// ---------------------------------------------------------------- shift lock
head('Shift lock never traps the learner');
(function () {
  var G = ['P', 'R', 'N', 'D'], bad = [];
  G.forEach(function (a) { G.forEach(function (b) {
    var s = newSim(); if (a !== 'P') shift(s, a); var r = s.requestGear(b, true); if (!r.ok) bad.push(a + '->' + b);
  }); });
  ok(bad.length === 0, 'at standstill with the brake pressed every gear reaches every gear' + (bad.length ? ' (refused: ' + bad.join(',') + ')' : ''));
  var s = newSim(); ok(!s.requestGear('D', false).ok, 'P -> D without brake is refused (shift-lock solenoid)');
  var m = newSim(); shift(m, 'D'); run(m, 4, K());
  ok(!m.requestGear('R', true).ok && !m.requestGear('P', true).ok, 'R / P refused while rolling at creep');
  ok(m.requestGear('N', false).ok, 'D -> N is always allowed');
})();

// ---------------------------------------------------------------- kerb
head('Kerb contact (parallel scenario kerb at z = ' + cfg.scenarios.parallel.curbs[0].z1 + ')');
(function () {
  var sc = cfg.scenarios.parallel, kz = sc.curbs[0].z1;
  function kerbCase(label, feather) {
    var s = P.create(cfg, sc);
    // parallel to the kerb, rear swung 12° towards it, right tyres ~0,45 m away; reverse
    s.state.x = 3; s.state.z = kz - 0.85 - 0.45 - 0.5; s.state.heading = Math.PI / 2 + 12 / DEG;
    shift(s, 'R');
    var touched = null, t = 0;
    run(s, 15, function (q) { t += DT; return K({ brake: feather ? (t % 0.6) < 0.36 : false }); }, function (q) { if (q.curbHits.length) { touched = q.curbHits[0]; return true; } });
    ok(!!touched, label + ': rear tyre reaches the kerb, impact ' + (touched ? f2(touched.speed * KMH) + ' km/h -> ' + (touched.speed > D.curbHardSpeed ? 'HARD' : 'gentle') : 'none'));
    if (!touched) return;
    var pen = s.curbPenetration(s.pose(), s.state.steerAngle);
    var x0 = s.state.x, z0 = s.state.z;
    run(s, 4, K());
    ok(s.state.speed === 0 && Math.abs(s.state.x - x0) < 0.02 && s.curbHits.length === 1, label + ': kerb holds the car against the reverse creep (moved ' + f2(Math.hypot(s.state.x - x0, s.state.z - z0) * 100) + ' cm, ' + s.curbHits.length + ' hit)');
    ok(s.curbPenetration(s.pose(), s.state.steerAngle) < 0.02, label + ': tyre does not sink into the kerb (penetration ' + (Math.max(0, s.curbPenetration(s.pose(), s.state.steerAngle)) * 100).toFixed(1) + ' cm)');
    run(s, 1, K({ brake: true })); shift(s, 'D');
    var zz = s.state.z;
    run(s, 3, K());
    ok(s.state.speed > 1 && s.state.z < zz - 0.05, label + ': drives away forward at once (now ' + f2(s.state.speed * KMH) + ' km/h, moved ' + f2((zz - s.state.z) * 100) + ' cm off the kerb)');
    return touched;
  }
  var a = kerbCase('creep (no brake)', false);
  var b = kerbCase('brake-feathered', true);
  ok(a && a.speed > D.curbHardSpeed, 'hitting the kerb at idle creep counts as a hard hit');
  ok(b && b.speed <= D.curbHardSpeed, 'touching it while feathering the brake is a gentle touch (normal when parking)');
  // front wheel steered into the kerb while driving forward, then reverse away
  var s = P.create(cfg, sc);
  s.state.x = 0; s.state.z = kz - 1.5; s.state.heading = Math.PI / 2; shift(s, 'D');
  run(s, 2, K({ right: true, brake: true }));
  run(s, 10, K(), function (q) { return q.curbHits.length > 0; });
  var h0 = s.curbHits.length; run(s, 2, K());
  ok(h0 === 1 && s.state.speed === 0, 'front tyre steered into the kerb is stopped');
  run(s, 1, K({ brake: true })); shift(s, 'R'); var p0 = s.pose(); run(s, 2, K());
  ok(Math.hypot(s.state.x - p0.x, s.state.z - p0.z) > 0.5, 'and backs away in R without getting stuck');
})();

// ---------------------------------------------------------------- footprint
head('Cone contact uses the rounded footprint');
(function () {
  var e = P.carExtents(car), pose = { x: 0, z: 0, heading: Math.PI / 2 };
  // a cone exactly off the sharp front-right corner, diagonally 8 cm away from the sharp corner
  var corner = P.toWorld(pose, e.right, e.front), d = 0.08 + 0.14;
  var cx = corner.x + d * Math.SQRT1_2, cz = corner.z + d * Math.SQRT1_2;
  var cl = P.rectCircleClearance(car, pose, cx, cz, 0.14);
  console.log('  cone diagonally 8 cm off the sharp corner: clearance to the rounded body ' + (cl * 100).toFixed(1) + ' cm');
  ok(Math.abs(cl - (0.08 + 0.25 * (Math.SQRT2 - 1))) < 0.005, 'corner rounding r = 0,25 m adds ' + (0.25 * (Math.SQRT2 - 1) * 100).toFixed(1) + ' cm on the diagonal');
  ok(Math.abs(P.rectCircleClearance(car, pose, 1, -(e.left + 0.14 + 0.05), 0.14) - 0.05) < 1e-9, 'flat sides unchanged');
})();

console.log('\n' + (fails ? fails + ' AUDIT FAILURES' : 'PHYSICS AUDIT PASSED'));
process.exitCode = fails ? 1 : 0;
