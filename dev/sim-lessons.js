/* Headless validation of the lessons ("duba kuralı") with the realistic car.
 * Usage: node dev/sim-lessons.js [--verbose] [--moves]
 *
 * Every learner drives through the REAL input path: boolean keys (W/Q/A/D) -> sim.step at 60 fps
 * -> pedal travel inside physics. Speed is controlled the human way: feathering the brake with
 * short Q pulses (bang-bang with ≥0,12 s presses/releases), no gas.
 *  - "panel" learners follow the lesson panel / cue bar ("ŞİMDİ DUR") with a reaction delay;
 *  - the "textbook" learner ignores the panel and uses only the standard instructor numbers.
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var VERBOSE = process.argv.indexOf('--verbose') >= 0;
var DT = 1 / 60, DEG = 180 / Math.PI, HALF = Math.PI / 2;
var CRAWL_NEAR = 1.5 / 3.6, CRAWL_FAR = 3.0 / 3.6;     // m/s – target speeds while feathering the brake

function loadPS() {
  var ctx = { window: {}, console: console, Math: Math };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  ['js/config.js', 'js/physics.js', 'js/lessons.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  });
  return ctx.window.PS;
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function r2(v) { return Math.round(v * 1000) / 1000; }

var PS = loadPS();
var cfg = PS.config, E = PS.lessonEngine, P = PS.physics, car = cfg.car;
var MIR = require('./sim-phys-mirrors.js');

function makeScenario(scId, gap) {
  var sc = clone(cfg.scenarios[scId]);
  if (gap !== undefined) {
    var lineZ = scId === 'parallel' ? sc.lesson.coneLineZ : sc.lesson.mouthZ;
    sc.start.z = lineZ - gap - car.width / 2;
  }
  return sc;
}

/** Human-like driver primitives shared by both learner types. */
function Driver(sim) {
  this.sim = sim;
  this.inp = { gas: false, brake: true, left: false, right: false };
  this.fb = { on: true, t: 0 };
  this.minClear = { v: 99, id: null };
  this.maxKmh = 0;
}
Driver.prototype.tick = function () {
  var sim = this.sim;
  sim.step(DT, this.inp);
  var pose = sim.pose(), self = this;
  sim.cones.forEach(function (c) {
    var d = P.rectCircleClearance(car, pose, c.x, c.z, sim.coneR);
    if (d < self.minClear.v) { self.minClear.v = d; self.minClear.id = c.id; }
  });
  this.maxKmh = Math.max(this.maxKmh, Math.abs(sim.state.speed) * 3.6);
};
/** feather the brake to hold about vt (m/s): press when faster than 1,1·vt, release below 0,8·vt (each press/release ≥ 0,12 s) */
Driver.prototype.feather = function (vt) {
  var v = Math.abs(this.sim.state.speed), fb = this.fb;
  fb.t += DT;
  if (fb.on) { if (v < vt * 0.8 && fb.t >= 0.12) { fb.on = false; fb.t = 0; } }
  else if (v > vt * 1.1 && fb.t >= 0.12) { fb.on = true; fb.t = 0; }
  this.inp.brake = fb.on;
  this.inp.gas = false;
};
Driver.prototype.holdBrake = function () { this.inp.brake = true; this.inp.gas = false; this.fb.on = true; this.fb.t = 0; };
Driver.prototype.steerToward = function (target) {
  var inp = this.inp, s = this.sim.state.steer;
  inp.left = inp.right = false;
  if (target === 0) { if (s > 0) inp.left = true; else if (s < 0) inp.right = true; }
  else if (target > 0) { if (s < 1) inp.right = true; }
  else { if (s > -1) inp.left = true; }
};
Driver.prototype.ensureGear = function (g) {
  var sim = this.sim;
  if (sim.gear === g) return true;
  this.holdBrake();
  if (sim.isStopped(0.05)) return sim.requestGear(g, true).ok;
  return false;
};

