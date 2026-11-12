/* Geometry exploration for the cone methods (dev only), using the real car footprint (rounded corners).
 *   node dev/sim-explore.js parallel [BL] [margin]      – θ-window of the 45° method per start gap / stop point
 *   node dev/sim-explore.js perp [bayWidth] [margin]    – stop window of the perpendicular method per approach gap
 * Ideal kinematic paths (full lock, exact stops), like the lessons' kinRun look-ahead.
 */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var ROOT = path.join(__dirname, '..');
var ctx = { window: {}, console: console, Math: Math }; ctx.window.window = ctx.window; vm.createContext(ctx);
['js/config.js', 'js/physics.js'].forEach(function (f) { vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx); });
var PS = ctx.window.PS, P = PS.physics, car = PS.config.car;
var DEG = Math.PI / 180, HALF = Math.PI / 2;
var R = car.wheelbase / Math.tan(car.maxSteerDeg * DEG), CR = PS.config.cone.radius;
var mode = process.argv[2] || 'parallel';

function move(p, steer, dir, ds) {
  p.x += dir * Math.sin(p.heading) * ds; p.z += dir * Math.cos(p.heading) * ds;
  p.heading += -(dir / car.wheelbase) * Math.tan(steer * car.maxSteerDeg * DEG) * ds;
}
function clear(p, cones) { var m = 9; cones.forEach(function (c) { m = Math.min(m, P.rectCircleClearance(car, p, c.x, c.z, CR)); }); return m; }
function cp(p) { return { x: p.x, z: p.z, heading: p.heading }; }

