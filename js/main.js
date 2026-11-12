/* main.js – bootstrap + requestAnimationFrame loop.
 * read inputs -> physics.step -> lessons.update -> world.render(state, dt)
 */
(function (root) {
  'use strict';
  var PS = root.PS = root.PS || {};

  var app = {
    scenarioId: 'parallel', mode: 'learn',
    sim: null, started: false, frozen: false,
    last: 0, worldOk: true, blinkPrev: false, signalPrev: 'off', gearPrev: 'P',
    timeScale: 1
  };
  var worldErr = {};
  var hud = {};

  function $(id) { return document.getElementById(id); }

  function showError(msg) {
    var o = $('errorOverlay'), t = $('errorText');
    if (t) t.innerHTML = msg;
    if (o) o.classList.remove('hidden');
    var s = $('startScreen'); if (s) s.classList.add('hidden');
  }

  /** Guarded call into the renderer: never lets a rendering bug kill the UI/simulation. */
  function world(name, args) {
    var w = PS.world;
    if (!w || typeof w[name] !== 'function') return undefined;
    try { return w[name].apply(w, args || []); }
    catch (e) {
      if (!worldErr[name]) { worldErr[name] = true; if (root.console) console.error('[PS.world.' + name + ']', e); }
      return undefined;
    }
  }

  function scenario() { return PS.config.scenarios[app.scenarioId]; }

  function topInsets() {
    var p = $('panel'), tb = $('topbar');
    var left = p ? Math.round(p.getBoundingClientRect().right + 6) : 0;
    var top = tb ? Math.round(tb.getBoundingClientRect().bottom + 4) : 0;
    var lg = $('legend');
    if (lg && lg.offsetParent !== null) top = Math.max(top, Math.round(lg.getBoundingClientRect().bottom + 4));
    var bottom = $('cue') ? 34 : 0;      // cue bar sits just above the divider
    // move list ("Hamle listesi") docked on the right, under the top bar / legend
    var right = 0, ml = $('moveList'), W = root.innerWidth || 1280, H = root.innerHeight || 720;
    if (ml && !ml.classList.contains('hidden')) {
      ml.style.top = top + 'px';
      ml.style.maxHeight = Math.max(120, Math.round(H / 2 - top - 6)) + 'px';
      if (PS.lessons && PS.lessons.fitMoves) PS.lessons.fitMoves();
      right = Math.max(0, Math.round(W - ml.getBoundingClientRect().left + 6));
    }
    // centre toast + cue bar in the free area between the two panels
    var mid = Math.round((left + (W - right)) / 2), free = Math.max(200, W - right - left - 16);
    var ts = $('toast'); if (ts) { ts.style.left = mid + 'px'; ts.style.maxWidth = free + 'px'; }
    var cu = $('cue'); if (cu) { cu.style.left = mid + 'px'; cu.style.maxWidth = free + 'px'; }
    world('setTopInsets', [{ left: left, right: right, top: top, bottom: bottom }]);
  }

  function setSegments() {
    var mb = document.querySelectorAll('#modeSeg button');
    for (var i = 0; i < mb.length; i++) mb[i].classList.toggle('on', mb[i].getAttribute('data-mode') === app.mode);
    var sb = document.querySelectorAll('#scnSeg button');
    for (var j = 0; j < sb.length; j++) sb[j].classList.toggle('on', sb[j].getAttribute('data-scn') === app.scenarioId);
  }

  function restart() {
    var sc = scenario();
    if (app.sim.scenario !== sc) app.sim.setScenario(sc); else app.sim.reset();
    app.frozen = false;
    world('loadScenario', [sc]);
    if (PS.controls) {
      if (PS.controls.syncGearUI) PS.controls.syncGearUI(app.sim.gear); else PS.controls.setGearUI(app.sim.gear);
      PS.controls.setSignalUI('off'); PS.controls.clearKeys();
    }
    app.signalPrev = 'off'; app.gearPrev = app.sim.gear;
    if (PS.lessons) PS.lessons.start(app.mode, app.sim);
    setSegments();
    topInsets();
  }

  function setMode(m) { app.mode = m === 'exam' ? 'exam' : 'learn'; restart(); }
  function setScenario(id) { if (PS.config.scenarios[id]) { app.scenarioId = id; restart(); } }

  // ---------------- input callbacks ----------------
  function onGear(g, brakeHeld) {
    if (PS.audio) PS.audio.unlock();
    if (app.frozen || !app.started) return { ok: false };
    var res = app.sim.requestGear(g, brakeHeld);
    if (res.ok) {
      if (res.path.length && PS.audio) PS.audio.gearClunks(res.path);
      PS.controls.setGearUI(app.sim.gear);
    } else {
      if (PS.audio) PS.audio.refuse();
      var msg = res.reason === 'brake' ? 'Vites değiştirmek için frene bas (Q)' :
        (res.reason === 'speed' ? 'Önce aracı tamamen durdur (Q ile fren), sonra vites değiştir' : 'Bu vitese şu an geçilemez');
      if (PS.lessons) PS.lessons.toast(msg, 'warn', 2400);
    }
    return res;
  }

  function onSignal(s) {
    if (PS.audio) PS.audio.unlock();
    if (!app.started) return;
    if (s !== app.sim.signal) {
      app.sim.setSignal(s);
      if (PS.audio) PS.audio.stalkClick();
    }
    PS.controls.setSignalUI(app.sim.signal);
  }

  // ---------------- HUD ----------------
  function initHud() {
    hud.speed = $('speedVal'); hud.gear = $('gearBig'); hud.aL = $('arrowL'); hud.aR = $('arrowR');
    hud.steerRot = $('steerRot'); hud.steerTxt = $('steerTxt'); hud.gas = $('pedGas'); hud.brake = $('pedBrake');
    hud.cache = {};
  }
  function setText(key, node, txt) { if (node && hud.cache[key] !== txt) { hud.cache[key] = txt; node.textContent = txt; } }
  function setClass(key, node, cls) { if (node && hud.cache[key] !== cls) { hud.cache[key] = cls; node.className = cls; } }

  function updateHud(state, inputs) {
    setText('spd', hud.speed, String(Math.round(Math.abs(state.car.speed) * 3.6)));
    setText('gear', hud.gear, state.gear);
    setClass('gearc', hud.gear, 'gear-big ' + state.gear);
    setClass('aL', hud.aL, 'turn-arrow' + (state.signal === 'left' && state.blinkOn ? ' on' : ''));
    setClass('aR', hud.aR, 'turn-arrow' + (state.signal === 'right' && state.blinkOn ? ' on' : ''));
    var deg = state.car.steer * PS.config.car.steeringWheelLockDeg;
    if (hud.steerRot) hud.steerRot.setAttribute('transform', 'rotate(' + deg.toFixed(1) + ')');
    var tt = PS.lessonEngine ? PS.lessonEngine.turnsText(state.car.steer, PS.config.car.steeringWheelLockDeg) : '';
    setText('stt', hud.steerTxt, tt);
    setClass('stc', hud.steerTxt, 'hud-val' + (state.car.steer > 0.01 ? ' right' : (state.car.steer < -0.01 ? ' left' : '')));
    var pd = state.pedals || { gas: inputs.gas ? 1 : 0, brake: inputs.brake ? 1 : 0 };
    setClass('gas', hud.gas, 'pedal' + (pd.gas > 0.05 ? ' on' : ''));
    setClass('brk', hud.brake, 'pedal brake' + (pd.brake > 0.05 ? ' on' : ''));
    if (PS.controls) {
      PS.controls.setBrakeUI(inputs.brake || pd.brake > 0.05);
      if (typeof PS.controls.setPedalUI === 'function') PS.controls.setPedalUI({ gas: pd.gas, brake: pd.brake });
    }
  }

  // ---------------- per-frame state ----------------
  function buildState(head) {
    var s = app.sim;
    var blink = s.signal !== 'off' && ((s.time % (1 / 1.5)) < (0.5 / 1.5));
    // pose interpolated between the last two fixed physics sub-steps (smooth at any refresh rate)
    var rc = s.renderCar ? s.renderCar() : s.state;
    return {
      car: { x: rc.x, z: rc.z, heading: rc.heading, speed: rc.speed, steer: rc.steer, steerAngle: rc.steerAngle, wheelRot: rc.wheelRot },
      gear: s.gear,
      signal: s.signal, blinkOn: blink,
      brake: s.brake,                                   // brake lights: pedal travel > 5 %
      pedals: { gas: s.pedals ? s.pedals.gas : 0, brake: s.pedals ? s.pedals.brake : 0 },
      head: { yaw: head.yaw, pitch: head.pitch },
      time: s.time
    };
  }

  var NO_INPUT = { gas: false, brake: true, left: false, right: false };

  function frame(ts) {
    root.requestAnimationFrame(frame);
    if (document.hidden) { app.last = ts; return; }
    var raw = app.last ? (ts - app.last) / 1000 : 1 / 60;
    app.last = ts;
    // real-time accumulator: physics advances by the real elapsed time in fixed 1/240 s sub-steps
    // (inside sim.step). PS.physics.frameDt is the same clock the headless audit verifies
    // (10–144 fps: sim time = wall time; stalls > 0,25 s are dropped, not replayed).
    var dt = PS.physics.frameDt(raw, 1);

    var inputs = PS.controls ? PS.controls.read() : NO_INPUT;
    var head = PS.controls ? PS.controls.updateHead(dt) : { yaw: 0, pitch: 0 };
    var live = app.started && !app.frozen;
    var simDt = PS.physics.frameDt(raw, app.timeScale);
    if (live) app.sim.step(simDt, inputs);
    else app.sim.step(simDt, NO_INPUT);

    var evs = app.sim.drainEvents();
    for (var i = 0; i < evs.length; i++) {
      var ev = evs[i];
      if (ev.type === 'cone') { world('setConeHit', [ev.id, true]); if (PS.audio) PS.audio.coneHit(); }
      else if (ev.type === 'curb') { if (PS.audio) PS.audio.curb(ev.hard); }
      else if (ev.type === 'signalCancel') { if (PS.audio) PS.audio.stalkClick(); }
      if (PS.lessons && app.started) PS.lessons.onEvent(ev);
    }

    if (app.sim.signal !== app.signalPrev) { app.signalPrev = app.sim.signal; if (PS.controls) PS.controls.setSignalUI(app.sim.signal); }
    if (app.sim.gear !== app.gearPrev) { app.gearPrev = app.sim.gear; if (PS.controls) PS.controls.setGearUI(app.sim.gear); }

    if (PS.lessons && app.started) { try { PS.lessons.update(simDt); } catch (e) { if (!worldErr._lessons) { worldErr._lessons = true; console.error('[lessons]', e); } } }

    var state = buildState(head);
    if (state.blinkOn !== app.blinkPrev) {
      if (state.signal !== 'off' && PS.audio) PS.audio.tick(state.blinkOn);
      app.blinkPrev = state.blinkOn;
    }
    world('render', [state, dt]);
    updateHud(state, live ? inputs : NO_INPUT);
    if (PS.audio) PS.audio.updateEngine(state.car.speed, live && state.pedals.gas > 0.05, state.gear);
  }

  // ---------------- boot ----------------
  function boot() {
    if (!PS.config || !PS.physics) { showError('Simülasyon dosyaları yüklenemedi (js/config.js, js/physics.js). Dosyaların tam olduğundan emin ol.'); return; }
    app.sim = PS.physics.create(PS.config, scenario());

    if (!root.THREE) {
      showError('3D grafik kütüphanesi (three.js) yüklenemedi. Bu kütüphane internetten (cdnjs) indiriliyor — <b>internet bağlantını kontrol et</b> ve sayfayı yenile.');
      return;
    }
    if (!PS.world) {
      showError('3D sahne dosyası (js/world.js) yüklenemedi ya da hatalı. Dosyaların tam olduğundan emin ol ve sayfayı yenile.');
      return;
    }
    var canvas = $('scene');
    try { PS.world.init({ canvas: canvas }); }
    catch (e) {
      console.error('[PS.world.init]', e);
      showError('3D sahne başlatılamadı. Tarayıcın WebGL desteklemiyor olabilir ya da grafik sürücüsü kapalı. Başka bir tarayıcıyla (Chrome, Edge, Firefox) dene.<br><small>' + String(e && e.message || e).replace(/</g, '&lt;') + '</small>');
      return;
    }

    initHud();
    if (PS.controls) PS.controls.init({
      onGear: onGear,
      onSignal: onSignal,
      onReset: function () { if (app.started) restart(); },
      onAnyInput: function () { if (PS.audio) PS.audio.unlock(); }
    });
    if (PS.lessons) PS.lessons.init({
      world: world,
      setFrozen: function (f) { app.frozen = !!f; if (f && PS.controls) PS.controls.clearKeys(); },
      onRetry: function () { restart(); },
      onSwitchMode: function (m) { setMode(m); }
    });

    // top bar
    var mb = document.querySelectorAll('#modeSeg button');
    for (var i = 0; i < mb.length; i++) mb[i].addEventListener('click', function () { setMode(this.getAttribute('data-mode')); this.blur(); });
    var sb = document.querySelectorAll('#scnSeg button');
    for (var j = 0; j < sb.length; j++) sb[j].addEventListener('click', function () { setScenario(this.getAttribute('data-scn')); this.blur(); });
    $('btnReset').addEventListener('click', function () { restart(); this.blur(); });
    $('btnMute').addEventListener('click', function () {
      if (PS.audio) { PS.audio.unlock(); var m = PS.audio.toggleMute(); this.textContent = m ? '🔇' : '🔊'; }
      this.blur();
    });
    document.addEventListener('pointerdown', function () { if (PS.audio) PS.audio.unlock(); }, true);

    // start screen
    $('btnStart').addEventListener('click', function () {
      if (PS.audio) PS.audio.unlock();
      var sc = document.querySelector('input[name="scn"]:checked');
      var md = document.querySelector('input[name="mode"]:checked');
      app.scenarioId = sc ? sc.value : 'parallel';
      app.mode = md && md.value === 'exam' ? 'exam' : 'learn';
      $('startScreen').classList.add('hidden');
      app.started = true;
      restart();
      this.blur();
    });

    root.addEventListener('resize', function () {
      world('resize', []);
      if (PS.controls) PS.controls.refreshGearUI();
      topInsets();
    });
    document.addEventListener('visibilitychange', function () { app.last = 0; });

    // ---- testing hook (console): PS.debug.getState(), .sim, .setPose(x, z, heading), .setTimeScale(k)
    PS.debug = {
      sim: app.sim,
      app: app,
      getState: function () { return buildState(PS.controls ? PS.controls.head : { yaw: 0, pitch: 0 }); },
      setPose: function (x, z, heading) {
        var st = app.sim.state;
        if (typeof x === 'number') st.x = x;
        if (typeof z === 'number') st.z = z;
        if (typeof heading === 'number') st.heading = heading;
        st.speed = 0;
        return app.sim.pose();
      },
      setTimeScale: function (k) { app.timeScale = Math.max(0.05, Math.min(8, Number(k) || 1)); return app.timeScale; },
      metrics: function () { return PS.lessonEngine ? PS.lessonEngine.metrics(app.sim) : null; },
      evaluate: function () { return app.sim.evaluate(); }
    };

    world('loadScenario', [scenario()]);
    world('setPathPreview', [false]);
    world('resize', []);
    topInsets();
    setSegments();
    root.requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