// =====================================================================
// Panel learner
// =====================================================================
function runPanel(scId, opts) {
  var sc = makeScenario(scId, opts.gap);
  var sim = P.create(cfg, sc);
  var steps = PS.lessonDefs[scId](sc, cfg);
  var drv = new Driver(sim), inp = drv.inp;
  var log = [], feedback = [], corrections = 0, perStep = {}, windows = {};
  var maxT = 400, head = { yaw: 0, pitch: 0 }, moveOrder = [], moveBase = 0, moveStates = [], mirrorRes = [];

  // stop-window probe: from the current pose, crawl through the zone at ~1,5 km/h (feathered)
  function probeWindow(step) {
    var c = P.create(cfg, sc);
    c.state = clone(sim.state); c.gear = step.need.gear || sim.gear; c.signal = sim.signal;
    c.cones = clone(sim.cones);
    if (step.need.steer !== undefined) { c.state.steer = step.need.steer; c.state.steerAngle = step.need.steer * car.maxSteerDeg / DEG; }
    var d = new Driver(c), dIn = null, tIn = null, vIn = null;
    for (var k = 0; k < 60 * 120; k++) {
      d.feather(CRAWL_NEAR); d.tick();
      var z = E.evalStep(step, E.metrics(c), null).zone;
      if (!z) break;
      if (z.z === 'in' && dIn === null) { dIn = c.distance; tIn = c.time; vIn = z.value; }
      if (dIn !== null && z.z !== 'in') return { m: c.distance - dIn, s: c.time - tIn, from: vIn, to: z.value };
    }
    return null;
  }

  for (var i = 0; i < steps.length; i++) {
    var step = steps[i];
    if (step.kind === 'move' && opts.probe) windows[step.id] = probeWindow(step);
    var inZoneSince = null, correcting = false, t0 = sim.time, prevZone = null, stState = {}, ms = null, lookT = 0;
    while (true) {
      if (sim.time - t0 > 150 || sim.time > maxT) { log.push({ step: step.id, error: 'timeout' }); return finish(false, 'timeout at ' + step.id); }
      var m = E.metrics(sim);
      var r = E.evalStep(step, m, stState);
      var nBefore = ms && ms.order ? ms.order.length : 0;
      ms = E.updateMoves(step, m, r, { head: head }, ms);
      for (var oi = nBefore; oi < ms.order.length; oi++) moveOrder.push({ g: moveBase + ms.order[oi], st: ms.tick[ms.order[oi]], t: sim.time });
      var cm = E.currentMove(step, ms);
      if (r.done) break;
      if (r.zone && r.zone.z !== prevZone) {
        if (process.env.ZDBG) console.log('    [' + step.id + '] zone ' + r.zone.z + ' t=' + sim.time.toFixed(2) + ' v=' + sim.state.speed.toFixed(2) + ' theta=' + m.theta.toFixed(1) + ' x=' + m.pose.x.toFixed(2));
        if (r.zone.z === 'over' && r.zone.text) feedback.push(step.id + ': ' + r.zone.text);
        prevZone = r.zone.z;
      }
      var n = step.need || {};
      if (step.kind === 'setup') {
        // the learner works down the move list, one move at a time
        drv.holdBrake(); inp.left = inp.right = false;
        if (cm && cm.k === 'look') { lookT += DT; head.yaw = lookT > 0.4 ? -1.0 : -0.5; } else { head.yaw = 0; lookT = 0; }
        if (cm && cm.k === 'gear') drv.ensureGear(cm.v);
        else if (cm && cm.k === 'signal') sim.setSignal(cm.v);
        else if (cm && cm.k === 'steer') drv.steerToward(cm.v);
        else if (!cm) {
          if (n.signal && sim.signal !== n.signal) sim.setSignal(n.signal);
          if (n.steer !== undefined && !r.steerOk) drv.steerToward(n.steer);
          if (n.gear && sim.gear !== n.gear) drv.ensureGear(n.gear);
        }
        drv.tick();
        continue;
      }
      head.yaw = 0;
      // move / adjust
      if (n.steer !== undefined && !r.steerOk) { drv.holdBrake(); drv.steerToward(n.steer); drv.tick(); continue; }
      inp.left = inp.right = false;
      var z = r.zone.z;
      if (z === 'in') {
        if (correcting) drv.holdBrake();
        else {
          if (inZoneSince === null) inZoneSince = sim.time;
          if (sim.time - inZoneSince >= (opts.delay || 0) - 1e-9) drv.holdBrake();
          else drv.feather(CRAWL_NEAR);            // has not reacted yet: keeps doing what it did
        }
        drv.tick();
        continue;
      }
      inZoneSince = null;
      var wantGear;
      if (step.kind === 'adjust') { wantGear = r.zone.fix; correcting = true; }
      else if (z === 'before') wantGear = n.gear;
      else {
        wantGear = r.zone.fix;
        if (!correcting) { corrections++; perStep[step.id] = (perStep[step.id] || 0) + 1; }
        correcting = true;
      }
      if (sim.gear !== wantGear) { drv.ensureGear(wantGear); drv.tick(); continue; }
      var near = correcting || (r.zone.remain !== undefined && r.zone.remain < 2.0);
      drv.feather(near ? CRAWL_NEAR : CRAWL_FAR);
      drv.tick();
    }
    moveStates.push(ms); moveBase += (step.moves || []).length;
    if (opts.mirrors) mirrorRes = mirrorRes.concat(mirrorChecks(scId, step.id, sim));
    var mm = E.metrics(sim);
    log.push({ step: step.id, t: r2(sim.time), x: r2(mm.pose.x), z: r2(mm.pose.z), thetaDeg: r2(mm.theta),
      extra: scId === 'parallel' ? { pastFront: r2(mm.pastFront), predGap: r2(mm.predGap), coneGap: r2(mm.coneGap), c1Lz: r2(mm.c1Lz), centreOff: r2(mm.centreOff), curbGap: r2(mm.curbGap) }
        : { past: r2(mm.past), mouthGap: r2(mm.mouthGap), depth: r2(mm.depth), sideOff: r2(mm.sideOff), eps: r2(mm.eps) },
      cones: sim.coneHits.slice() });
    if (opts.onStepDone) opts.onStepDone(step, i, sim);
  }
  return finish(true);

  function finish(completed, why) {
    var total = steps.reduce(function (a, st) { return a + (st.moves || []).length; }, 0);
    var inOrder = moveOrder.every(function (o, k) { return o.g === k; });
    var allDone = moveOrder.length === total && moveOrder.every(function (o) { return o.st === 'done'; });
    return summarize(scId, sim, drv, completed, why, opts, { log: log, feedback: feedback, corrections: corrections, perStep: perStep, windows: windows,
      moves: { total: total, ticked: moveOrder.length, inOrder: inOrder, allDone: allDone, skipped: moveOrder.filter(function (o) { return o.st !== 'done'; }).map(function (o) { return o.g + 1; }) },
      mirrors: mirrorRes });
  }
}

