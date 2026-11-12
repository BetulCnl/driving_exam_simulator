/* PS.physics – pure vehicle / collision / evaluation logic.
 * No DOM, no THREE: loadable in node for headless tests (dev/sim-*.js).
 *
 * Pose: (x, z, heading) of the rear-axle centre. forward = (sin h, cos h).
 * Car-local: +Z forward, +X LEFT. steer > 0 = RIGHT, which DEcreases heading
 * when moving forward: dh/dt = -(v / L) * tan(steerAngle).
 *   forward + right  -> heading decreases (nose turns right)
 *   reverse + right  -> heading increases, the REAR swings to the right (like a real car)
 *
 * Model (see PS.config.drive for every figure and what it is matched to):
 *  - Lateral: kinematic bicycle about the rear axle (no tyre slip – correct for parking speeds),
 *    steer = steering-wheel position -1..1 (1 = 1.5 turns = 35° bicycle angle).
 *  - Longitudinal: pedals have travel (keys are binary, the pedal moves progressively),
 *    torque-converter idle creep that fades towards the creep speed, throttle proportional to
 *    pedal travel, rolling resistance + aero + engine braking, brake proportional to pedal
 *    travel (friction: it can stop and hold the car but never push it backwards).
 *  - Fixed 1/240 s sub-steps driven by a real-time accumulator; the render pose is interpolated.
 */
