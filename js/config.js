/* PS.config – shared configuration (car, cones, scenarios).
 * Conventions: meters / radians, Y up, ground = XZ plane.
 * Car pose origin = centre of rear axle. Heading h: forward = (sin h, 0, cos h).
 * The learner drives toward +X (h = +PI/2); parking areas are on the +Z (right) side.
 */
(function (root) {
  'use strict';
  var PS = root.PS = root.PS || {};
  var HALF_PI = Math.PI / 2;

  PS.config = PS.config || {};

  PS.config.car = {
    length: 4.05, width: 1.75, height: 1.45,
    wheelbase: 2.58, rearOverhang: 0.65, frontOverhang: 0.82,  // rear bumper at local z=-0.65, front bumper at z=+3.40
    trackWidth: 1.50, wheelRadius: 0.31, tyreWidth: 0.195,   // 195/55 R16
    cornerRadius: 0.25,         // plan-view rounding of the bumper corners (real footprint, used for cone contact)
    maxSteerDeg: 35,            // bicycle (virtual centre-wheel) angle at full lock; Ackermann: inner 41°, outer 30°
                                // -> rear-axle radius 2.58/tan35° = 3.68 m, kerb-to-kerb circle 10.5 m, wall-to-wall 11.3 m
                                //    (Renault Clio IV: 10.6 m kerb-to-kerb, Hyundai i20: 10.2 m)
    steeringWheelLockDeg: 540,  // steering wheel rotation centre -> full lock (1.5 turns, 3 turns lock-to-lock)
    eye: { x: 0.37, y: 1.18, z: 1.25 }  // driver's eye, car-local (+X = left)
  };

  PS.config.cone = { radius: 0.14, height: 0.50 };

  // Driving model (used by js/physics.js). Car: ~1150 kg B-segment hatchback with a torque-converter automatic.
  // All accelerations are per unit mass (m/s²). Real-world figure each value is matched to in the comment.
  PS.config.drive = {
    mass: 1150,                // kg (Clio/i20 automatic kerb weight ~1150 kg + driver) – informational
    // idle creep (foot off both pedals, flat ground)
    creepForward: 1.67,        // m/s = 6,0 km/h – typical D creep on the flat (5–7 km/h)
    creepReverse: 1.39,        // m/s = 5,0 km/h – typical R creep
    creepLaunchForward: 1.6,   // m/s² pull at standstill (idle converter stall torque) -> ~90 % of creep in 2,6 s
    creepLaunchReverse: 1.4,   // m/s²                                                  -> ~90 % of creep in 2,5 s
    // throttle
    gasAccel: 2.0,             // m/s² extra at full pedal at low speed -> 0–30 km/h ≈ 4,3 s incl. the 1 s pedal travel
    vTopForward: 16.7,         // m/s – throttle taper (only shapes the curve; the course is far too short to reach it)
    vTopReverse: 4.3,          // m/s – reverse is short-geared: full pedal tops out ≈ 15 km/h
    // resistances
    rollResist: 0.12,          // m/s² – rolling resistance, Crr 0.012 × g
    aeroK: 0.00035,            // 1/m – ½ρ·CdA/m (CdA 0,65 m²): 0,02 m/s² at 30 km/h
    engineBrake: 0.08,         // 1/s – engine braking above creep speed in D/R off the gas …
    engineBrakeMax: 0.5,       // m/s² … capped (coasting in D from 30 km/h loses ~0,6 m/s² in total)
    // brake: friction, never pushes; decel = brakeMax · pedal^brakeCurve
    brakeMax: 8.5,             // m/s² – full pedal on dry asphalt (ABS stop ≈ 0,87 g)
    brakeCurve: 1.5,           // progressive servo feel: 25 % pedal ≈ 1,1 m/s² (less than the creep pull), 50 % ≈ 3 m/s²
    // pedal travel (keys are on/off; the pedal moves)
    brakeBite: 0.25, brakeBiteTime: 0.15,   // first light "bite" after 0,15 s
    brakeFullTime: 0.80,                     // full pedal after 0,8 s of holding Q
    brakeReleaseTime: 0.15,                  // foot off the brake: pedal fully up in 0,15 s
    gasApplyTime: 1.0, gasReleaseTime: 0.25, // gas pedal: 0 -> 1 in 1 s, released in 0,25 s
    // steering
    steerRate: 1 / 1.4,        // steer units/s: full lock (1,5 turns = 540°) in 1,4 s ≈ 385°/s hand speed
    selfAlignK: 0.0021,        // 1/s per (m/s)³ – return-to-centre rate = K·v³·steer:
                               //   5 km/h: ≈3°/s of steering wheel at lock, 15 km/h: ≈75°/s, 30 km/h: ≈650°/s
    selfAlignFreeze: 0.03,     // no self-aligning within 3 % of full lock (a wheel left at lock at creep stays at lock)
    // misc
    shiftMaxSpeed: 0.3,        // m/s – "standing still" for shift lock (P, R, R->D)
    kerbHeight: 0.12,          // m – kerb face height (tyre outline at this height decides the contact)
    curbHardSpeed: 0.9,        // m/s (3,2 km/h) – touching the kerb faster than this is a hard hit
    substep: 1 / 240           // s – fixed physics step (real-time accumulator, render pose interpolated)
  };

  // ---------------------------------------------------------------------
  // Scenario 1: Paralel park (sağa, geri geri)
  // Box: x 0..7.5, z 0..2.5 ; curb (kaldırım) face along z = 2.5
  // ---------------------------------------------------------------------
  var BL = 7.5;   // box length (tuned: 6.5–7.0 m left a too narrow stop window for this car)
  var parallel = {
    id: 'parallel',
    name: 'Paralel Park',
    shortName: 'Paralel',
    description: 'Sağdaki dubalı alana geri geri paralel park (alıştırma ölçüsü: 7,5 m × 2,5 m, yaklaşık araç boyunun 1,85 katı).',
    signal: 'right',
    start: { x: -8.0, z: -1.475, heading: HALF_PI },   // right side 0.60 m from the cone line (z = 0): standard 50–70 cm
    cones: [
      { id: 'c1', x: BL, z: 0.0,  role: 'onIc',   label: 'öndeki duba (yol tarafı)' },
      { id: 'c2', x: 0.0, z: 0.0, role: 'arkaIc', label: 'arkadaki duba (yol tarafı)' },
      { id: 'c3', x: 0.0, z: 2.35, role: 'arkaDis', label: 'arka-dış duba (kaldırım tarafı)' },
      { id: 'c4', x: BL, z: 2.35, role: 'onDis',  label: 'ön-dış duba (kaldırım tarafı)' },
      { id: 'c5', x: 0.0, z: 1.18, role: 'arkaOrta', label: 'arka orta duba' },
      { id: 'c6', x: BL, z: 1.18, role: 'onOrta', label: 'ön orta duba' }
    ],
    lines: [
      { x1: 0, z1: 0, x2: BL, z2: 0, color: 'white', dashed: true },
      { x1: 0, z1: 0, x2: 0, z2: 2.5, color: 'white', dashed: false },
      { x1: BL, z1: 0, x2: BL, z2: 2.5, color: 'white', dashed: false },
      { x1: -22, z1: -3.6, x2: 28, z2: -3.6, color: 'white', dashed: true },   // lane divider
      { x1: -22, z1: -7.0, x2: 28, z2: -7.0, color: 'yellow', dashed: false }  // far road edge
    ],
    curbs: [
      { x1: -22, z1: 2.5, x2: 28, z2: 2.5 }
    ],
    box: {
      corners: [ { x: 0, z: 0 }, { x: BL, z: 0 }, { x: BL, z: 2.5 }, { x: 0, z: 2.5 } ],
      heading: HALF_PI          // target heading: facing +X (no folding)
    },
    road: { xMin: -22, xMax: 28, zMin: -7.4, zMax: 2.5 },
    topView: { cx: 2.0, cz: -1.6, width: 26, height: 9.6 },
    lesson: {
      coneLineZ: 0.0,           // z of the lane-side cone line
      curbZ: 2.5,
      // ---- tuned by dev/sim-lessons.js ----
      // step "pass": rear bumper relative to c1 (m; negative = not yet past). -0.65 = c1 level with the right REAR WHEEL
      // (the taught reference). Geometry (dev/sim-explore.js): with this car (10,4 m turning circle) a stop with the rear
      // bumper level with / past c1 only allows 27–42° (45° would put the front-right corner on c1 or the tyres on the
      // kerb); with c1 at the rear wheel the first-arc window is 32–52° and 45° sits inside it.
      refPast: -0.65,
      stop1: { min: -0.90, max: 0.30, core: -0.35 },   // up to +0,30 the method still works (smaller angle); core = target after an overshoot
      targetGap: 0.30,          // planning gap used to predict the rest of the manoeuvre (m)
      ghostGap: 0.25,           // curb gap of the ghost target pose (m)
      // step "arc1": stop when the predicted final rear-bumper x >= rearMin while the predicted rest keeps >= clearMin from all cones
      arc1: { rearMin: 0.6, clearMin: 0.06, maxDeg: 55 },
      // step "back": stop when the predicted final curb gap <= gapTrigger; "over" below gapMin
      gapTrigger: 0.42, gapMin: 0.08, gapCore: 0.20, arc2ClearMin: 0.05,
      // step "arc2": stop when heading <= trigger (deg); "over" below min
      arc2: { trigger: 7.0, min: -4.5, curbMin: 0.10, curbCore: 0.13 },  // + 'over' when nose-in and the front tyre is < curbMin from the curb
      centreTol: 0.60            // centring tolerance along the box (m)
    }
  };

  // ---------------------------------------------------------------------
  // Scenario 2: Geri geri dik park (garaj / L park)
  // Bay: x -1.5..1.5, z 0..5.2 (mouth on z = 0 facing the lane), back curb at z = 5.8
  // ---------------------------------------------------------------------
  var perpendicular = {
    id: 'perpendicular',
    name: 'Geri Geri Dik Park',
    shortName: 'Dik (garaj)',
    description: 'Sağdaki 3,0 m × 5,2 m dubalı cebe geri geri, 90° ile girme (alıştırma ölçüsü).',
    signal: 'right',
    start: { x: -12.0, z: -2.375, heading: HALF_PI },   // right side 1.5 m from the bay mouth line (standard approach)
    cones: [
      { id: 'p1', x: 1.5,  z: 0.0, role: 'agizYakin', label: 'ağızdaki yakın duba (geçtiğin son duba)' },
      { id: 'p2', x: -1.5, z: 0.0, role: 'agizUzak',  label: 'ağızdaki uzak duba (ilk geçtiğin duba)' },
      { id: 'p3', x: 1.5,  z: 2.6, role: 'yanSag',    label: 'yan duba (araç girince sağ tarafın)' },
      { id: 'p4', x: -1.5, z: 2.6, role: 'yanSol',    label: 'yan duba (araç girince sol tarafın)' },
      { id: 'p5', x: 1.5,  z: 5.2, role: 'dipSag',    label: 'dip duba' },
      { id: 'p6', x: -1.5, z: 5.2, role: 'dipSol',    label: 'dip duba' }
    ],
    lines: [
      { x1: -1.5, z1: 0, x2: 1.5, z2: 0, color: 'white', dashed: true },
      { x1: -1.5, z1: 0, x2: -1.5, z2: 5.2, color: 'white', dashed: false },
      { x1: 1.5, z1: 0, x2: 1.5, z2: 5.2, color: 'white', dashed: false },
      { x1: -1.5, z1: 5.2, x2: 1.5, z2: 5.2, color: 'white', dashed: false },
      { x1: -22, z1: -4.9, x2: 22, z2: -4.9, color: 'white', dashed: true },
      { x1: -22, z1: -8.6, x2: 22, z2: -8.6, color: 'yellow', dashed: false }
    ],
    curbs: [
      { x1: -22, z1: 5.8, x2: 22, z2: 5.8 }
    ],
    box: {
      corners: [ { x: -1.5, z: 0 }, { x: 1.5, z: 0 }, { x: 1.5, z: 5.2 }, { x: -1.5, z: 5.2 } ],
      heading: Math.PI          // car ends nose-out (facing -Z); no folding
    },
    road: { xMin: -22, xMax: 22, zMin: -9.0, zMax: 5.8 },
    topView: { cx: -2.0, cz: -1.5, width: 24, height: 14.8 },
    lesson: {
      bayCx: 0.0,
      mouthZ: 0.0,
      backZ: 5.2,
      // ---- tuned by dev/sim-lessons.js ----
      // Single full-lock arc geometry (dev/sim-explore.js perp 3.0): the inner (right) side sweeps past p1 only if the
      // approach gap is >= ~1.2 m; at 1.5 m the usable stop window is rear axle 3.30–3.75 m past the bay centre.
      gapNominal: 1.5,
      gapRange: { min: 1.3, max: 2.0 },    // right side to bay mouth line during approach (m)
      refBumperPast: 1.3,                  // taught stop: rear bumper ~1,3 m past the near mouth cone p1
      stop1: { min: 3.24, max: 4.10, core: 3.62 },   // rear-axle x past bay centre line (m); 'over' also when the predicted arc touches a cone
      arc: { epsMin: -4.8, epsMax: 4.8, clearMin: 0.06 },  // heading error window (deg) + predicted straight-in clearance (m)
      depth: { trigger: 3.55, max: 4.45 }  // rear-axle depth in the bay (m from mouth line)
    }
  };

  PS.config.scenarios = { parallel: parallel, perpendicular: perpendicular };
  PS.config.scenarioOrder = ['parallel', 'perpendicular'];
})(typeof window !== 'undefined' ? window : this);
