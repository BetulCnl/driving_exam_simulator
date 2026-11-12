/* PS.controls – keyboard (W/Q/A/D by physical key code), hold-to-look head turning,
 * automatic gear selector, signal stalk, pedal bars.
 *
 * LOOK RULES: the view only turns while a mouse button (left or right) is HELD on the
 * driver view (bottom half of #scene) and dragged. Bare cursor movement never moves the
 * head. Rotation is relative (delta based); on release the head stays where it is.
 * Recentre: double-click on the driver view, Space, or the "Öne bak" button.
 */
(function (root) {
  'use strict';
  var PS = root.PS = root.PS || {};
  var DEG = Math.PI / 180;

  var keys = { gas: false, brake: false, left: false, right: false };
  var CODE = { KeyW: 'gas', KeyQ: 'brake', KeyA: 'left', KeyD: 'right' };
  var BLOCK = { Space: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, PageUp: 1, PageDown: 1, Home: 1, End: 1 };

  var cb = {};
  var head = { yaw: 0, pitch: 0 }, target = { yaw: 0, pitch: 0 };
  var MAX_YAW = 120 * DEG, MAX_PITCH = 20 * DEG;
  var YAW_SPAN = 0.45;          // fraction of viewport width that sweeps 0 -> MAX_YAW
  var PITCH_RATE = 0.5;         // pitch radians per pixel relative to yaw radians per pixel
  var DRAG_THRESHOLD = 4;       // px before a press becomes a look-drag
  var K_FOLLOW = 28;            // 1/s, head easing while dragging (time constant ~36 ms)
  var K_RECENTER = 13;          // 1/s, recentre easing (~96 % in 0.25 s)
  var recentering = false;
  var look = null;              // active press on the driver view
  var lookEndedAt = -1e9;       // for context-menu suppression after a right-button drag
  var busy = false;             // dragging a widget (gear knob / stalk)
  var gearUI = 'P', signalUI = 'off';
  var el = {};
  var cancelGearDrag = function () {};
  var pedalCache = { gas: -1, brake: -1 };

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function now() { return (root.performance && root.performance.now) ? root.performance.now() : Date.now(); }
  function anyInput() { if (cb.onAnyInput) cb.onAnyInput(); }

  function clearKeys() { keys.gas = keys.brake = keys.left = keys.right = false; }

  function recenter() {
    target.yaw = 0; target.pitch = 0;
    recentering = true;
  }

  function onKeyDown(e) {
    var t = e.target;
    var typing = t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type === 'text'));
    if (typing) return;
    var k = CODE[e.code];
    if (k) {
      e.preventDefault();
      keys[k] = true;            // repeats just keep it true
      anyInput();
      return;
    }
    if (e.code === 'KeyR') {
      e.preventDefault();
      if (!e.repeat && cb.onReset) cb.onReset();
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();        // never scroll / never activate a focused button
      if (!e.repeat) recenter();
      return;
    }
    if (BLOCK[e.code]) e.preventDefault();
  }
  function onKeyUp(e) {
    var k = CODE[e.code];
    if (k) { e.preventDefault(); keys[k] = false; return; }
    if (e.code === 'Space') e.preventDefault();
  }

  // ---------------- hold-to-look ----------------
  function setRootClass(c, on) {
    var d = document.documentElement;
    if (d && d.classList) d.classList.toggle(c, !!on);
  }
  function setSceneCursor(c) {
    if (el.scene && el.sceneCursor !== c) { el.sceneCursor = c; el.scene.style.cursor = c; }
  }
  function inDriverView(y) { return y >= root.innerHeight / 2; }

  function onScenePointerDown(e) {
    if (e.button !== 0 && e.button !== 2) return;
    if (look) return;
    e.preventDefault();          // no text selection / drag ghost / focus change
    if (!inDriverView(e.clientY)) return;   // bird's-eye half: nothing
    look = { id: e.pointerId, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, active: false };
    try { el.scene.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
  }
  function onScenePointerMove(e) {
    if (!look) {
      // no button held: only cursor feedback, NEVER the view
      setSceneCursor(inDriverView(e.clientY) ? 'grab' : 'default');
      return;
    }
    if (e.pointerId !== look.id) return;
    if (!look.active) {
      var tx = e.clientX - look.x0, ty = e.clientY - look.y0;
      if (tx * tx + ty * ty < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      look.active = true;
      look.lx = look.x0; look.ly = look.y0;   // apply the movement from the press point
      recentering = false;
      setRootClass('look-drag', true);
      setSceneCursor('grabbing');
    }
    var dx = e.clientX - look.lx, dy = e.clientY - look.ly;
    look.lx = e.clientX; look.ly = e.clientY;
    var radPerPx = MAX_YAW / Math.max(200, root.innerWidth * YAW_SPAN);
    target.yaw = clamp(target.yaw - dx * radPerPx, -MAX_YAW, MAX_YAW);            // drag left -> look left (+yaw)
    target.pitch = clamp(target.pitch - dy * radPerPx * PITCH_RATE, -MAX_PITCH, MAX_PITCH);   // drag up -> look up
  }
  function endLook() {
    if (!look) return;
    var id = look.id, wasActive = look.active;
    look = null;
    if (wasActive) lookEndedAt = now();
    setRootClass('look-drag', false);
    setSceneCursor('grab');
    try { if (el.scene.hasPointerCapture && el.scene.hasPointerCapture(id)) el.scene.releasePointerCapture(id); } catch (er) { /* ignore */ }
  }
  function onScenePointerUp(e) { if (look && e.pointerId === look.id) endLook(); }
  function onSceneDblClick(e) {
    if (inDriverView(e.clientY)) { e.preventDefault(); recenter(); }
  }

  function updateHead(dt) {
    if (!(dt > 0)) dt = 1 / 60;
    var k = 1 - Math.exp(-dt * (recentering ? K_RECENTER : K_FOLLOW));
    head.yaw += (target.yaw - head.yaw) * k;
    head.pitch += (target.pitch - head.pitch) * k;
    if (Math.abs(target.yaw - head.yaw) < 1e-3 && Math.abs(target.pitch - head.pitch) < 1e-3) {
      head.yaw = target.yaw; head.pitch = target.pitch;     // settle exactly (no endless drift)
      recentering = false;
    }
    if (el.btnLook) {
      var off = Math.abs(target.yaw) > 2 * DEG || Math.abs(target.pitch) > 2 * DEG;
      if (el.lookOff !== off) { el.lookOff = off; el.btnLook.classList.toggle('active', off); }
    }
    return head;
  }

  function initLook() {
    el.scene = document.getElementById('scene');
    el.btnLook = document.getElementById('btnLook');
    if (el.scene) {
      el.scene.addEventListener('pointerdown', onScenePointerDown);
      el.scene.addEventListener('pointermove', onScenePointerMove);
      el.scene.addEventListener('pointerup', onScenePointerUp);
      el.scene.addEventListener('pointercancel', onScenePointerUp);
      el.scene.addEventListener('lostpointercapture', onScenePointerUp);
      el.scene.addEventListener('dblclick', onSceneDblClick);
      el.scene.addEventListener('dragstart', function (e) { e.preventDefault(); });
      el.scene.addEventListener('selectstart', function (e) { e.preventDefault(); });
    }
    if (el.btnLook) {
      el.btnLook.addEventListener('pointerdown', function (e) { e.preventDefault(); });   // keep focus off the button
      el.btnLook.addEventListener('click', function () { anyInput(); recenter(); this.blur(); });
    }
    root.addEventListener('blur', endLook);
  }

  // ---------------- automatic gear selector ----------------
  function slotTop(g) {
    var s = el.gearGate && el.gearGate.querySelector('.gear-slot[data-g="' + g + '"]');
    return s ? s.offsetTop : 0;
  }
  function placeKnob(g) {
    if (!el.gearKnob) return;
    el.gearKnob.style.top = slotTop(g) + 'px';
    var slots = el.gearGate.querySelectorAll('.gear-slot');
    for (var i = 0; i < slots.length; i++) slots[i].classList.toggle('on', slots[i].getAttribute('data-g') === g);
  }
  function requestGear(g) {
    if (!cb.onGear) return;
    var res = cb.onGear(g, keys.brake);
    if (!res || !res.ok) {
      placeKnob(gearUI);
      if (el.gearWrap) {
        el.gearWrap.classList.remove('shake');
        void el.gearWrap.offsetWidth;
        el.gearWrap.classList.add('shake');
      }
    }
  }
  function initGear() {
    el.gearWrap = document.getElementById('gearWrap');
    el.gearGate = document.getElementById('gearGate');
    el.gearKnob = document.getElementById('gearKnob');
    el.gearLock = document.getElementById('gearLock');
    if (!el.gearGate) return;
    var slots = el.gearGate.querySelectorAll('.gear-slot');
    for (var i = 0; i < slots.length; i++) {
      slots[i].addEventListener('pointerdown', function (e) {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        anyInput();
        requestGear(this.getAttribute('data-g'));
      });
    }
    var drag = null;
    el.gearKnob.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      anyInput();
      drag = { y0: e.clientY, top0: el.gearKnob.offsetTop, moved: false };
      busy = true;
      el.gearKnob.classList.add('dragging');
      try { el.gearKnob.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
    });
    el.gearKnob.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dy = e.clientY - drag.y0;
      if (Math.abs(dy) > 3) drag.moved = true;
      el.gearKnob.style.top = clamp(drag.top0 + dy, slotTop('P'), slotTop('D')) + 'px';
    });
    function endDrag() {
      if (!drag) return;
      var top = el.gearKnob.offsetTop, best = gearUI, bd = 1e9;
      ['P', 'R', 'N', 'D'].forEach(function (g) { var d = Math.abs(slotTop(g) - top); if (d < bd) { bd = d; best = g; } });
      el.gearKnob.classList.remove('dragging');
      var moved = drag.moved;
      drag = null; busy = false;
      if (moved && best !== gearUI) requestGear(best); else placeKnob(gearUI);
    }
    el.gearKnob.addEventListener('pointerup', endDrag);
    el.gearKnob.addEventListener('pointercancel', endDrag);
    el.gearKnob.addEventListener('lostpointercapture', endDrag);
    cancelGearDrag = function () { if (drag) { drag = null; busy = false; el.gearKnob.classList.remove('dragging'); } };
    placeKnob('P');
  }

  // ---------------- signal stalk ----------------
  var STALK_DEG = 16;
  function sigPos(s) { return s === 'right' ? 1 : (s === 'left' ? -1 : 0); }
  function drawStalk(pos) {
    if (el.stalk) el.stalk.style.transform = 'rotate(' + (pos * STALK_DEG) + 'deg)';   // + = tip up (pivot on the right)
  }
  function setSignal(s) { if (cb.onSignal) cb.onSignal(s); }
  function initStalk() {
    el.stalk = document.getElementById('stalk');
    el.stalkArea = document.getElementById('stalkArea');
    el.up = document.getElementById('stalkHitUp');
    el.down = document.getElementById('stalkHitDown');
    if (!el.stalkArea) return;
    var drag = null;
    el.stalkArea.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      anyInput();
      drag = { y0: e.clientY, p0: sigPos(signalUI), pos: sigPos(signalUI), moved: false };
      busy = true;
      el.stalk.classList.add('dragging');
      el.stalkArea.classList.add('drag');
      try { el.stalkArea.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
    });
    el.stalkArea.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dy = drag.y0 - e.clientY;               // up = +
      if (Math.abs(dy) > 4) drag.moved = true;
      drag.pos = clamp(drag.p0 + dy / 28, -1.15, 1.15);
      drawStalk(drag.pos);
    });
    function end() {
      if (!drag) return;
      var p = drag.pos, s;
      if (!drag.moved) s = 'off';                  // a simple click on the lever (middle) cancels the signal
      else s = p > 0.5 ? 'right' : (p < -0.5 ? 'left' : 'off');
      drag = null; busy = false;
      el.stalk.classList.remove('dragging');
      el.stalkArea.classList.remove('drag');
      setSignal(s);
      drawStalk(sigPos(signalUI));
    }
    el.stalkArea.addEventListener('pointerup', end);
    el.stalkArea.addEventListener('pointercancel', end);
    el.stalkArea.addEventListener('lostpointercapture', end);
    function hit(dir) {
      return function (e) {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault(); anyInput();
        setSignal(signalUI === dir ? 'off' : dir);
      };
    }
    el.up.addEventListener('pointerdown', hit('right'));
    el.down.addEventListener('pointerdown', hit('left'));
    drawStalk(0);
  }

  // ---------------- pedal bars ----------------
  function setPedalUI(p) {
    if (!p) return;
    if (!el.gasFill) { el.gasFill = document.getElementById('pedGasFill'); el.brakeFill = document.getElementById('pedBrakeFill'); }
    var g = Math.round(clamp(Number(p.gas) || 0, 0, 1) * 50) * 2;      // percent in 2 % steps
    var b = Math.round(clamp(Number(p.brake) || 0, 0, 1) * 50) * 2;
    if (g !== pedalCache.gas && el.gasFill) { pedalCache.gas = g; el.gasFill.style.width = g + '%'; }
    if (b !== pedalCache.brake && el.brakeFill) { pedalCache.brake = b; el.brakeFill.style.width = b + '%'; }
  }

  PS.controls = {
    /** opts: { onGear(g, brakeHeld) -> {ok}, onSignal(s), onReset(), onAnyInput() } */
    init: function (opts) {
      cb = opts || {};
      root.addEventListener('keydown', onKeyDown, true);
      root.addEventListener('keyup', onKeyUp, true);
      root.addEventListener('blur', clearKeys);
      document.addEventListener('visibilitychange', function () { if (document.hidden) { clearKeys(); endLook(); } });
      root.addEventListener('wheel', function (e) { if (!(e.target && e.target.closest && e.target.closest('#panel, .card'))) e.preventDefault(); }, { passive: false });
      document.addEventListener('contextmenu', function (e) {
        if ((e.target && e.target.id === 'scene') || look || now() - lookEndedAt < 400) e.preventDefault();
      });
      // a clicked button must not keep focus (Space would re-trigger it)
      document.addEventListener('click', function (e) {
        var b = e.target && e.target.closest && e.target.closest('button');
        if (b && b.blur) b.blur();
      });
      initLook();
      initGear();
      initStalk();
    },
    read: function () { return { gas: keys.gas, brake: keys.brake, left: keys.left, right: keys.right }; },
    clearKeys: clearKeys,
    updateHead: updateHead,
    head: head,
    resetHead: function () { head.yaw = head.pitch = target.yaw = target.pitch = 0; recentering = false; },
    recenterHead: recenter,
    isLooking: function () { return !!(look && look.active); },
    isBusy: function () { return busy; },
    setGearUI: function (g) { if (g !== gearUI) { gearUI = g; placeKnob(g); } },
    /** hard re-sync (reset / scenario switch): cancel drags, jump the knob without animation */
    syncGearUI: function (g) {
      cancelGearDrag();
      gearUI = g;
      if (el.gearKnob) {
        el.gearKnob.classList.add('dragging');
        placeKnob(g);
        void el.gearKnob.offsetWidth;
        var k = el.gearKnob;
        (root.requestAnimationFrame || setTimeout)(function () { k.classList.remove('dragging'); });
      }
    },
    refreshGearUI: function () { placeKnob(gearUI); },
    setBrakeUI: function (on) { if (el.gearLock) { el.gearLock.classList.toggle('ok', !!on); el.gearLock.textContent = on ? '✓ fren basılı' : '🔒 fren (Q)'; } },
    /** analog pedal positions 0..1 (optional; without it the bars follow the W/Q keys) */
    setPedalUI: setPedalUI,
    setSignalUI: function (s) {
      if (s === signalUI) return;
      signalUI = s;
      if (!busy) drawStalk(sigPos(s));
      if (el.up) { el.up.classList.toggle('on', s === 'right'); el.down.classList.toggle('on', s === 'left'); }    }
  };
})(typeof window !== 'undefined' ? window : this);
