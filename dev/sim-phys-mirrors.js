/* Pure-JS replica of the renderer's mirror visibility test (js/mirrors.js planar reflection +
 * js/world.js isConeVisibleInMirror), so the move-list references can be checked headlessly.
 * Exports (node module): visible(PS, which, pose, worldPts, yaw) and conePoints(cone).
 * Mirror DEFS are read from js/mirrors.js source (not executed: it needs THREE).
 */
'use strict';
var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');

function readDefs() {
  var src = fs.readFileSync(path.join(ROOT, 'js/mirrors.js'), 'utf8');
  var m = /var DEFS = (\{[\s\S]*?\n {2}\});/.exec(src);
  if (!m) throw new Error('mirror DEFS not found in js/mirrors.js');
  return Function('return ' + m[1])();
}
var DEFS = readDefs();

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function mul(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { var l = Math.sqrt(dot(a, a)) || 1; return mul(a, 1 / l); }
function smooth(e0, e1, x) { var t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }

/** eye in car-local coordinates (x = left, y = up, z = forward) for head yaw, as js/world.js updateHead */
function eyeLocal(car, yaw) {
  var e = car.eye, ay = Math.abs(yaw), sg = yaw >= 0 ? 1 : -1;
  var lean = smooth(0.8, 2.1, ay) * 0.11 * sg, rise = smooth(1.2, 2.2, ay) * 0.03;
  return [e.x + lean + Math.sin(yaw) * 0.09, e.y + rise, e.z - 0.09 + Math.cos(yaw) * 0.09];
}

/** which: 'left' | 'right' | 'center'; pose: car pose; worldPts: [{x, y, z}] ; yaw: head yaw (rad) */
function visible(PS, which, pose, worldPts, yaw) {
  var car = PS.config.car, d = DEFS[which];
  var eye0 = [car.eye.x, car.eye.y, car.eye.z];
  var C = d.center.slice(), T = d.target.slice();
  var N = norm(add(norm(sub(eye0, C)), norm(sub(T, C))));
  var Vv = norm(sub([0, 1, 0], mul(N, N[1])));
  var U = cross(Vv, N);
  var E = eyeLocal(car, yaw || 0);
  var dist = dot(sub(E, C), N); if (!(dist > 0.02)) dist = 0.02;
  var Ep = sub(E, mul(N, 2 * dist));
  var R = mul(U, -1);
  var rel = sub(C, Ep);
  var x0 = dot(rel, R), y0 = dot(rel, Vv), near = dot(rel, N); if (!(near > 0.01)) near = 0.01;
  var hw = d.w / 2 * d.wide, hh = d.h / 2 * d.wide;
  for (var i = 0; i < worldPts.length; i++) {
    var w = worldPts[i], l = PS.physics.toLocal(pose, w.x, w.z);
    var p = sub([l.lx, w.y, l.lz], Ep);
    var depth = dot(p, N);                  // along the view direction
    if (depth < near || depth > 300) continue;
    var xs = dot(p, R) * near / depth, ys = dot(p, Vv) * near / depth;
    if (xs >= x0 - hw && xs <= x0 + hw && ys >= y0 - hh && ys <= y0 + hh) return true;
  }
  return false;
}

/** sample points of a cone (as js/world.js isConeVisibleInMirror) */
function conePoints(PS, c) {
  var r = PS.config.cone.radius, h = PS.config.cone.height;
  var local = [[0, 0.04, 0], [0, h * 0.5, 0], [0, h * 0.95, 0], [r, 0.05, 0], [-r, 0.05, 0], [0, 0.05, r], [0, 0.05, -r],
    [r * 0.55, h * 0.5, 0], [-r * 0.55, h * 0.5, 0], [0, h * 0.5, r * 0.55], [0, h * 0.5, -r * 0.55]];
  return local.map(function (l) { return { x: c.x + l[0], y: l[1], z: c.z + l[2] }; });
}
/** sample points along a kerb face top edge between x0..x1 */
function kerbPoints(curb, x0, x1) {
  var pts = [];
  for (var x = x0; x <= x1; x += 0.25) pts.push({ x: x, y: 0.12, z: curb.z1 });
  return pts;
}

module.exports = { visible: visible, conePoints: conePoints, kerbPoints: kerbPoints, DEFS: DEFS };