// ---------------------------------------------------------------------
// Visual references named in the move list, checked with the renderer's mirror geometry
// at the pose where the learner actually stops (head turned toward that mirror).
// ---------------------------------------------------------------------
function mirrorChecks(scId, stepId, sim) {
  var pose = sim.pose(), sc = sim.scenario, out = [];
  function cone(id) { return sc.cones.filter(function (c) { return c.id === id; })[0]; }
  function see(which, id, yaw) { return MIR.visible(PS, which, pose, MIR.conePoints(PS, cone(id)), yaw); }
  function add(name, ok) { out.push({ name: name, ok: !!ok }); }
  if (scId === 'parallel') {
    if (stepId === 'pass') add('pass: front cone c1 visible in the RIGHT mirror at the stop', see('right', 'c1', -1.0));
    if (stepId === 'arc1') {
      add('arc1: road-side rear cone c2 has LEFT the left mirror at the stop (looking at it)', !see('left', 'c2', 0.6) && !see('left', 'c2', 1.0));
      add('arc1: kerb-side rear cone c3 visible in the left mirror at the stop', see('left', 'c3', 0.6));
      // same full-lock circle, 35° (too early): c2 must still be in the left mirror there
      var R = sim.minRadius, icr = P.toWorld(pose, -R, 0), h35 = HALF + 35 / 180 * Math.PI;
      var p35 = { x: icr.x + R * Math.cos(h35), z: icr.z - R * Math.sin(h35), heading: h35 };
      add('arc1: at 35° the road-side rear cone c2 is still in the left mirror (reference not met too early)', MIR.visible(PS, 'left', p35, MIR.conePoints(PS, cone('c2')), 0.6));
    }
    if (stepId === 'arc2') add('arc2: kerb visible in the RIGHT mirror at the stop', MIR.visible(PS, 'right', pose, MIR.kerbPoints(sc.curbs[0], pose.x - 6, pose.x + 3), -1.0));
  } else {
    if (stepId === 'pass') add('pass: near mouth cone p1 NOT yet in the right mirror at the stop (it enters only when you have gone too far)', !see('right', 'p1', 0) && !see('right', 'p1', -1.0));
    if (stepId === 'arc') { add('arc: left row (p4) visible in the LEFT mirror at the stop', see('left', 'p4', 0.6)); add('arc: right row (p3) visible in the RIGHT mirror at the stop', see('right', 'p3', -1.0)); }
  }
  return out;
}

