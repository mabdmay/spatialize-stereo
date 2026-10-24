/**
 * engine.js — a reverse-engineered equivalent of Apple's "Spatialize Stereo".
 *
 * Apple's feature is not documented, but its behaviour is reproducible from four
 * observable properties, and AVFoundation leaks the essential constraint:
 *
 *   "Spatialization applies only to inputs with a mono channel connection format.
 *    This class doesn't spatialize stereo inputs."   — AVAudioEnvironmentNode docs
 *
 * A binaural renderer convolves a *point* source with a head-related transfer
 * function (HRTF) for one direction. Stereo is not a point — it is two channels
 * with no direction attached. So "spatialize stereo" cannot mean "run HRTF on the
 * stereo file". It must mean: synthesise a set of mono virtual loudspeakers from
 * the two channels, place them in a listener-relative frame, HRTF-render each one,
 * and rotate the whole rig against head motion so it stays world-locked.
 *
 * That is the pipeline below.
 *
 *   STAGE 1  Mid/side decomposition      stereo -> correlated + decorrelated parts
 *   STAGE 2  Virtual loudspeaker array   mono feeds placed on a 5.0-style bed
 *   STAGE 3  Distance & room acoustics   rolloff, air absorption, D/R ratio
 *   STAGE 4  World-locking               listener rotated to measured head pose
 *   STAGE 5  Decorrelation               per-speaker fractional delay
 *
 * Coordinates follow the Web Audio convention: +x right, +y up, -z forward.
 * Azimuth is degrees clockwise from straight ahead, elevation degrees up.
 */

const DEG = Math.PI / 180;

/** Convert azimuth/elevation/distance into Web Audio cartesian coordinates. */
export function sphericalToCartesian(azimuthDeg, elevationDeg, distance) {
  const az = azimuthDeg * DEG;
  const el = elevationDeg * DEG;
  const horiz = Math.cos(el);
  return {
    x: distance * Math.sin(az) * horiz,
    y: distance * Math.sin(el),
    z: -distance * Math.cos(az) * horiz,
  };
}

/**
 * STAGE 2 — the virtual loudspeaker bed.
 *
 * Angles mirror a 5.0 cinema layout, which is what Apple's upmix targets: fronts
 * at +/-30 degrees, a phantom-killing hard centre, surrounds at +/-110 degrees.
 *
 *   feed   which decomposed signal drives this speaker
 *   gain   linear trim
 *   delay  milliseconds — doubles as decorrelation (STAGE 5) and as a crude
 *          early reflection for the surrounds
 */
const SPEAKER_BED = [
  { id: 'L',  feed: 'left',  azimuth: -30,  elevation: 0, gain: 1.00, delay: 0.0  },
  { id: 'R',  feed: 'right', azimuth:  30,  elevation: 0, gain: 1.00, delay: 0.0  },
  { id: 'C',  feed: 'mid',   azimuth:   0,  elevation: 0, gain: 0.70, delay: 0.0  },
  { id: 'Ls', feed: 'side',  azimuth: -110, elevation: 0, gain: 0.45, delay: 11.0 },
  { id: 'Rs', feed: 'side',  azimuth:  110, elevation: 0, gain: 0.45, delay: 17.0 },
];

/**
 * One virtual loudspeaker.
 *
 *   in -> delay -> airAbsorption -> trim -> panner(HRTF) -> dryBus
 *                                       \-> send -------> wetBus
 */
class VirtualSpeaker {
  constructor(ctx, spec, dryBus, wetBus) {
    this.spec = spec;

    this.input = ctx.createGain();

    this.delay = ctx.createDelay(0.1);
    this.delay.delayTime.value = spec.delay / 1000;

    // STAGE 3 — air absorption. Distance costs high frequencies.
    this.air = ctx.createBiquadFilter();
    this.air.type = 'lowpass';
    this.air.frequency.value = 20000;
    this.air.Q.value = 0.0001;

    this.trim = ctx.createGain();
    this.trim.gain.value = spec.gain;

    // The HRTF renderer. This is the part that does what AirPods do.
    this.panner = ctx.createPanner();
    this.panner.panningModel = 'HRTF';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = 1;
    this.panner.maxDistance = 120;
    this.panner.rolloffFactor = 0.65;
    this.panner.coneInnerAngle = 360;

    this.send = ctx.createGain();
    this.send.gain.value = 1;

    this.input.connect(this.delay);
    this.delay.connect(this.air);
    this.air.connect(this.trim);
    this.trim.connect(this.panner);
    this.panner.connect(dryBus);
    // The reverb send is taken pre-panner: a room's reverberant field is diffuse,
    // so it must not inherit the dry signal's direction.
    this.trim.connect(this.send);
    this.send.connect(wetBus);
  }

