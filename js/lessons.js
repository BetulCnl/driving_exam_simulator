/* PS.lessonDefs / PS.lessonEngine – pure step definitions ("duba kuralı") + evaluation (node-safe)
 * PS.lessons – Öğren / Sınav UI controller (browser only, created in PS.lessons.init)
 */
(function (root) {
  'use strict';
  var PS = root.PS = root.PS || {};
  var DEG = 180 / Math.PI, HALF_PI = Math.PI / 2;

  function fmtNum(v, d) { return v.toFixed(d === undefined ? 1 : d).replace('.', ','); }
  function cm(v) { return Math.round(v * 100) + ' cm'; }

  // ------------------------------------------------------------------
  // Kinematic look-ahead: run the remaining manoeuvre segments (ideal stops) and
  // report the end pose and the minimum body clearance to every standing cone.
  // segs: [{ steer: -1|0|1, dir: -1 (reverse) | 1, until(pose) -> bool }]
  // ------------------------------------------------------------------
  function kinRun(sim, segs) {
    var P = PS.physics, car = sim.car, L = car.wheelbase, maxS = car.maxSteerDeg * Math.PI / 180;
    var p = sim.pose(), ds = 0.03, n = 0, minC = 99, minId = null, ok = true;
    var cones = sim.cones.filter(function (c) { return !c.hit; });
    function chk() {
      for (var i = 0; i < cones.length; i++) {
        var d = P.rectCircleClearance(car, p, cones[i].x, cones[i].z, sim.coneR);
        if (d < minC) { minC = d; minId = cones[i].id; }
      }
    }
    chk();
    for (var k = 0; k < segs.length; k++) {
      var sg = segs[k], dir = sg.dir || -1, tn = Math.tan(sg.steer * maxS), guard = 0;
      while (!sg.until(p)) {
        p.x += dir * Math.sin(p.heading) * ds;
        p.z += dir * Math.cos(p.heading) * ds;
        p.heading += -(dir / L) * tn * ds;
        if ((++n & 1) === 0) chk();
        if (++guard > 600) { ok = false; break; }
      }
    }
    chk();
    return { pose: p, minClear: minC, minId: minId, ok: ok };
  }

  // ------------------------------------------------------------------
  // Metrics (pure): everything the steps need, computed from the sim
  // ------------------------------------------------------------------
  function metrics(sim) {
    var P = PS.physics, sc = sim.scenario, car = sim.car, st = sim.state, L = sc.lesson || {};
    var pose = sim.pose();
    var R = sim.minRadius;
    var m = {
      pose: pose, v: st.speed, kmh: Math.abs(st.speed) * 3.6,
      stopped: Math.abs(st.speed) < 0.05,
      gear: sim.gear, steer: st.steer, turns: st.steer * car.steeringWheelLockDeg / 360,
      signal: sim.signal,
      headingErr: P.headingErrorRad(pose, sc.box) * DEG,
      inside: P.isInsideBox(car, pose, sc.box),
      R: R
    };
    var cones = {};
    sc.cones.forEach(function (c) { cones[c.id] = c; });
    m.cones = cones;
    var rearC = P.toWorld(pose, 0, -car.rearOverhang);
    var centre = P.toWorld(pose, 0, (car.wheelbase + car.frontOverhang - car.rearOverhang) / 2);
    m.centre = centre;
    if (sc.id === 'parallel') {
      m.theta = P.wrapPi(pose.heading - HALF_PI) * DEG;            // + = rear swung toward the curb
      m.pastFront = rearC.x - cones.c1.x;                          // rear bumper past the front cone
      var cs = P.carCorners(car, pose);
      m.coneGap = L.coneLineZ - Math.max(cs[1].z, cs[2].z);         // right side to the cone line
      var th = Math.max(0, m.theta / DEG);
      m.predGap = L.curbZ - (pose.z + R * (1 - Math.cos(th)) + car.width / 2);   // gap if you full-lock left now
      var memoPlan = null, memoArc2 = null;
      // Plan from arc 1: straighten now, reverse straight until the planned curb gap is reachable,
      // then full-lock left until parallel. -> predicted final rear bumper x + cone clearance.
      m.plan = function () {
        if (memoPlan) return memoPlan;
        if (th < 0.05) { memoPlan = { rear: -99, clear: 99 }; return memoPlan; }
        var zA = L.curbZ - (L.targetGap || 0.4) - car.width / 2 - R * (1 - Math.cos(th));
        var r = kinRun(sim, [
          { steer: 0, until: function (q) { return q.z >= zA; } },
          { steer: -1, until: function (q) { return q.heading <= HALF_PI; } }
        ]);
        memoPlan = { rear: r.pose.x - car.rearOverhang, clear: r.minClear, id: r.minId };
        return memoPlan;
      };
      // From the straight reverse: full-lock left now until parallel -> clearance
      m.arc2Pred = function () {
        if (memoArc2) return memoArc2;
        var r = kinRun(sim, [{ steer: -1, until: function (q) { return q.heading <= HALF_PI; } }]);
        memoArc2 = { rear: r.pose.x - car.rearOverhang, clear: r.minClear, id: r.minId };
        return memoArc2;
      };
      m.curbGap = P.rightSideCurbGap(car, pose, sc.curbs);
      var bx0 = Math.min(sc.box.corners[0].x, sc.box.corners[2].x), bx1 = Math.max(sc.box.corners[0].x, sc.box.corners[2].x);
      m.centreOff = centre.x - (bx0 + bx1) / 2;
      m.c1Clear = P.rectCircleClearance(car, pose, cones.c1.x, cones.c1.z, sim.coneR);
      m.c1Lz = P.toLocal(pose, cones.c1.x, cones.c1.z).lz;          // where the front cone is along the car (m ahead of the rear axle)
    } else {
      m.theta = P.wrapPi(pose.heading - HALF_PI) * DEG;            // 0 on approach, 90 when straight in the bay
      m.past = pose.x - L.bayCx;                                   // rear axle past the bay centre line
      var cs2 = P.carCorners(car, pose);
      m.mouthGap = L.mouthZ - Math.max(cs2[1].z, cs2[2].z);         // right side to the bay mouth line (approach)
      m.depth = pose.z - L.mouthZ;                                 // rear-axle depth in the bay
      m.sideOff = centre.x - L.bayCx;
      m.rearGap = L.backZ - P.toWorld(pose, 0, -car.rearOverhang).z;
      m.eps = m.theta - 90;                                        // heading error vs straight-in (deg)
      var memoSt = null;
      // straighten now and reverse straight to the max depth -> clearance + final side offset
      m.straightPred = function () {
        if (memoSt) return memoSt;
        var dmax = L.depth.max;
        var r = kinRun(sim, [{ steer: 0, until: function (q) { return q.z - L.mouthZ >= dmax || Math.cos(q.heading) > -0.2; } }]);
        memoSt = { clear: r.minClear, id: r.minId, off: r.pose.x - L.bayCx };
        return memoSt;
      };
      m.frontIn = P.toWorld(pose, 0, car.wheelbase + car.frontOverhang).z - L.mouthZ;
      var memoArc = null;
      // full right lock from here until straight in the bay -> minimum cone clearance on the way
      m.arcPred = function () {
        if (memoArc) return memoArc;
        var r = kinRun(sim, [{ steer: 1, until: function (q) { return q.heading >= Math.PI; } }]);
        memoArc = { clear: r.minClear, id: r.minId, off: r.pose.x - L.bayCx };
        return memoArc;
      };
    }
    return m;
  }

  function turnsText(steer, lockDeg) {
    var t = Math.abs(steer) * (lockDeg || 540) / 360;
    if (Math.abs(steer) < 0.03) return 'DÜZ';
    var s = (Math.round(t * 4) / 4);
    var txt = s === 0 ? fmtNum(t, 2) : fmtNum(s, s % 1 === 0 ? 0 : (s * 2 % 1 === 0 ? 1 : 2));
    return txt + ' tur ' + (steer > 0 ? 'SAĞ' : 'SOL');
  }

  // ------------------------------------------------------------------
  // Step definitions
  // step.kind: 'setup' (no movement; all needs) | 'move' (zone) | 'adjust' (zone, either direction)
  // step.need: { gear, steer (-1|0|1), signal }
  // step.zone(m) -> { z: 'before'|'in'|'over', fix: 'D'|'R' (gear to correct an overshoot), text }
  // ------------------------------------------------------------------
  function mTxt(v) { return fmtNum(Math.max(0, v), v < 1 ? 2 : 1) + ' m'; }

  // ------------------------------------------------------------------
  // "Hamle listesi": the complete instructor sequence as atomic moves, attached to the lesson
  // steps they belong to. k = completion predicate kind:
  //   gear / signal / steer (live: un-ticks if undone while the step is current), look (head turned
  //   to the right mirror / over the right shoulder, latched), stop (the step's stop zone is done).
  // when = "Ne zaman dur:" line (visual reference in the car · number the sim shows).
  // References are checked in dev/sim-lessons.js (mirror visibility by planar-mirror geometry).
  // ------------------------------------------------------------------
  var MOVES = {
    parallel: {
      prep: [
        { k: 'gear', v: 'D', t: 'Frene bas (Q), vitesi D\'ye al' },
        { k: 'look', t: 'Aynalara bak (iç ayna + sağ ayna)' },
        { k: 'signal', v: 'right', t: 'Sağ sinyali ver (kol yukarı)' }
      ],
      pass: [
        { k: 'stop', t: '50–70 cm açıktan çok yavaş ilerle, DUR', when: 'duba sağ arka teker hizasında (sağ ayna)' }
      ],
      rev1: [
        { k: 'gear', v: 'R', t: 'Frene bas, vitesi R\'ye al' },
        { k: 'look', t: 'Arkayı kontrol et (ayna + omuz)' },
        { k: 'steer', v: 1, t: 'SAĞA sonuna kadar kır (1,5 tur)' }
      ],
      arc1: [
        { k: 'stop', t: 'Çok yavaş geri gel, DUR', when: '~45° · sol aynada yol tarafı arka duba kaybolur' }
      ],
      straight1: [
        { k: 'steer', v: 0, t: 'Düzelt: SOLA 1,5 tur (DÜZ)' }
      ],
      back: [
        { k: 'stop', t: 'Düz, çok yavaş geri gel, DUR', when: 'duba sağ ön teker hizasında (sağ cam) · kaldırıma ~25 cm' }
      ],
      rev2: [
        { k: 'steer', v: -1, t: 'SOLA sonuna kadar kır (1,5 tur)' }
      ],
      arc2: [
        { k: 'stop', t: 'Çok yavaş geri gel, DUR', when: 'kaldırıma paralel · 0° (sağ aynada kaldırım)' }
      ],
      centre: [
        { k: 'steer', v: 0, t: 'Düzelt: SAĞA 1,5 tur (DÜZ)' },
        { k: 'stop', t: 'Gerekirse düz ortala, DUR', when: 'öne ve arkaya eşit boşluk · ±60 cm' }
      ],
      park: [
        { k: 'signal', v: 'off', t: 'Sinyali kapat (kapandıysa tamam)' },
        { k: 'gear', v: 'P', t: 'Frene bas, vitesi P\'ye al' }
      ]
    },
    perpendicular: {
      prep: [
        { k: 'gear', v: 'D', t: 'Frene bas (Q), vitesi D\'ye al' },
        { k: 'look', t: 'Aynalara bak (iç ayna + sağ ayna)' },
        { k: 'signal', v: 'right', t: 'Sağ sinyali ver (kol yukarı)' }
      ],
      pass: [
        { k: 'stop', t: '1,5 m açıktan çok yavaş ilerle, DUR', when: 'yakın duba tamponun ~1,3 m gerisinde (omuz üstü)' }
      ],
      rev1: [
        { k: 'gear', v: 'R', t: 'Frene bas, vitesi R\'ye al' },
        { k: 'look', t: 'Arkayı kontrol et (ayna + omuz)' },
        { k: 'steer', v: 1, t: 'SAĞA sonuna kadar kır (1,5 tur)' }
      ],
      arc: [
        { k: 'stop', t: 'Çok yavaş geri gel, DUR', when: '90° · iki aynada duba sıraları gövdeye paralel' }
      ],
      straight: [
        { k: 'steer', v: 0, t: 'Düzelt: SOLA 1,5 tur (DÜZ)' }
      ],
      back: [
        { k: 'stop', t: 'Düz, çok yavaş geri gel, DUR', when: 'dip çizgiye ~0,5 m · ön tampon cebin içinde' }
      ],
      park: [
        { k: 'signal', v: 'off', t: 'Sinyali kapat (kapandıysa tamam)' },
        { k: 'gear', v: 'P', t: 'Frene bas, vitesi P\'ye al' }
      ]
    }
  };
  function withMoves(steps, table) {
    steps.forEach(function (st) { st.moves = (table[st.id] || []).map(function (mv) { var o = {}; for (var k in mv) o[k] = mv[k]; return o; }); });
    return steps;
  }

  function parallelSteps(sc, cfg) {
    var L = sc.lesson, car = cfg.car;
    var R = car.wheelbase / Math.tan(car.maxSteerDeg * Math.PI / 180);
    // analytic plan from a pose on arc 1 (heading = PI/2 + th): straighten, reverse straight until the
    // planned gap is reachable, full-lock left until parallel -> final rear-bumper x
    function rearAt(x, z, th) {
      if (th < 0.05) return -99;
      var zA = L.curbZ - (L.targetGap || 0.4) - car.width / 2 - R * (1 - Math.cos(th));
      var s = Math.max(0, (zA - z) / Math.sin(th));
      return x - s * Math.cos(th) - R * Math.sin(th) - car.rearOverhang;
    }
    // metres of further full-right-lock reversing until the predicted rear reaches rearMin
    function arc1Remain(m) {
      var h = m.pose.heading, ix = m.pose.x - R * Math.cos(h), iz = m.pose.z + R * Math.sin(h);   // ICR (right side)
      for (var d = 0; d <= 40; d += 0.5) {
        var hh = h + d / DEG;
        var x = ix + R * Math.cos(hh), z = iz - R * Math.sin(hh);
        if (rearAt(x, z, hh - HALF_PI) >= L.arc1.rearMin) return R * d / DEG;
      }
      return 9;
    }
    var finalAxleZ = L.curbZ - (L.ghostGap || 0.3) - car.width / 2;
    var bx = (sc.box.corners[0].x + sc.box.corners[1].x) / 2;
    var finalAxleX = bx - (car.wheelbase + car.frontOverhang - car.rearOverhang) / 2;
    var finalGhost = { x: finalAxleX, z: finalAxleZ, heading: HALF_PI };
    return withMoves([
      {
        id: 'prep', kind: 'setup', title: 'Hazırlık',
        text: 'Frene bas (Q) ve basılı tut. Vites kolunu fareyle P\'den D\'ye al. Sinyal kolunu yukarı iterek SAĞ sinyali ver — park edeceğini arkadakilere haber ver.',
        look: 'Fareyi basılı tutup sürükleyerek başını çevir: önce iç dikiz aynasına, sonra sağ aynaya bak; arkadan gelen var mı? (Çift tık ya da Boşluk: tekrar öne bak.)',
        highlight: [],
        need: { gear: 'D', signal: 'right' },
        guide: { targetBox: true, ghost: finalGhost, line: null }
      },
      {
        id: 'pass', kind: 'move', title: 'Dubalara paralel, çok yavaş ilerle',
        text: 'Direksiyon düz, gaz yok. Freni bırakınca araç rölantide kendiliğinden ~6 km/h ile gider — park için bu hızlı: frene hafif hafif dokunarak (Q\'ya kısa kısa basarak) çok yavaş ilerle (1–3 km/h). Sağ tarafınla dubalar arasında 50–70 cm boşluk olsun. Öndeki duba sağ ARKA TEKERİNİN hizasına gelince (arka tampona ~65 cm kala) DUR. Arka tamponun dubayı geçmesini bekleme: bu araçla o zaman 45° ile ya öndeki dubaya değersin ya da kaldırıma sıkışırsın.',
        look: 'Sağ aynaya bak (fareyi basılı tutup sağa sürükle): öndeki duba (yeşil) aynada sağ arka tekerin yanına geldiğinde dur.',
        highlight: ['c1'],
        need: { gear: 'D', steer: 0 },
        guide: function (m) {
          var x = m.cones.c1.x + car.rearOverhang + (typeof L.refPast === 'number' ? L.refPast : (L.stop1.min + L.stop1.max) / 2);
          return { targetBox: true, ghost: { x: x, z: m.pose.z, heading: HALF_PI }, line: { x1: m.cones.c1.x, z1: -4, x2: m.cones.c1.x, z2: 0.6 } };
        },
        zone: function (m) {
          var rem = L.stop1.min - m.pastFront;
          if (rem > 0) return { z: 'before', value: m.pastFront, remain: rem, left: mTxt(rem) };
          if (m.pastFront <= L.stop1.max) return { z: 'in', value: m.pastFront, core: m.pastFront <= L.stop1.core };
          return { z: 'over', fix: 'R', value: m.pastFront, text: 'Fazla ileri gittin. Frene bas, R\'ye al, direksiyon düz — biraz geri gel.', cue: 'Fazla gittin → R\'ye al, biraz geri' };
        },
        info: function (m) {
          var g = m.coneGap, warn = (g < 0.45) ? ' ⚠ çok yakın' : (g > 0.8 ? ' ⚠ çok uzak' : ' ✓');
          var p = m.pastFront;
          return 'Dubalara yan mesafe: <b>' + cm(g) + '</b>' + warn + '<br>Arka tampon öndeki dubayı ' +
            (p < 0 ? '<b>' + fmtNum(-p, 1) + ' m</b> sonra geçecek' : '<b>' + fmtNum(p, 1) + ' m</b> geçti') +
            '<br>Duba – sağ arka teker: <b>' + fmtNum(Math.abs(m.cones.c1.x - m.pose.x), 2) + ' m</b> ' + (m.pose.x < m.cones.c1.x ? 'ileride' : 'geride') + ' (hedef: hizada)';
        }
      },
      {
        id: 'rev1', kind: 'setup', title: 'R\'ye al, direksiyonu sağa sonuna kadar kır',
        text: 'Frene basılı tutarak vitesi R\'ye al. Araç dururken direksiyonu SAĞA sonuna kadar çevir (D tuşu): yaklaşık 1,5 tur.',
        look: 'Göstergedeki direksiyon simgesini izle: "1,5 tur SAĞ" yazmalı.',
        highlight: ['c1'],
        need: { gear: 'R', steer: 1 },
        guide: { targetBox: true, ghost: finalGhost, line: null }
      },
      {
        id: 'arc1', kind: 'move', title: 'Çok yavaş geri gel — araç 45° açı alsın',
        text: 'Freni yavaşça bırak; frene hafif hafif dokunarak (Q\'ya kısa kısa basarak) çok yavaş geri gel. Aracın arkası park yerine girer. Araç kaldırıma göre yaklaşık 45° açı alınca DUR (bu araçla doğru durak ~37–55°; ekrandaki şerit "ŞİMDİ DUR" der).',
        look: 'Fareyi basılı tutup sola sürükle, sol aynaya bak: önce kaldırım tarafındaki arka duba görünür; yol tarafındaki arka duba aynadan kaybolunca araç ~45° olmuştur — dur.',
        highlight: ['c3', 'c2'],
        need: { gear: 'R', steer: 1 },
        guide: { targetBox: true, ghost: finalGhost, line: null },
        zone: function (m) {
          var over = { z: 'over', fix: 'D', value: m.theta, text: 'Fazla döndün, bu açıyla öndeki dubaya değeceksin. Frene bas, D\'ye al ve direksiyonu bozmadan biraz ileri gel.', cue: 'Fazla döndün → D\'ye al, biraz ileri' };
          if (m.theta > L.arc1.maxDeg) return over;
          var rear = rearAt(m.pose.x, m.pose.z, Math.max(0, m.theta / DEG));
          if (rear < L.arc1.rearMin) { var rem = arc1Remain(m); return { z: 'before', value: m.theta, remain: rem, left: Math.max(1, Math.round(rem / R * DEG)) + '°' }; }
          if (m.plan().clear >= L.arc1.clearMin) return { z: 'in', value: m.theta };
          return over;
        },
        info: function (m) { return 'Araç açısı: <b>' + Math.round(m.theta) + '°</b> (hedef ~45°, "ŞİMDİ DUR" deyince dur)'; }
      },
      {
        id: 'straight1', kind: 'setup', title: 'Direksiyonu düzelt',
        text: 'Araç dururken direksiyonu 1,5 tur SOLA çevirerek düzelt (A tuşu). Göstergede "DÜZ" yazana kadar.',
        look: 'Direksiyon simgesine bak: DÜZ.',
        highlight: [],
        need: { gear: 'R', steer: 0 },
        guide: { targetBox: true, ghost: finalGhost, line: null }
      },
      {
        id: 'back', kind: 'move', title: 'Düz geri gel',
        text: 'Direksiyon düz; frene hafif hafif dokunarak (Q\'ya kısa kısa basarak) çok yavaş geri gel. Sağ yan camdan öndeki dubaya bak: duba sağ ÖN TEKERİNİN hizasına gelince DUR — sağ ön köşe dubayı kurtarır, kaldırıma ~20–25 cm kalırsın. (Şerit "ŞİMDİ DUR" der.)',
        look: 'Fareyi basılı tutup sağa sürükle: sağ yan camdan öndeki dubayı izle (ön tekerin hizası). Sağ aynada arka teker ile kaldırım arasını da gör.',
        highlight: ['c1', 'c3'],
        need: { gear: 'R', steer: 0 },
        guide: { targetBox: true, ghost: finalGhost, line: null },
        zone: function (m) {
          var sn = Math.max(0.2, Math.sin(Math.max(0, m.theta / DEG)));
          if (m.predGap < L.gapMin) return { z: 'over', fix: 'D', value: m.predGap, text: 'Fazla geri geldin, kaldırıma çok yaklaşacaksın. D\'ye al, direksiyon düz — biraz ileri gel.', cue: 'Fazla geri → D\'ye al, biraz ileri' };
          if (m.predGap > L.gapTrigger) { var rem = (m.predGap - L.gapTrigger) / sn; return { z: 'before', value: m.predGap, remain: rem, left: mTxt(rem) }; }
          if (m.arc2Pred().clear >= L.arc2ClearMin) return { z: 'in', value: m.predGap, core: m.predGap >= L.gapCore };
          return { z: 'before', value: m.predGap, remain: 0.3, left: 'ön köşe dubayı kurtarsın' };
        },
        info: function (m) {
          return 'Şimdi sola kırarsan kaldırıma kalacak mesafe: <b>' + cm(Math.max(0, m.predGap)) + '</b> (hedef ~15–35 cm)<br>Öndeki duba sağ ön tekere: <b>' + cm(Math.abs(m.c1Lz - car.wheelbase)) + (m.c1Lz < car.wheelbase ? ' önde' : ' geride') + '</b> · sağ ön köşe – duba: <b>' + cm(Math.max(0, m.c1Clear)) + '</b>';
        }
      },
      {
        id: 'rev2', kind: 'setup', title: 'Direksiyonu sola sonuna kadar kır',
        text: 'Araç dururken direksiyonu SOLA sonuna kadar çevir (A tuşu): düzden 1,5 tur sola.',
        look: 'Direksiyon simgesi: "1,5 tur SOL".',
        highlight: [],
        need: { gear: 'R', steer: -1 },
        guide: { targetBox: true, ghost: finalGhost, line: null }
      },
      {
        id: 'arc2', kind: 'move', title: 'Geri gel — kaldırıma paralel ol',
        text: 'Direksiyon solda tam; frene hafif hafif dokunarak (Q\'ya kısa kısa basarak) çok yavaş geri gel. Aracın önü park yerine girer. Araç kaldırıma paralel olunca (açı 0°) DUR.',
        look: 'Sağ aynada aracın yan çizgisi ile kaldırım paralel olunca; sol aynada arkadaki dubalar düz bir sıra halinde görünür.',
        highlight: ['c1', 'c3', 'c5'],
        need: { gear: 'R', steer: -1 },
        guide: { targetBox: true, ghost: finalGhost, line: { x1: -1, z1: L.curbZ - (L.ghostGap || 0.3), x2: 8, z2: L.curbZ - (L.ghostGap || 0.3) } },
        zone: function (m) {
          if (m.theta > L.arc2.trigger) { var rem = (m.theta - L.arc2.trigger) / DEG * R; return { z: 'before', value: m.theta, remain: rem, left: Math.max(1, Math.round(m.theta - L.arc2.trigger)) + '°' }; }
          if (m.theta >= L.arc2.min && (m.theta >= 0 || m.curbGap >= L.arc2.curbMin)) return { z: 'in', value: m.theta, core: m.theta >= 0 || m.curbGap >= L.arc2.curbCore };
          return { z: 'over', fix: 'D', value: m.theta, text: 'Fazla döndün. D\'ye al ve direksiyonu bozmadan biraz ileri gel.', cue: 'Fazla döndün → D\'ye al, biraz ileri' };
        },
        info: function (m) { return 'Kaldırıma göre açı: <b>' + Math.round(m.theta) + '°</b> (hedef 0°)<br>Kaldırıma mesafe: <b>' + cm(m.curbGap) + '</b>'; }
      },
      {
        id: 'centre', kind: 'adjust', title: 'Direksiyonu düzelt, gerekirse ortala',
        text: 'Direksiyonu 1,5 tur sağa çevirip düzelt (DÜZ). Araç park yerinde öne ya da arkaya fazla yakınsa D veya R ile düz biraz hareket edip ortala, sonra dur.',
        look: 'Öndeki ve arkadaki dubalara benzer mesafe kalsın (iç aynada arka dubalar, ön camdan öndeki dubalar).',
        highlight: ['c1', 'c2'],
        need: { steer: 0 },
        guide: { targetBox: true, ghost: finalGhost, line: null },
        zone: function (m) {
          if (m.centreOff < -L.centreTol) { var r1 = -L.centreTol - m.centreOff; return { z: 'before', fix: 'D', value: m.centreOff, remain: r1, left: mTxt(r1), text: 'Araç arka dubalara yakın: D\'ye al, düz biraz ileri gel.', cue: 'D\'ye al, düz ileri…' }; }
          if (m.centreOff > L.centreTol) { var r2 = m.centreOff - L.centreTol; return { z: 'over', fix: 'R', value: m.centreOff, remain: r2, left: mTxt(r2), text: 'Araç öndeki dubalara yakın: R\'ye al, düz biraz geri gel.', cue: 'R\'ye al, düz geri…' }; }
          return { z: 'in', value: m.centreOff };
        },
        info: function (m) { return 'Ortaya göre: <b>' + (m.centreOff >= 0 ? 'ileride ' : 'geride ') + cm(Math.abs(m.centreOff)) + '</b> (±' + cm(L.centreTol) + ' yeterli)'; }
      },
      {
        id: 'park', kind: 'setup', title: 'Dur ve P\'ye al',
        text: 'Frene basılı tutarak vitesi P\'ye al. Sinyali kapat (kol ortada). Tebrikler — park tamam!',
        look: 'Son kontrol: araç park alanının içinde ve kaldırıma paralel mi?',
        highlight: [],
        need: { gear: 'P' },
        guide: { targetBox: true, ghost: finalGhost, line: null }
      }
    ], MOVES.parallel);
  }

  function perpendicularSteps(sc, cfg) {
    var L = sc.lesson, car = cfg.car;
    var finalGhost = { x: L.bayCx, z: L.mouthZ + (L.depth.trigger + L.depth.max) / 2, heading: Math.PI };
    return withMoves([
      {
        id: 'prep', kind: 'setup', title: 'Hazırlık',
        text: 'Frene bas (Q) ve basılı tut. Vitesi fareyle D\'ye al. Sinyal kolunu yukarı iterek SAĞ sinyali ver.',
        look: 'Fareyi basılı tutup sürükleyerek iç aynaya ve sağ aynaya bak; arkadan gelen var mı? (Çift tık ya da Boşluk: tekrar öne bak.)',
        highlight: [],
        need: { gear: 'D', signal: 'right' },
        guide: { targetBox: true, ghost: finalGhost, line: null }
      },
      {
        id: 'pass', kind: 'move', title: 'Park cebini çok yavaş geç',
        text: 'Direksiyon düz, gaz yok. Rölantide araç ~6 km/h ile gider, bu park için hızlı: frene hafif hafif dokunarak (Q\'ya kısa kısa basarak) çok yavaş ilerle. Cebin ağzındaki duba sırasıyla sağ tarafın arasında yaklaşık 1,5 m boşluk olsun. Cebi geç; yakın ağız dubası arka tamponunun ~1,3 m gerisinde kalınca DUR (şerit "ŞİMDİ DUR" der).',
        look: 'Fareyi basılı tutup sağa-arkaya sürükle (omuz üstü): cebin ağzındaki yakın duba (yeşil) arka tamponun ~1,3 m gerisinde kalınca dur. Bu duba sağ aynaya girdiyse fazla gittin.',
        highlight: ['p1'],
        need: { gear: 'D', steer: 0 },
        guide: function (m) {
          var x = typeof L.refBumperPast === 'number' ? m.cones.p1.x + L.refBumperPast + car.rearOverhang : L.bayCx + (L.stop1.min + L.stop1.max) / 2;
          return { targetBox: true, ghost: { x: x, z: m.pose.z, heading: HALF_PI }, line: { x1: L.bayCx, z1: -6, x2: L.bayCx, z2: L.backZ } };
        },
        zone: function (m) {
          var rem = L.stop1.min - m.past;
          if (rem > 0) return { z: 'before', value: m.past, remain: rem, left: mTxt(rem) };
          var ap = m.arcPred();
          if (m.past <= L.stop1.max && ap.clear >= L.arc.clearMin) return { z: 'in', value: m.past, core: m.past <= L.stop1.core };
          // a predicted touch on the FAR side (left row) means "not far enough yet", on the near side "too far"
          if (m.past <= L.stop1.max && m.cones[ap.id] && m.cones[ap.id].x < L.bayCx) return { z: 'before', value: m.past, remain: 0.05, left: '5 cm' };
          return { z: 'over', fix: 'R', value: m.past, text: 'Fazla ileri gittin: buradan tam kırarsan yakın ağız dubasına değersin. Frene bas, R\'ye al, direksiyon düz — biraz geri gel.', cue: 'Fazla gittin → R\'ye al, biraz geri' };
        },
        info: function (m) {
          var g = m.mouthGap, warn = (g < L.gapRange.min) ? ' ⚠ cebe çok yakınsın, biraz sola açıl' : (g > L.gapRange.max ? ' ⚠ çok uzaksın' : ' ✓');
          var pb = m.pose.x - car.rearOverhang - m.cones.p1.x;
          return 'Cebin ağzına yan mesafe: <b>' + fmtNum(g, 1) + ' m</b> (hedef 1,5 m)' + warn + '<br>Yakın ağız dubası arka tamponun <b>' + fmtNum(Math.abs(pb), 1) + ' m</b> ' + (pb >= 0 ? 'gerisinde' : 'ilerisinde') + ' (hedef ~1,3 m geride)';
        }
      },
      {
        id: 'rev1', kind: 'setup', title: 'R\'ye al, direksiyonu sağa sonuna kadar kır',
        text: 'Frene basılı tutarak R\'ye al. Araç dururken direksiyonu SAĞA sonuna kadar çevir (D tuşu): 1,5 tur.',
        look: 'Direksiyon simgesi: "1,5 tur SAĞ".',
        highlight: ['p1'],
        need: { gear: 'R', steer: 1 },
        guide: { targetBox: true, ghost: finalGhost, line: null }
      },
      {
        id: 'arc', kind: 'move', title: 'Yavaşça geri gel — iki aynayı izle',
        text: 'Freni yavaşça bırak; frene hafif hafif dokunarak (Q\'ya kısa kısa basarak) çok yavaş geri gel. Araç arkasıyla cebe dönerek girer. Araç cebin içinde iki duba sırasına paralel olunca (90° dönmüş) DUR.',
        look: 'Sağ aynada yakın ağız dubası aracın yanından geçer (değmemeli), sol aynada karşı sıradaki dubalar görünür. İki aynada dubalar aracın gövdesine eşit uzaklıkta, paralel görününce dur.',
        highlight: ['p1', 'p2', 'p3', 'p4'], mirrorCheck: { cone: 'p4', which: 'left' },
        need: { gear: 'R', steer: 1 },
        guide: { targetBox: true, ghost: finalGhost, line: null },
        zone: function (m) {
          var over = { z: 'over', fix: 'D', value: m.theta, text: 'Fazla döndün (ya da cebe ortalı girmiyorsun). D\'ye al ve direksiyonu bozmadan biraz ileri gel.', cue: 'Fazla döndün → D\'ye al, biraz ileri' };
          if (m.eps < L.arc.epsMin) { var rem = (L.arc.epsMin - m.eps) / DEG * m.R; return { z: 'before', value: m.theta, remain: rem, left: Math.max(1, Math.round(L.arc.epsMin - m.eps)) + '°' }; }
          if (m.eps > L.arc.epsMax) return over;
          var sp = m.straightPred();
          if (sp.clear >= L.arc.clearMin) return { z: 'in', value: m.theta };
          if (sp.off < 0) return { z: 'before', value: m.theta, remain: 0.1, left: 'biraz daha' };
          return over;
        },
        info: function (m) { return 'Dönülen açı: <b>' + Math.round(m.theta) + '°</b> (hedef 90°)'; }
      },
      {
        id: 'straight', kind: 'setup', title: 'Direksiyonu düzelt',
        text: 'Araç dururken direksiyonu 1,5 tur SOLA çevirerek düzelt (DÜZ).',
        look: 'Direksiyon simgesi: DÜZ.',
        highlight: [],
        need: { gear: 'R', steer: 0 },
        guide: { targetBox: true, ghost: finalGhost, line: null }
      },
      {
        id: 'back', kind: 'move', title: 'Düz geri gel',
        text: 'Direksiyon düz; frene hafif hafif dokunarak (Q\'ya kısa kısa basarak) çok yavaş geri gel. Aracın önü cebin ağzını geçip tamamen içeri girince, arkada dip çizgiye ~0,5 m kalmışken DUR.',
        look: 'İki aynada yan dubaları izle: iki tarafta boşluk eşit kalmalı. Ön camdan ağız dubalarının aracın önünde kaldığını gör.',
        highlight: ['p5', 'p6'],
        need: { gear: 'R', steer: 0 },
        guide: { targetBox: true, ghost: finalGhost, line: null },
        zone: function (m) {
          var rem = L.depth.trigger - m.depth;
          if (rem > 0) return { z: 'before', value: m.depth, remain: rem, left: mTxt(rem) };
          if (m.depth <= L.depth.max) return { z: 'in', value: m.depth };
          return { z: 'over', fix: 'D', value: m.depth, text: 'Fazla geri geldin. D\'ye al, direksiyon düz — biraz ileri gel.', cue: 'Fazla geri → D\'ye al, biraz ileri' };
        },
        info: function (m) {
          return 'Önün cebin içinde: <b>' + cm(m.frontIn) + '</b> · Arkada kalan: <b>' + cm(m.rearGap) + '</b><br>Yan kayma: <b>' + cm(Math.abs(m.sideOff)) + (m.sideOff > 0.02 ? ' (sola)' : (m.sideOff < -0.02 ? ' (sağa)' : '')) + '</b>';
        }
      },
      {
        id: 'park', kind: 'setup', title: 'Dur ve P\'ye al',
        text: 'Frene basılı tutarak vitesi P\'ye al. Sinyali kapat. Tebrikler — garaja park tamam!',
        look: 'Son kontrol: araç iki duba sırasının tam ortasında ve düz mü?',
        highlight: [],
        need: { gear: 'P' },
        guide: { targetBox: true, ghost: finalGhost, line: null }
      }
    ], MOVES.perpendicular);
  }

  PS.lessonDefs = { parallel: parallelSteps, perpendicular: perpendicularSteps };

  // ------------------------------------------------------------------
  // Step evaluation (pure)
  // ------------------------------------------------------------------
  var STEER_TOL = 0.03, LOCK_TOL = 0.995;
  function steerMatches(target, steer) {
    if (target === 0) return Math.abs(steer) <= STEER_TOL;
    if (target > 0) return steer >= LOCK_TOL;
    return steer <= -LOCK_TOL;
  }

  /** st (optional, per-step scratch object): after an overshoot, 'in' only counts inside the zone's core band */
  function evalStep(step, m, st) {
    var r = { needs: [], zone: null, done: false, stopNow: false, steerOk: true, gearOk: true, signalOk: true };
    var n = step.need || {};
    if (n.gear && m.gear !== n.gear) { r.gearOk = false; r.needs.push({ k: 'gear', text: 'Vitesi ' + n.gear + '\'ye al (frene basarak)' }); }
    if (n.steer !== undefined) {
      r.steerOk = steerMatches(n.steer, m.steer);
      if (!r.steerOk) {
        r.needs.push({ k: 'steer', text: n.steer === 0 ? 'Direksiyonu düzelt (DÜZ)' : ('Direksiyonu ' + (n.steer > 0 ? 'SAĞA' : 'SOLA') + ' sonuna kadar kır') });
      }
    }
    if (n.signal && m.signal !== n.signal) { r.signalOk = false; r.needs.push({ k: 'signal', text: (n.signal === 'right' ? 'Sağ' : 'Sol') + ' sinyali ver (kolu ' + (n.signal === 'right' ? 'yukarı' : 'aşağı') + ' it)' }); }
    if (step.zone) {
      r.zone = step.zone(m);
      if (st) {
        if (r.zone.z === 'over') st.wasOver = true;
        else if (r.zone.z === 'in' && r.zone.core === false && st.wasOver) {
          var prevOver = st.lastOver || {};
          r.zone = { z: 'over', fix: prevOver.fix, text: 'Biraz daha… dubaya göre ortaya gel.', cue: prevOver.cue || 'Biraz daha…', remain: 0.1 };
        }
        if (r.zone.z === 'over' && r.zone.fix) st.lastOver = r.zone;
      }
    }
    if (step.kind === 'setup') {
      r.done = r.needs.length === 0 && m.stopped;
    } else {
      r.done = r.steerOk && r.zone && r.zone.z === 'in' && m.stopped;
      r.stopNow = r.zone && r.zone.z === 'in' && !m.stopped;
    }
    return r;
  }

  // ------------------------------------------------------------------
  // Move ticking (pure). ms = per-step state { tick: [null|'done'|'skip'], cur }
  // ctx = { head: { yaw } | null }. Looking right (mirror / shoulder) = yaw <= LOOK_YAW.
  // ------------------------------------------------------------------
  var LOOK_YAW = -0.6, LIVE_KINDS = { gear: 1, signal: 1, steer: 1 };
  function movePred(mv, m, r, ctx) {
    switch (mv.k) {
      case 'gear': return m.gear === mv.v;
      case 'signal': return m.signal === mv.v;
      case 'steer': return steerMatches(mv.v, m.steer);
      case 'look': return !!(ctx && ctx.head && typeof ctx.head.yaw === 'number' && ctx.head.yaw <= LOOK_YAW);
      case 'stop': return !!(r && r.done);
    }
    return false;
  }
  function updateMoves(step, m, r, ctx, ms) {
    var mv = step.moves || [];
    ms = ms || {};
    if (!ms.tick || ms.tick.length !== mv.length) { ms.tick = mv.map(function () { return null; }); ms.order = []; }
    // live predicates: an undone gear / signal / steering move becomes current again
    for (var i = 0; i < mv.length; i++) {
      if (ms.tick[i] === 'done' && LIVE_KINDS[mv[i].k] && !movePred(mv[i], m, r, ctx) && !(r && r.done)) {
        for (var j = i; j < mv.length; j++) if (mv[j].k !== 'look') ms.tick[j] = null;
        break;
      }
    }
    for (var k = 0; k < mv.length; k++) {
      if (ms.tick[k]) continue;
      if (movePred(mv[k], m, r, ctx)) { ms.tick[k] = 'done'; ms.order.push(k); } else break;
    }
    if (r && r.done) for (var q = 0; q < mv.length; q++) if (!ms.tick[q]) { ms.tick[q] = movePred(mv[q], m, r, ctx) ? 'done' : 'skip'; ms.order.push(q); }
    ms.cur = -1;
    for (var c = 0; c < mv.length; c++) if (!ms.tick[c]) { ms.cur = c; break; }
    return ms;
  }
  /** current move object of a step state (or null) */
  function currentMove(step, ms) { return ms && ms.cur >= 0 && step.moves ? step.moves[ms.cur] : null; }
  function moveLines(steps) {
    var out = [], n = 0;
    steps.forEach(function (st) { (st.moves || []).forEach(function (mv) { n++; out.push({ n: n, step: st.id, t: mv.t, when: mv.when || null }); }); });
    return out;
  }

  PS.lessonEngine = { metrics: metrics, evalStep: evalStep, steerMatches: steerMatches, turnsText: turnsText, fmtNum: fmtNum,
    updateMoves: updateMoves, currentMove: currentMove, moveLines: moveLines, LOOK_YAW: LOOK_YAW };

  // ==================================================================
  // UI controller (browser only)
  // ==================================================================
  var HONEST_NOTE = 'Not: Referans noktaları (hangi dubanın hangi camda ya da aynada görüneceği) araç modeline ve koltuk ayarına göre değişir. ' +
    'Buradaki adımları yöntemin mantığı olarak öğren; gerçek araçta kendi hocanın gösterdiği referans noktalarını kullan. ' +
    'Park alanı ölçüleri tipik alıştırma ölçüleridir, resmî ölçü değildir.';
  var HIGHLIGHT = 0x36d27a;
  var PRAISE = ['Aferin!', 'Çok iyi!', 'Harika!', 'Tamam, devam!', 'Güzel!'];

  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function mmss(t) { t = Math.max(0, t); var m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ':' + (s < 10 ? '0' : '') + s; }

  var C = {
    mode: 'learn', sim: null, sc: null, steps: [], idx: 0,
    opts: {}, el: {}, renderT: 0, mirrorT: 0, mirrorOk: false,
    lastZone: null, lastStop: false, finished: false, exam: null, toastTimer: null,
    moves: [], moveSig: ''
  };

  function world(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (C.opts.world) return C.opts.world(name, args);
    return undefined;
  }
  function audio(name) { var a = PS.audio; if (a && typeof a[name] === 'function') { try { a[name].apply(a, Array.prototype.slice.call(arguments, 1)); } catch (e) { /* ignore */ } } }

  function toast(msg, kind, ms) {
    var t = C.el.toast; if (!t) return;
    t.textContent = msg;
    t.className = 'show ' + (kind || '');
    clearTimeout(C.toastTimer);
    C.toastTimer = setTimeout(function () { t.className = ''; }, ms || 2600);
  }

  function applyWorldForStep() {
    if (C.mode !== 'learn') {
      world('highlightCones', [], HIGHLIGHT);
      world('setGuide', null);
      world('setPathPreview', false);
      return;
    }
    var step = C.steps[C.idx];
    world('setPathPreview', true);
    if (!step) { world('highlightCones', [], HIGHLIGHT); return; }
    world('highlightCones', step.highlight || [], HIGHLIGHT);
    var g = step.guide;
    if (typeof g === 'function') { try { g = g(metrics(C.sim)); } catch (e) { g = null; } }
    world('setGuide', g || { targetBox: true, ghost: null, line: null });
  }

  // ---------------- cue bar (just above the divider, where the learner looks) ----------------
  function setCue(cls, html) {
    var c = C.el.cue; if (!c) return;
    if (C.cueCls !== cls) { C.cueCls = cls; c.className = cls ? 'show ' + cls : ''; }
    if (C.cueHtml !== html) { C.cueHtml = html; c.innerHTML = html; }
  }

  /** text of the move that is next (current move of this step, else the first move of the next step) */
  function nextMoveText(step, ms) {
    var mv = currentMove(step, ms);
    if (!mv) { var nx = C.steps[C.idx + 1]; mv = nx && nx.moves && nx.moves[0]; }
    return mv ? mv.t : (step ? step.title : '');
  }

  function cueFor(step, r, m, ms) {
    if (!step) return ['', ''];
    if (r.done) return ['done', '✓ Tamam · SIRADAKİ: ' + esc(nextMoveText(C.steps[C.idx + 1] || step, null))];
    var n = step.need || {}, mv = currentMove(step, ms);
    var extra = mv && mv.k === 'steer' ? ' <small>(şu an ' + esc(turnsText(m.steer)) + ')</small>' : '';
    if (step.kind === 'setup') {
      if (!m.stopped) return ['setup', 'Frene bas, DUR <small>· sonra: ' + esc(nextMoveText(step, ms)) + '</small>'];
      return ['setup', 'SIRADAKİ: ' + esc(nextMoveText(step, ms)) + extra];
    }
    var z = r.zone || { z: 'before' };
    if (z.z === 'in') return m.stopped ? ['done', '✓ Tamam'] : ['stop', 'ŞİMDİ DUR!'];
    if (z.z === 'over' || (step.kind === 'adjust' && z.z === 'before' && r.steerOk)) return ['over', esc(z.cue || z.text || 'Fazla gittin')];
    if (!r.steerOk) return ['setup', (m.stopped ? '' : 'Önce dur · ') + 'SIRADAKİ: ' + esc(nextMoveText(step, ms)) + extra];
    if (n.gear && !r.gearOk) return ['setup', 'Frene bas · ' + n.gear + '\'ye al'];
    var slow = m.kmh > 3.5 ? ' <small>yavaş! frene hafif hafif dokun</small>' : ((z.remain !== undefined && z.remain < 1.5) ? ' <small>frene hafif dokunarak çok yavaş</small>' : '');
    return ['go', esc(mv ? mv.t : (n.gear === 'R' ? 'GERİ GEL…' : 'İLERLE…')) + (z.left ? ' <small>(hedefe ' + esc(z.left) + ')</small>' : '') + slow];
  }

  // ---------------- move list (top-right, Öğren mode) ----------------
  function moveListHtml(steps, name, withIds) {
    var h = '<div class="ml-head">Hamle listesi — ' + esc(name) + '</div><ol class="ml">', n = 0;
    steps.forEach(function (st, si) {
      (st.moves || []).forEach(function (mv, mi) {
        n++;
        h += '<li' + (withIds ? ' data-s="' + si + '" data-m="' + mi + '"' : '') + '><span class="n">' + n + '</span><span class="t">' + esc(mv.t) + '</span>' +
          (mv.when ? '<span class="w">Ne zaman dur: ' + esc(mv.when) + '</span>' : '') + '</li>';
      });
    });
    return h + '</ol>';
  }
  function buildMoveList() {
    var el = C.el.moves; if (!el) return;
    C.moveSig = '';
    if (C.mode !== 'learn') { el.classList.add('hidden'); el.innerHTML = ''; C.el.moveItems = []; return; }
    el.innerHTML = moveListHtml(C.steps, C.sc.name, true);
    el.classList.remove('hidden');
    C.el.moveItems = typeof el.querySelectorAll === 'function' ? Array.prototype.slice.call(el.querySelectorAll('li')) : [];
    fitMoves();
    renderMoves();
  }
  function moveState(si, mi) {
    var ms = C.moves[si];
    if (si < C.idx) return (ms && ms.tick && ms.tick[mi]) || 'done';
    if (si > C.idx || C.finished) return si > C.idx ? '' : ((ms && ms.tick && ms.tick[mi]) || 'done');
    if (!ms || !ms.tick) return mi === 0 ? 'cur' : '';
    return ms.tick[mi] || (ms.cur === mi ? 'cur' : '');
  }
  function renderMoves() {
    var items = C.el.moveItems; if (!items || !items.length) return;
    var sig = '', cur = null;
    items.forEach(function (li) {
      var si = +li.getAttribute('data-s'), mi = +li.getAttribute('data-m'), stt = moveState(si, mi);
      sig += stt.charAt(0) || '-';
      var cls = stt === 'done' ? 'done' : (stt === 'skip' ? 'skip' : (stt === 'cur' ? 'cur' : ''));
      if (li.className !== cls) li.className = cls;
      if (cls === 'cur') cur = li;
    });
    if (sig === C.moveSig) return;
    C.moveSig = sig;
    // keep the current row in view inside the list (never scrolls the page)
    var ol = typeof C.el.moves.querySelector === 'function' ? C.el.moves.querySelector('ol') : null;
    if (cur && ol && ol.scrollHeight > ol.clientHeight + 1) {
      var top = cur.offsetTop - ol.offsetTop;
      if (top < ol.scrollTop || top + cur.offsetHeight > ol.scrollTop + ol.clientHeight) ol.scrollTop = Math.max(0, top - 20);
    }
  }
  /** pick 1 or 2 columns (and a tighter font) so every move is visible without scrolling */
  function fitMoves() {
    var el = C.el.moves; if (!el || el.classList.contains('hidden')) return;
    el.classList.remove('two', 'tight');
    if (el.scrollHeight > el.clientHeight + 1) el.classList.add('two');
    if (el.scrollHeight > el.clientHeight + 1) el.classList.add('tight');
  }
  function moveCtx() { return { head: (PS.controls && PS.controls.head) || null }; }

  // ---------------- learn panel ----------------
  function buildLearnSkeleton() {
    var step = C.steps[C.idx], n = C.steps.length;
    var prog = '';
    for (var i = 0; i < n; i++) prog += '<i class="' + (i < C.idx ? 'done' : (i === C.idx ? 'cur' : '')) + '"></i>';
    C.el.body.innerHTML =
      '<div class="p-scroll">' +
        '<div class="steps-progress">' + prog + '</div>' +
        '<div class="step-num">Adım ' + (C.idx + 1) + ' / ' + n + '</div>' +
        '<div class="step-title">' + esc(step.title) + '</div>' +
        '<p class="step-text">' + esc(step.text) + '</p>' +
        '<div class="look">👀 <b>Nereye bak:</b> ' + esc(step.look) + '</div>' +
      '</div>' +
      '<div class="p-fixed">' +
        '<ul class="needs" id="lsNeeds"></ul>' +
        '<div id="lsStatus" class="status go"></div>' +
        '<div id="lsLive" class="live"></div>' +
        '<div id="lsMirror" class="mirror-ok"></div>' +
        '<div class="panel-btns"><button class="btn" id="lsPrev">◀ Önceki</button><button class="btn" id="lsSkip">Adımı atla ⏭</button>' +
          '<button class="btn info-btn" id="lsInfo" title="' + esc(HONEST_NOTE) + '">ⓘ</button></div>' +
        '<div class="note-pop hidden" id="lsNote">' + esc(HONEST_NOTE) + '</div>' +
      '</div>';
    C.el.needs = document.getElementById('lsNeeds');
    C.el.status = document.getElementById('lsStatus');
    C.el.live = document.getElementById('lsLive');
    C.el.mirror = document.getElementById('lsMirror');
    document.getElementById('lsSkip').addEventListener('click', function () { gotoStep(C.idx + 1, false); this.blur(); });
    document.getElementById('lsPrev').addEventListener('click', function () { gotoStep(C.idx - 1, false); this.blur(); });
    document.getElementById('lsInfo').addEventListener('click', function () { var nn = document.getElementById('lsNote'); if (nn) nn.classList.toggle('hidden'); this.blur(); });
    C.mirrorOk = false;
  }

  function gotoStep(i, praised) {
    if (i < 0) i = 0;
    if (i >= C.steps.length) { finishLesson(); return; }
    for (var s2 = 0; s2 < C.steps.length; s2++) {
      if (s2 >= i) C.moves[s2] = null;                                   // current + later steps start fresh
      else if (!C.moves[s2] || !C.moves[s2].tick) C.moves[s2] = { tick: (C.steps[s2].moves || []).map(function () { return 'skip'; }), cur: -1 };
      else C.moves[s2].tick = C.moves[s2].tick.map(function (t) { return t || 'skip'; });
    }
    C.idx = i; C.lastZone = null; C.lastStop = false; C.stepState = {}; C.beepT = 0;
    buildLearnSkeleton();
    applyWorldForStep();
    renderLearn(true);
  }

  function statusFor(step, r, m) {
    if (r.done) return { cls: 'done', html: '✓ Tamam' };
    if (step.kind === 'setup') {
      if (!m.stopped) return { cls: 'over', html: 'Önce frene basıp (Q) aracı durdur.' };
      return { cls: 'go', html: 'Yukarıdaki maddeleri tamamla.' };
    }
    var z = r.zone ? r.zone.z : 'before';
    if (r.stopNow) return { cls: 'stop', html: 'ŞİMDİ DUR! &nbsp;Frene bas (Q)' };
    if (z === 'over' || (step.kind === 'adjust' && z === 'before')) return { cls: 'over', html: '⚠ ' + esc(r.zone.text || '') };
    if (z === 'in') return { cls: 'done', html: '✓ Doğru yerdesin, dur.' };
    if (!r.steerOk) return { cls: 'over', html: 'Önce aracı durdur ve ' + (step.need.steer === 0 ? 'direksiyonu düzelt (DÜZ).' : 'direksiyonu ' + (step.need.steer > 0 ? 'SAĞA' : 'SOLA') + ' sonuna kadar kır.') };
    if (!r.gearOk) return { cls: 'over', html: 'Vitesi ' + step.need.gear + '\'ye al (frene basarak).' };
    var fast = m.kmh > 3.5 ? ' <b>Yavaş!</b> Q\'ya kısa kısa basarak hızı 1–3 km/h\'de tut (gaz yok).' : '';
    var dirTxt = (step.need.gear === 'R' ? 'Freni yavaşça bırak, araç rölantide geri gider.' : 'Freni yavaşça bırak, araç rölantide ilerler.') + ' Frene hafif hafif dokunarak çok yavaş gel.';
    return { cls: 'go', html: dirTxt + (r.zone && r.zone.left ? ' Hedefe: <b>' + esc(r.zone.left) + '</b>.' : '') + fast };
  }

  function renderLearn(force) {
    var step = C.steps[C.idx];
    if (!step || !C.el.status) return;
    var m = metrics(C.sim), r = evalStep(step, m, C.stepState);
    // needs list
    var n = step.need || {}, items = [];
    if (n.gear) items.push({ ok: r.gearOk, t: 'Vites ' + n.gear + (r.gearOk ? '' : ' (şu an ' + m.gear + ')') });
    if (n.steer !== undefined) items.push({ ok: r.steerOk, t: 'Direksiyon ' + (n.steer === 0 ? 'DÜZ' : (n.steer > 0 ? '1,5 tur SAĞ (tam)' : '1,5 tur SOL (tam)')) + ' — şu an: ' + turnsText(m.steer) });
    if (n.signal) items.push({ ok: r.signalOk, t: (n.signal === 'right' ? 'Sağ' : 'Sol') + ' sinyal (kolu ' + (n.signal === 'right' ? 'yukarı' : 'aşağı') + ' it)' });
    if (step.kind === 'setup' && (n.gear || n.signal)) items.push({ ok: m.stopped, t: 'Araç duruyor (frene bas: Q)' });
    C.el.needs.innerHTML = items.map(function (it) { return '<li class="' + (it.ok ? 'ok' : 'no') + '">' + (it.ok ? '✓ ' : '○ ') + esc(it.t) + '</li>'; }).join('');
    var st = statusFor(step, r, m);
    C.el.status.className = 'status ' + st.cls;
    C.el.status.innerHTML = st.html;
    var live = '';
    if (step.info) { try { live = step.info(m); } catch (e) { live = ''; } }
    live += (live ? '<br>' : '') + 'Direksiyon: <b>' + turnsText(m.steer) + '</b> · Hız: <b>' + Math.round(m.kmh) + ' km/h</b>';
    if (C.sc.id === 'parallel' && step.id !== 'pass' && step.id !== 'prep' && step.id !== 'arc1' && step.id !== 'arc2') live += ' · Açı: <b>' + Math.round(Math.abs(m.theta)) + '°</b>';
    C.el.live.innerHTML = live;
    C.el.mirror.textContent = (step.mirrorCheck && C.mirrorOk) ? '✓ Duba ' + (step.mirrorCheck.which === 'left' ? 'sol' : (step.mirrorCheck.which === 'right' ? 'sağ' : 'iç')) + ' aynada görünüyor' : '';
  }

  function updateLearn(dt) {
    var step = C.steps[C.idx];
    if (!step || C.finished) { setCue('', ''); return; }
    var m = metrics(C.sim), r = evalStep(step, m, C.stepState);
    var ms = C.moves[C.idx] = updateMoves(step, m, r, moveCtx(), C.moves[C.idx]);
    renderMoves();
    var cue = cueFor(step, r, m, ms);
    setCue(cue[0], cue[1]);
    // feedback sounds
    var z = r.zone ? r.zone.z : null;
    if (r.stopNow && !C.lastStop) audio('stopBeep');
    C.lastStop = r.stopNow;
    if (z === 'over' && C.lastZone !== 'over' && step.kind !== 'adjust') { audio('refuse'); toast(r.zone.text, 'warn', 3500); }
    C.lastZone = z;
    // parking-sensor style approach beeps during the last ~0.8 m before the stop zone
    if (z === 'before' && !m.stopped && r.zone && typeof r.zone.remain === 'number' && r.zone.remain < 0.8 && step.kind === 'move') {
      C.beepT -= dt;
      if (C.beepT <= 0) { audio('sensorBeep'); C.beepT = 0.12 + r.zone.remain * 0.7; }
    } else C.beepT = 0;
    if (step.mirrorCheck) {
      C.mirrorT -= dt;
      if (C.mirrorT <= 0) {
        C.mirrorT = 0.25;
        var v = world('isConeVisibleInMirror', step.mirrorCheck.cone, step.mirrorCheck.which);
        C.mirrorOk = v === true;
      }
    }
    if (r.done) {
      if (C.idx === C.steps.length - 1) { audio('chime'); finishLesson(); return; }
      audio('chime');
      toast('✓ ' + PRAISE[C.idx % PRAISE.length] + ' Sıradaki adım: ' + C.steps[C.idx + 1].title, 'good', 2200);
      gotoStep(C.idx + 1, true);
      return;
    }
    C.renderT -= dt;
    if (C.renderT <= 0) { C.renderT = 0.1; renderLearn(); }
  }

  function finishLesson() {
    C.finished = true;
    renderMoves();
    setCue('', '');
    var ev = C.sim.evaluate();
    audio(ev.pass ? 'passJingle' : 'chime');
    showResult(ev, null, 'learn');
  }

  // ---------------- exam ----------------
  function buildExam() {
    setCue('', '');
    var note = 'Bu bir sınav benzeri değerlendirmedir; resmî MEB puanlaması değildir. Dubaya çarpmak ya da kaldırıma sert vurmak sınavı hemen bitirir.';
    C.el.body.innerHTML =
      '<div class="p-scroll">' +
        '<div class="step-title">Sınav: ' + esc(C.sc.name) + '</div>' +
        '<p class="exam-task">Aracı dubalara değmeden park alanına park et, P\'ye al.</p>' +
        '<div class="exam-sub" id="exSub">Süre, araç ilk hareket ettiğinde başlar. Araç P\'de ve park alanının içindeyse sınav kendiliğinden biter.</div>' +
      '</div>' +
      '<div class="p-fixed">' +
        '<div class="exam-timer" id="exTimer">0:00</div>' +
        '<div class="panel-btns"><button class="btn danger" id="exFinish">■ Bitir</button><button class="btn info-btn" id="exInfo" title="' + esc(note) + '">ⓘ</button></div>' +
        '<div class="note-pop hidden" id="exNote">' + esc(note) + '</div>' +
      '</div>';
    document.getElementById('exInfo').addEventListener('click', function () { var nn = document.getElementById('exNote'); if (nn) nn.classList.toggle('hidden'); this.blur(); });
    C.el.timer = document.getElementById('exTimer');
    document.getElementById('exFinish').addEventListener('click', function () { finishExam(null); });
  }

  function updateExam(dt) {
    if (C.finished) return;
    var sim = C.sim;
    var t = sim.firstMoveTime === null ? 0 : sim.time - sim.firstMoveTime;
    C.renderT -= dt;
    if (C.renderT <= 0 && C.el.timer) { C.renderT = 0.2; C.el.timer.textContent = mmss(t); }
    if (sim.firstMoveTime !== null && sim.gear === 'P' && sim.isStopped() && PS.physics.isInsideBox(sim.car, sim.pose(), C.sc.box)) {
      C.exam.parkedT += dt;
      if (C.exam.parkedT > 0.7) finishExam(null);
    } else C.exam.parkedT = 0;
  }

  function finishExam(failReason) {
    if (C.finished) return;
    C.finished = true;
    setCue('', '');
    if (C.opts.setFrozen) C.opts.setFrozen(true);
    var ev = C.sim.evaluate();
    var pass = ev.pass && !failReason;
    audio(pass ? 'passJingle' : 'failJingle');
    showResult(ev, failReason, 'exam');
  }

  // ---------------- result card ----------------
  function showResult(ev, failReason, kind) {
    var e = C.el, sc = C.sc;
    var pass = ev.pass && !failReason;
    var head;
    if (kind === 'learn') {
      head = pass ? '🎉 Tebrikler, park tamam!' : '✓ Adımları bitirdin';
      head += '<small>' + (pass ? 'Tüm adımları duba kuralına göre yaptın. Şimdi Sınav modunda ipuçsuz dene!' : 'Sonuç tam değil — aşağıdaki kırmızı maddelere bak ve tekrar dene.') + '</small>';
    } else {
      head = pass ? '✅ Başarılı' : '❌ Başarısız';
      var why = failReason || (!ev.checks.cones ? 'Dubaya temas var.' : !ev.checks.inside ? 'Araç tamamen park alanının içinde değil.' :
        !ev.checks.angle ? 'Araç park alanına yeterince paralel / dik değil.' : !ev.checks.gap ? 'Kaldırıma mesafe uygun değil.' :
          !ev.checks.gearP ? 'Vites P\'de değil.' : !ev.checks.curb ? 'Kaldırıma sert çarptın.' : 'Güzel park!');
      head += '<small>' + esc(why) + '</small>';
    }
    e.resultHead.className = 'result-head ' + (pass ? 'pass' : 'fail');
    e.resultHead.innerHTML = head;
    var rows = [];
    function row(label, val, cls) { rows.push('<li class="' + cls + '"><span>' + esc(label) + '</span><span class="v">' + esc(val) + '</span></li>'); }
    row('Dubaya temas yok', ev.checks.cones ? '✓ Evet' : '✗ ' + ev.conesHit.length + ' duba', ev.checks.cones ? 'ok' : 'no');
    row('Kaldırım', ev.curbHits === 0 ? '✓ Temas yok' : (ev.hardCurb ? '✗ Sert çarpma' : '△ ' + ev.curbHits + ' hafif temas'), ev.curbHits === 0 ? 'ok' : (ev.hardCurb ? 'no' : 'mid'));
    row('Araç tamamen park alanında', ev.inside ? '✓ Evet' : '✗ Hayır', ev.inside ? 'ok' : 'no');
    var ang = Math.abs(ev.headingErrDeg);
    row(sc.id === 'parallel' ? 'Paralellik açısı' : 'Diklik açısı (sıralara göre)', fmtNum(ang, 1) + '°', ang <= 5 ? 'ok' : (ang <= 8 ? 'mid' : 'no'));
    if (ev.curbGapCm !== null) row('Kaldırıma mesafe (sağ teker)', Math.round(ev.curbGapCm) + ' cm', ev.checks.gap ? (ev.curbGapCm >= 10 && ev.curbGapCm <= 45 ? 'ok' : 'mid') : 'no');
    row('Sinyal verildi mi', ev.signalOk ? '✓ Evet' : '✗ Hayır', ev.signalOk ? 'ok' : 'mid');
    row('Manevra sayısı (yön değişimi)', String(ev.dirChanges), ev.dirChanges <= 3 ? 'ok' : 'mid');
    row('Süre', mmss(ev.time), 'ok');
    row('Vites P', ev.gear === 'P' ? '✓ Evet' : '✗ ' + ev.gear, ev.gear === 'P' ? 'ok' : 'no');
    e.resultList.innerHTML = rows.join('');
    e.btnToLearn.textContent = kind === 'learn' ? 'Sınav modunu dene ▶' : 'Öğren moduna dön';
    e.btnToLearn.setAttribute('data-target', kind === 'learn' ? 'exam' : 'learn');
    if (e.resultMoves) { e.resultMoves.classList.add('hidden'); e.resultMoves.innerHTML = ''; }
    if (e.btnMoves) e.btnMoves.textContent = 'Hamle listesini göster';
    e.result.classList.remove('hidden');
  }

  function hideResult() { if (C.el.result) C.el.result.classList.add('hidden'); }

  PS.lessons = {
    /** opts: { world(name, args) -> result, setFrozen(bool), onRetry(), onSwitchMode(mode) } */
    init: function (opts) {
      C.opts = opts || {};
      var $ = function (id) { return document.getElementById(id); };
      C.el = {
        body: $('panelBody'), mode: $('panelMode'), scn: $('panelScenario'), toast: $('toast'), cue: $('cue'),
        result: $('resultCard'), resultHead: $('resultHead'), resultList: $('resultList'),
        btnRetry: $('btnRetry'), btnToLearn: $('btnToLearn'),
        moves: $('moveList'), resultMoves: $('resultMoves'), btnMoves: $('btnMoves')
      };
      if (C.el.btnMoves && C.el.resultMoves) C.el.btnMoves.addEventListener('click', function () {
        var rm = C.el.resultMoves, open = rm.classList.contains('hidden');
        if (open) {
          rm.innerHTML = moveListHtml(C.steps, C.sc ? C.sc.name : '', true);
          // read-only copy: in Öğren it shows what was ticked, in Sınav it is the plain list
          if (C.mode === 'learn' && typeof rm.querySelectorAll === 'function') Array.prototype.forEach.call(rm.querySelectorAll('li'), function (li) {
            var stt = moveState(+li.getAttribute('data-s'), +li.getAttribute('data-m')); li.className = stt === 'cur' ? '' : stt;
          });
        }
        rm.classList.toggle('hidden', !open);
        this.textContent = open ? 'Hamle listesini gizle' : 'Hamle listesini göster';
        this.blur();
      });
      C.el.btnRetry.addEventListener('click', function () { hideResult(); if (C.opts.onRetry) C.opts.onRetry(); });
      C.el.btnToLearn.addEventListener('click', function () {
        hideResult();
        if (C.opts.onSwitchMode) C.opts.onSwitchMode(this.getAttribute('data-target') || 'learn');
      });
    },
    /** (re)start the current mode on a freshly reset sim */
    start: function (mode, sim) {
      C.mode = mode === 'exam' ? 'exam' : 'learn';
      C.sim = sim; C.sc = sim.scenario;
      C.steps = PS.lessonDefs[C.sc.id](C.sc, PS.config);
      C.idx = 0; C.finished = false; C.exam = { parkedT: 0 }; C.stepState = {}; C.beepT = 0; C.cueCls = null; C.cueHtml = null;
      C.renderT = 0; C.lastZone = null; C.lastStop = false;
      hideResult();
      if (C.el.mode) { C.el.mode.textContent = C.mode === 'exam' ? 'Sınav' : 'Öğren'; C.el.mode.className = 'chip' + (C.mode === 'exam' ? ' exam' : ''); }
      if (C.el.scn) C.el.scn.textContent = C.sc.name;
      C.moves = C.steps.map(function () { return null; });
      if (C.mode === 'learn') { buildLearnSkeleton(); renderLearn(true); } else buildExam();
      buildMoveList();
      if (C.el.resultMoves) { C.el.resultMoves.classList.add('hidden'); C.el.resultMoves.innerHTML = ''; }
      applyWorldForStep();
    },
    update: function (dt) {
      if (!C.sim) return;
      if (C.mode === 'learn') updateLearn(dt); else updateExam(dt);
    },
    onEvent: function (ev) {
      if (!C.sim || C.finished) return;
      if (ev.type === 'cone') {
        if (C.mode === 'exam') { finishExam('Dubaya çarptın.'); return; }
        toast('💥 Dubaya çarptın! İstersen ↺ Baştan başla ile tekrar dene.', 'bad', 3500);
      } else if (ev.type === 'curb') {
        if (C.mode === 'exam' && ev.hard) { finishExam('Kaldırıma sert çarptın.'); return; }
        toast(ev.hard ? 'Kaldırıma çarptın! Biraz ters yöne al.' : 'Teker kaldırıma değdi.', 'warn', 2600);
      } else if (ev.type === 'bounds') {
        toast('Parkurun dışına çıktın — ↺ Baştan başla.', 'warn', 2600);
      }
    },
    finishExam: finishExam,
    fitMoves: fitMoves,
    isFinished: function () { return C.finished; },
    mode: function () { return C.mode; },
    toast: toast,
    hideResult: hideResult
  };
})(typeof window !== 'undefined' ? window : this);