// =====================================================================
// Textbook learner: ignores the panel, uses only the standard numbers.
// It aims to stop ON each reference (starts braking ~0,3 s before, like a driver who
// is crawling and watching the reference) and then reacts with a 0,3 s delay.
// =====================================================================
var LOOKAHEAD = 0.15;   // s – the textbook learner starts its stop this much before the reference (plus its reaction time)
function textbookPlan(scId, sc) {
  var L = sc.lesson, R = car.wheelbase / Math.tan(car.maxSteerDeg / DEG);
  function theta(sim) { return (sim.state.heading - HALF) * DEG; }
  if (scId === 'parallel') {
    var c1 = sc.cones.filter(function (c) { return c.id === 'c1'; })[0];
    var bx = (sc.box.corners[0].x + sc.box.corners[1].x) / 2;
    return [
      { setup: { gear: 'D', signal: 'right', steer: 0 }, label: 'D, sağ sinyal' },
      { move: 'D', steer: 0, label: 'ileri: öndeki duba sağ arka teker hizasında dur', rem: function (s) { return c1.x - s.state.x; } },
      { setup: { gear: 'R', steer: 1 }, label: 'R, sağa tam' },
      { move: 'R', steer: 1, label: 'geri: 45°', rem: function (s) { return (45 - theta(s)) / DEG * R; } },
      { setup: { steer: 0 }, label: 'düzelt' },
      { move: 'R', steer: 0, label: 'düz geri: öndeki duba sağ ön teker hizasında dur', rem: function (s) { return car.wheelbase - P.toLocal(s.pose(), c1.x, c1.z).lz; } },
      { setup: { steer: -1 }, label: 'sola tam' },
      { move: 'R', steer: -1, label: 'geri: paralel (0°)', rem: function (s) { return theta(s) / DEG * R; } },
      { setup: { steer: 0 }, label: 'düzelt' },
      { centre: function (s) { var c = P.toWorld(s.pose(), 0, (car.wheelbase + car.frontOverhang - car.rearOverhang) / 2); return c.x - bx; }, tol: 0.30, label: 'ortala' },
      { setup: { gear: 'P' }, label: 'P' }
    ];
  }
  var p1 = sc.cones.filter(function (c) { return c.id === 'p1'; })[0];
  return [
    { setup: { gear: 'D', signal: 'right', steer: 0 }, label: 'D, sağ sinyal' },
    { move: 'D', steer: 0, label: 'ileri: yakın duba arka tamponun 1,3 m gerisinde', rem: function (s) { return (p1.x + 1.3 + car.rearOverhang) - s.state.x; } },
    { setup: { gear: 'R', steer: 1 }, label: 'R, sağa tam' },
    { move: 'R', steer: 1, label: 'geri: 90° (sıralara paralel)', rem: function (s) { return (90 - theta(s)) / DEG * R; } },
    { setup: { steer: 0 }, label: 'düzelt' },
    { move: 'R', steer: 0, label: 'düz geri: dip çizgiye 0,5 m', rem: function (s) { return (L.backZ - 0.5) - P.toWorld(s.pose(), 0, -car.rearOverhang).z; } },
    { setup: { gear: 'P' }, label: 'P' }
  ];
}

