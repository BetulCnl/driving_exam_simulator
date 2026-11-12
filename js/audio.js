/* PS.audio – all sounds synthesized with WebAudio (no files).
 * The AudioContext is created lazily on the first user gesture (PS.audio.unlock()).
 */
(function (root) {
  'use strict';
  var PS = root.PS = root.PS || {};

  var ctx = null, master = null, noiseBuf = null, muted = false;
  var engine = null;
  var lastTick = 0;

  function unlock() {
    if (ctx) { if (ctx.state === 'suspended' && ctx.resume) ctx.resume(); return; }
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.8;
      var comp = ctx.createDynamicsCompressor();
      master.connect(comp); comp.connect(ctx.destination);
      var len = Math.floor(ctx.sampleRate * 1.0);
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) { ctx = null; }
  }

  function ok() { return ctx && master && !muted; }
  function now() { return ctx.currentTime; }

  function env(g, t, a, peak, dcy) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + dcy);
  }

  function noise(t, dur, type, freq, q, peak, attack) {
    var src = ctx.createBufferSource(); src.buffer = noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    var f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q || 1;
    var g = ctx.createGain();
    env(g, t, attack || 0.002, peak, dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
  }

  function tone(t, type, f0, f1, dur, peak, attack) {
    var o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    var g = ctx.createGain();
    env(g, t, attack || 0.004, peak, dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  /** one mechanical detent: "çaart" (filtered noise) + "çurt" (low thump); variant 0..3 */
  function clunkAt(t, variant) {
    var v = variant || 0;
    noise(t, 0.045, 'bandpass', 1900 + v * 260, 1.4, 0.55, 0.002);
    noise(t + 0.012, 0.03, 'highpass', 4200, 0.7, 0.18, 0.001);
    tone(t + 0.008, 'sine', 120 - v * 8, 52, 0.10, 0.6, 0.003);
    tone(t + 0.004, 'triangle', 340 + v * 30, 180, 0.035, 0.12, 0.002);
  }

  var api = {
    unlock: unlock,
    isMuted: function () { return muted; },
    setMuted: function (m) {
      muted = !!m;
      if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : 0.8, ctx.currentTime, 0.02);
    },
    toggleMute: function () { api.setMuted(!muted); return muted; },

    /** n clunks, one per detent passed; gears = array of gear letters passed (for variation) */
    gearClunks: function (gears) {
      if (!ok()) return;
      var t = now() + 0.01;
      var map = { P: 0, R: 1, N: 2, D: 3 };
      (gears && gears.length ? gears : ['D']).forEach(function (g, i) {
        clunkAt(t + i * 0.085, map[g] || 0);
      });
    },
    refuse: function () {
      if (!ok()) return;
      var t = now() + 0.01;
      tone(t, 'square', 170, 160, 0.09, 0.08, 0.003);
      tone(t + 0.12, 'square', 150, 140, 0.11, 0.08, 0.003);
      noise(t, 0.05, 'lowpass', 600, 0.7, 0.15, 0.002);
    },
    tick: function (on) {
      if (!ok()) return;
      var t = now();
      if (t - lastTick < 0.05) return;
      lastTick = t;
      noise(t, 0.018, 'highpass', on ? 3200 : 2400, 1, 0.35, 0.001);
      tone(t, 'sine', on ? 1900 : 1450, on ? 1700 : 1250, 0.03, 0.12, 0.001);
    },
    stalkClick: function () {
      if (!ok()) return;
      var t = now();
      noise(t, 0.025, 'bandpass', 2600, 2, 0.4, 0.001);
      tone(t, 'triangle', 600, 300, 0.03, 0.12, 0.001);
    },
    coneHit: function () {
      if (!ok()) return;
      var t = now();
      tone(t, 'sine', 160, 55, 0.28, 0.7, 0.004);
      noise(t, 0.18, 'lowpass', 900, 0.8, 0.5, 0.003);
      tone(t + 0.02, 'triangle', 420, 200, 0.12, 0.15, 0.003);  // hollow plastic
    },
    curb: function (hard) {
      if (!ok()) return;
      var t = now();
      tone(t, 'sine', hard ? 90 : 110, 38, 0.3, hard ? 0.95 : 0.6, 0.003);
      noise(t, 0.12, 'lowpass', 500, 0.7, hard ? 0.6 : 0.35, 0.002);
    },
    chime: function () {
      if (!ok()) return;
      var t = now() + 0.01;
      tone(t, 'sine', 880, 880, 0.35, 0.25, 0.005);
      tone(t + 0.11, 'sine', 1318.5, 1318.5, 0.5, 0.22, 0.005);
    },
    sensorBeep: function () {
      if (!ok()) return;
      var t = now() + 0.005;
      tone(t, 'sine', 1568, 1568, 0.045, 0.10, 0.002);
    },
    stopBeep: function () {
      if (!ok()) return;
      var t = now() + 0.01;
      tone(t, 'sine', 1046.5, 1046.5, 0.09, 0.22, 0.003);
      tone(t + 0.12, 'sine', 1046.5, 1046.5, 0.09, 0.22, 0.003);
    },
    passJingle: function () {
      if (!ok()) return;
      var t = now() + 0.02;
      [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) { tone(t + i * 0.13, 'triangle', f, f, i === 3 ? 0.7 : 0.22, 0.3, 0.006); });
    },
    failJingle: function () {
      if (!ok()) return;
      var t = now() + 0.02;
      [392, 349.23, 311.13, 261.63].forEach(function (f, i) { tone(t + i * 0.17, 'sawtooth', f, f * 0.98, i === 3 ? 0.6 : 0.2, 0.08, 0.01); });
    },

    /** very quiet engine hum following speed and gas; call every frame */
    updateEngine: function (speed, gas, gear) {
      if (!ctx || !master) return;
      if (!engine) {
        try {
          var o1 = ctx.createOscillator(); o1.type = 'sawtooth';
          var o2 = ctx.createOscillator(); o2.type = 'sine';
          var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 220; f.Q.value = 0.6;
          var g = ctx.createGain(); g.gain.value = 0;
          o1.connect(f); o2.connect(f); f.connect(g); g.connect(master);
          o1.start(); o2.start();
          engine = { o1: o1, o2: o2, f: f, g: g };
        } catch (e) { engine = { dead: true }; }
      }
      if (engine.dead) return;
      var t = ctx.currentTime;
      var rpm = 750 + Math.abs(speed) * 180 + (gas ? 900 : 0);
      var base = rpm / 60 * 2;   // 4-cyl firing frequency
      engine.o1.frequency.setTargetAtTime(base, t, 0.15);
      engine.o2.frequency.setTargetAtTime(base / 2, t, 0.15);
      engine.f.frequency.setTargetAtTime(160 + (gas ? 260 : 0) + Math.abs(speed) * 20, t, 0.2);
      var vol = muted ? 0 : (0.018 + (gas ? 0.022 : 0) + Math.min(0.01, Math.abs(speed) * 0.002));
      engine.g.gain.setTargetAtTime(vol, t, 0.2);
    }
  };

  PS.audio = api;
})(typeof window !== 'undefined' ? window : this);
