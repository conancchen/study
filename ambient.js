// Ambient: background sounds to study to, made right here from noise with
// the Web Audio API, so there are no files to load. Every slider starts all
// the way left, silent; sliding one up plays that sound (any number at once),
// and back to the left stops it. Clicking a name does the same in one go.
// Mute silences them all at once and leaves the sliders where they are.
(function () {
  var section = document.getElementById('ambient');
  var list = document.getElementById('ambient-sounds');
  var Ctx = window.AudioContext || window.webkitAudioContext;
  if (!section || !Ctx) { if (section) section.hidden = true; return; }

  var audio = null;
  var master = null;
  var buffers = {};
  var playing = {};  // name: { stop, gain }
  var volumes = {};  // name: volume from 0 to 1, all 0 to begin with
  var muted = false;
  var muteBtn = document.getElementById('ambient-mute');

  // A few seconds of noise, looped: white is flat, pink falls off gently,
  // brown (summed white) is deep like a far-off rumble
  function noise(color) {
    if (buffers[color]) return buffers[color];
    var length = audio.sampleRate * 6;
    var buffer = audio.createBuffer(2, length, audio.sampleRate);
    for (var ch = 0; ch < 2; ch++) {
      var data = buffer.getChannelData(ch);
      var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
      for (var i = 0; i < length; i++) {
        var white = Math.random() * 2 - 1;
        if (color === 'brown') {
          last = (last + 0.02 * white) / 1.02;
          data[i] = last * 3.5;
        } else if (color === 'pink') {
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.96900 * b2 + white * 0.1538520;
          b3 = 0.86650 * b3 + white * 0.3104856;
          b4 = 0.55000 * b4 + white * 0.5329522;
          b5 = -0.7616 * b5 - white * 0.0168980;
          data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
          b6 = white * 0.115926;
        } else {
          data[i] = white * 0.5;
        }
      }
      // Fades the loop's ends into each other so it never clicks
      var fade = audio.sampleRate * 0.05;
      for (var j = 0; j < fade; j++) {
        var mix = j / fade;
        data[j] = data[j] * mix + data[length - fade + j] * (1 - mix);
      }
    }
    return (buffers[color] = buffer);
  }

  function source(color) {
    var src = audio.createBufferSource();
    src.buffer = noise(color);
    src.loop = true;
    return src;
  }

  function filter(type, freq, q) {
    var f = audio.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q) f.Q.value = q;
    return f;
  }

  // A slow swell on a gain, for sounds that come and go like waves
  function swell(param, rate, depth) {
    var lfo = audio.createOscillator();
    var amount = audio.createGain();
    lfo.frequency.value = rate;
    amount.gain.value = depth;
    lfo.connect(amount).connect(param);
    lfo.start();
    return lfo;
  }

  // Each sound wires its noise into out and returns what to stop
  var SOUNDS = [
    { name: 'Rain', build: function (out) {
      var hiss = source('pink');
      hiss.connect(filter('highpass', 500)).connect(filter('lowpass', 6000)).connect(out);
      var patter = source('white');
      var patterGain = audio.createGain();
      patterGain.gain.value = 0.25;
      patter.connect(filter('bandpass', 2500, 0.7)).connect(patterGain).connect(out);
      hiss.start(); patter.start();
      return [hiss, patter];
    } },
    { name: 'Thunder', build: function (out) {
      // A rumble every 10 to 35 seconds (the first one soon), each a few
      // overlapping rolls of deep noise that crack in and die away slowly
      var timer = null;
      var live = [];
      function rumble() {
        var t = audio.currentTime;
        var rolls = 2 + Math.floor(Math.random() * 3);
        for (var i = 0; i < rolls; i++) {
          var at = t + i * (0.3 + Math.random() * 0.9);
          var length = 3 + Math.random() * 5;
          var src = source('brown');
          var lp = filter('lowpass', 120 + Math.random() * 260);
          var env = audio.createGain();
          var peak = (i ? 0.6 : 1) * (0.6 + Math.random() * 0.4);
          env.gain.setValueAtTime(0.0001, at);
          env.gain.exponentialRampToValueAtTime(peak, at + 0.08 + Math.random() * 0.4);
          env.gain.exponentialRampToValueAtTime(0.0001, at + length);
          src.connect(lp).connect(env).connect(out);
          src.start(at, Math.random() * 5);
          src.stop(at + length + 0.1);
          live.push(src);
          src.onended = (function (s) { return function () { live.splice(live.indexOf(s), 1); }; })(src);
        }
        timer = setTimeout(rumble, 10000 + Math.random() * 25000);
      }
      timer = setTimeout(rumble, 800);
      return [{ stop: function (when) {
        clearTimeout(timer);
        live.slice().forEach(function (s) { try { s.stop(when); } catch (e) {} });
      } }];
    } },
    { name: 'Wind', build: function (out) {
      // Air through a band that drifts up and down, swelling into gusts
      var air = source('pink');
      var band = filter('bandpass', 450, 1.2);
      var level = audio.createGain();
      level.gain.value = 0.9;
      var sweep = swell(band.frequency, 0.07, 280);
      var gust = swell(level.gain, 0.11, 0.6);
      air.connect(band).connect(level).connect(out);
      var low = source('brown');
      var lowGain = audio.createGain();
      lowGain.gain.value = 0.4;
      low.connect(filter('lowpass', 300)).connect(lowGain).connect(out);
      air.start(); low.start();
      return [air, low, sweep, gust];
    } },
    { name: 'Waves', build: function (out) {
      var wash = source('brown');
      var level = audio.createGain();
      level.gain.value = 0.6;
      var lfo = swell(level.gain, 0.08, 0.4);
      wash.connect(filter('lowpass', 1200)).connect(level).connect(out);
      wash.start();
      return [wash, lfo];
    } },
    { name: 'Brown noise', build: function (out) {
      var src = source('brown');
      src.connect(out);
      src.start();
      return [src];
    } },
    { name: 'White noise', build: function (out) {
      var src = source('white');
      src.connect(filter('lowpass', 9000)).connect(out);
      src.start();
      return [src];
    } }
  ];

  function start(sound) {
    if (!audio) {
      audio = new Ctx();
      master = audio.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(audio.destination);
    }
    if (audio.state === 'suspended') audio.resume();
    var gain = audio.createGain();
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volumes[sound.name]), audio.currentTime + 1);
    gain.connect(master);
    var nodes = sound.build(gain);
    playing[sound.name] = {
      gain: gain,
      stop: function () {
        var t = audio.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
        nodes.forEach(function (n) { n.stop(t + 0.45); });
        setTimeout(function () { gain.disconnect(); }, 600);
      }
    };
  }

  SOUNDS.forEach(function (sound) {
    var row = document.createElement('div');
    row.className = 'row ambient-sound';
    var btn = document.createElement('button');
    btn.className = 'ambient-toggle';
    btn.type = 'button';
    btn.textContent = sound.name;
    btn.setAttribute('aria-pressed', 'false');
    var slider = document.createElement('input');
    slider.className = 'ambient-volume';
    slider.type = 'range';
    slider.min = 0;
    slider.max = 1;
    slider.step = 0.01;
    slider.value = 0;
    slider.setAttribute('aria-label', sound.name + ' volume');

    // Plays at the slider's volume, or stops at zero
    function set(level) {
      volumes[sound.name] = level;
      slider.value = level;
      var p = playing[sound.name];
      if (level && p) p.gain.gain.setTargetAtTime(level, audio.currentTime, 0.05);
      else if (level) start(sound);
      else if (p) { p.stop(); delete playing[sound.name]; }
      btn.setAttribute('aria-pressed', !!playing[sound.name]);
    }

    // A name turns its sound off, or on at half volume
    btn.addEventListener('click', function () {
      set(playing[sound.name] ? 0 : 0.5);
    });
    slider.addEventListener('input', function () {
      set(+slider.value);
    });

    row.appendChild(btn);
    row.appendChild(slider);
    list.appendChild(row);
  });

  muteBtn.addEventListener('click', function () {
    muted = !muted;
    if (master) master.gain.setTargetAtTime(muted ? 0 : 1, audio.currentTime, 0.05);
    muteBtn.setAttribute('aria-pressed', muted);
    muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    muteBtn.title = muted ? 'Unmute' : 'Mute';
  });
})();