if (mode === 'parallel') {
  var BL = Number(process.argv[3] || 7.5), MARGIN = Number(process.argv[4] || 0.10);
  var kerbZ = Number(process.env.KERB || 2.5), coneZ = kerbZ - 0.15;
  var GL = (process.env.G || '0.5,0.6,0.7').split(',').map(Number), PL = (process.env.PF || '0,0.15,0.3').split(',').map(Number);
  var cones = [{ x: BL, z: 0 }, { x: 0, z: 0 }, { x: 0, z: coneZ }, { x: BL, z: coneZ }, { x: 0, z: kerbZ / 2 }, { x: BL, z: kerbZ / 2 }];
  var box = { corners: [{ x: 0, z: 0 }, { x: BL, z: 0 }, { x: BL, z: kerbZ }, { x: 0, z: kerbZ }] };
  console.log('Parallel, box ' + BL + ' × ' + kerbZ + ' m, cone margin ' + MARGIN + ' m, R = ' + R.toFixed(3) + ' m. Final kerb gap must be 0,10–0,45 m.');
  console.log('For each θ: range of straight-reverse length s that works; "lm" = where the front cone c1 is along the car (m ahead of the rear axle).');
  GL.forEach(function (g) {
    PL.forEach(function (pf) {
      var good = [], rows = [];
      for (var th = 25; th <= 60; th += 1) {
        var p = { x: BL + pf + car.rearOverhang, z: -g - car.width / 2, heading: HALF }, c1m = clear(p, cones);
        while (p.heading - HALF < th * DEG) { move(p, 1, -1, 0.01); c1m = Math.min(c1m, clear(p, cones)); }
        var a1 = cp(p), ok = [], sp = cp(a1), sm = c1m;
        for (var s = 0; s <= 4.5; s += 0.02) {
          if (s > 0) { move(sp, 0, -1, 0.02); sm = Math.min(sm, clear(sp, cones)); }
          var q = cp(sp), m = sm;
          var lm = P.toLocal(sp, BL, 0).lz;
          while (q.heading > HALF) { move(q, -1, -1, 0.02); m = Math.min(m, clear(q, cones)); }
          var gap = P.rightSideCurbGap(car, q, [{ x1: -20, z1: kerbZ, x2: 30, z2: kerbZ }]);
          var ins = P.isInsideBox(car, q, box);
          if (m >= MARGIN && gap >= 0.10 && gap <= 0.45 && ins) ok.push({ s: s, gap: gap, rear: q.x - car.rearOverhang, lm: lm, m: m });
        }
        if (ok.length >= 8) {   // at least 0,16 m of usable straight reverse
          good.push(th);
          var mid = ok[Math.floor(ok.length / 2)];
          rows.push(th + '°: s ' + ok[0].s.toFixed(2) + '–' + ok[ok.length - 1].s.toFixed(2) + ' (gap ' + Math.round(ok[0].gap * 100) + '→' + Math.round(ok[ok.length - 1].gap * 100) + ' cm, lm ' + ok[0].lm.toFixed(2) + '–' + ok[ok.length - 1].lm.toFixed(2) + ', rear ' + mid.rear.toFixed(2) + ')');
        }
      }
      console.log('\n gap ' + g + ' m, rear bumper ' + pf.toFixed(2) + ' m past c1: θ window ' + (good.length ? good[0] + '–' + good[good.length - 1] + '° (middle ' + ((good[0] + good[good.length - 1]) / 2) + '°)' : 'none'));
      if (process.argv.indexOf('-v') >= 0 || pf === 0.15) rows.filter(function (r, i) { return i % 5 === 0 || /^45/.test(r); }).forEach(function (r) { console.log('   ' + r); });
    });
  });
} else {
  var W = Number(process.argv[3] || 3.0), MARG = Number(process.argv[4] || 0.10), depth = 5.2, hw = W / 2;
  var cones2 = [{ x: hw, z: 0 }, { x: -hw, z: 0 }, { x: hw, z: depth / 2 }, { x: -hw, z: depth / 2 }, { x: hw, z: depth }, { x: -hw, z: depth }];
  var box2 = { corners: [{ x: -hw, z: 0 }, { x: hw, z: 0 }, { x: hw, z: depth }, { x: -hw, z: depth }] };
  console.log('Perpendicular bay ' + W + ' × ' + depth + ' m, margin ' + MARG + ' m. Single full-right-lock arc to straight (eps window) then straight in.');
  [1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2.0, 2.2].forEach(function (g) {
    var okX = [];
    for (var x0 = 2.6; x0 <= 4.8; x0 += 0.02) {
      // reverse at full right lock; at each heading error in [-6, +6]° try straightening and reversing in
      var p = { x: x0, z: -g - car.width / 2, heading: HALF }, m = clear(p, cones2), best = null;
      while (p.heading < Math.PI + 8 * DEG) {
        move(p, 1, -1, 0.01); m = Math.min(m, clear(p, cones2));
        var eps = (p.heading - Math.PI) / DEG;
        if (eps > -6 && m >= MARG) {
          var q = cp(p), mm = m;
          while (q.z < 0 + 0.65 + 3.9 && Math.cos(q.heading) < -0.2) { move(q, 0, -1, 0.01); mm = Math.min(mm, clear(q, cones2)); }
          if (mm >= MARG && P.isInsideBox(car, q, box2)) { if (!best) best = { e0: eps, e1: eps }; best.e1 = eps; }
        }
      }
      if (best) okX.push({ x0: x0, e0: best.e0, e1: best.e1 });
    }
    if (!okX.length) { console.log(' gap ' + g.toFixed(1) + ' m: no single-arc solution'); return; }
    var mid = okX[Math.floor(okX.length / 2)];
    console.log(' gap ' + g.toFixed(1) + ' m: rear axle past bay centre ' + okX[0].x0.toFixed(2) + '–' + okX[okX.length - 1].x0.toFixed(2) + ' m (width ' + (okX[okX.length - 1].x0 - okX[0].x0).toFixed(2) + ' m; R = ' + R.toFixed(2) + ' m centres the car)' +
      '; at the middle the heading window is ' + mid.e0.toFixed(1) + '…' + mid.e1.toFixed(1) + '°; rear bumper past near cone at middle ' + (mid.x0 - car.rearOverhang - hw).toFixed(2) + ' m');
  });
}
