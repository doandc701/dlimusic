// The player's sound, on the main page (ui.js) and a shared playlist's (share.js), through Web Audio:
//
//   <audio> → equalizer (10 bands, bass, treble) → preamp → surround → loudness → speakers
//
// The surround, two switches — one on, the other off and disabled: neither, "Âm thanh vòm" (a wider stereo: what differs left / right ×1.6, the middle as it is)
// or "8D" (for headphones: the song goes round the head — one source turned by two oscillators, so it turns on
// with the screen off too — with a room's echo).
//
// Loudness: each song's gain (core.js levelGain), given by the page (setLevel). The equalizer: the panel
// "Bộ chỉnh âm" (built here, opened by the player's #eqBtn). What is moved is heard at once; "Xong" keeps it (this
// browser); closed otherwise, it goes back to what was kept. "Bình thường" is the curve flat; any other preset or a
// slider moved changes it. The surround is apart from the presets (Bình thường with 8D, Pop with 8D). The preamp lowers everything by as much as the curve raises
// some sound, so nothing clips.
// Built on the first play (a page may start Web Audio only after a tap); until it runs the player plays as it is.
// Not on iPhones / iPads: with the screen locked their browsers may stop Web Audio, and the music with it — there
// the player plays as it is and the equalizer is not offered.
window.AudioFx = (() => {
  const IOS =
    /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const ok = typeof AudioContext === "function" && !IOS;
  const t = window.t || ((s) => s);

  const BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]; // Hz, an octave apart
  const RANGE = 12; // dB, up and down
  const DEFAULT = "Bình thường";
  const CUSTOM = "Tuỳ chỉnh";
  // bass (32–250 Hz) · middle (500 Hz–2 kHz) · treble (4–16 kHz); "nhẹ" about +2 dB, "vừa" +3, "mạnh" +5,
  // "rất mạnh" +7
  const PRESETS = {
    [DEFAULT]: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // Flat / Normal: the song as it is
    Pop: [2, 2, 1, 0, -1, -1, 0, 1, 2, 2], // bass a little up, middle as it is / a little down, treble a little up
    Rock: [5, 5, 3, 0, -1, -2, 0, 3, 5, 5], // bass and treble well up, middle a little down
    "Dance / EDM": [8, 7, 5, 1, -2, -3, -1, 2, 3, 3], // bass far up, middle down, treble up some (Vinahouse, hip-hop)
    "Vocal / Podcast": [-4, -3, -2, 1, 3, 5, 5, 3, 2, 1], // bass down, middle well up, treble a little up
    "Acoustic / Jazz": [2, 2, 2, 1, 2, 3, 3, 2, 2, 1], // a warm bass, middle up some, treble a little up
  };
  const WIDE = 1.6; // "Âm thanh vòm": the difference between left and right ×1.6, what is in both the same
  // the switches (label, icon); neither on: "off"
  const SPACES = { wide: ["Âm thanh vòm", "bi-broadcast"], "8d": ["8D", "bi-headphones"] };
  const TURN = 10; // 8D: seconds a turn round the head (0.1 Hz: lively, yet a sung line is not torn apart)
  const ECHO = 0.3; // 8D: the room's echo, beside the song
  const ITD = 0.0006; // 8D: seconds from one ear to the other (a head's width)
  const KEY = "eq"; // this browser's equalizer, kept by "Xong"
  const flat = () => ({ preset: DEFAULT, bands: [...PRESETS[DEFAULT]], bass: 0, treble: 0, space: "off" });
  const curved = (s) => s.bass !== 0 || s.treble !== 0 || s.bands.some((v) => v !== 0);
  const isOn = (s) => s.space !== "off" || curved(s);

  /** What was kept, or flat (nothing kept, or not readable). */
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || "null");
      const db = (v) => (Number.isFinite(v) ? Math.max(-RANGE, Math.min(RANGE, Math.round(v))) : 0);
      if (s && Array.isArray(s.bands) && s.bands.length === BANDS.length)
        return {
          preset: s.preset in PRESETS || s.preset === CUSTOM ? s.preset : CUSTOM,
          bands: s.bands.map(db),
          bass: db(s.bass),
          treble: db(s.treble),
          space: s.space in SPACES ? s.space : s.wide === true ? "wide" : "off",
        };
    } catch {}
    return flat();
  }
  let kept = load();
  let cur = structuredClone(kept); // what is heard: kept, or being tried in the panel

  // ---------- the chain ----------
  let ctx = null;
  let nodes = null; // { bands, bass, treble, pre, ll, rl, rr, lr, dry, mono, round, level, round8d }
  let levelDb = 0;
  const gainOf = (db) => 10 ** (db / 20);

  /** Build it on a play (once Web Audio may run), or wake it up. */
  async function start(player) {
    if (!ok) return;
    if (nodes) return void ctx.resume().catch(() => {});
    try {
      ctx ??= new AudioContext();
      await ctx.resume();
      if (ctx.state !== "running" || nodes) return; // not allowed yet: the next play tries again
      const make = (type, frequency, Q = 1) => {
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.frequency.value = frequency;
        f.Q.value = Q;
        return f;
      };
      const n = {
        bands: BANDS.map((hz) => make("peaking", hz, 1.4)),
        bass: make("lowshelf", 100),
        treble: make("highshelf", 8000),
        // two channels from here on (a mono song: the same in both), for the surround
        pre: Object.assign(ctx.createGain(), { channelCount: 2, channelCountMode: "explicit" }),
        split: ctx.createChannelSplitter(2),
        merge: ctx.createChannelMerger(2),
        ll: ctx.createGain(),
        rl: ctx.createGain(),
        rr: ctx.createGain(),
        lr: ctx.createGain(),
        dry: ctx.createGain(), // the song as the surround "off" / "Âm thanh vòm" leaves it
        mono: Object.assign(ctx.createGain(), { channelCount: 1, channelCountMode: "explicit" }), // 8D: one source
        round: ctx.createGain(), // 8D: the source going round, and its echo
        level: ctx.createGain(),
      };
      let last = ctx.createMediaElementSource(player);
      for (const f of [...n.bands, n.bass, n.treble, n.pre]) last = last.connect(f);
      n.pre.connect(n.split);
      // left out = left × a + right × b, right out = right × a + left × b
      n.split.connect(n.ll, 0).connect(n.merge, 0, 0);
      n.split.connect(n.rl, 1).connect(n.merge, 0, 0);
      n.split.connect(n.rr, 1).connect(n.merge, 0, 1);
      n.split.connect(n.lr, 0).connect(n.merge, 0, 1);
      n.merge.connect(n.dry).connect(n.level).connect(ctx.destination);
      build8d(n);
      nodes = n;
      apply(true);
    } catch (err) {
      console.warn("audio: no Web Audio:", err);
    }
  }

  /**
   * 8D, joined to the chain only while it is chosen (mono → round, see apply): the source on a circle round the
   * listener (sin: −1 left … +1 right; cos: +1 in front … −1 behind; it starts in front), turned by two oscillators
   * at 1 / TURN Hz — the audio clock turns it, no timer — and a room's echo. Each ear: louder and sooner on its side
   * (the other: −10 dB, ITD later), duller behind. Not Chrome's HRTF panner: it clicks ("bụp") as it turns, on
   * bass most; here everything moves smoothly.
   */
  function build8d(n) {
    const wave = (re, im) =>
      ctx.createPeriodicWave(Float32Array.from(re), Float32Array.from(im), { disableNormalization: true });
    const sin = new OscillatorNode(ctx, { periodicWave: wave([0, 0], [0, 1]), frequency: 1 / TURN });
    const cos = new OscillatorNode(ctx, { periodicWave: wave([0, 1], [0, 0]), frequency: 1 / TURN });
    const behind = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 12500 }); // in front 20 kHz, behind 5
    cos.connect(new GainNode(ctx, { gain: 7500 })).connect(behind.frequency);
    const ears = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    n.mono.connect(behind);
    for (const [ch, side] of [
      [0, -1],
      [1, 1],
    ]) {
      const delay = new DelayNode(ctx, { delayTime: ITD / 2 }); // 0 on its side, ITD on the other
      sin.connect(new GainNode(ctx, { gain: (-side * ITD) / 2 })).connect(delay.delayTime);
      const gain = new GainNode(ctx, { gain: 0 }); // √((1 ± 0.8 sin) / 2): left² + right² the same all round
      const curve = Float32Array.from({ length: 1025 }, (_, i) => Math.sqrt((1 + 0.8 * side * (i / 512 - 1)) / 2));
      sin.connect(new WaveShaperNode(ctx, { curve })).connect(gain.gain);
      behind.connect(delay).connect(gain).connect(ears, 0, ch);
    }
    const at = ctx.currentTime + 0.05;
    for (const o of [sin, cos]) o.start(at); // together: a quarter turn apart, always
    // the room: 2.5 s of noise fading out (to −60 dB), a little different in each ear
    const len = Math.round(ctx.sampleRate * 2.5);
    const room = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = room.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp((-6.9 * i) / len);
    }
    ears.connect(n.round);
    ears
      .connect(new ConvolverNode(ctx, { buffer: room }))
      .connect(new GainNode(ctx, { gain: ECHO }))
      .connect(n.round);
    n.round8d = false; // joined to the chain
  }

  /** What the equalizer adds at most (dB, over the audible range), from the filters' own response. */
  function peakBoost() {
    const freqs = Float32Array.from({ length: 120 }, (_, i) => 20 * 1000 ** (i / 119)); // 20 Hz … 20 kHz
    const total = new Float32Array(freqs.length).fill(1);
    const mag = new Float32Array(freqs.length);
    const phase = new Float32Array(freqs.length);
    for (const f of [...nodes.bands, nodes.bass, nodes.treble]) {
      f.getFrequencyResponse(freqs, mag, phase);
      for (let i = 0; i < total.length; i++) total[i] *= mag[i];
    }
    return Math.max(0, 20 * Math.log10(Math.max(...total)));
  }

  /** The settings heard now into the chain (`now`: at once; else a few ms, so a slider moved does not click). */
  function apply(now = false) {
    renderButton();
    if (!nodes) return;
    const at = ctx.currentTime;
    const set = (param, v) => (now ? param.setValueAtTime(v, at) : param.setTargetAtTime(v, at, 0.015));
    // set straight (not scheduled): the response read just below must be the new one
    nodes.bands.forEach((f, i) => (f.gain.value = cur.bands[i]));
    nodes.bass.gain.value = cur.bass;
    nodes.treble.gain.value = cur.treble;
    const w = cur.space === "wide" ? WIDE : 1;
    for (const g of [nodes.ll, nodes.rr]) set(g.gain, (1 + w) / 2);
    for (const g of [nodes.rl, nodes.lr]) set(g.gain, (1 - w) / 2);
    // "Âm thanh vòm" makes a sound on one side louder by (1 + w) / 2
    set(nodes.pre.gain, gainOf(-peakBoost()) / ((1 + w) / 2));
    const round = cur.space === "8d";
    set(nodes.dry.gain, round ? 0 : 1);
    if (round !== nodes.round8d) {
      // 8D in the chain only while chosen: its panner and echo cost nothing otherwise
      if (round) {
        nodes.merge.connect(nodes.mono);
        nodes.round.connect(nodes.level);
      } else {
        nodes.merge.disconnect(nodes.mono);
        nodes.round.disconnect(nodes.level);
      }
      nodes.round8d = round;
    }
    set(nodes.level.gain, gainOf(levelDb));
  }

  /** The gain (dB) the playing song is played at (its loudness): at once, or smoothly when it comes later. */
  function setLevel(db, smooth = false) {
    levelDb = db;
    if (!nodes) return;
    const p = nodes.level.gain;
    p.cancelScheduledValues(ctx.currentTime);
    if (smooth) p.setTargetAtTime(gainOf(db), ctx.currentTime, 0.3);
    else p.setValueAtTime(gainOf(db), ctx.currentTime);
  }

  // ---------- the panel ----------
  let modal = null;
  let saving = false; // "Xong" was pressed: what is heard is kept

  const dbText = (v) => `${v > 0 ? "+" : ""}${v}`;
  const hzText = (hz) => (hz >= 1000 ? `${hz / 1000}k` : String(hz));

  function renderButton() {
    const btn = document.getElementById("eqBtn");
    if (btn) btn.classList.toggle("on", isOn(cur));
  }

  function renderPanel() {
    if (!modal) return;
    for (const b of modal.querySelectorAll("[data-eq-preset]")) {
      const on = b.dataset.eqPreset === cur.preset;
      b.classList.toggle("btn-primary", on);
      b.classList.toggle("btn-outline-secondary", !on);
      b.setAttribute("aria-pressed", String(on));
    }
    modal.querySelectorAll("[data-eq-band]").forEach((input) => {
      const i = Number(input.dataset.eqBand);
      input.value = cur.bands[i];
      modal.querySelector(`[data-eq-db="${i}"]`).textContent = dbText(cur.bands[i]);
    });
    for (const k of ["bass", "treble"]) {
      modal.querySelector(`[data-eq-knob="${k}"]`).value = cur[k];
      modal.querySelector(`[data-eq-val="${k}"]`).textContent = `${dbText(cur[k])} dB`;
    }
    for (const input of modal.querySelectorAll("[data-eq-space]")) {
      const k = input.dataset.eqSpace;
      input.checked = cur.space === k;
      input.disabled = cur.space !== "off" && cur.space !== k; // the other one on
      modal.querySelector(`label[for="${input.id}"]`).classList.toggle("opacity-50", input.disabled);
    }
  }

  /**
   * A change made in the panel: heard at once. A slider moved by hand: "Tuỳ chỉnh", or "Bình thường" when the curve
   * is left flat. The surround leaves the preset as it is (Bình thường with 8D, Pop with 8D).
   */
  function changed(byHand) {
    if (byHand) cur.preset = curved(cur) ? CUSTOM : DEFAULT;
    apply();
    renderPanel();
  }

  function build() {
    const presets = [...Object.keys(PRESETS), CUSTOM];
    const el = document.createElement("div");
    el.className = "modal fade eq-modal";
    el.id = "eqModal";
    el.tabIndex = -1;
    el.setAttribute("aria-labelledby", "eqTitle");
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = `
      <div class="modal-dialog modal-dialog-centered modal-lg">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="eqTitle"><i class="bi bi-sliders me-2"></i>${t("Bộ chỉnh âm")}</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="${t("Đóng")}"></button>
          </div>
          <div class="modal-body">
            <div class="d-flex flex-wrap gap-2 mb-4">
              ${presets.map((p) => `<button type="button" class="btn btn-sm eq-preset" data-eq-preset="${p}">${t(p)}</button>`).join("")}
            </div>
            <div class="eq-bands mb-2">
              ${BANDS.map(
                (hz, i) => `
                <div class="eq-band">
                  <div class="eq-db" data-eq-db="${i}"></div>
                  <div class="eq-slot">
                    <input type="range" class="form-range" min="${-RANGE}" max="${RANGE}" step="1" data-eq-band="${i}"
                      aria-label="${hzText(hz)} Hz" />
                  </div>
                  <div class="eq-hz">${hzText(hz)}</div>
                </div>`,
              ).join("")}
            </div>
            <div class="text-center small text-body-secondary mb-4">${t("Hz · kéo lên để tăng, xuống để giảm (±12 dB)")}</div>
            ${[
              ["bass", "bi-speaker", "Âm trầm"],
              ["treble", "bi-music-note", "Âm bổng"],
            ]
              .map(
                ([k, icon, label]) => `
              <div class="d-flex align-items-center gap-3 mb-2 eq-knob">
                <span class="eq-knob-name"><i class="bi ${icon} me-1"></i>${t(label)}</span>
                <input type="range" class="form-range" min="${-RANGE}" max="${RANGE}" step="1" data-eq-knob="${k}"
                  aria-label="${t(label)}" />
                <span class="eq-knob-val" data-eq-val="${k}"></span>
              </div>`,
              )
              .join("")}
            ${Object.entries(SPACES)
              .map(
                ([k, [label, icon]], i) => `
              <div class="d-flex align-items-center gap-3 ${i ? "mt-2" : "mt-3"} eq-knob">
                <label class="eq-knob-name" for="eqSpace-${k}"><i class="bi ${icon} me-1"></i>${t(label)}</label>
                <div class="form-check form-switch mb-0">
                  <input class="form-check-input" type="checkbox" role="switch" id="eqSpace-${k}" data-eq-space="${k}" />
                </div>
              </div>`,
              )
              .join("")}
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline-secondary btn-sm me-auto" data-eq-reset>
              <i class="bi bi-arrow-counterclockwise me-1"></i>${t("Đặt lại")}
            </button>
            <button type="button" class="btn btn-primary btn-sm" data-eq-done>${t("Xong")}</button>
          </div>
        </div>
      </div>`;
    document.body.append(el);

    el.addEventListener("click", (e) => {
      const preset = e.target.closest("[data-eq-preset]")?.dataset.eqPreset;
      if (preset === CUSTOM) {
        cur.preset = CUSTOM; // the sliders as they are, to move by hand
        renderPanel();
      } else if (preset === DEFAULT) {
        cur = { ...flat(), space: cur.space }; // the surround stays
        changed(false);
      } else if (preset) {
        cur.preset = preset;
        cur.bands = [...PRESETS[preset]];
        changed(false);
      } else if (e.target.closest("[data-eq-reset]")) {
        cur = flat();
        changed(false);
      } else if (e.target.closest("[data-eq-done]")) {
        saving = true;
        bootstrap.Modal.getOrCreateInstance(el).hide();
      }
    });
    el.addEventListener("input", (e) => {
      const band = e.target.dataset.eqBand;
      const knob = e.target.dataset.eqKnob;
      const space = e.target.dataset.eqSpace;
      if (space) {
        cur.space = e.target.checked ? space : "off";
        return void changed(false);
      }
      if (band !== undefined) cur.bands[Number(band)] = Number(e.target.value);
      else if (knob) cur[knob] = Number(e.target.value);
      else return;
      changed(true);
    });
    el.addEventListener("show.bs.modal", () => {
      saving = false;
      cur = structuredClone(kept);
      renderPanel();
    });
    el.addEventListener("hidden.bs.modal", () => {
      if (saving) {
        kept = structuredClone(cur);
        try {
          localStorage.setItem(KEY, JSON.stringify(kept));
        } catch {}
      } else cur = structuredClone(kept); // closed without "Xong": as it was
      apply();
    });
    return el;
  }

  /** The page's player: plays through the chain from its first play; the equalizer button opens the panel. */
  function attach(player) {
    const btn = document.getElementById("eqBtn");
    if (!ok) return void btn?.remove();
    player.addEventListener("play", () => start(player));
    btn?.classList.remove("d-none");
    btn?.addEventListener("click", () => {
      modal ??= build();
      bootstrap.Modal.getOrCreateInstance(modal).show();
    });
    renderButton();
  }

  return { ok, attach, setLevel };
})();