(function (root) {
  'use strict';
  var PS = root.PS = root.PS || {};

  var GEARS = ['P', 'R', 'N', 'D'];

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function sign(v) { return v > 0 ? 1 : (v < 0 ? -1 : 0); }
  function wrapPi(a) {
    a = (a + Math.PI) % (2 * Math.PI);
    if (a < 0) a += 2 * Math.PI;
    return a - Math.PI;
  }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

  // local (lx = left, lz = forward) -> world
  function toWorld(pose, lx, lz) {
    var s = Math.sin(pose.heading), c = Math.cos(pose.heading);
    return { x: pose.x + lx * c + lz * s, z: pose.z - lx * s + lz * c };
  }
  // world -> local {lx (left), lz (forward)}
  function toLocal(pose, wx, wz) {
    var s = Math.sin(pose.heading), c = Math.cos(pose.heading);
    var dx = wx - pose.x, dz = wz - pose.z;
    return { lx: dx * c - dz * s, lz: dx * s + dz * c };
  }

  function carExtents(car) {
    return { left: car.width / 2, right: -car.width / 2, rear: -car.rearOverhang, front: car.wheelbase + car.frontOverhang };
  }
  function cornerR(car) { return Math.min(num(car.cornerRadius, 0.25), car.width / 2 - 0.01); }

  /** Sharp bounding-box corners in world space: [frontLeft, frontRight, rearRight, rearLeft] (drawing / reference only) */
  function carCorners(car, pose) {
    var e = carExtents(car);
    return [
      toWorld(pose, e.left, e.front),
      toWorld(pose, e.right, e.front),
      toWorld(pose, e.right, e.rear),
      toWorld(pose, e.left, e.rear)
    ];
  }

  /** Real footprint: rectangle with rounded bumper corners (radius car.cornerRadius), as world points. */
  function carOutline(car, pose, perCorner) {
    var e = carExtents(car), rc = cornerR(car), n = perCorner || 4, pts = [];
    // corner-arc centres with outward signs (sx: +left, sz: +front): FL, FR, RR, RL
    var cs = [[e.left - rc, e.front - rc, 1, 1], [e.right + rc, e.front - rc, -1, 1],
              [e.right + rc, e.rear + rc, -1, -1], [e.left - rc, e.rear + rc, 1, -1]];
    for (var k = 0; k < 4; k++) {
      for (var i = 0; i <= n; i++) {
        var t = (k % 2 === 0 ? i : n - i) / n * Math.PI / 2;     // keeps the points in perimeter order
        pts.push(toWorld(pose, cs[k][0] + cs[k][2] * rc * Math.sin(t), cs[k][1] + cs[k][3] * rc * Math.cos(t)));
      }
    }
    return pts;
  }

  /** Front-wheel angles with true Ackermann geometry (rad, + = right). The bicycle angle is the
   *  virtual centre wheel: inner wheel turns more, outer less (35° bicycle -> 41° inner / 30° outer). */
  function ackermann(car, steerAngle) {
    if (Math.abs(steerAngle) < 1e-6) return { left: 0, right: 0 };
    var R = car.wheelbase / Math.tan(Math.abs(steerAngle)), t = car.trackWidth / 2, sg = sign(steerAngle);
    var inner = Math.atan(car.wheelbase / (R - t)), outer = Math.atan(car.wheelbase / (R + t));
    return sg > 0 ? { right: inner, left: outer } : { left: -inner, right: -outer };
  }

  /** Wheel centres [FL, FR, RR, RL] */
  function wheelPoints(car, pose) {
    var t = car.trackWidth / 2;
    return [
      toWorld(pose, t, car.wheelbase), toWorld(pose, -t, car.wheelbase),
      toWorld(pose, -t, 0), toWorld(pose, t, 0)
    ];
  }

  /** Tyre footprints as world-space rectangles (4 corners each). halfLen = half length of the tyre
   *  outline at the height considered (contact patch on the ground, or the tyre's horizontal
   *  extent at kerb height for kerb contact). Front tyres are turned by their Ackermann angle. */
  function tyreRects(car, pose, steerAngle, halfLen) {
    var t = car.trackWidth / 2, hw = num(car.tyreWidth, 0.195) / 2, ak = ackermann(car, steerAngle || 0);
    var wheels = [
      { lx: t, lz: car.wheelbase, a: ak.left }, { lx: -t, lz: car.wheelbase, a: ak.right },
      { lx: -t, lz: 0, a: 0 }, { lx: t, lz: 0, a: 0 }
    ];
    var out = [];
    for (var i = 0; i < 4; i++) {
      var w = wheels[i], ca = Math.cos(w.a), sa = Math.sin(w.a), rect = [];
      // wheel-local forward (rotated right by a): (lx, lz) = (-sa, ca); wheel-local left: (ca, sa)
      var c4 = [[hw, halfLen], [-hw, halfLen], [-hw, -halfLen], [hw, -halfLen]];
      for (var k = 0; k < 4; k++) {
        var ox = c4[k][0], oz = c4[k][1];
        rect.push(toWorld(pose, w.lx + ox * ca - oz * sa, w.lz + ox * sa + oz * ca));
      }
      out.push(rect);
    }
    return out;
  }

  function pointInPoly(p, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var a = poly[i], b = poly[j];
      if (((a.z > p.z) !== (b.z > p.z)) && (p.x < (b.x - a.x) * (p.z - a.z) / (b.z - a.z) + a.x)) inside = !inside;
    }
    return inside;
  }

  function distPointSeg(px, pz, x1, z1, x2, z2) {
    var dx = x2 - x1, dz = z2 - z1;
    var l2 = dx * dx + dz * dz;
    var t = l2 > 0 ? clamp(((px - x1) * dx + (pz - z1) * dz) / l2, 0, 1) : 0;
    var qx = x1 + t * dx, qz = z1 + t * dz;
    return Math.sqrt((px - qx) * (px - qx) + (pz - qz) * (pz - qz));
  }

  /** Signed distance of a point to the box edges (+ inside). */
  function insideMargin(p, poly) {
    var m = Infinity;
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length];
      var d = distPointSeg(p.x, p.z, a.x, a.z, b.x, b.z);
      m = Math.min(m, d);
    }
    return pointInPoly(p, poly) ? m : -m;
  }
  function minMargin(pts, poly) {
    var m = Infinity;
    for (var i = 0; i < pts.length; i++) m = Math.min(m, insideMargin(pts[i], poly));
    return m;
  }

  /* ---------------- "parked inside the box" rule ----------------
   * Judged against the PAINTED box (lines):
   *  1. all four tyre contact patches (19.5 cm × 20 cm) are completely inside the lines, and
   *  2. no part of the real (rounded) body outline sticks out more than BODY_TOL = 10 cm over a line
   *     (a bumper overhanging the paint by a hand's width is accepted by examiners; a wheel on the
   *     line is not).
   */
  var PATCH_HALF_LEN = 0.10, BODY_TOL = 0.10;
  function parkMargins(car, pose, box, steerAngle) {
    var rects = tyreRects(car, pose, steerAngle || 0, PATCH_HALF_LEN), tyre = Infinity;
    for (var i = 0; i < rects.length; i++) tyre = Math.min(tyre, minMargin(rects[i], box.corners));
    var body = minMargin(carOutline(car, pose, 4), box.corners);
    return { tyre: tyre, body: body, margin: Math.min(tyre, body + BODY_TOL) };
  }
  function isInsideBox(car, pose, box, steerAngle) { return parkMargins(car, pose, box, steerAngle).margin >= 0; }
  function boxMargin(car, pose, box, steerAngle) { return parkMargins(car, pose, box, steerAngle).margin; }

  /** Signed angle error (rad) of the car heading vs the box's target heading, in (-PI, PI].
   *  Not folded: only the correct facing direction counts (e.g. nose-out for the reverse bay). */
  function headingErrorRad(pose, box) {
    var target = (box && typeof box.heading === 'number') ? box.heading : Math.PI / 2;
    return wrapPi(pose.heading - target);
  }

  /** Minimum distance (m) from the outer wall of the right-side tyres (front + rear) to any curb segment
   *  ("teker ile kaldırım arası" – what instructors and examiners look at). */
  function rightSideCurbGap(car, pose, curbs) {
    if (!curbs || !curbs.length) return null;
    var tx = -(car.trackWidth / 2 + 0.10);
    var pts = [toWorld(pose, tx, 0), toWorld(pose, tx, car.wheelbase)];
    var best = Infinity;
    for (var i = 0; i < pts.length; i++) {
      for (var k = 0; k < curbs.length; k++) {
        var c = curbs[k];
        best = Math.min(best, distPointSeg(pts[i].x, pts[i].z, c.x1, c.z1, c.x2, c.z2));
      }
    }
    return best;
  }

  /** Clearance (m) between the rounded car body and a circle (negative = overlap). */
  function rectCircleClearance(car, pose, cx, cz, r) {
    var e = carExtents(car), rc = cornerR(car);
    var p = toLocal(pose, cx, cz);
    var l = e.left - rc, ri = e.right + rc, f = e.front - rc, b = e.rear + rc;
    var qx = clamp(p.lx, ri, l), qz = clamp(p.lz, b, f);
    var dx = p.lx - qx, dz = p.lz - qz;
    var d = Math.sqrt(dx * dx + dz * dz);
    if (d === 0) d = -Math.min(p.lx - ri, l - p.lx, p.lz - b, f - p.lz);
    return d - rc - r;
  }
  /** Does the rounded car body touch a circle? */
  function rectCircleHit(car, pose, cx, cz, r) { return rectCircleClearance(car, pose, cx, cz, r) < 0; }

  /** Fixed-step clock shared by main.js and the headless tests: raw frame time (s) -> sim dt (s). */
  var MAX_FRAME_DT = 0.25;
  function frameDt(raw, timeScale) {
    var dt = raw > 0 && isFinite(raw) ? raw : 1 / 60;
    dt = Math.min(dt, MAX_FRAME_DT);                      // long stalls (tab switch) are dropped, never replayed
    return Math.min(dt * (timeScale || 1), MAX_FRAME_DT);
  }

  // ---------------------------------------------------------------------
  function Sim(config, scenario) {
    this.config = config;
    this.car = config.car;
    this.drive = config.drive || {};
    this.coneR = (config.cone && config.cone.radius) || 0.14;
    this.L = this.car.wheelbase;
    this.maxSteer = this.car.maxSteerDeg * Math.PI / 180;
    this.minRadius = this.L / Math.tan(this.maxSteer);
    var d = this.drive, wr = this.car.wheelRadius, hk = num(d.kerbHeight, 0.12);
    this.kerbHalfLen = Math.sqrt(Math.max(0.01, wr * wr - (wr - Math.min(hk, wr * 0.9)) * (wr - Math.min(hk, wr * 0.9))));
    this.setScenario(scenario);
  }

  Sim.prototype.setScenario = function (scenario) {
    this.scenario = scenario;
    // which side of each kerb line is the road: the side the car starts on
    var s = scenario.start;
    this.curbs = (scenario.curbs || []).map(function (c) {
      var dx = c.x2 - c.x1, dz = c.z2 - c.z1, l = Math.sqrt(dx * dx + dz * dz) || 1;
      var nx = -dz / l, nz = dx / l;
      if ((s.x - c.x1) * nx + (s.z - c.z1) * nz < 0) { nx = -nx; nz = -nz; }
      return { x1: c.x1, z1: c.z1, x2: c.x2, z2: c.z2, nx: nx, nz: nz, ux: dx / l, uz: dz / l, len: l };
    });
    this.reset();
  };

  Sim.prototype.reset = function () {
    var s = this.scenario.start;
    this.state = {
      x: s.x, z: s.z, heading: s.heading,
      speed: 0, steer: 0, steerAngle: 0, wheelRot: 0
    };
    this.prev = { x: s.x, z: s.z, heading: s.heading, steer: 0, steerAngle: 0, wheelRot: 0 };
    this.gear = 'P';
    this.signal = 'off';
    this.brake = false;
    this.gas = false;
    this.pedals = { gas: 0, brake: 0 };
    this.accel = 0;
    this.time = 0;
    this.acc = 0;
    this.detent = 0;
    this.cones = this.scenario.cones.map(function (c) { return { id: c.id, x: c.x, z: c.z, hit: false }; });
    this.events = [];
    this.coneHits = [];
    this.curbHits = [];
    this.curbContact = 0;
    this.curbTouching = false;
    this.boundsContact = 0;
    this.dirChanges = 0;
    this.lastDir = 0;
    this.firstMoveTime = null;
    this.firstReverseTime = null;
    this.signalAtFirstReverse = null;
    this.signalAtStart = null;
    this.signalMaxTurn = 0;
    this.distance = 0;
  };

  Sim.prototype.pose = function () { return { x: this.state.x, z: this.state.z, heading: this.state.heading }; };

  /** Pose for drawing: interpolated between the last two fixed sub-steps by the accumulator
   *  remainder, so 144 Hz displays move smoothly although physics runs at 240 Hz. */
  Sim.prototype.renderCar = function () {
    var st = this.state, p = this.prev, h = this.drive.substep || 1 / 240;
    var a = clamp(this.acc / h, 0, 1);
    function lerp(u, v) { return u + (v - u) * a; }
    return {
      x: lerp(p.x, st.x), z: lerp(p.z, st.z), heading: lerp(p.heading, st.heading),
      speed: st.speed, steer: lerp(p.steer, st.steer), steerAngle: lerp(p.steerAngle, st.steerAngle), wheelRot: lerp(p.wheelRot, st.wheelRot)
    };
  };

  Sim.prototype.emit = function (ev) { ev.t = this.time; this.events.push(ev); };
  Sim.prototype.drainEvents = function () { var e = this.events; this.events = []; return e; };

  Sim.prototype.isStopped = function (tol) { return Math.abs(this.state.speed) < (tol || 0.05); };

  /**
   * Automatic-transmission shift request with realistic shift lock.
   *  - leaving P needs the brake pedal (shift-lock solenoid);
   *  - D<->R and N->R need the brake and (almost) standstill;
   *  - P or R can only be engaged at (almost) standstill (parking pawl / reverse dog);
   *  - everything else (D->N, N->D, R->N) is free, like a real selector.
   * Returns { ok, reason, from, to, path:[gears passed incl. target] }
   */
  Sim.prototype.requestGear = function (target, brakeHeld) {
    var from = this.gear;
    var res = { ok: false, reason: null, from: from, to: target, path: [] };
    if (GEARS.indexOf(target) < 0) { res.reason = 'invalid'; return res; }
    if (target === from) { res.ok = true; return res; }
    var b = (typeof brakeHeld === 'boolean') ? (brakeHeld || this.pedals.brake > 0.05) : this.pedals.brake > 0.05;
    var slow = Math.abs(this.state.speed) <= (this.drive.shiftMaxSpeed || 0.3);
    var needBrake = (from === 'P') ||
      ((from === 'D' && target === 'R') || (from === 'R' && target === 'D')) ||
      ((from === 'N') && (target === 'R'));
    if (needBrake && !b) { res.reason = 'brake'; return res; }
    if ((target === 'P' || target === 'R' || (from === 'R' && target === 'D')) && !slow) { res.reason = 'speed'; return res; }
    var i0 = GEARS.indexOf(from), i1 = GEARS.indexOf(target), st = i1 > i0 ? 1 : -1;
    for (var i = i0 + st; ; i += st) { res.path.push(GEARS[i]); if (i === i1) break; }
    this.gear = target;
    res.ok = true;
    return res;
  };

  Sim.prototype.setSignal = function (s) {
    if (s !== 'left' && s !== 'right') s = 'off';
    if (s !== this.signal) this.signalMaxTurn = 0;
    this.signal = s;
  };

  /** inputs: { gas, brake, left, right } (booleans, straight from the keys) */
  Sim.prototype.step = function (dt, inputs) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, MAX_FRAME_DT);
    var h = this.drive.substep || 1 / 240;
    var maxN = Math.ceil(MAX_FRAME_DT / h) + 2;
    this.acc += dt;
    var n = 0;
    while (this.acc >= h && n < maxN) { this.substep(h, inputs || {}); this.acc -= h; n++; }
    if (this.acc >= h) this.acc = 0;              // only reachable if dt was clipped
  };

  /** Longitudinal acceleration produced by the powertrain, along the gear's direction of travel
   *  (u = speed in that direction, m/s; pg = gas pedal 0..1). Exposed for tests. */
  Sim.prototype.driveAccel = function (gear, u, pg) {
    var d = this.drive;
    if (gear !== 'D' && gear !== 'R') return 0;
    var fwd = gear === 'D';
    var vc = fwd ? d.creepForward : d.creepReverse;
    var A0 = fwd ? d.creepLaunchForward : d.creepLaunchReverse;
    var rr = d.rollResist;
    var uf = vc / (1 - rr / A0);               // creep force reaches 0 here -> equilibrium with rolling resistance = vc
    var a;
    if (u <= 0) a = A0;                         // rolling against the gear: full converter stall torque
    else if (u < uf) a = A0 * (1 - u / uf);
    else a = -(1 - pg) * Math.min(d.engineBrakeMax, d.engineBrake * (u - uf));
    var vTop = fwd ? d.vTopForward : d.vTopReverse;
    a += d.gasAccel * pg * (u <= 0 ? 1 : Math.max(0, 1 - (u / vTop) * (u / vTop)));
    return a;
  };

  /** Brake deceleration (m/s²) for a pedal position 0..1: progressive like a real servo brake. */
  Sim.prototype.brakeDecel = function (pb) {
    var d = this.drive;
    return pb <= 0 ? 0 : d.brakeMax * Math.pow(pb, d.brakeCurve || 1.5);
  };

  Sim.prototype.curbPenetration = function (pose, steerAngle) {
    if (!this.curbs.length) return -Infinity;
    var rects = tyreRects(this.car, pose, steerAngle, this.kerbHalfLen), best = -Infinity;
    for (var i = 0; i < rects.length; i++) {
      for (var j = 0; j < 4; j++) {
        var p = rects[i][j];
        for (var k = 0; k < this.curbs.length; k++) {
          var c = this.curbs[k];
          var along = (p.x - c.x1) * c.ux + (p.z - c.z1) * c.uz;
          if (along < -0.3 || along > c.len + 0.3) continue;
          var sd = (p.x - c.x1) * c.nx + (p.z - c.z1) * c.nz;   // + = road side
          if (-sd > best) best = -sd;
        }
      }
    }
    return best;   // > 0: a tyre is pressing into the kerb face
  };

  Sim.prototype.substep = function (h, inp) {
    var st = this.state, d = this.drive, car = this.car;
    this.time += h;
    var p0 = this.prev;
    p0.x = st.x; p0.z = st.z; p0.heading = st.heading; p0.steer = st.steer; p0.steerAngle = st.steerAngle; p0.wheelRot = st.wheelRot;

    // ---- pedals: binary keys -> progressive pedal travel ----
    var pd = this.pedals, pb = pd.brake, pg = pd.gas;
    if (inp.brake) {
      var bite = d.brakeBite, tB = d.brakeBiteTime, tF = d.brakeFullTime;
      pb += (pb < bite ? bite / tB : (1 - bite) / (tF - tB)) * h;
      if (pb > 1) pb = 1;
    } else {
      pb -= h / d.brakeReleaseTime; if (pb < 0) pb = 0;
    }
    if (inp.gas) { pg += h / d.gasApplyTime; if (pg > 1) pg = 1; }
    else { pg -= h / d.gasReleaseTime; if (pg < 0) pg = 0; }
    pd.brake = pb; pd.gas = pg;
    this.brake = pb > 0.05;
    this.gas = pg > 0.05;

    // ---- steering ----
    var s = st.steer, rate = d.steerRate || (1 / 1.4);
    var ds = 0;
    if (inp.right && !inp.left) ds = rate * h; else if (inp.left && !inp.right) ds = -rate * h;
    if (ds !== 0) {
      if (this.detent > 0) {
        this.detent -= h;
      } else {
        var ns = clamp(s + ds, -1, 1);
        if (s !== 0 && (ns === 0 || (s > 0) !== (ns > 0))) { ns = 0; this.detent = 0.2; }   // short "centre" notch so DÜZ is findable
        s = ns;
      }
    } else {
      this.detent = 0;
      // self-aligning torque (caster trail): proportional to speed³ -> negligible at creep, clear at 15+ km/h.
      // Frozen near full lock so a wheel left at lock at parking speed stays there.
      var av = Math.abs(st.speed);
      if (av > 0.05 && s !== 0 && Math.abs(s) < 1 - (d.selfAlignFreeze || 0.03)) {
        var k = (d.selfAlignK || 0.0021) * av * av * av;
        s -= s * Math.min(1, k * h);
      }
      if (Math.abs(s) < 0.03) s = 0;           // centre notch: within ±16° of the steering wheel the wheel drops into DÜZ
    }
    st.steer = s;
    st.steerAngle = s * this.maxSteer;

    // signal auto-cancel (wheel returns to centre after > 90° in the signalled direction)
    var turnDeg = s * car.steeringWheelLockDeg;
    if (this.signal === 'right' && turnDeg > this.signalMaxTurn) this.signalMaxTurn = turnDeg;
    if (this.signal === 'left' && -turnDeg > this.signalMaxTurn) this.signalMaxTurn = -turnDeg;
    if (this.signal !== 'off' && this.signalMaxTurn > 90 && Math.abs(turnDeg) < 8) {
      this.signal = 'off'; this.signalMaxTurn = 0;
      this.emit({ type: 'signalCancel' });
    }

    // ---- longitudinal dynamics ----
    var v = st.speed, g = this.gear, v0 = v;
    var aB = this.brakeDecel(pb);
    if (g === 'P') {
      // parking pawl: P can only be engaged below shiftMaxSpeed, the pawl stops the car at once
      v = Math.abs(v) <= 20 * h ? 0 : v - sign(v) * 20 * h;
    } else {
      var dir = g === 'R' ? -1 : 1;
      var aDrive = (g === 'D' || g === 'R') ? dir * this.driveAccel(g, v * dir, pg) : 0;   // world-longitudinal
      if (v === 0) {
        // standstill: brake + rolling resistance act as static friction – they hold the car unless
        // the drive force is larger; nothing ever pushes the car backwards.
        var hold = aB + d.rollResist;
        if (Math.abs(aDrive) > hold) v = (aDrive - sign(aDrive) * hold) * h;
      } else {
        var aRes = aB + d.rollResist + (d.aeroK || 0) * v * v;
        var nv = v + (aDrive - sign(v) * aRes) * h;
        if (nv * v <= 0) nv = 0;               // friction forces stop the car exactly, no sign flip / jitter
        v = nv;
      }
    }
    this.accel = (v - v0) / h;
    st.speed = v;

    // ---- pose integration (exact arc for the step) ----
    var prevPose = { x: st.x, z: st.z, heading: st.heading };
    if (v !== 0) {
      var dsd = v * h, dh = -(dsd / this.L) * Math.tan(st.steerAngle), hm = st.heading + dh / 2;
      st.x += dsd * Math.sin(hm);
      st.z += dsd * Math.cos(hm);
      st.heading += dh;
      st.wheelRot += dsd / car.wheelRadius;
    }

    // ---- kerbs: a tyre pressing into a kerb face is stopped like a real kerb; moving so that the
    // penetration shrinks (the opposite direction) is always allowed, so the car can never get stuck ----
    if (this.curbs.length && v !== 0) {
      var pen1 = this.curbPenetration(st, st.steerAngle);
      if (pen1 > 0) {
        var pen0 = this.curbPenetration(prevPose, st.steerAngle);
        if (pen1 > pen0 + 1e-7) {
          var impact = Math.abs(v);
          st.x = prevPose.x; st.z = prevPose.z; st.heading = prevPose.heading; st.wheelRot = p0.wheelRot;
          st.speed = v = 0;
          if (!this.curbTouching && this.curbContact <= 0) {
            this.curbHits.push({ t: this.time, speed: impact });
            this.emit({ type: 'curb', speed: impact, hard: impact > (d.curbHardSpeed || 0.9) });
          }
          this.curbTouching = true;
          this.curbContact = 0.8;
        }
      }
    }
    if (this.curbContact > 0) { this.curbContact -= h; if (this.curbContact <= 0) this.curbTouching = false; }

    if (v !== 0) { var ddx = st.x - prevPose.x, ddz = st.z - prevPose.z; this.distance += Math.sqrt(ddx * ddx + ddz * ddz); }

    // ---- direction bookkeeping ----
    var mdir = v > 0.15 ? 1 : (v < -0.15 ? -1 : 0);
    if (mdir !== 0) {
      if (this.firstMoveTime === null) { this.firstMoveTime = this.time; this.signalAtStart = this.signal; this.emit({ type: 'firstMove' }); }
      if (mdir < 0 && this.firstReverseTime === null) { this.firstReverseTime = this.time; this.signalAtFirstReverse = this.signal; }
      if (this.lastDir !== 0 && mdir !== this.lastDir) this.dirChanges++;
      this.lastDir = mdir;
    }

    // ---- cone collisions (rounded body outline) ----
    var r = this.coneR;
    for (var i = 0; i < this.cones.length; i++) {
      var c = this.cones[i];
      if (c.hit) continue;
      if (rectCircleHit(car, st, c.x, c.z, r)) {
        c.hit = true;
        this.coneHits.push(c.id);
        this.emit({ type: 'cone', id: c.id, speed: Math.abs(v) });
      }
    }

    // ---- leaving the course far away: an invisible wall (pose is held, never teleported sideways) ----
    var rd = this.scenario.road;
    if (rd) {
      var m = 3.5;
      if (st.x < rd.xMin - m || st.x > rd.xMax + m || st.z < rd.zMin - m || st.z > rd.zMax + m + 6) {
        var wasOut = prevPose.x < rd.xMin - m || prevPose.x > rd.xMax + m || prevPose.z < rd.zMin - m || prevPose.z > rd.zMax + m + 6;
        if (!wasOut) { st.x = prevPose.x; st.z = prevPose.z; st.heading = prevPose.heading; st.speed = 0; }
        if (this.boundsContact <= 0) this.emit({ type: 'bounds' });
        this.boundsContact = 1;
      } else if (this.boundsContact > 0) this.boundsContact -= h;
    }
  };

  // ---------------------------------------------------------------------
  /** Evaluation snapshot (used by exam result card and lessons). */
  Sim.prototype.evaluate = function () {
    var sc = this.scenario, car = this.car, pose = this.pose();
    var pm = parkMargins(car, pose, sc.box, this.state.steerAngle);
    var inside = pm.margin >= 0;
    var herr = headingErrorRad(pose, sc.box) * 180 / Math.PI;
    var gap = sc.id === 'parallel' ? rightSideCurbGap(car, pose, sc.curbs) : null;
    var sig = this.signalAtFirstReverse === sc.signal || (this.signalAtFirstReverse === null && this.signalAtStart === sc.signal);
    var hardLim = this.drive.curbHardSpeed || 0.9;
    var hardCurb = this.curbHits.some(function (c) { return c.speed > hardLim; });
    var res = {
      conesHit: this.coneHits.slice(),
      curbHits: this.curbHits.length,
      hardCurb: hardCurb,
      inside: inside,
      margin: pm.margin,
      tyreMargin: pm.tyre,
      bodyMargin: pm.body,
      headingErrDeg: herr,
      curbGapCm: gap === null ? null : gap * 100,
      signalOk: !!sig,
      dirChanges: this.dirChanges,
      time: this.firstMoveTime === null ? 0 : this.time - this.firstMoveTime,
      gear: this.gear,
      stopped: this.isStopped(),
      pose: pose
    };
    res.checks = {
      cones: res.conesHit.length === 0,
      curb: !hardCurb,
      inside: inside,
      angle: Math.abs(herr) <= 5,
      gap: gap === null ? true : (gap >= 0.05 && gap <= 0.5),
      signal: res.signalOk,
      maneuvers: res.dirChanges <= 3,
      gearP: this.gear === 'P'
    };
    res.pass = res.checks.cones && res.checks.curb && res.checks.inside && res.checks.angle && res.checks.gap && res.checks.gearP;
    return res;
  };

  PS.physics = {
    GEARS: GEARS,
    create: function (config, scenario) { return new Sim(config, scenario); },
    Sim: Sim,
    frameDt: frameDt,
    MAX_FRAME_DT: MAX_FRAME_DT,
    toWorld: toWorld,
    toLocal: toLocal,
    carCorners: carCorners,
    carOutline: carOutline,
    wheelPoints: wheelPoints,
    tyreRects: tyreRects,
    ackermann: ackermann,
    carExtents: carExtents,
    isInsideBox: isInsideBox,
    boxMargin: boxMargin,
    parkMargins: parkMargins,
    PARK_RULE: { patchHalfLen: PATCH_HALF_LEN, bodyTol: BODY_TOL },
    headingErrorRad: headingErrorRad,
    rightSideCurbGap: rightSideCurbGap,
    rectCircleHit: rectCircleHit,
    rectCircleClearance: rectCircleClearance,
    distPointSeg: distPointSeg,
    pointInPoly: pointInPoly,
    wrapPi: wrapPi,
    clamp: clamp
  };
})(typeof window !== 'undefined' ? window : this);