  /** Place this speaker relative to the rig's aim point. */
  place(ctx, azimuthDeg, elevationDeg, distance, spread) {
    const az = azimuthDeg + this.spec.azimuth * spread;
    const el = elevationDeg + this.spec.elevation * spread;
    const { x, y, z } = sphericalToCartesian(az, el, distance);
    const t = ctx.currentTime;
    const ramp = 0.08;
    if (this.panner.positionX) {
      this.panner.positionX.linearRampToValueAtTime(x, t + ramp);
      this.panner.positionY.linearRampToValueAtTime(y, t + ramp);
      this.panner.positionZ.linearRampToValueAtTime(z, t + ramp);
    } else {
      this.panner.setPosition(x, y, z); // Safari legacy path
    }
  }

  setAirCutoff(hz, ctx) {
    this.air.frequency.linearRampToValueAtTime(hz, ctx.currentTime + 0.08);
  }
}

/**
 * STAGE 3 — late reverberation.
 *
 * Generates a stereo impulse response procedurally so the app ships no binary
 * assets: a sparse early-reflection pattern from a shoebox image-source
 * approximation, then an exponentially decaying diffuse tail that loses high
 * frequencies as it decays.
 */
function buildRoomImpulse(ctx, { rt60 = 1.1, roomSize = 1.0, damping = 0.35 }) {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * Math.min(rt60 * 1.25, 4)));
  const ir = ctx.createBuffer(2, length, rate);

  // Early reflections: first-order images of a shoebox, arrival times scaled by
  // room size. Alternating polarity keeps the cluster from summing into a click.
  const earlyTaps = [
    { t: 0.0081, g: 0.72 }, { t: 0.0127, g: -0.61 }, { t: 0.0193, g: 0.52 },
    { t: 0.0241, g: -0.44 }, { t: 0.0316, g: 0.37 }, { t: 0.0402, g: -0.29 },
    { t: 0.0533, g: 0.23 },
  ];

  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    // Independent noise per channel — a correlated tail collapses to the centre.
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / rate;
      const envelope = Math.exp((-6.9078 * t) / rt60); // -60 dB at rt60
      const white = Math.random() * 2 - 1;
      // Progressive HF damping: the one-pole closes as the tail decays.
      const coeff = Math.min(0.95, damping + (1 - damping) * (1 - envelope));
      lp = lp * coeff + white * (1 - coeff);
      data[i] = lp * envelope;
    }
    // Stamp the early reflections on top, skewed per channel for width.
    for (const tap of earlyTaps) {
      const idx = Math.floor(tap.t * roomSize * rate * (ch === 0 ? 1 : 1.13));
      if (idx < length) data[idx] += tap.g * (ch === 0 ? 1 : -0.92);
    }
  }
  return ir;
}

