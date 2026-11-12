/* PS.world – scene, course, cameras, viewports (three.js r128).
 * Grafik modülü. Classic script; real work starts in PS.world.init().
 *
 * Layers: 0 = everything shared, 1 = bird's-eye-only overlays,
 *         2 = mirror glass surfaces (never rendered by mirror cameras).
 * Top half of the window: orthographic bird's-eye view (screen-right = +X,
 * screen-down = +Z). Bottom half: first-person driver view.
 */
(function () {
  'use strict';
  var PS = window.PS = window.PS || {};

  var DEG = Math.PI / 180;
  var L_TOP = 1, L_SURF = 2;
  var Y = { road: 0.010, box: 0.016, line: 0.020, guide: 0.026, path: 0.032, ring: 0.036 };

  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function smooth(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function col(hex) { return new THREE.Color(hex).convertSRGBToLinear(); }

  var R = {
    renderer: null, scene: null, canvas: null,
    topCam: null, drvCam: null, car: null, mirrors: null,
    sun: null, sky: null,
    courseGroup: null, guideGroup: null, hlGroup: null, pathGroup: null,
    course: null, insets: { left: 0, right: 0, top: 0, bottom: 0 },
    w: 1, h: 1, topH: 1, dpr: 1, clock: 0,
    carPose: { x: 0, z: 0, h: 0 }, guide: null, highlights: [], hlColor: null,
    pathOn: false, path: null, shared: {}, textures: {}, errLogged: false, mirrorsValid: false,
    driverVFov: 50 * DEG, lastState: null,
    deviceDpr: 1, frameNo: 0, lastT: 0, mirrorPasses: 0,
    // adaptive quality: level indexes QUAL_DPR; shadowEvery = shadow-map update interval (frames)
    q: { level: 0, ema: 0, overT: 0, underT: 0, lockUntil: 0, upDelay: 20000, shadowEvery: 1, steps: 0 }
  };
  var QUAL_DPR = [2, 1.5, 1.25, 1.0, 0.85, 0.75];
  function effDpr(level) { return Math.max(0.75, Math.min(R.deviceDpr || 1, QUAL_DPR[level])); }

  /* ------------------------------------------------------------------ */
  /* textures                                                            */
  function noiseTexture(size, base, amp, extra) {
    var cv = document.createElement('canvas'); cv.width = cv.height = size;
    var ctx = cv.getContext('2d');
    var img = ctx.createImageData(size, size), d = img.data;
    for (var i = 0; i < size * size; i++) {
      var n = (Math.random() - 0.5) * 2 * amp;
      d[i * 4] = clamp(base[0] + n, 0, 255);
      d[i * 4 + 1] = clamp(base[1] + n * 1.05, 0, 255);
      d[i * 4 + 2] = clamp(base[2] + n * 0.9, 0, 255);
      d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    if (extra) extra(ctx, size);
    var t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.encoding = THREE.sRGBEncoding;
    t.anisotropy = R.renderer ? Math.min(8, R.renderer.capabilities.getMaxAnisotropy()) : 1;
    return t;
  }
  function makeTextures() {
    R.textures.asphalt = noiseTexture(256, [82, 84, 88], 16, function (ctx, s) {
      for (var i = 0; i < 900; i++) {
        var g = 60 + Math.random() * 90;
        ctx.fillStyle = 'rgba(' + g + ',' + g + ',' + g + ',0.55)';
        ctx.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 2, 1 + Math.random() * 2);
      }
      for (var k = 0; k < 6; k++) {   // faint patches
        ctx.fillStyle = 'rgba(40,40,44,0.08)';
        ctx.beginPath(); ctx.arc(Math.random() * s, Math.random() * s, 20 + Math.random() * 50, 0, 7); ctx.fill();
      }
    });
    R.textures.grass = noiseTexture(256, [92, 132, 62], 22, function (ctx, s) {
      for (var i = 0; i < 1400; i++) {
        ctx.fillStyle = Math.random() < 0.5 ? 'rgba(60,100,40,0.5)' : 'rgba(130,160,80,0.4)';
        ctx.fillRect(Math.random() * s, Math.random() * s, 1, 2 + Math.random() * 3);
      }
    });
    R.textures.concrete = noiseTexture(128, [176, 174, 166], 10, function (ctx, s) {
      ctx.strokeStyle = 'rgba(90,90,85,0.6)'; ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, s - 2, s - 2);
    });
    var blob = document.createElement('canvas'); blob.width = blob.height = 64;
    var bx = blob.getContext('2d'); var gr = bx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    bx.fillStyle = gr; bx.fillRect(0, 0, 64, 64);
    R.textures.glow = new THREE.CanvasTexture(blob);
  }

  /* ------------------------------------------------------------------ */
  /* geometry helpers                                                    */
  // ensure every triangle of a ground decal faces +Y and normals are up
  function faceUp(g) {
    var p = g.attributes.position, idx = g.index;
    var n = idx ? idx.count : p.count, i, a, b, c;
    var arr = idx ? Array.prototype.slice.call(idx.array) : null;
    for (i = 0; i < n; i += 3) {
      a = arr ? arr[i] : i; b = arr ? arr[i + 1] : i + 1; c = arr ? arr[i + 2] : i + 2;
      var e1x = p.getX(b) - p.getX(a), e1z = p.getZ(b) - p.getZ(a);
      var e2x = p.getX(c) - p.getX(a), e2z = p.getZ(c) - p.getZ(a);
      var ny = e1z * e2x - e1x * e2z;
      if (ny < 0) {
        if (arr) { arr[i + 1] = c; arr[i + 2] = b; }
        else {
          var tx = p.getX(b), ty = p.getY(b), tz = p.getZ(b);
          p.setXYZ(b, p.getX(c), p.getY(c), p.getZ(c)); p.setXYZ(c, tx, ty, tz);
        }
      }
    }
    if (arr) g.setIndex(arr);
    var nrm = new Float32Array(p.count * 3);
    for (i = 0; i < p.count; i++) nrm[i * 3 + 1] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    return g;
  }

  // segs: [[x1,z1,x2,z2],...] -> flat quads (ends extended by w/2 so corners close)
  function segQuads(segs, w, ext) {
    var pos = [], idx = [], hw = w / 2, e = ext == null ? hw : ext;
    segs.forEach(function (s) {
      var dx = s[2] - s[0], dz = s[3] - s[1], L = Math.sqrt(dx * dx + dz * dz);
      if (L < 1e-6) return;
      var ux = dx / L, uz = dz / L, nx = -uz * hw, nz = ux * hw;
      var ax = s[0] - ux * e, az = s[1] - uz * e, bx = s[2] + ux * e, bz = s[3] + uz * e;
      var base = pos.length / 3;
      pos.push(ax + nx, 0, az + nz, ax - nx, 0, az - nz, bx - nx, 0, bz - nz, bx + nx, 0, bz + nz);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return faceUp(g);
  }
  function dashedSegs(x1, z1, x2, z2, dash, gap) {
    var dx = x2 - x1, dz = z2 - z1, L = Math.sqrt(dx * dx + dz * dz), out = [];
    if (L < 1e-6) return out;
    var ux = dx / L, uz = dz / L;
    for (var s = 0; s < L; s += dash + gap) {
      var e = Math.min(L, s + dash);
      out.push([x1 + ux * s, z1 + uz * s, x1 + ux * e, z1 + uz * e]);
    }
    return out;
  }
  function polyFill(pts) {
    var shape = new THREE.Shape();
    shape.moveTo(pts[0].x, -pts[0].z);
    for (var i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, -pts[i].z);
    var g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2);
    return faceUp(g);
  }
  function groundRect(x0, x1, z0, z1, tile) {
    var g = new THREE.PlaneGeometry(x1 - x0, z1 - z0, 1, 1);
    g.rotateX(-Math.PI / 2);
    g.translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
    var p = g.attributes.position, uv = g.attributes.uv;
    for (var i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / tile, -p.getZ(i) / tile);
    return g;
  }
  function decalMat(hex, opacity, lit) {
    var o = { color: col(hex), transparent: opacity < 1, opacity: opacity, depthWrite: opacity >= 1,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, side: THREE.DoubleSide };
    return lit ? new THREE.MeshLambertMaterial(o) : new THREE.MeshBasicMaterial(o);
  }

  // dynamic ribbon (for path preview)
  function makeRibbon(n, mat) {
    var g = new THREE.BufferGeometry();
    var pos = new THREE.BufferAttribute(new Float32Array(n * 6), 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pos);
    var idx = [];
    for (var i = 0; i < n - 1; i++) { var a = 2 * i; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    g.setIndex(idx);
    var m = new THREE.Mesh(g, mat);
    m.frustumCulled = false;
    m.userData.n = n;
    return m;
  }
  function ribbonSet(mesh, pts, width) {
    var n = mesh.userData.n, p = mesh.geometry.attributes.position, hw = width / 2;
    for (var i = 0; i < n; i++) {
      var i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      var tx = pts[i1 * 2] - pts[i0 * 2], tz = pts[i1 * 2 + 1] - pts[i0 * 2 + 1];
      var L = Math.sqrt(tx * tx + tz * tz) || 1;
      var nx = -tz / L * hw, nz = tx / L * hw;
      var x = pts[i * 2], z = pts[i * 2 + 1];
      p.setXYZ(2 * i, x + nx, 0, z + nz);
      p.setXYZ(2 * i + 1, x - nx, 0, z - nz);
    }
    p.needsUpdate = true;
  }

  function disposeTree(obj) {
    obj.traverse(function (o) {
      if (o.geometry && !(o.geometry.userData && o.geometry.userData.shared)) o.geometry.dispose();
      if (o.material) {
        var ms = Array.isArray(o.material) ? o.material : [o.material];
        ms.forEach(function (m) { if (!(m.userData && m.userData.shared)) m.dispose(); });
      }
    });
  }
  function clearGroup(g) {
    while (g.children.length) { var c = g.children[0]; g.remove(c); disposeTree(c); }
  }
  function shareGeo(g) { g.userData.shared = true; return g; }
  function shareMat(m) { m.userData.shared = true; return m; }

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) { var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  /* ------------------------------------------------------------------ */
  /* config access                                                       */
  function carCfg() { return (R.car && R.car.config) || PS.carModel.mergeCfg(PS.config && PS.config.car); }
  function coneCfg() {
    var c = (PS.config && PS.config.cone) || {};
    return { r: num(c.radius, 0.14), h: num(c.height, 0.50) };
  }

  /* ------------------------------------------------------------------ */
  /* init                                                                */
  function init(opts) {
    opts = opts || {};
    var canvas = opts.canvas || document.getElementById('scene');
    if (!canvas) { canvas = document.createElement('canvas'); canvas.id = 'scene'; document.body.appendChild(canvas); }
    R.canvas = canvas;
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = true;
    R.renderer = renderer;
    makeTextures();

    var scene = new THREE.Scene();
    scene.autoUpdate = false;
    var horizon = col(0xdbe6ee);
    scene.background = horizon;
    scene.fog = new THREE.Fog(horizon, 90, 330);
    R.scene = scene;

    // sky dome
    var skyG = new THREE.SphereGeometry(340, 24, 14);
    var cols = [], p = skyG.attributes.position, cTop = col(0x5d9bd6), cHor = col(0xdbe6ee), cLow = col(0xc9d3d6);
    for (var i = 0; i < p.count; i++) {
      var yy = p.getY(i) / 340, cc = new THREE.Color();
      if (yy > 0) cc.copy(cHor).lerp(cTop, Math.pow(yy, 0.6)); else cc.copy(cHor).lerp(cLow, Math.min(1, -yy * 4));
      cols.push(cc.r, cc.g, cc.b);
    }
    skyG.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    R.sky = new THREE.Mesh(skyG, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    R.sky.renderOrder = -10;
    scene.add(R.sky);

    // lights
    var hemi = new THREE.HemisphereLight(col(0xe4eeff), col(0x6f6656), 0.62);
    scene.add(hemi);
    var sun = new THREE.DirectionalLight(col(0xfff6e8), 0.78);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    var sc = sun.shadow.camera; sc.left = -16; sc.right = 16; sc.top = 16; sc.bottom = -16; sc.near = 1; sc.far = 80;
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.02;
    scene.add(sun); scene.add(sun.target);
    R.sun = sun;

    // base grass (static, very large)
    var grass = new THREE.Mesh(groundRect(-700, 700, -700, 700, 6), new THREE.MeshLambertMaterial({ map: R.textures.grass, color: col(0xffffff) }));
    grass.receiveShadow = true;
    scene.add(grass);

    R.courseGroup = new THREE.Group(); scene.add(R.courseGroup);
    R.guideGroup = new THREE.Group(); scene.add(R.guideGroup);
    R.hlGroup = new THREE.Group(); scene.add(R.hlGroup);
    R.pathGroup = new THREE.Group(); R.pathGroup.visible = false; scene.add(R.pathGroup);

    // car
    R.car = PS.carModel.create(PS.config && PS.config.car);
    scene.add(R.car.root);
    R.car.root.traverse(function (o) { if (o.isMesh && !o.castShadow) o.receiveShadow = false; });

    // cameras
    var top = new THREE.OrthographicCamera(-10, 10, 5, -5, 1, 200);
    top.up.set(0, 0, -1);
    top.layers.enable(L_TOP); top.layers.enable(L_SURF);
    R.topCam = top;
    var drv = new THREE.PerspectiveCamera(50, 3, 0.05, 450);
    drv.layers.enable(L_SURF);
    R.car.root.add(drv);
    R.drvCam = drv;

    // mirrors
    R.mirrors = PS.mirrors.create(R.car, renderer);

    // shared cone/highlight geometry
    buildShared();

    // path preview ribbons
    var pm = [decalMat(0x40c4ff, 0.9), decalMat(0xffd54f, 0.9), decalMat(0xffd54f, 0.9)];
    R.path = { ribbons: pm.map(function (m) { var r = makeRibbon(41, m); r.position.y = Y.path; R.pathGroup.add(r); return r; }) };

    window.addEventListener('resize', function () { resize(); });
    resize();
    applyCarPose(0, 0, 0);
    return true;
  }

  function buildShared() {
    var cc = coneCfg(), r = cc.r, h = cc.h, baseH = 0.03, rTop = Math.max(0.02, r * 0.16);
    var S = R.shared;
    S.coneKey = r + '|' + h;
    S.coneBase = shareGeo(new THREE.BoxGeometry(r * 2.6, baseH, r * 2.6)); S.coneBase.translate(0, baseH / 2, 0);
    S.coneBody = shareGeo(new THREE.CylinderGeometry(rTop, r, h - baseH, 18, 1));
    S.coneBody.translate(0, baseH + (h - baseH) / 2, 0);
    function rAt(y) { return r + (rTop - r) * (y - baseH) / (h - baseH); }
    var y0 = baseH + 0.42 * (h - baseH), y1 = baseH + 0.62 * (h - baseH);
    S.coneBand = shareGeo(new THREE.CylinderGeometry(rAt(y1) + 0.004, rAt(y0) + 0.004, y1 - y0, 18, 1, true));
    S.coneBand.translate(0, (y0 + y1) / 2, 0);
    S.coneBaseMat = shareMat(new THREE.MeshLambertMaterial({ color: col(0xd8560e) }));
    S.coneBandMat = shareMat(new THREE.MeshLambertMaterial({ color: col(0xf5f5f5), emissive: col(0x202020) }));
    S.coneTipAngle = Math.PI / 2 - Math.atan2(r, h) * 0.85;
    S.coneR = r; S.coneH = h;
    // highlight pieces
    S.ring = shareGeo(new THREE.RingGeometry(0.34, 0.50, 40)); S.ring.rotateX(-Math.PI / 2);
    S.disc = shareGeo(new THREE.CircleGeometry(0.62, 32)); S.disc.rotateX(-Math.PI / 2);
    S.arrow = shareGeo(new THREE.ConeGeometry(0.17, 0.38, 14)); S.arrow.rotateX(Math.PI); // points down
    S.beam = shareGeo(new THREE.CylinderGeometry(0.025, 0.025, 1, 8, 1, true)); S.beam.translate(0, 0.5, 0);
  }

  /* ------------------------------------------------------------------ */
  /* sizing                                                              */
  // Idempotent: always re-reads the window; only touches the renderer when something changed.
  function resize() {
    if (!R.renderer) return;
    var W = Math.max(1, window.innerWidth || 1), H = Math.max(2, window.innerHeight || 2);
    R.deviceDpr = Math.min(window.devicePixelRatio || 1, 2);
    var dpr = effDpr(R.q.level);
    R.topH = Math.round(H / 2);
    if (W === R.w && H === R.h && dpr === R.dpr) return;
    if (dpr !== R.dpr) R.renderer.setPixelRatio(dpr);
    R.renderer.setSize(W, H, true);
    R.w = W; R.h = H; R.dpr = dpr;
  }
  function needsResize() {
    return window.innerWidth !== R.w || window.innerHeight !== R.h ||
      Math.min(window.devicePixelRatio || 1, 2) !== R.deviceDpr;
  }

  // adaptive resolution with hysteresis (called once per render with the wall-clock frame interval)
  function adaptQuality(ftMs) {
    var q = R.q, now = performance.now(), e = ftMs / 1000;
    q.ema = q.ema ? q.ema * 0.92 + ftMs * 0.08 : ftMs;
    if (q.ema > 22) { q.overT += e; q.underT = 0; }
    else if (q.ema < 18) { q.underT += e; q.overT = 0; }
    else { q.overT = 0; q.underT = 0; }
    var cur = effDpr(q.level), lvl, changed = false;
    if (q.overT > 1.5) {
      q.overT = 0;
      for (lvl = q.level + 1; lvl < QUAL_DPR.length; lvl++) {
        if (effDpr(lvl) < cur) { q.level = lvl; changed = true; break; }
      }
      if (!changed && !q.shadowHalf) { q.shadowHalf = true; changed = true; }   // already at the lowest dpr
      if (changed) {
        q.steps++; q.ema = 16.7;
        q.lockUntil = now + q.upDelay;
        q.upDelay = Math.min(q.upDelay * 2, 600000);          // every drop makes the next climb slower
      }
    } else if (q.underT > 10 && now > q.lockUntil) {
      q.underT = 0;
      if (q.shadowHalf) { q.shadowHalf = false; changed = true; }
      else {
        for (lvl = q.level - 1; lvl >= 0; lvl--) {
          if (effDpr(lvl) > cur) { q.level = lvl; changed = true; break; }
        }
        if (!changed) q.level = 0;
      }
      if (changed) q.lockUntil = now + 10000;
    }
    var d = effDpr(q.level);
    q.shadowEvery = (q.shadowHalf || (d < effDpr(0) && d <= 1.0)) ? 2 : 1;
    if (effDpr(q.level) !== R.dpr) resize();
  }
  function setTopInsets(ins) {
    ins = ins || {};
    R.insets = { left: Math.max(0, num(ins.left, 0)), right: Math.max(0, num(ins.right, 0)),
      top: Math.max(0, num(ins.top, 0)), bottom: Math.max(0, num(ins.bottom, 0)) };
  }

  function updateTopCam() {
    var W = R.w, Hh = R.topH, ins = R.insets;
    var tv = (R.course && R.course.topView) || { cx: 0, cz: 0, width: 30, height: 12 };
    var fx0 = ins.left, fx1 = W - ins.right, fy0 = ins.top, fy1 = Hh - ins.bottom;
    if (fx1 - fx0 < 80) { fx0 = 0; fx1 = W; }
    if (fy1 - fy0 < 60) { fy0 = 0; fy1 = Hh; }
    var s = Math.min((fx1 - fx0) / Math.max(1, tv.width), (fy1 - fy0) / Math.max(1, tv.height));
    s = Math.max(s, 1e-3);
    var cam = R.topCam;
    var cx = tv.cx - ((fx0 + fx1) / 2 - W / 2) / s;
    var cz = tv.cz - ((fy0 + fy1) / 2 - Hh / 2) / s;
    cam.left = -W / 2 / s; cam.right = W / 2 / s; cam.top = Hh / 2 / s; cam.bottom = -Hh / 2 / s;
    cam.near = 1; cam.far = 120;
    cam.updateProjectionMatrix();
    cam.position.set(cx, 60, cz);
    cam.lookAt(cx, 0, cz);
    R.topScale = s;
  }

  function updateDriverProj() {
    var w = R.w, h = Math.max(1, R.h - R.topH), a = w / h;
    var vfov = 50 * DEG, maxH = 115 * DEG;
    if (2 * Math.atan(a * Math.tan(vfov / 2)) > maxH) vfov = 2 * Math.atan(Math.tan(maxH / 2) / a);
    vfov = Math.max(vfov, 40 * DEG);
    var near = 0.05, far = 450, t = near * Math.tan(vfov / 2) / (R.debugZoom || 1), shift = 0.12;
    var cam = R.drvCam;
    cam.fov = vfov / DEG; cam.aspect = a; cam.near = near; cam.far = far;
    cam.projectionMatrix.makePerspective(-t * a, t * a, t * (1 - shift), -t * (1 + shift), near, far);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    R.driverVFov = vfov;
  }

  function updateHead(head) {
    head = head || {};
    var c = carCfg(), e = c.eye;
    var yaw = clamp(num(head.yaw, 0), -2.7, 2.7), pitch = clamp(num(head.pitch, 0), -1.2, 1.2);
    var ay = Math.abs(yaw), sg = yaw >= 0 ? 1 : -1;
    var lean = smooth(0.8, 2.1, ay) * 0.11 * sg;
    var rise = smooth(1.2, 2.2, ay) * 0.03;
    var cam = R.drvCam;
    cam.position.set(e.x + lean + Math.sin(yaw) * 0.09, e.y + rise, e.z - 0.09 + Math.cos(yaw) * 0.09);
    cam.rotation.set(pitch, Math.PI + yaw, 0, 'YXZ');
  }

  function applyCarPose(x, z, h) {
    R.carPose.x = x; R.carPose.z = z; R.carPose.h = h;
    R.car.root.position.set(x, 0, z);
    R.car.root.rotation.set(0, h, 0);
    var sx = x + Math.sin(h) * 1.3, sz = z + Math.cos(h) * 1.3;
    R.sun.position.set(sx - 11, 24, sz - 15);
    R.sun.target.position.set(sx, 0, sz);
    R.sky.position.set(x, 0, z);
  }

  /* ------------------------------------------------------------------ */
  /* scenario                                                            */
  function loadScenario(scn) {
    if (!R.renderer) return;
    clearGroup(R.courseGroup);
    clearHighlights();
    setGuide(null);
    R.course = null;
    if (!scn) return;
    var cc = coneCfg();
    if (R.shared.coneKey !== cc.r + '|' + cc.h) buildShared();

    var course = { scn: scn, cones: {}, coneList: [], topView: null };
    var g = R.courseGroup;

    // road extents (fallback: bounds of cones / box)
    var rd = scn.road;
    if (!rd || !isFinite(rd.xMin)) {
      var xs = [0], zs = [0];
      (scn.cones || []).forEach(function (c) { xs.push(c.x); zs.push(c.z); });
      rd = { xMin: Math.min.apply(null, xs) - 15, xMax: Math.max.apply(null, xs) + 15, zMin: Math.min.apply(null, zs) - 6, zMax: Math.max.apply(null, zs) + 2 };
    }
    var rcx = (rd.xMin + rd.xMax) / 2, rcz = (rd.zMin + rd.zMax) / 2;
    course.roadCenter = { x: rcx, z: rcz };

    var asphalt = new THREE.Mesh(groundRect(rd.xMin, rd.xMax, rd.zMin, rd.zMax, 4),
      new THREE.MeshLambertMaterial({ map: R.textures.asphalt, color: col(0xffffff), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
    asphalt.position.y = Y.road; asphalt.receiveShadow = true;
    g.add(asphalt);

    // painted lines
    var whiteSegs = [], yellowSegs = [];
    (scn.lines || []).forEach(function (l) {
      if (!l || !isFinite(l.x1) || !isFinite(l.z1) || !isFinite(l.x2) || !isFinite(l.z2)) return;
      var segs = l.dashed ? dashedSegs(l.x1, l.z1, l.x2, l.z2, 1.0, 1.0) : [[l.x1, l.z1, l.x2, l.z2]];
      Array.prototype.push.apply(l.color === 'yellow' ? yellowSegs : whiteSegs, segs);
    });
    if (whiteSegs.length) { var wl = new THREE.Mesh(segQuads(whiteSegs, 0.12, 0), decalMat(0xf2f2ee, 1, true)); wl.position.y = Y.line; wl.receiveShadow = true; g.add(wl); }
    if (yellowSegs.length) { var yl = new THREE.Mesh(segQuads(yellowSegs, 0.12, 0), decalMat(0xf0c419, 1, true)); yl.position.y = Y.line; yl.receiveShadow = true; g.add(yl); }

    // curbs + sidewalk
    var curbMat = new THREE.MeshLambertMaterial({ color: col(0xcfccc4) });
    var walkMat = new THREE.MeshLambertMaterial({ map: R.textures.concrete, color: col(0xffffff) });
    (scn.curbs || []).forEach(function (cb) {
      if (!cb || !isFinite(cb.x1) || !isFinite(cb.x2)) return;
      var dx = cb.x2 - cb.x1, dz = cb.z2 - cb.z1, L = Math.sqrt(dx * dx + dz * dz);
      if (L < 0.01) return;
      var ang = Math.atan2(-dz, dx);
      var mx = (cb.x1 + cb.x2) / 2, mz = (cb.z1 + cb.z2) / 2;
      var nx = -dz / L, nz = dx / L;
      if ((mx - rcx) * nx + (mz - rcz) * nz < 0) { nx = -nx; nz = -nz; }
      var curb = new THREE.Mesh(new THREE.BoxGeometry(L + 0.3, 0.15, 0.30), curbMat);
      curb.position.set(mx + nx * 0.15, 0.075, mz + nz * 0.15); curb.rotation.y = ang;
      curb.castShadow = true; curb.receiveShadow = true; g.add(curb);
      var wg = new THREE.BoxGeometry(L + 0.3, 0.12, 2.6);
      var uv = wg.attributes.uv; var pp = wg.attributes.position;
      for (var i = 0; i < uv.count; i++) uv.setXY(i, (pp.getX(i) + L) / 1.0, pp.getZ(i) / 1.0);
      var walk = new THREE.Mesh(wg, walkMat);
      walk.position.set(mx + nx * (0.30 + 1.3), 0.06, mz + nz * (0.30 + 1.3)); walk.rotation.y = ang;
      walk.receiveShadow = true; g.add(walk);
    });

    // parking box: very faint fill (always)
    if (scn.box && scn.box.corners && scn.box.corners.length >= 3) {
      var bf = new THREE.Mesh(polyFill(scn.box.corners), decalMat(0xffffff, 0.07));
      bf.position.y = Y.box; g.add(bf);
    }

    // cones
    (scn.cones || []).forEach(function (cd) {
      if (!cd || !isFinite(cd.x) || !isFinite(cd.z)) return;
      var cone = makeCone(cd);
      g.add(cone.root);
      course.cones[cd.id] = cone; course.coneList.push(cone);
    });

    // top view
    var tv = scn.topView;
    if (!tv || !isFinite(tv.cx)) tv = { cx: rcx, cz: rcz, width: Math.max(10, rd.xMax - rd.xMin), height: Math.max(6, rd.zMax - rd.zMin) };
    course.topView = { cx: tv.cx, cz: tv.cz, width: Math.max(1, num(tv.width, 20)), height: Math.max(1, num(tv.height, 10)) };

    buildProps(g, scn, rd, course.topView);
    R.course = course;
  }

  function makeCone(cd) {
    var S = R.shared;
    var root = new THREE.Group(); root.position.set(cd.x, 0, cd.z);
    root.name = 'cone-' + cd.id;
    var tip = new THREE.Group(); root.add(tip);
    var bodyMat = new THREE.MeshLambertMaterial({ color: col(0xff6a10), emissive: col(0x000000) });
    var base = new THREE.Mesh(S.coneBase, S.coneBaseMat); base.castShadow = true; base.receiveShadow = true;
    var body = new THREE.Mesh(S.coneBody, bodyMat); body.castShadow = true;
    var band = new THREE.Mesh(S.coneBand, S.coneBandMat);
    tip.add(base); tip.add(body); tip.add(band);
    return { id: cd.id, x: cd.x, z: cd.z, root: root, tip: tip, mat: bodyMat, hit: false, t: 1, dir: { x: 1, z: 0 }, hl: 0 };
  }

  function buildProps(g, scn, rd, tv) {
    var rng = mulberry32(hashStr(scn.id || 'course'));
    var cx = (rd.xMin + rd.xMax) / 2, cz = (rd.zMin + rd.zMax) / 2;
    var halfX = (rd.xMax - rd.xMin) / 2, halfZ = (rd.zMax - rd.zMin) / 2;
    function blocked(x, z, m) {
      if (x > rd.xMin - m && x < rd.xMax + m && z > rd.zMin - m && z < rd.zMax + m) return true;
      if (x > tv.cx - tv.width / 2 - 3 && x < tv.cx + tv.width / 2 + 3 && z > tv.cz - tv.height / 2 - 3 && z < tv.cz + tv.height / 2 + 3) return true;
      return false;
    }
    var trees = [], i, tries;
    for (tries = 0; trees.length < 54 && tries < 800; tries++) {
      var a = rng() * Math.PI * 2, rr = 14 + rng() * 75;
      var x = cx + Math.cos(a) * (halfX + rr), z = cz + Math.sin(a) * (halfZ + rr);
      if (blocked(x, z, 9)) continue;
      trees.push([x, z, 0.75 + rng() * 0.7, rng()]);
    }
    // a row of trees along the far side of the sidewalk for motion cues
    for (var tx = rd.xMin + 4; tx < rd.xMax; tx += 9 + rng() * 4) {
      if (!blocked(tx, rd.zMax + 6.5, 0)) trees.push([tx, rd.zMax + 6.5 + rng() * 2, 0.7 + rng() * 0.3, rng()]);
      if (!blocked(tx + 3, rd.zMin - 7, 0)) trees.push([tx + 3, rd.zMin - 7 - rng() * 2, 0.7 + rng() * 0.3, rng()]);
    }
    var trunkG = new THREE.CylinderGeometry(0.12, 0.2, 2.0, 6); trunkG.translate(0, 1.0, 0);
    var leafG = new THREE.IcosahedronGeometry(1.5, 0); leafG.translate(0, 3.0, 0);
    var trunk = new THREE.InstancedMesh(trunkG, new THREE.MeshLambertMaterial({ color: col(0x6b4f35) }), trees.length);
    var leaf = new THREE.InstancedMesh(leafG, new THREE.MeshLambertMaterial({ color: col(0xffffff) }), trees.length);
    var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3(), cl = new THREE.Color();
    for (i = 0; i < trees.length; i++) {
      var t = trees[i];
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t[3] * 6.28);
      m4.compose(pv.set(t[0], 0, t[1]), q, sv.set(t[2], t[2] * (0.9 + t[3] * 0.4), t[2]));
      trunk.setMatrixAt(i, m4); leaf.setMatrixAt(i, m4);
      cl.setHSL(0.25 + t[3] * 0.08, 0.45, 0.28 + t[3] * 0.1); cl.convertSRGBToLinear();
      leaf.setColorAt(i, cl);
    }
    if (leaf.instanceColor) leaf.instanceColor.needsUpdate = true;
    g.add(trunk); g.add(leaf);

    // buildings
    var blds = [];
    for (tries = 0; blds.length < 14 && tries < 400; tries++) {
      var a2 = rng() * Math.PI * 2, r2 = 60 + rng() * 60;
      var bx = cx + Math.cos(a2) * (halfX + r2), bz = cz + Math.sin(a2) * (halfZ + r2);
      if (blocked(bx, bz, 25)) continue;
      blds.push([bx, bz, 8 + rng() * 14, 4 + rng() * 12, 8 + rng() * 10, rng()]);
    }
    var bg = new THREE.BoxGeometry(1, 1, 1); bg.translate(0, 0.5, 0);
    var bm = new THREE.InstancedMesh(bg, new THREE.MeshLambertMaterial({ color: col(0xffffff) }), blds.length);
    var palette = [0xd9cbb3, 0xc4c7cc, 0xe0d6c8, 0xb8a58e, 0xcfd6dc, 0xa9b0b8];
    for (i = 0; i < blds.length; i++) {
      var b = blds[i];
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(cz - b[1], cx - b[0]));
      m4.compose(pv.set(b[0], 0, b[1]), q, sv.set(b[2], b[3], b[4]));
      bm.setMatrixAt(i, m4);
      bm.setColorAt(i, col(palette[Math.floor(b[5] * palette.length) % palette.length]));
    }
    if (bm.instanceColor) bm.instanceColor.needsUpdate = true;
    g.add(bm);

    // light poles along the road edges (strong motion cue from the driver's seat)
    var poles = [];
    for (var px = rd.xMin + 6; px < rd.xMax - 2; px += 16) {
      if (!blocked(px, rd.zMin - 1.2, 0)) poles.push([px, rd.zMin - 1.2]);
    }
    var poleG = new THREE.CylinderGeometry(0.06, 0.09, 6, 6); poleG.translate(0, 3, 0);
    var pm = new THREE.InstancedMesh(poleG, new THREE.MeshLambertMaterial({ color: col(0x8a8f96) }), Math.max(1, poles.length));
    pm.count = poles.length;
    for (i = 0; i < poles.length; i++) { m4.makeTranslation(poles[i][0], 0, poles[i][1]); pm.setMatrixAt(i, m4); }
    g.add(pm);
  }

  /* ------------------------------------------------------------------ */
  /* cones: hit / highlight                                              */
  function setConeHit(id, hit) {
    var cone = R.course && R.course.cones[id];
    if (!cone) return;
    if (hit) {
      if (cone.hit) return;
      var p = R.carPose, ccx = p.x + Math.sin(p.h) * 1.29, ccz = p.z + Math.cos(p.h) * 1.29;
      var dx = cone.x - ccx, dz = cone.z - ccz, L = Math.sqrt(dx * dx + dz * dz);
      if (L < 1e-3) { dx = Math.sin(p.h); dz = Math.cos(p.h); L = 1; }
      cone.dir = { x: dx / L, z: dz / L };
      cone.hit = true; cone.t = 0;
      cone.mat.color.copy(col(0xa8361a));
    } else {
      cone.hit = false; cone.t = 1;
      cone.tip.quaternion.identity(); cone.tip.position.set(0, 0, 0);
      cone.mat.color.copy(col(0xff6a10));
    }
  }
  var _q = new THREE.Quaternion(), _k = new THREE.Vector3(), _pv = new THREE.Vector3();
  function poseCone(cone, e) {
    var S = R.shared, d = cone.dir;
    var ang = e * S.coneTipAngle, rb = S.coneR * 1.3;
    _k.set(d.z, 0, -d.x).normalize();
    _q.setFromAxisAngle(_k, ang);
    cone.tip.quaternion.copy(_q);
    _pv.set(d.x * rb, 0, d.z * rb);
    var px = _pv.x, pz = _pv.z;
    _pv.applyQuaternion(_q);
    cone.tip.position.set(px - _pv.x + d.x * 0.3 * e, -_pv.y, pz - _pv.z + d.z * 0.3 * e);
  }
  function animateCones(dt) {
    if (!R.course) return;
    R.course.coneList.forEach(function (c) {
      if (c.hit && c.t < 1) {
        c.t = Math.min(1, c.t + dt / 0.45);
        var t = c.t, e = 1 - Math.pow(1 - t, 3);
        poseCone(c, e);
      }
    });
  }

  function clearHighlights() {
    clearGroup(R.hlGroup);
    R.highlights.forEach(function (h) { if (h.cone) h.cone.mat.emissive.setRGB(0, 0, 0); });
    R.highlights = [];
  }
  function highlightCones(ids, colorHex) {
    if (!R.renderer) return;
    clearHighlights();
    if (!ids || !ids.length || !R.course) return;
    var color = new THREE.Color(colorHex == null ? 0xffe600 : colorHex).convertSRGBToLinear();
    var S = R.shared;
    ids.forEach(function (id) {
      var cone = R.course.cones[id];
      if (!cone) return;
      var g = new THREE.Group(); g.position.set(cone.x, 0, cone.z);
      var discMat = new THREE.MeshBasicMaterial({ color: color, map: R.textures.glow, transparent: true, opacity: 0.55, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 });
      var disc = new THREE.Mesh(S.disc, discMat); disc.position.y = Y.ring - 0.002; g.add(disc);
      var ringMat = new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
      var ring = new THREE.Mesh(S.ring, ringMat); ring.position.y = Y.ring; g.add(ring);
      var arrowMat = new THREE.MeshBasicMaterial({ color: color });
      var arrow = new THREE.Mesh(S.arrow, arrowMat); g.add(arrow);
      var beamMat = new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.35, depthWrite: false });
      var beam = new THREE.Mesh(S.beam, beamMat); beam.position.y = S.coneH + 0.05; beam.scale.y = 1.6; g.add(beam);
      R.hlGroup.add(g);
      R.highlights.push({ cone: cone, g: g, ring: ring, disc: disc, arrow: arrow, ringMat: ringMat, color: color });
    });
  }
  function animateHighlights(t) {
    if (!R.highlights.length) return;
    var p = 0.5 + 0.5 * Math.sin(t * 6.0);
    var S = R.shared;
    R.highlights.forEach(function (h) {
      var sc = 1 + 0.35 * p;
      h.ring.scale.set(sc, 1, sc);
      h.ringMat.opacity = 0.65 + 0.35 * p;
      h.disc.scale.set(0.8 + 0.4 * p, 1, 0.8 + 0.4 * p);
      h.arrow.position.y = S.coneH + 0.45 + 0.12 * Math.sin(t * 4.0);
      h.arrow.rotation.y = t * 2;
      h.cone.mat.emissive.copy(h.color).multiplyScalar(0.25 + 0.55 * p);
    });
  }

  /* ------------------------------------------------------------------ */
  /* guides                                                              */
  function setGuide(gd) {
    if (!R.renderer) return;
    clearGroup(R.guideGroup);
    R.guide = null;
    if (!gd) return;
    var G = { mats: [] };
    var c = carCfg();
    if (gd.targetBox && R.course && R.course.scn.box && R.course.scn.box.corners && R.course.scn.box.corners.length >= 3) {
      var cs = R.course.scn.box.corners;
      var fm = decalMat(0x2ee66b, 0.30);
      var fill = new THREE.Mesh(polyFill(cs), fm); fill.position.y = Y.guide; R.guideGroup.add(fill);
      var segs = [];
      for (var i = 0; i < cs.length; i++) { var a = cs[i], b = cs[(i + 1) % cs.length]; segs.push([a.x, a.z, b.x, b.z]); }
      var om = decalMat(0x2ee66b, 0.95);
      var ol = new THREE.Mesh(segQuads(segs, 0.08), om); ol.position.y = Y.guide + 0.002; R.guideGroup.add(ol);
      G.mats.push({ m: fm, base: 0.22, amp: 0.14 }, { m: om, base: 0.75, amp: 0.25 });
    }
    if (gd.ghost && isFinite(gd.ghost.x) && isFinite(gd.ghost.z)) {
      var gh = new THREE.Group();
      gh.position.set(gd.ghost.x, Y.guide + 0.001, gd.ghost.z); gh.rotation.y = num(gd.ghost.heading, 0);
      var hw = c.width / 2, fz = c.wheelbase + c.frontOverhang, rz = -c.rearOverhang;
      var corners = [{ x: hw, z: rz }, { x: hw, z: fz }, { x: -hw, z: fz }, { x: -hw, z: rz }];
      var gfm = decalMat(0x4fc3f7, 0.22);
      gh.add(new THREE.Mesh(polyFill(corners), gfm));
      var gsegs = [];
      for (var j = 0; j < 4; j++) { var p0 = corners[j], p1 = corners[(j + 1) % 4]; gsegs.push([p0.x, p0.z, p1.x, p1.z]); }
      var gom = decalMat(0x4fc3f7, 0.95);
      var go = new THREE.Mesh(segQuads(gsegs, 0.07), gom); go.position.y = 0.002; gh.add(go);
      var tri = new THREE.Mesh(polyFill([{ x: 0.35, z: fz - 0.75 }, { x: 0, z: fz - 0.2 }, { x: -0.35, z: fz - 0.75 }]), gom);
      tri.position.y = 0.002; gh.add(tri);
      // axle marks
      var am = new THREE.Mesh(segQuads([[hw - 0.05, 0, -hw + 0.05, 0], [hw - 0.05, c.wheelbase, -hw + 0.05, c.wheelbase]], 0.04), gom);
      am.position.y = 0.002; gh.add(am);
      R.guideGroup.add(gh);
      G.mats.push({ m: gfm, base: 0.16, amp: 0.10 }, { m: gom, base: 0.7, amp: 0.3 });
    }
    if (gd.line && isFinite(gd.line.x1) && isFinite(gd.line.x2)) {
      var lm = decalMat(0x00e5ff, 0.95);
      var ln = new THREE.Mesh(segQuads(dashedSegs(gd.line.x1, gd.line.z1, gd.line.x2, gd.line.z2, 0.5, 0.35), 0.10, 0), lm);
      ln.position.y = Y.guide + 0.003; R.guideGroup.add(ln);
      G.mats.push({ m: lm, base: 0.7, amp: 0.3 });
    }
    R.guide = G;
  }
  function animateGuide(t) {
    if (!R.guide) return;
    var p = 0.5 + 0.5 * Math.sin(t * 4.0);
    R.guide.mats.forEach(function (o) { o.m.opacity = o.base + o.amp * p; });
  }

  /* ------------------------------------------------------------------ */
  /* path preview                                                        */
  function setPathPreview(on) { R.pathOn = !!on; if (R.pathGroup) R.pathGroup.visible = R.pathOn; }
  var _pts = [new Float32Array(82), new Float32Array(82), new Float32Array(82)];
  function updatePath(s) {
    if (!R.pathOn) return;
    var cs = s.car || {}, c = carCfg();
    var x = R.carPose.x, z = R.carPose.z, h = R.carPose.h;
    var steerAngle = clamp(num(cs.steerAngle, num(cs.steer, 0) * c.maxSteerDeg * DEG), -1.2, 1.2);
    var sig;
    if (s.gear === 'R') sig = -1; else if (s.gear === 'D') sig = 1; else sig = num(cs.speed, 0) < -0.01 ? -1 : 1;
    var k = Math.tan(steerAngle) / c.wheelbase;
    var n = 41, ds = 6 / (n - 1);
    var hw = c.width / 2, cz = sig > 0 ? c.wheelbase + c.frontOverhang : -c.rearOverhang;
    for (var i = 0; i < n; i++) {
      var ch = Math.cos(h), sh = Math.sin(h);
      _pts[0][i * 2] = x; _pts[0][i * 2 + 1] = z;
      _pts[1][i * 2] = x + hw * ch + cz * sh; _pts[1][i * 2 + 1] = z - hw * sh + cz * ch;
      _pts[2][i * 2] = x - hw * ch + cz * sh; _pts[2][i * 2 + 1] = z + hw * sh + cz * ch;
      var hm = h - k * sig * ds / 2;
      x += sig * ds * Math.sin(hm); z += sig * ds * Math.cos(hm);
      h -= k * sig * ds;
    }
    ribbonSet(R.path.ribbons[0], _pts[0], 0.07);
    ribbonSet(R.path.ribbons[1], _pts[1], 0.08);
    ribbonSet(R.path.ribbons[2], _pts[2], 0.08);
  }

  /* ------------------------------------------------------------------ */
  /* render                                                              */
  var _eye = new THREE.Vector3();
  var _frustum = new THREE.Frustum(), _mFrustum = new THREE.Matrix4(), _sphere = new THREE.Sphere();
  function glassInView(m) {
    var g = m.glass.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    _sphere.copy(g.boundingSphere).applyMatrix4(m.glass.matrixWorld);
    _sphere.radius += 0.06;
    return _frustum.intersectsSphere(_sphere);
  }
  function render(state, dt) {
    if (!R.renderer) return;
    try {
      var now = performance.now();
      if (R.lastT) { var ft = now - R.lastT; if (ft > 0 && ft < 250) adaptQuality(ft); }  // ignore hidden-tab gaps
      R.lastT = now;
    } catch (e0) { /* quality control must never break rendering */ }
    try { renderImpl(state || {}, dt); }
    catch (e) {
      if (!R.errLogged) { R.errLogged = true; if (window.console) console.error('[PS.world] render error:', e); }
    }
  }
  function renderImpl(s, dt) {
    dt = clamp(num(dt, 0.016), 0, 0.1);
    R.clock += dt;
    var t = num(s.time, R.clock);
    R.lastState = s;
    if (needsResize()) resize();

    var cs = s.car || {};
    applyCarPose(num(cs.x, R.carPose.x), num(cs.z, R.carPose.z), num(cs.heading, R.carPose.h));
    R.car.update(s, t);
    updateHead(s.head);
    animateCones(dt);
    animateHighlights(t);
    animateGuide(t);
    updatePath(s);

    var renderer = R.renderer, scene = R.scene;
    scene.updateMatrixWorld();
    // shadow map: at most one update per frame (consumed by the first pass), every Nth frame under load
    R.frameNo++;
    renderer.shadowMap.needsUpdate = (R.frameNo % R.q.shadowEvery) === 0;

    // mirrors (render-to-texture). Cameras are always updated (isConeVisibleInMirror uses them);
    // the pass itself is skipped when the glass is outside the driver's view frustum.
    updateDriverProj();
    R.drvCam.getWorldPosition(_eye);
    R.mirrors.update(_eye);
    R.mirrorsValid = true;
    _mFrustum.multiplyMatrices(R.drvCam.projectionMatrix, R.drvCam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_mFrustum);
    renderer.setScissorTest(false);
    R.mirrorPasses = R.mirrors.render(renderer, scene, glassInView);
    renderer.setRenderTarget(null);

    var W = R.w, H = R.h, topH = R.topH;
    renderer.setScissorTest(true);
    // top half: bird's-eye
    updateTopCam();
    renderer.setViewport(0, H - topH, W, topH);
    renderer.setScissor(0, H - topH, W, topH);
    renderer.render(scene, R.topCam);
    // bottom half: driver
    renderer.setViewport(0, 0, W, H - topH);
    renderer.setScissor(0, 0, W, H - topH);
    renderer.render(scene, R.drvCam);
    renderer.setScissorTest(false);
  }

  /* ------------------------------------------------------------------ */
  function isConeVisibleInMirror(coneId, which) {
    try {
      var cone = R.course && R.course.cones[coneId];
      if (!cone || !R.mirrors) return false;
      if (!R.mirrorsValid) {
        R.scene.updateMatrixWorld();
        R.drvCam.getWorldPosition(_eye);
        R.mirrors.update(_eye);
        R.mirrorsValid = true;
      }
      cone.tip.updateWorldMatrix(true, false);
      var S = R.shared, r = S.coneR, h = S.coneH, mw = cone.tip.matrixWorld;
      var local = [[0, 0.04, 0], [0, h * 0.5, 0], [0, h * 0.95, 0], [r, 0.05, 0], [-r, 0.05, 0], [0, 0.05, r], [0, 0.05, -r],
        [r * 0.55, h * 0.5, 0], [-r * 0.55, h * 0.5, 0], [0, h * 0.5, r * 0.55], [0, h * 0.5, -r * 0.55]];
      var pts = local.map(function (l) { return new THREE.Vector3(l[0], l[1], l[2]).applyMatrix4(mw); });
      return R.mirrors.pointsVisible(which, pts);
    } catch (e) { return false; }
  }

  PS.world = {
    init: init,
    loadScenario: loadScenario,
    resize: resize,
    render: render,
    setConeHit: setConeHit,
    highlightCones: highlightCones,
    setGuide: setGuide,
    setPathPreview: setPathPreview,
    setTopInsets: setTopInsets,
    isConeVisibleInMirror: isConeVisibleInMirror,
    // optional helpers
    getDebug: function () { return R; },
    setDebugZoom: function (z) { R.debugZoom = Math.max(0.2, num(z, 1)); },  // dev only: magnify driver view
    getDriverFovDeg: function () { return R.driverVFov / DEG; }
  };
})();
