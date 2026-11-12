/* PS.carModel – procedural hatchback (exterior + interior), three.js r128.
 * Grafik modülü. Classic script, no modules. Nothing runs at load time.
 *
 * Car-local frame: origin = centre of rear axle on the ground, +Z forward,
 * +Y up, +X = car's LEFT (driver side, LHD). Nominal design numbers are for
 * the config car (4.05 x 1.75 x 1.45, rear bumper z=-0.65, front z=+3.40);
 * the body group is scaled if PS.config.car differs.
 */
(function () {
  'use strict';
  var PS = window.PS = window.PS || {};

  var DEG = Math.PI / 180;
  var BELT = 0.97;      // beltline (window sill) height
  var TUMBLE = 0.30;    // inward lean of the greenhouse per metre of height
  var LAYER_TOP = 1;    // bird's-eye-only overlays

  var DEFAULT_CAR = {
    length: 4.05, width: 1.75, height: 1.45,
    wheelbase: 2.58, rearOverhang: 0.65, frontOverhang: 0.82,
    trackWidth: 1.50, wheelRadius: 0.31,
    maxSteerDeg: 35, steeringWheelLockDeg: 540,
    eye: { x: 0.37, y: 1.18, z: 1.25 }
  };

  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function col(hex) { return new THREE.Color(hex).convertSRGBToLinear(); }

  function mergeCfg(cfg) {
    var c = {}, k;
    cfg = cfg || {};
    for (k in DEFAULT_CAR) c[k] = (k === 'eye') ? DEFAULT_CAR.eye : num(cfg[k], DEFAULT_CAR[k]);
    var e = cfg.eye || {};
    c.eye = { x: num(e.x, DEFAULT_CAR.eye.x), y: num(e.y, DEFAULT_CAR.eye.y), z: num(e.z, DEFAULT_CAR.eye.z) };
    return c;
  }

  function lam(hex, o) {
    o = o || {};
    var m = new THREE.MeshLambertMaterial({ color: col(hex) });
    if (o.emissive != null) m.emissive = col(o.emissive);
    if (o.side) m.side = o.side;
    return m;
  }

  function tumbleX(x, y) {
    var t = Math.max(0, y - BELT) * TUMBLE;
    return x > 0 ? x - t : x + t;
  }
  function applyTumble(g) {
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) p.setX(i, tumbleX(p.getX(i), p.getY(i)));
    p.needsUpdate = true;
    g.computeBoundingBox(); g.computeBoundingSphere();
  }

  function shapeFrom(pts, isPath) {
    var s = isPath ? new THREE.Path() : new THREE.Shape();
    s.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
    if (isPath) s.lineTo(pts[0][0], pts[0][1]);
    return s;
  }
  // Rotation that maps shape (sx=z_car, sy=y_car, sz=extrude) to car (x = xmax - sz, y = sy, z = sx)
  function profileMatrix(xmax) { return new THREE.Matrix4().set(0, 0, -1, xmax, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1); }

  function extrudeX(shape, xa, xb, segs) {
    var xmin = Math.min(xa, xb), xmax = Math.max(xa, xb);
    var g = new THREE.ExtrudeGeometry(shape, { depth: xmax - xmin, bevelEnabled: false, curveSegments: segs || 6 });
    g.applyMatrix4(profileMatrix(xmax));
    return g;
  }
  function flatShapeAtX(shape, x) {
    var g = new THREE.ShapeGeometry(shape);
    g.applyMatrix4(profileMatrix(x));
    return g;
  }

  function quadGeom(a, b, c, d) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z,
      a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z], 3));
    g.computeVertexNormals();
    return g;
  }

  function V(x, y, z) { return new THREE.Vector3(x, y, z); }

  function strut(a, b, w, d, mat) {
    var len = a.distanceTo(b);
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, d, len), mat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.lookAt(b);
    return m;
  }

  function radialTexture(inner, outer) {
    var cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    var ctx = cv.getContext('2d');
    var g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, inner); g.addColorStop(1, outer);
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    var t = new THREE.CanvasTexture(cv);
    return t;
  }

  /* ------------------------------------------------------------------ */
  function lowerSideShape() {
    var s = new THREE.Shape();
    var a0 = Math.PI + 0.302, a1 = -0.302;
    s.moveTo(-0.55, 0.20);
    s.lineTo(-0.353, 0.20);
    s.absarc(0, 0.31, 0.37, a0, a1, true);
    s.lineTo(2.58 - 0.353, 0.20);
    s.absarc(2.58, 0.31, 0.37, a0, a1, true);
    s.lineTo(3.28, 0.20);
    s.lineTo(3.40, 0.32);
    s.lineTo(3.40, 0.68);
    s.lineTo(3.30, 0.84);
    s.lineTo(2.30, BELT);
    s.lineTo(-0.60, BELT);
    s.lineTo(-0.66, 0.90);
    s.lineTo(-0.66, 0.30);
    s.lineTo(-0.55, 0.20);
    return s;
  }

  var FRAME_OUTER = [[2.30, BELT], [1.60, 1.43], [-0.38, 1.43], [-0.64, BELT]];
  var WINDOW_HOLES = [
    [[2.22, 0.995], [1.68, 1.355], [1.02, 1.36], [1.02, 0.995]],          // front door window
    [[0.92, 1.00], [0.92, 1.36], [0.10, 1.36], [0.10, 1.00]],          // rear door window
    [[0.03, 1.00], [0.03, 1.35], [-0.16, 1.35], [-0.40, 1.00]]         // rear quarter window
  ];
  function frameShape() {
    var s = shapeFrom(FRAME_OUTER);
    WINDOW_HOLES.forEach(function (h) { s.holes.push(shapeFrom(h, true)); });
    return s;
  }

  /* ------------------------------------------------------------------ */
  function createCar(cfgIn) {
    var c = mergeCfg(cfgIn);
    var lockRad = c.steeringWheelLockDeg * DEG;
    var maxSteer = c.maxSteerDeg * DEG;

    var root = new THREE.Group(); root.name = 'car';
    var body = new THREE.Group(); body.name = 'carBody'; root.add(body);
    var sx = c.width / 1.75, sy = c.height / 1.45, sz = c.length / 4.05;
    body.scale.set(sx, sy, sz);
    body.position.z = -c.rearOverhang + 0.65 * sz;
    function bodyPoint(x, y, z) { return new THREE.Vector3(x * sx, y * sy, z * sz + body.position.z); }

    var M = {
      body: new THREE.MeshPhongMaterial({ color: col(0xf1f1ef), specular: col(0x3a3a3a), shininess: 45 }),
      pillar: lam(0x3a3d42),
      trim: lam(0x26272a),
      dash: lam(0x2b2d31),
      dashTop: lam(0x1f2023),
      door: lam(0x4a4d53),
      headliner: lam(0xb4b1a9),
      seat: lam(0x35383d),
      floor: lam(0x1c1d20),
      glass: new THREE.MeshPhongMaterial({ color: col(0x2a3a48), transparent: true, opacity: 0.10, depthWrite: false,
        side: THREE.DoubleSide, specular: col(0x777777), shininess: 80 }),
      tyre: lam(0x161616), rim: lam(0xb9bdc3), hub: lam(0x55595f),
      grille: lam(0x18191b), plate: lam(0xf2f2f2),
      head: lam(0xe8eef4, { emissive: 0x2a2e33 }),
      tail: lam(0x5a0b0b), third: lam(0x3a0606),
      indL: lam(0x6e4306), indR: lam(0x6e4306), rev: lam(0xa8a8a8),
      marker: lam(0xffc400, { emissive: 0x4a3200 })
    };
    var ownedMaterials = [];
    for (var mk in M) ownedMaterials.push(M[mk]);

    function addMesh(geo, mat, parent, shadow) {
      var m = new THREE.Mesh(geo, mat);
      if (shadow) m.castShadow = true;
      (parent || body).add(m);
      return m;
    }
    function box(w, h, d, x, y, z, mat, parent, shadow) {
      var m = addMesh(new THREE.BoxGeometry(w, h, d), mat, parent, shadow);
      m.position.set(x, y, z);
      return m;
    }

    /* ---------------- exterior shell ---------------- */
    var lowShape = lowerSideShape();
    var frShape = frameShape();
    [1, -1].forEach(function (sg) {
      addMesh(extrudeX(lowShape, sg * 0.815, sg * 0.875, 10), M.body, body, true);
      // door cards (inner trim of the doors)
      addMesh(extrudeX(shapeFrom([[-0.38, 0.68], [0.42, 0.68], [0.42, 0.30], [2.27, 0.30], [2.27, 0.965], [-0.38, 0.965]]),
        sg * 0.795, sg * 0.815), M.door);
      box(0.075, 0.025, 2.66, sg * 0.815, 0.978, 0.945, M.trim);           // window sill cap
      box(0.06, 0.05, 0.62, sg * 0.77, 0.73, 1.35, M.trim);                // arm rest
      // greenhouse side frame: pillars A/B/C + roof rail, outer (body) and inner (trim)
      var g2 = extrudeX(frShape, sg * 0.80, sg * 0.85); applyTumble(g2); addMesh(g2, M.body, body, true);
      var g3 = extrudeX(frShape, sg * 0.78, sg * 0.80); applyTumble(g3); addMesh(g3, M.pillar);
      // side glass
      WINDOW_HOLES.forEach(function (h) {
        var gg = flatShapeAtX(shapeFrom(h), sg * 0.825); applyTumble(gg); addMesh(gg, M.glass);
      });
      // A-pillar (windshield side frame)
      body.add(strut(V(sg * 0.807, 0.98, 2.27), V(sg * 0.676, 1.42, 1.62), 0.075, 0.05, M.pillar));
    });

    // roof (headliner colour underneath)
    var roof = new THREE.Mesh(new THREE.BoxGeometry(1.44, 0.05, 2.04),
      [M.body, M.body, M.body, M.headliner, M.body, M.body]);
    roof.position.set(0, 1.435, 0.61); roof.castShadow = true; body.add(roof);
    box(1.40, 0.035, 0.03, 0, 1.40, 1.61, M.pillar);                       // windshield header
    box(1.30, 0.04, 0.13, 0, 1.44, -0.44, M.body, body, true);              // spoiler
    box(0.30, 0.025, 0.02, 0, 1.425, -0.505, M.third);                     // 3rd brake light

    // windshield & rear window
    addMesh(quadGeom(V(0.83, BELT, 2.30), V(-0.83, BELT, 2.30), V(-0.69, 1.425, 1.60), V(0.69, 1.425, 1.60)), M.glass);
    addMesh(quadGeom(V(0.82, 0.975, -0.63), V(-0.82, 0.975, -0.63), V(-0.69, 1.425, -0.39), V(0.69, 1.425, -0.39)), M.glass);

    // hood/front block (incl. bumper) and rear block (hatch + bumper)
    addMesh(extrudeX(shapeFrom([[2.28, 0.64], [2.98, 0.64], [2.98, 0.22], [3.28, 0.22], [3.40, 0.33], [3.40, 0.68],
      [3.30, 0.84], [2.28, BELT]]), -0.83, 0.83), M.body, body, true);
    addMesh(extrudeX(shapeFrom([[-0.66, 0.30], [-0.55, 0.22], [-0.40, 0.22], [-0.40, BELT], [-0.60, BELT], [-0.66, 0.90]]),
      -0.83, 0.83), M.body, body, true);
    box(1.64, 0.08, 2.68, 0, 0.26, 0.94, M.floor);                          // floor
    box(1.64, 0.40, 0.04, 0, 0.62, 2.27, M.dash);                           // firewall
    box(0.20, 0.42, 0.80, 0.72, 0.47, 0.0, M.trim);                         // rear wheel housings
    box(0.20, 0.42, 0.80, -0.72, 0.47, 0.0, M.trim);

    // front details
    box(0.90, 0.17, 0.03, 0, 0.50, 3.40, M.grille);
    box(0.52, 0.11, 0.02, 0, 0.35, 3.405, M.plate);
    box(1.50, 0.10, 0.03, 0, 0.32, -0.655, M.trim);
    box(0.52, 0.11, 0.02, 0, 0.55, -0.665, M.plate);
    [1, -1].forEach(function (sg) {
      box(0.36, 0.12, 0.10, sg * 0.56, 0.70, 3.355, M.head);
      box(0.10, 0.06, 0.10, sg * 0.80, 0.70, 3.33, sg > 0 ? M.indL : M.indR);
      box(0.30, 0.15, 0.05, sg * 0.64, 0.85, -0.645, M.tail);
      box(0.14, 0.05, 0.05, sg * 0.66, 0.75, -0.648, sg > 0 ? M.indL : M.indR);
      box(0.10, 0.07, 0.05, sg * 0.44, 0.85, -0.646, M.rev);
      box(0.012, 0.035, 0.08, sg * 0.879, 0.82, 2.70, sg > 0 ? M.indL : M.indR); // side repeater
    });

    /* ---------------- interior ---------------- */
    var dashStd = [[2.29, 0.965], [2.02, 0.995], [1.86, 1.0], [1.80, 0.97], [1.80, 0.80], [1.95, 0.60], [2.27, 0.55]];
    var dashDrv = [[2.29, 0.965], [2.02, 0.995], [2.00, 0.88], [1.82, 0.86], [1.80, 0.80], [1.95, 0.60], [2.27, 0.55]];
    addMesh(extrudeX(shapeFrom(dashStd), -0.80, 0.17), M.dash);
    addMesh(extrudeX(shapeFrom(dashDrv), 0.17, 0.57), M.dash);
    addMesh(extrudeX(shapeFrom(dashStd), 0.57, 0.80), M.dash);
    box(0.42, 0.035, 0.21, 0.37, 1.04, 1.935, M.dashTop);                   // binnacle visor
    box(0.02, 0.18, 0.20, 0.37 + 0.20, 0.95, 1.94, M.dashTop);
    box(0.02, 0.18, 0.20, 0.37 - 0.20, 0.95, 1.94, M.dashTop);
    box(0.26, 0.55, 0.50, 0, 0.56, 2.02, M.dash);                           // centre stack
    box(0.20, 0.10, 0.012, 0, 0.84, 1.775, M.dashTop);                      // radio face
    box(0.22, 0.16, 0.95, 0, 0.38, 1.28, M.dash);                           // tunnel
    var lever = addMesh(new THREE.CylinderGeometry(0.012, 0.012, 0.16, 8), M.trim); lever.position.set(0, 0.54, 1.45);
    var knob = addMesh(new THREE.SphereGeometry(0.03, 10, 8), M.trim); knob.position.set(0, 0.63, 1.45);
    box(0.34, 0.015, 0.16, 0.37, 1.395, 1.52, M.headliner);                 // sun visors
    box(0.34, 0.015, 0.16, -0.37, 1.395, 1.52, M.headliner);

    // instrument dial (canvas texture)
    var dialCanvas = document.createElement('canvas');
    dialCanvas.width = 512; dialCanvas.height = 170;
    var dialCtx = dialCanvas.getContext('2d');
    var dialTex = new THREE.CanvasTexture(dialCanvas);
    dialTex.encoding = THREE.sRGBEncoding;
    var dialMat = new THREE.MeshBasicMaterial({ map: dialTex });
    ownedMaterials.push(dialMat);
    var dial = addMesh(new THREE.PlaneGeometry(0.30, 0.10), dialMat);
    dial.position.set(0.37, 0.935, 1.985);
    root.updateMatrixWorld(true);
    dial.lookAt(V(c.eye.x, c.eye.y, c.eye.z));

    function tri(ctx, x, y, dir, on) {
      ctx.beginPath();
      ctx.moveTo(x + dir * 26, y); ctx.lineTo(x - dir * 4, y - 22); ctx.lineTo(x - dir * 4, y - 9);
      ctx.lineTo(x - dir * 26, y - 9); ctx.lineTo(x - dir * 26, y + 9); ctx.lineTo(x - dir * 4, y + 9);
      ctx.lineTo(x - dir * 4, y + 22); ctx.closePath();
      ctx.fillStyle = on ? '#2bff5a' : '#16301c'; ctx.fill();
    }
    function drawDial(kmh, gear, L, R) {
      var ctx = dialCtx;
      ctx.fillStyle = '#06080b'; ctx.fillRect(0, 0, 512, 170);
      ctx.lineWidth = 12; ctx.lineCap = 'round';
      ctx.strokeStyle = '#26303b';
      ctx.beginPath(); ctx.arc(256, 160, 125, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke();
      var f = Math.max(0, Math.min(1, kmh / 60));
      if (f > 0.001) {
        ctx.strokeStyle = '#7fd4ff';
        ctx.beginPath(); ctx.arc(256, 160, 125, Math.PI * 1.08, Math.PI * (1.08 + 0.84 * f)); ctx.stroke();
      }
      ctx.fillStyle = '#eef3f8'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.font = 'bold 70px Arial, sans-serif'; ctx.fillText(String(kmh), 256, 128);
      ctx.font = '22px Arial, sans-serif'; ctx.fillStyle = '#9aa7b4'; ctx.fillText('km/h', 256, 158);
      var gears = ['P', 'R', 'N', 'D'];
      ctx.font = 'bold 30px Arial, sans-serif';
      for (var i = 0; i < 4; i++) {
        var on = gears[i] === gear;
        ctx.fillStyle = on ? (gear === 'R' ? '#ff7060' : '#ffffff') : '#3b4652';
        ctx.fillText(gears[i], 400 + i * 28, 160);
      }
      tri(ctx, 48, 60, -1, L);
      tri(ctx, 464, 60, 1, R);
      dialTex.needsUpdate = true;
    }
    var dialKey = '', dialTime = -1;
    drawDial(0, 'P', false, false);

    // steering wheel
    var swGroup = new THREE.Group();
    swGroup.position.set(0.37, 0.90, 1.66); swGroup.rotation.x = 0.42; body.add(swGroup);
    var swSpin = new THREE.Group(); swGroup.add(swSpin);
    addMesh(new THREE.TorusGeometry(0.185, 0.018, 8, 40), M.trim, swSpin);
    var mark = box(0.034, 0.044, 0.046, 0, 0.185, 0, M.marker, swSpin);
    mark.name = 'steeringTopMarker';
    var hubG = new THREE.CylinderGeometry(0.062, 0.066, 0.05, 18); hubG.rotateX(Math.PI / 2);
    var hub = addMesh(hubG, M.dashTop, swSpin); hub.position.z = 0.02;
    box(0.13, 0.04, 0.02, 0.115, -0.01, 0.02, M.trim, swSpin);
    box(0.13, 0.04, 0.02, -0.115, -0.01, 0.02, M.trim, swSpin);
    box(0.04, 0.12, 0.02, 0, -0.115, 0.02, M.trim, swSpin);
    var colG = new THREE.CylinderGeometry(0.035, 0.045, 0.32, 10); colG.rotateX(Math.PI / 2);
    var column = addMesh(colG, M.dashTop, swGroup); column.position.z = 0.18;

    // seats (no driver headrest – it would sit inside the driver's head)
    function seat(x, withHead) {
      box(0.48, 0.12, 0.50, x, 0.48, 1.08, M.seat);
      var back = box(0.48, 0.60, 0.11, x, 0.80, 0.80, M.seat); back.rotation.x = -0.22;
      if (withHead) { var hr = box(0.25, 0.19, 0.10, x, 1.20, 0.72, M.seat); hr.rotation.x = -0.12; }
    }
    seat(0.37, false); seat(-0.37, true);
    box(1.34, 0.12, 0.46, 0, 0.47, 0.12, M.seat);                           // rear bench
    var rb = box(1.34, 0.52, 0.10, 0, 0.76, -0.22, M.seat); rb.rotation.x = -0.18;
    box(0.24, 0.10, 0.08, 0.40, 1.07, -0.28, M.seat);                       // rear headrests (low)
    box(0.24, 0.10, 0.08, -0.40, 1.07, -0.28, M.seat);
    box(1.56, 0.02, 0.28, 0, 0.965, -0.52, M.dashTop);                      // parcel shelf

    /* ---------------- wheels ---------------- */
    var R = c.wheelRadius, halfTrack = c.trackWidth / 2;
    var tyreG = new THREE.CylinderGeometry(R, R, 0.19, 22); tyreG.rotateZ(Math.PI / 2);
    var rimG = new THREE.CylinderGeometry(R * 0.62, R * 0.62, 0.194, 16); rimG.rotateZ(Math.PI / 2);
    var spokeG = new THREE.BoxGeometry(0.012, R * 1.15, 0.05);
    var wheels = [];
    [[1, 0, false], [-1, 0, false], [1, c.wheelbase, true], [-1, c.wheelbase, true]].forEach(function (w) {
      var pivot = new THREE.Group(); pivot.position.set(w[0] * halfTrack, R, w[1]); root.add(pivot);
      var spin = new THREE.Group(); pivot.add(spin);
      var ty = new THREE.Mesh(tyreG, M.tyre); ty.castShadow = true; spin.add(ty);
      spin.add(new THREE.Mesh(rimG, M.rim));
      for (var k = 0; k < 5; k++) {
        var sp = new THREE.Mesh(spokeG, M.hub);
        sp.position.x = w[0] * 0.098; sp.rotation.x = k * Math.PI * 2 / 5; spin.add(sp);
      }
      wheels.push({ pivot: pivot, spin: spin, front: w[2] });
    });

    /* ---------------- contact shadow blob ---------------- */
    var blobTex = (function () {
      var cv = document.createElement('canvas'); cv.width = 64; cv.height = 128;
      var ctx = cv.getContext('2d');
      ctx.filter = 'blur(9px)';
      ctx.fillStyle = 'rgba(0,0,0,1)';
      ctx.fillRect(14, 14, 36, 100);
      var t = new THREE.CanvasTexture(cv); return t;
    })();
    var blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, opacity: 0.55, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    ownedMaterials.push(blobMat);
    var blobG = new THREE.PlaneGeometry(c.width + 0.7, c.length + 0.9); blobG.rotateX(-Math.PI / 2);
    var blob = new THREE.Mesh(blobG, blobMat);
    blob.position.set(0, 0.022, (c.wheelbase + c.frontOverhang - c.rearOverhang) / 2);
    blob.renderOrder = 1;
    root.add(blob);

    /* ---------------- bird's-eye overlays (layer 1 only) ---------------- */
    var ovY = c.height + 0.25;
    var ov = new THREE.Group(); root.add(ov);
    var glowTex = radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)');
    function ovMat(hex, op, additive, map) {
      var m = new THREE.MeshBasicMaterial({ color: col(hex), transparent: true, opacity: op, depthTest: false, depthWrite: false });
      if (additive) m.blending = THREE.AdditiveBlending;
      if (map) m.map = map;
      ownedMaterials.push(m);
      return m;
    }
    function ovRect(w, l, x, z, mat, parent) {
      var g = new THREE.PlaneGeometry(w, l); g.rotateX(-Math.PI / 2);
      var m = new THREE.Mesh(g, mat);
      m.position.set(x, parent ? 0 : ovY, z);
      m.renderOrder = 20; m.layers.set(LAYER_TOP);
      (parent || ov).add(m);
      return m;
    }
    var front = c.wheelbase + c.frontOverhang, rear = -c.rearOverhang, hw = c.width / 2;
    var ovWheelMat = ovMat(0x101010, 0.82);
    var ovWheels = [];
    wheels.forEach(function (w) {
      var g = new THREE.Group(); g.position.set(w.pivot.position.x, ovY + 0.01, w.pivot.position.z); ov.add(g);
      ovRect(0.21, 2 * R, 0, 0, ovWheelMat, g);
      ovWheels.push({ g: g, front: w.front });
    });
    // tinted glass footprints so front/rear read clearly from above
    var ovGlassMat = ovMat(0x16202b, 0.62);
    var ws = ovRect(1.46 * sx, 0.68 * sz, 0, bodyPoint(0, 0, 1.95).z, ovGlassMat); ws.renderOrder = 19;
    var rw = ovRect(1.40 * sx, 0.24 * sz, 0, bodyPoint(0, 0, -0.51).z, ovGlassMat); rw.renderOrder = 19;
    var ovHeadMat = ovMat(0xfff4c2, 0.95);
    var ovTailMat = ovMat(0x7a1010, 0.95);
    var ovRevMat = ovMat(0xffffff, 1.0);
    var ovIndMat = ovMat(0xffa000, 1.0);
    var ovGlowInd = ovMat(0xffa000, 0.9, true, glowTex);
    var ovGlowBrake = ovMat(0xff2020, 0.8, true, glowTex);
    var ovGlowRev = ovMat(0xffffff, 0.7, true, glowTex);
    var ovRev = [], ovIndL = [], ovIndR = [], ovBrakeGlow = [], ovRevGlow = [];
    [1, -1].forEach(function (sg) {
      ovRect(0.34, 0.11, sg * 0.56, front - 0.08, ovHeadMat);
      ovRect(0.32, 0.10, sg * 0.60, rear + 0.07, ovTailMat);
      ovRev.push(ovRect(0.12, 0.10, sg * 0.33, rear + 0.07, ovRevMat));
      var arr = sg > 0 ? ovIndL : ovIndR;
      arr.push(ovRect(0.16, 0.16, sg * (hw - 0.08), front - 0.12, ovIndMat));
      arr.push(ovRect(0.16, 0.16, sg * (hw - 0.08), rear + 0.12, ovIndMat));
      arr.push(ovRect(1.1, 1.1, sg * (hw + 0.05), front - 0.05, ovGlowInd));
      arr.push(ovRect(1.1, 1.1, sg * (hw + 0.05), rear + 0.05, ovGlowInd));
      ovBrakeGlow.push(ovRect(0.9, 0.9, sg * 0.6, rear - 0.05, ovGlowBrake));
      ovRevGlow.push(ovRect(0.7, 0.7, sg * 0.33, rear - 0.10, ovGlowRev));
    });

    /* ---------------- state application ---------------- */
    var C_OFF = col(0x000000);
    var C_AMBER = col(0xffa000), C_BRAKE = col(0xff1a1a), C_TAIL = col(0x5a0808), C_REV = col(0xffffff);
    var C_OVTAIL = col(0x7a1010), C_OVBRAKE = col(0xff2a2a);

    function setVis(arr, v) { for (var i = 0; i < arr.length; i++) arr[i].visible = v; }

    function update(s, time) {
      s = s || {};
      var cs = s.car || {};
      var steerAngle = num(cs.steerAngle, num(cs.steer, 0) * maxSteer);
      var steer = num(cs.steer, maxSteer ? steerAngle / maxSteer : 0);
      steer = Math.max(-1.25, Math.min(1.25, steer));
      var wr = num(cs.wheelRot, 0);
      for (var i = 0; i < wheels.length; i++) {
        wheels[i].pivot.rotation.y = wheels[i].front ? -steerAngle : 0;
        wheels[i].spin.rotation.x = wr;
        ovWheels[i].g.rotation.y = wheels[i].front ? -steerAngle : 0;
      }
      swSpin.rotation.z = steer * lockRad;   // + = clockwise for the driver

      var sig = s.signal;
      var blink = !!s.blinkOn;
      var L = blink && (sig === 'left' || sig === 'hazard');
      var Rr = blink && (sig === 'right' || sig === 'hazard');
      M.indL.emissive.copy(L ? C_AMBER : C_OFF);
      M.indR.emissive.copy(Rr ? C_AMBER : C_OFF);
      setVis(ovIndL, L); setVis(ovIndR, Rr);

      var brake = !!s.brake;
      M.tail.emissive.copy(brake ? C_BRAKE : C_TAIL);
      M.third.emissive.copy(brake ? C_BRAKE : C_OFF);
      ovTailMat.color.copy(brake ? C_OVBRAKE : C_OVTAIL);
      setVis(ovBrakeGlow, brake);

      var rev = s.gear === 'R';
      M.rev.emissive.copy(rev ? C_REV : C_OFF);
      setVis(ovRev, rev); setVis(ovRevGlow, rev);

      var kmh = Math.round(Math.abs(num(cs.speed, 0)) * 3.6);
      var gear = (typeof s.gear === 'string') ? s.gear : 'P';
      var key = kmh + '|' + gear + '|' + L + '|' + Rr;
      var t = num(time, 0);
      if (key !== dialKey) {
        var onlySpeed = dialKey && key.split('|').slice(1).join('|') === dialKey.split('|').slice(1).join('|');
        if (!onlySpeed || Math.abs(t - dialTime) > 0.1 || t < dialTime) {
          drawDial(kmh, gear, L, Rr); dialKey = key; dialTime = t;
        }
      }
    }

    root.traverse(function (o) { if (o.isMesh && o.layers.mask === 1) o.receiveShadow = false; });

    return {
      root: root,
      body: body,
      config: c,
      materials: M,
      bodyPoint: bodyPoint,
      wheels: wheels,
      steeringWheel: swSpin,
      update: update,
      frontZ: front, rearZ: rear
    };
  }

  PS.carModel = { create: createCar, tumbleX: tumbleX, BELT: BELT, LAYER_TOP: LAYER_TOP, mergeCfg: mergeCfg };
})();