export class SpatialEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.speakers = [];
    this.media = null;
    this.source = null;

    // Rig aim, in the room frame.
    this.azimuth = 0;
    this.elevation = -5;
    this.distance = 3.0;
    this.spread = 1.0;
    this.intensity = 1.0;

    this.rt60 = 1.1;
    this.roomSize = 1.0;
    this.wetness = 0.28;

    this.headYaw = 0;
    this.headPitch = 0;
    this.headRoll = 0;
  }

  /** Must be called from a user gesture — iOS will not start audio otherwise. */
  async init(mediaElement) {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'playback' });
    const ctx = this.ctx;

    this.media = mediaElement;
    this.source = ctx.createMediaElementSource(mediaElement);

    // --- buses -------------------------------------------------------------
    this.dryBus = ctx.createGain();
    this.wetBus = ctx.createGain();
    this.master = ctx.createGain();
    this.spatialGain = ctx.createGain();

    this.convolver = ctx.createConvolver();
    this.convolver.normalize = true;
    this.convolver.buffer = buildRoomImpulse(ctx, {
      rt60: this.rt60, roomSize: this.roomSize,
    });
    this.wetGain = ctx.createGain();
    this.wetBus.connect(this.convolver);
    this.convolver.connect(this.wetGain);

    // Both the direct and reverberant paths ride the spatial crossfade.
    this.dryBus.connect(this.spatialGain);
    this.wetGain.connect(this.spatialGain);
    this.spatialGain.connect(this.master);

    // --- STAGE 1: mid/side decomposition ------------------------------------
    // M = (L+R)/2 is what the two channels agree on: lead vocal, kick, snare,
    // bass — the content a real speaker would radiate from one physical point.
    // S = (L-R)/2 is what they disagree on: reverb, strings, stereo widening —
    // already-decorrelated material, which is what the surrounds want.
    const splitter = ctx.createChannelSplitter(2);
    this.source.connect(splitter);

    const feeds = {
      left: ctx.createGain(),
      right: ctx.createGain(),
      mid: ctx.createGain(),
      side: ctx.createGain(),
    };
    splitter.connect(feeds.left, 0);
    splitter.connect(feeds.right, 1);

    const midL = ctx.createGain(); midL.gain.value = 0.5;
    const midR = ctx.createGain(); midR.gain.value = 0.5;
    splitter.connect(midL, 0); splitter.connect(midR, 1);
    midL.connect(feeds.mid); midR.connect(feeds.mid);

    const sideL = ctx.createGain(); sideL.gain.value = 0.5;
    const sideR = ctx.createGain(); sideR.gain.value = -0.5; // the subtraction
    splitter.connect(sideL, 0); splitter.connect(sideR, 1);
    sideL.connect(feeds.side); sideR.connect(feeds.side);

    this.feeds = feeds;

    // --- STAGE 2: build the virtual loudspeaker bed -------------------------
    this.speakers = SPEAKER_BED.map((spec) => {
      const sp = new VirtualSpeaker(ctx, spec, this.dryBus, this.wetBus);
      feeds[spec.feed].connect(sp.input);
      return sp;
    });

    // --- bypass path: unprocessed stereo, for the intensity crossfade --------
    this.bypassGain = ctx.createGain();
    this.bypassGain.gain.value = 0;
    this.source.connect(this.bypassGain);
    this.bypassGain.connect(this.master);

    // Analyser for the level meter and the silent-routing self-test.
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.master.connect(this.analyser);

    this.master.connect(ctx.destination);

    this.ready = true;
    this.applyAll();
  }

  /** Recompute everything that depends on geometry or room settings. */
  applyAll() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const d = this.distance;

    for (const sp of this.speakers) {
      sp.place(ctx, this.azimuth, this.elevation, d, this.spread);
      // Air absorption: ~0.86 of the band survives each metre. Gentle at 2 m,
      // clearly "other side of the room" by 10 m.
      sp.setAirCutoff(Math.max(1600, 20000 * Math.pow(0.86, d)), ctx);
    }

    // STAGE 3 — direct-to-reverberant ratio.
    // In a real room the reverberant field is roughly uniform while the direct
    // sound falls off as 1/d. Holding the send constant and letting the panners
    // attenuate the dry path reproduces that for free; this is only a nudge.
    const dr = this.wetness * (0.55 + 0.45 * Math.min(d / 7, 1));
    this.wetGain.gain.linearRampToValueAtTime(dr, ctx.currentTime + 0.1);

    // Intensity crossfade between untouched stereo and the full rig.
    const k = this.intensity;
    this.spatialGain.gain.linearRampToValueAtTime(k, ctx.currentTime + 0.1);
    this.bypassGain.gain.linearRampToValueAtTime(1 - k, ctx.currentTime + 0.1);

    this.updateListener();
  }

  /**
   * STAGE 4 — world-locking.
   *
   * The speakers live in the room frame. To keep them anchored when the head
   * turns, the *listener* is rotated to the measured head pose, which is the
   * same thing AVAudioEnvironmentNode's listenerAngularOrientation does.
   */
  updateListener() {
    if (!this.ready) return;
    const l = this.ctx.listener;
    const yaw = this.headYaw * DEG;
    const pitch = this.headPitch * DEG;
    const roll = this.headRoll * DEG;

    // Default forward is (0,0,-1). Yaw right -> swing toward +x.
    const fx = Math.sin(yaw) * Math.cos(pitch);
    const fy = Math.sin(pitch);
    const fz = -Math.cos(yaw) * Math.cos(pitch);

    // Up vector: world up tilted by pitch, then rolled about the forward axis.
    let ux = -Math.sin(yaw) * Math.sin(pitch);
    let uy = Math.cos(pitch);
    let uz = Math.cos(yaw) * Math.sin(pitch);

    if (roll !== 0) {
      // Rodrigues rotation of up about forward.
      const c = Math.cos(roll), s = Math.sin(roll);
      const dot = ux * fx + uy * fy + uz * fz;
      const cx = fy * uz - fz * uy;
      const cy = fz * ux - fx * uz;
      const cz = fx * uy - fy * ux;
      ux = ux * c + cx * s + fx * dot * (1 - c);
      uy = uy * c + cy * s + fy * dot * (1 - c);
      uz = uz * c + cz * s + fz * dot * (1 - c);
    }

    const t = this.ctx.currentTime;
    if (l.forwardX) {
      const ramp = 0.03; // short, or head motion smears; not zero, or it zippers
      l.forwardX.linearRampToValueAtTime(fx, t + ramp);
      l.forwardY.linearRampToValueAtTime(fy, t + ramp);
      l.forwardZ.linearRampToValueAtTime(fz, t + ramp);
      l.upX.linearRampToValueAtTime(ux, t + ramp);
      l.upY.linearRampToValueAtTime(uy, t + ramp);
      l.upZ.linearRampToValueAtTime(uz, t + ramp);
    } else if (l.setOrientation) {
      l.setOrientation(fx, fy, fz, ux, uy, uz); // Safari legacy path
    }
  }

  setHeadPose(yaw, pitch, roll) {
    this.headYaw = yaw;
    this.headPitch = pitch;
    this.headRoll = roll;
    this.updateListener();
  }

  setGeometry({ azimuth, elevation, distance, spread }) {
    if (azimuth !== undefined) this.azimuth = azimuth;
    if (elevation !== undefined) this.elevation = elevation;
    if (distance !== undefined) this.distance = distance;
    if (spread !== undefined) this.spread = spread;
    this.applyAll();
  }

  setRoom({ rt60, roomSize, wetness }) {
    let rebuild = false;
    if (rt60 !== undefined && rt60 !== this.rt60) { this.rt60 = rt60; rebuild = true; }
    if (roomSize !== undefined && roomSize !== this.roomSize) {
      this.roomSize = roomSize; rebuild = true;
    }
    if (wetness !== undefined) this.wetness = wetness;
    if (rebuild && this.ready) {
      this.convolver.buffer = buildRoomImpulse(this.ctx, {
        rt60: this.rt60, roomSize: this.roomSize,
      });
    }
    this.applyAll();
  }

  setIntensity(k) {
    this.intensity = Math.max(0, Math.min(1, k));
    this.applyAll();
  }

  /** Peak level, for the meter and for the routing self-test. */
  peak() {
    if (!this.analyser) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let p = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(buf[i]);
      if (a > p) p = a;
    }
    return p;
  }

  resume() {
    if (this.ctx && this.ctx.state !== 'running') return this.ctx.resume();
    return Promise.resolve();
  }
}

