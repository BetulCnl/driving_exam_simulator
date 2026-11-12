/* PS.mirrors – three working mirrors (interior + two door mirrors), three.js r128.
 * Grafik modülü. Classic script, nothing runs at load time.
 *
 * Technique: true planar reflection. Every frame the driver's eye E is
 * reflected across the mirror plane (E' = E - 2dN). A virtual camera sits at
 * E', looks along the mirror normal and uses an off-axis frustum whose near
 * plane IS the mirror plane and whose window is the mirror glass, so
 * everything between E' and the glass (housing, windshield, the mirror itself)
 * is clipped. The glass UVs are flipped horizontally, which gives the
 * left-right reversed image a real mirror shows. Mirror glass meshes live on
 * layer 2, which mirror cameras never render (no recursion).
 *
 * Optional "wide" factor > 1 widens the field around the true reflected
 * direction (behaves like a mildly convex / aspheric mirror); 1 = exactly flat.
 */
(function () {
  'use strict';
  var PS = window.PS = window.PS || {};
  var LAYER_SURFACE = 2;

  // car-local (nominal body coordinates, +X = car's left)
  var DEFS = {
    left:   { center: [1.00, 1.035, 1.95], w: 0.26, h: 0.175, target: [1.80, -0.58, -4.92], wide: 1.45, px: [384, 258], housing: 'body', door: [0.84, 1.00, 2.10] },
    right:  { center: [-1.00, 1.035, 1.95], w: 0.26, h: 0.175, target: [-1.90, -0.71, -4.92], wide: 1.70, px: [384, 258], housing: 'body', door: [-0.84, 1.00, 2.10] },
    center: { center: [0.02, 1.295, 1.72], w: 0.26, h: 0.08, target: [0.12, 0.85, -6.0], wide: 1.15, px: [416, 128], housing: 'trim', stem: [0.02, 1.405, 1.80] }
  };

  function col(hex) { return new THREE.Color(hex).convertSRGBToLinear(); }

  function makeRT(renderer, w, h) {
    var opts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat,
      encoding: THREE.sRGBEncoding, depthBuffer: true, stencilBuffer: false };
    var rt = null;
    try {
      if (renderer && renderer.capabilities && renderer.capabilities.isWebGL2 && THREE.WebGLMultisampleRenderTarget) {
        rt = new THREE.WebGLMultisampleRenderTarget(w, h, opts);
        rt.samples = 4;
      }
    } catch (e) { rt = null; }
    if (!rt) rt = new THREE.WebGLRenderTarget(w, h, opts);
    rt.texture.generateMipmaps = false;
    rt.texture.encoding = THREE.sRGBEncoding;
    return rt;
  }

  function strut(a, b, w, d, mat) {
    var len = Math.max(0.001, a.distanceTo(b));
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, d, len), mat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.lookAt(b);
    return m;
  }

  function create(car, renderer) {
    var cfg = car.config;
    var eye0 = new THREE.Vector3(cfg.eye.x, cfg.eye.y, cfg.eye.z);
    var mirrors = {};
    var tmpBasis = new THREE.Matrix4();
    car.root.updateMatrixWorld(true);

    Object.keys(DEFS).forEach(function (key) {
      var d = DEFS[key];
      var C = car.bodyPoint(d.center[0], d.center[1], d.center[2]);
      var T = new THREE.Vector3(d.target[0], d.target[1], d.target[2]);
      var a = eye0.clone().sub(C).normalize();
      var b = T.clone().sub(C).normalize();
      var N = a.add(b).normalize();                     // mirror normal bisects eye & target directions
      var Vv = new THREE.Vector3(0, 1, 0);
      Vv.sub(N.clone().multiplyScalar(Vv.dot(N))).normalize();
      var U = new THREE.Vector3().crossVectors(Vv, N);
      var q = new THREE.Quaternion().setFromRotationMatrix(tmpBasis.makeBasis(U, Vv, N));

      var rt = makeRT(renderer, d.px[0], d.px[1]);
      var geo = new THREE.PlaneGeometry(d.w, d.h);
      var uv = geo.attributes.uv;
      for (var i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));   // mirror reversal
      var mat = new THREE.MeshBasicMaterial({ map: rt.texture, color: col(0xe4e4e4) });
      var glass = new THREE.Mesh(geo, mat);
      glass.position.copy(C); glass.quaternion.copy(q);
      glass.layers.set(LAYER_SURFACE);
      glass.name = 'mirror-' + key;
      car.root.add(glass);

      var hMat = d.housing === 'body' ? car.materials.body : car.materials.trim;
      var housing = new THREE.Mesh(new THREE.BoxGeometry(d.w + 0.035, d.h + 0.035, 0.07), hMat);
      housing.position.copy(C).addScaledVector(N, -0.0375);
      housing.quaternion.copy(q);
      if (d.housing === 'body') housing.castShadow = true;
      car.root.add(housing);
      if (d.door) {
        var dp = car.bodyPoint(d.door[0], d.door[1], d.door[2]);
        var hp = housing.position.clone().addScaledVector(U, -Math.sign(d.center[0]) * (d.w * 0.25));
        hp.addScaledVector(N, -0.02); hp.y -= 0.03;
        car.root.add(strut(hp, dp, 0.05, 0.035, hMat));
      }
      if (d.stem) {
        var sp = car.bodyPoint(d.stem[0], d.stem[1], d.stem[2]);
        car.root.add(strut(housing.position.clone().addScaledVector(N, -0.03), sp, 0.025, 0.025, car.materials.trim));
      }

      var cam = new THREE.PerspectiveCamera(40, d.w / d.h, 0.05, 300);
      cam.layers.set(0);

      mirrors[key] = {
        key: key, def: d, glass: glass, housing: housing, rt: rt, camera: cam,
        halfW: d.w / 2, halfH: d.h / 2, wide: d.wide, valid: false
      };
    });

    var vC = new THREE.Vector3(), vU = new THREE.Vector3(), vV = new THREE.Vector3(), vN = new THREE.Vector3();
    var vEp = new THREE.Vector3(), vR = new THREE.Vector3(), vRel = new THREE.Vector3(), vNn = new THREE.Vector3();
    var basis = new THREE.Matrix4();

    // eyeWorld: THREE.Vector3 world position of the driver's eye. Scene matrices must be up to date.
    function update(eyeWorld) {
      for (var k in mirrors) {
        var m = mirrors[k];
        var mw = m.glass.matrixWorld;
        vC.setFromMatrixPosition(mw);
        vU.setFromMatrixColumn(mw, 0).normalize();
        vV.setFromMatrixColumn(mw, 1).normalize();
        vN.setFromMatrixColumn(mw, 2).normalize();
        var dist = vRel.copy(eyeWorld).sub(vC).dot(vN);
        if (!(dist > 0.02)) dist = 0.02;
        vEp.copy(eyeWorld).addScaledVector(vN, -2 * dist);
        vR.copy(vU).negate();
        vRel.copy(vC).sub(vEp);
        var x0 = vRel.dot(vR), y0 = vRel.dot(vV), near = vRel.dot(vN);
        if (!(near > 0.01)) near = 0.01;
        var hw = m.halfW * m.wide, hh = m.halfH * m.wide;
        var cam = m.camera;
        cam.position.copy(vEp);
        basis.makeBasis(vR, vV, vNn.copy(vN).negate());
        cam.quaternion.setFromRotationMatrix(basis);
        cam.updateMatrixWorld(true);
        cam.projectionMatrix.makePerspective(x0 - hw, x0 + hw, y0 + hh, y0 - hh, near, 300);
        cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
        m.valid = true;
      }
    }

    // shouldRender(mirror) -> bool (optional). A mirror that was never rendered is always rendered once.
    // Skipped mirrors keep their last texture; their cameras are still updated by update().
    function render(renderer, scene, shouldRender) {
      var n = 0;
      for (var k in mirrors) {
        var m = mirrors[k];
        if (m.rendered && shouldRender && !shouldRender(m)) continue;
        renderer.setRenderTarget(m.rt);
        renderer.render(scene, m.camera);
        m.rendered = true;
        n++;
      }
      renderer.setRenderTarget(null);
      return n;
    }

    var pv = new THREE.Vector3();
    // true if any of the world points projects inside that mirror's current view
    function pointsVisible(which, pts) {
      var m = mirrors[which];
      if (!m || !m.valid) return false;
      var cam = m.camera;
      var near = -1;
      for (var i = 0; i < pts.length; i++) {
        pv.copy(pts[i]).applyMatrix4(cam.matrixWorldInverse);
        if (pv.z > -0.02) continue;                       // behind the virtual eye
        pv.applyMatrix4(cam.projectionMatrix);            // NDC (perspective divide)
        if (pv.z < near || pv.z > 1) continue;            // between eye and glass, or past far plane
        if (pv.x >= -1 && pv.x <= 1 && pv.y >= -1 && pv.y <= 1) return true;
      }
      return false;
    }

    function dispose() {
      for (var k in mirrors) {
        mirrors[k].rt.dispose();
        mirrors[k].glass.material.dispose();
        mirrors[k].glass.geometry.dispose();
      }
    }

    return { list: mirrors, update: update, render: render, pointsVisible: pointsVisible, dispose: dispose };
  }

  PS.mirrors = { create: create, DEFS: DEFS, LAYER_SURFACE: LAYER_SURFACE };
})();