function runTextbook(scId, opts) {
  var sc = makeScenario(scId, opts.gap);
  var sim = P.create(cfg, sc), drv = new Driver(sim), inp = drv.inp, plan = textbookPlan(scId, sc);
  var REACT = opts.delay === undefined ? 0.3 : opts.delay, log = [];
  for (var i = 0; i < plan.length; i++) {
    var ph = plan[i], t0 = sim.time;
    function timeout() { return sim.time - t0 > 120; }
    if (ph.setup) {
      var u = ph.setup;
      while (!timeout()) {
        drv.holdBrake();
        if (u.signal && sim.signal !== u.signal) sim.setSignal(u.signal);
        var steerOk = u.steer === undefined || E.steerMatches(u.steer, sim.state.steer);
        if (!steerOk) drv.steerToward(u.steer); else inp.left = inp.right = false;
        if (u.gear && sim.gear !== u.gear) drv.ensureGear(u.gear);
        if (steerOk && (!u.gear || sim.gear === u.gear) && sim.isStopped()) break;
        drv.tick();
      }
    } else if (ph.move) {
      var trig = null;
      while (!timeout()) {
        drv.ensureGear(ph.move);
        if (sim.gear !== ph.move) { drv.tick(); continue; }
        inp.left = inp.right = false;
        var rem = ph.rem(sim), v = Math.abs(sim.state.speed);
        if (trig === null && rem <= v * (REACT + LOOKAHEAD)) trig = sim.time;      // aims to be stopped ON the reference
        if (trig !== null && sim.time - trig >= REACT) { drv.holdBrake(); if (sim.isStopped()) break; }
        else drv.feather(rem < 2.0 ? CRAWL_NEAR : CRAWL_FAR);
        drv.tick();
      }
    } else if (ph.centre) {
      var off = ph.centre(sim);
      if (Math.abs(off) > ph.tol) {
        var g = off < 0 ? 'D' : 'R', trig2 = null;
        while (!timeout()) {
          drv.ensureGear(g);
          if (sim.gear !== g) { drv.tick(); continue; }
          var rm = Math.abs(ph.centre(sim)), vv = Math.abs(sim.state.speed);
          if (trig2 === null && (rm <= vv * (REACT + LOOKAHEAD) || Math.sign(ph.centre(sim)) !== Math.sign(off))) trig2 = sim.time;
          if (trig2 !== null && sim.time - trig2 >= REACT) { drv.holdBrake(); if (sim.isStopped()) break; }
          else drv.feather(CRAWL_NEAR);
          drv.tick();
        }
      }
    }
    var th = (sim.state.heading - HALF) * DEG;
    var mmx = E.metrics(sim);
    log.push({ phase: ph.label, t: r2(sim.time), x: r2(sim.state.x), z: r2(sim.state.z), thetaDeg: r2(th), kerb: mmx.curbGap === undefined ? null : r2(mmx.curbGap), c1Lz: mmx.c1Lz === undefined ? null : r2(mmx.c1Lz), predGap: mmx.predGap === undefined ? null : r2(mmx.predGap), cones: sim.coneHits.slice(), kerbHits: sim.curbHits.length });
  }
  return summarize(scId, sim, drv, true, null, opts, { log: log, feedback: [], corrections: 0, perStep: {}, windows: {} });
}

// =====================================================================
function summarize(scId, sim, drv, completed, why, opts, extra) {
  var ev = sim.evaluate();
  var checks = [], ok = completed;
  function check(name, cond, val) { checks.push((cond ? 'OK  ' : 'FAIL') + ' ' + name + (val !== undefined ? ' = ' + val : '')); if (!cond) ok = false; }
  check('no cone touched', ev.conesHit.length === 0, ev.conesHit.join(',') || 'none');
  if (opts.textbook) check('no hard kerb hit', !ev.hardCurb, ev.curbHits + ' touch(es)' + (ev.hardCurb ? ' HARD' : ''));
  else check('no kerb contact', ev.curbHits === 0, ev.curbHits);
  check('inside the painted box (tyres in, body ≤10 cm over)', ev.inside, 'tyres ' + Math.round(ev.tyreMargin * 100) + ' cm, body ' + Math.round(ev.bodyMargin * 100) + ' cm');
  check('heading error < 5°', Math.abs(ev.headingErrDeg) < 5, ev.headingErrDeg.toFixed(2) + '°');
  if (scId === 'parallel') check('kerb gap 10..45 cm', ev.curbGapCm >= 10 && ev.curbGapCm <= 45, ev.curbGapCm.toFixed(1) + ' cm');
  check('gear P', ev.gear === 'P', ev.gear);
  check('signal given', ev.signalOk, ev.signalOk);
  checks.push('info min cone clearance during run = ' + Math.round(drv.minClear.v * 100) + ' cm (' + drv.minClear.id + '), top speed ' + drv.maxKmh.toFixed(1) + ' km/h');
  if (opts.maxCorr !== undefined) check('corrections <= ' + opts.maxCorr, extra.corrections <= opts.maxCorr, extra.corrections + (extra.corrections ? ' ' + JSON.stringify(extra.perStep) : ''));
  if (opts.maxKmh !== undefined) check('never faster than ' + opts.maxKmh + ' km/h', drv.maxKmh <= opts.maxKmh, drv.maxKmh.toFixed(1));
  if (extra.moves) check('move list: every move ticked, in order, none skipped', extra.moves.allDone && extra.moves.inOrder,
    extra.moves.ticked + '/' + extra.moves.total + (extra.moves.inOrder ? ' in order' : ' OUT OF ORDER') + (extra.moves.skipped.length ? ', skipped #' + extra.moves.skipped.join(',#') : ''));
  (extra.mirrors || []).forEach(function (mr) { check('reference: ' + mr.name, mr.ok); });
  return { label: opts.label, scId: scId, ok: ok, completed: completed, why: why, ev: ev, checks: checks, log: extra.log, feedback: extra.feedback,
    corrections: extra.corrections, minClear: drv.minClear, windows: extra.windows };
}