/** Named positions, so the thing is usable without touching a single slider. */
export const PRESETS = {
  'across-the-room': {
    label: 'Across the room',
    hint: 'A bookshelf pair about four metres ahead.',
    azimuth: 0, elevation: -8, distance: 4.0, spread: 1.0,
    rt60: 1.0, roomSize: 1.0, wetness: 0.30, intensity: 1.0,
  },
  'kitchen-speaker': {
    label: 'Kitchen speaker',
    hint: 'Off to your right, through a doorway, a little muffled.',
    azimuth: 68, elevation: 4, distance: 7.0, spread: 0.55,
    rt60: 1.5, roomSize: 1.4, wetness: 0.46, intensity: 1.0,
  },
  'behind-me': {
    label: 'Behind me',
    hint: 'Over your left shoulder. The clearest test that it works.',
    azimuth: -145, elevation: 0, distance: 3.0, spread: 0.8,
    rt60: 1.1, roomSize: 1.0, wetness: 0.32, intensity: 1.0,
  },
  'cinema': {
    label: 'Cinema front',
    hint: 'Wide screen bed, dry and close. Nearest to Apple’s default.',
    azimuth: 0, elevation: -2, distance: 2.2, spread: 1.25,
    rt60: 0.7, roomSize: 0.8, wetness: 0.18, intensity: 1.0,
  },
  'live-venue': {
    label: 'Live venue',
    hint: 'A stage PA at distance in a big reflective hall.',
    azimuth: 0, elevation: 6, distance: 11.0, spread: 1.4,
    rt60: 2.4, roomSize: 2.0, wetness: 0.55, intensity: 1.0,
  },
  'headphone-stereo': {
    label: 'Bypass (A/B)',
    hint: 'Untouched stereo, for comparison.',
    azimuth: 0, elevation: 0, distance: 1.0, spread: 1.0,
    rt60: 1.0, roomSize: 1.0, wetness: 0.0, intensity: 0.0,
  },
};