// =====================================================================
// ---- the move lists exactly as the learner sees them (top-right panel) ----
['parallel', 'perpendicular'].forEach(function (id) {
  var sc = cfg.scenarios[id], lines = E.moveLines(PS.lessonDefs[id](sc, cfg));
  console.log('\nHAMLE LİSTESİ — ' + sc.name + ' (' + lines.length + ' hamle)');
  lines.forEach(function (l) {
    console.log('  ' + (l.n < 10 ? ' ' : '') + l.n + '. ' + l.t + '   [' + l.step + ', ' + l.t.length + ' kar.]');
    if (l.when) console.log('       Ne zaman dur: ' + l.when);
  });
});

var cases = [];
[['parallel', [0.5, 0.6, 0.7], 0.6], ['perpendicular', [1.4, 1.5, 1.7], 1.5]].forEach(function (d) {
  var sc = d[0], nominal = d[2];
  cases.push({ sc: sc, label: 'panel, react 0,3 s, gap ' + nominal + ' m (+ stop-window probe, mirror references)', delay: 0.3, gap: nominal, maxCorr: 0, probe: true, maxKmh: 4.5, mirrors: true });
  d[1].forEach(function (g) { cases.push({ sc: sc, label: 'panel, react 0,3 s, gap ' + g + ' m', delay: 0.3, gap: g, maxCorr: 0 }); });
  d[1].forEach(function (g) { cases.push({ sc: sc, label: 'panel, react 0,6 s, gap ' + g + ' m', delay: 0.6, gap: g, maxCorr: 0 }); });
  d[1].forEach(function (g) { cases.push({ sc: sc, label: 'panel, react 1,0 s, gap ' + g + ' m', delay: 1.0, gap: g, maxCorr: 1 }); });
  d[1].forEach(function (g) { cases.push({ sc: sc, label: 'TEXTBOOK (standard numbers, no panel), gap ' + g + ' m', textbook: true, gap: g }); });
});

var SUMMARY = [], allOk = true;
cases.forEach(function (c) {
  var res = c.textbook ? runTextbook(c.sc, c) : runPanel(c.sc, c);
  allOk = allOk && res.ok;
  var p = res.ev.pose;
  console.log('\n[' + (res.ok ? 'PASS' : 'FAIL') + '] ' + c.sc + ' — ' + c.label + (res.why ? ' (' + res.why + ')' : ''));
  console.log('  final pose: x=' + p.x.toFixed(3) + ' z=' + p.z.toFixed(3) + ' heading=' + (p.heading * DEG).toFixed(2) + '°  dirChanges=' + res.ev.dirChanges + '  time=' + res.ev.time.toFixed(1) + ' s');
  res.checks.forEach(function (l) { console.log('  ' + l); });
  if (res.feedback.length) console.log('  step feedback shown: ' + res.feedback.join(' | '));
  if (c.probe) Object.keys(res.windows).forEach(function (k) {
    var w = res.windows[k];
    console.log('  stop window [' + k + ']: ' + (w ? w.m.toFixed(2) + ' m of travel = ' + w.s.toFixed(2) + ' s at 1,5 km/h (value ' + w.from.toFixed(2) + ' -> ' + w.to.toFixed(2) + ')' : 'open-ended'));
  });
  SUMMARY.push([res.ok ? 'PASS' : 'FAIL', c.sc, c.label, 'h=' + (p.heading * DEG).toFixed(1),
    'err=' + res.ev.headingErrDeg.toFixed(1) + 'deg', res.ev.curbGapCm === null ? '' : 'kerb=' + res.ev.curbGapCm.toFixed(0) + 'cm',
    'minClear=' + Math.round(res.minClear.v * 100) + 'cm', 'corr=' + res.corrections, 't=' + res.ev.time.toFixed(0) + 's'].join(' | '));
  if (VERBOSE || !res.ok) res.log.forEach(function (l) { console.log('    ' + JSON.stringify(l)); });
});
console.log('\nSUMMARY');
SUMMARY.forEach(function (l) { console.log('  ' + l); });
console.log('\n' + (allOk ? 'ALL CASES PASSED' : 'SOME CASES FAILED'));
process.exitCode = allOk ? 0 : 1;
