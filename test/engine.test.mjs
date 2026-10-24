/**
 * Runs engine.js against a mock Web Audio API to verify the graph builds and the
 * spatial math is correct. Not a substitute for hearing it, but it catches
 * exceptions, bad connections and sign errors without a browser.
 */
import { SpatialEngine, PRESETS, sphericalToCartesian } from '../docs/engine.js';

let fails = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label} ${extra}`); fails++; }
};
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/* ------------------------------------------------------ mock Web Audio API */

const created = [];
const edges = [];

class Param {
  constructor(v) { this.value = v; this._ramps = 0; }
  linearRampToValueAtTime(v) { this.value = v; this._ramps++; return this; }
  setValueAtTime(v) { this.value = v; return this; }
}
class Node {
  constructor(type, ctx) { this.type_ = type; this.ctx = ctx; created.push(type); }
  connect(dst, out) { edges.push([this.type_, dst.type_ ?? 'destination', out ?? 0]); return dst; }
  disconnect() { }
}
class GainNode extends Node {
  constructor(ctx) { super('gain', ctx); this.gain = new Param(1); }
}
class PannerNode extends Node {
  constructor(ctx) {
    super('panner', ctx);
    this.positionX = new Param(0);
    this.positionY = new Param(0);
    this.positionZ = new Param(0);
  }
  setPosition(x, y, z) { this.positionX.value = x; this.positionY.value = y; this.positionZ.value = z; }
}
class BiquadNode extends Node {
  constructor(ctx) { super('biquad', ctx); this.frequency = new Param(350); this.Q = new Param(1); }
}
class DelayNode extends Node {
  constructor(ctx) { super('delay', ctx); this.delayTime = new Param(0); }
}
class Listener {
  constructor() {
    for (const k of ['forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ']) this[k] = new Param(0);
    this.forwardZ.value = -1; this.upY.value = 1;
  }
}
class MockCtx {
  constructor() {
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.state = 'running';
    this.destination = { type_: 'destination', connect() {} };
    this.listener = new Listener();
  }
  createGain() { return new GainNode(this); }
  createPanner() { return new PannerNode(this); }
  createBiquadFilter() { return new BiquadNode(this); }
  createDelay() { return new DelayNode(this); }
  createConvolver() { const n = new Node('convolver', this); n.normalize = true; n.buffer = null; return n; }
  createChannelSplitter() { return new Node('splitter', this); }
  createAnalyser() {
    const n = new Node('analyser', this);
    n.fftSize = 2048;
    n.getFloatTimeDomainData = (a) => a.fill(0.25);
    return n;
  }
  createMediaElementSource() { return new Node('mediaSource', this); }
  createBuffer(ch, len, rate) {
    const data = Array.from({ length: ch }, () => new Float32Array(len));
    return { numberOfChannels: ch, length: len, sampleRate: rate, getChannelData: (i) => data[i] };
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
}
global.window = { AudioContext: MockCtx };

/* ------------------------------------------------------------------- tests */

console.log('\n1. sphericalToCartesian — Web Audio frame (+x right, -z forward)');
{
  const f = sphericalToCartesian(0, 0, 3);
  ok(close(f.x, 0) && close(f.y, 0) && close(f.z, -3), 'straight ahead -> -z', JSON.stringify(f));
  const r = sphericalToCartesian(90, 0, 2);
  ok(close(r.x, 2) && close(r.z, 0, 1e-9), '+90 deg -> +x (right)', JSON.stringify(r));
  const l = sphericalToCartesian(-90, 0, 2);
  ok(close(l.x, -2), '-90 deg -> -x (left)', JSON.stringify(l));
  const b = sphericalToCartesian(180, 0, 2);
  ok(close(b.z, 2, 1e-9), '180 deg -> +z (behind)', JSON.stringify(b));
  const u = sphericalToCartesian(0, 90, 2);
  ok(close(u.y, 2), 'elevation +90 -> +y (above)', JSON.stringify(u));
  const d = sphericalToCartesian(37, 12, 5);
  ok(close(Math.hypot(d.x, d.y, d.z), 5, 1e-9), 'radius preserved at arbitrary angles');
}

console.log('\n2. Graph construction');
const eng = new SpatialEngine();
await eng.init({});
ok(eng.ready, 'engine reports ready');
ok(eng.speakers.length === 5, `5 virtual speakers built (got ${eng.speakers.length})`);
ok(created.filter((c) => c === 'panner').length === 5, 'exactly 5 HRTF panners');
ok(created.includes('convolver'), 'reverb convolver created');
ok(eng.convolver.buffer && eng.convolver.buffer.numberOfChannels === 2, 'stereo impulse response');
ok(edges.some(([, d]) => d === 'destination'), 'graph reaches the destination');

console.log('\n3. Mid/side decomposition gains');
{
  // Side must be L*0.5 + R*(-0.5): one leg negative, or mono collapses to silence
  const gains = created.filter((c) => c === 'gain').length;
  ok(gains > 10, `gain nodes allocated (${gains})`);
  // Walk the engine's own feed objects
  ok(eng.feeds.mid && eng.feeds.side, 'mid and side feeds exist');
}

console.log('\n4. Speaker placement — bed angles land where intended');
{
  eng.setGeometry({ azimuth: 0, elevation: 0, distance: 4, spread: 1 });
  const by = {};
  eng.speakers.forEach((s) => { by[s.spec.id] = s.panner; });
  ok(by.L.positionX.value < 0, 'L is to the left (x<0)', `x=${by.L.positionX.value.toFixed(2)}`);
  ok(by.R.positionX.value > 0, 'R is to the right (x>0)', `x=${by.R.positionX.value.toFixed(2)}`);
  ok(close(by.C.positionX.value, 0, 1e-9) && by.C.positionZ.value < 0, 'C is dead ahead');
  ok(by.Ls.positionZ.value > 0, 'Ls is behind (z>0)', `z=${by.Ls.positionZ.value.toFixed(2)}`);
  ok(by.Rs.positionZ.value > 0, 'Rs is behind (z>0)', `z=${by.Rs.positionZ.value.toFixed(2)}`);
  ok(close(Math.hypot(by.C.positionX.value, by.C.positionZ.value), 4, 1e-6),
    'centre speaker sits at the requested 4 m');
}

console.log('\n5. "Behind me" preset really puts energy behind the listener');
{
  const p = PRESETS['behind-me'];
  eng.setGeometry({ azimuth: p.azimuth, elevation: p.elevation, distance: p.distance, spread: p.spread });
  const behind = eng.speakers.filter((s) => s.panner.positionZ.value > 0).length;
  ok(behind >= 3, `${behind}/5 speakers rendered behind the head`);
}

console.log('\n6. Distance drives air absorption and the dry/wet ratio');
{
  eng.setGeometry({ distance: 1 });
  const nearCut = eng.speakers[0].air.frequency.value;
  const nearWet = eng.wetGain.gain.value;
  eng.setGeometry({ distance: 14 });
  const farCut = eng.speakers[0].air.frequency.value;
  const farWet = eng.wetGain.gain.value;
  ok(farCut < nearCut, `cutoff falls with distance (${nearCut.toFixed(0)} -> ${farCut.toFixed(0)} Hz)`);
  ok(farCut >= 1600, 'cutoff clamped above 1.6 kHz so it never goes to mud');
  ok(farWet > nearWet, `reverb share rises with distance (${nearWet.toFixed(3)} -> ${farWet.toFixed(3)})`);
}

console.log('\n7. Intensity crossfade is complementary (no level jump on A/B)');
{
  eng.setIntensity(1);
  ok(close(eng.spatialGain.gain.value, 1) && close(eng.bypassGain.gain.value, 0), 'full effect: spatial 1 / bypass 0');
  eng.setIntensity(0);
  ok(close(eng.spatialGain.gain.value, 0) && close(eng.bypassGain.gain.value, 1), 'bypass: spatial 0 / bypass 1');
  eng.setIntensity(0.5);
  ok(close(eng.spatialGain.gain.value + eng.bypassGain.gain.value, 1), 'halfway: the two sum to unity');
  eng.setIntensity(1);
}

console.log('\n8. World-locking — listener vectors');
{
  const l = eng.ctx.listener;
  const unit = () => Math.hypot(l.forwardX.value, l.forwardY.value, l.forwardZ.value);
  const dot = () => l.forwardX.value * l.upX.value + l.forwardY.value * l.upY.value + l.forwardZ.value * l.upZ.value;

  eng.setHeadPose(0, 0, 0);
  ok(close(l.forwardZ.value, -1) && close(l.upY.value, 1), 'neutral pose faces -z, up is +y');

  eng.setHeadPose(90, 0, 0);
  ok(close(l.forwardX.value, 1, 1e-9), 'yaw +90 (turn right) -> forward is +x',
    `fwd=(${l.forwardX.value.toFixed(2)},${l.forwardY.value.toFixed(2)},${l.forwardZ.value.toFixed(2)})`);

  eng.setHeadPose(-90, 0, 0);
  ok(close(l.forwardX.value, -1, 1e-9), 'yaw -90 (turn left) -> forward is -x');

  for (const [y, p, r] of [[0, 0, 0], [45, 20, 15], [-130, -25, -40], [179, 44, 70]]) {
    eng.setHeadPose(y, p, r);
    ok(close(unit(), 1, 1e-6), `forward stays unit at (${y},${p},${r})`, `|f|=${unit()}`);
    ok(close(dot(), 0, 1e-6), `up stays perpendicular to forward at (${y},${p},${r})`, `dot=${dot()}`);
  }
  eng.setHeadPose(0, 0, 0);
}

console.log('\n9. World-locking actually counter-rotates the image');
{
  // Speaker dead ahead; turn the head right 90 deg. In the listener's own frame
  // the speaker must now be on the LEFT. World coords stay put, so we verify by
  // projecting the speaker onto the listener's right-hand axis.
  eng.setGeometry({ azimuth: 0, elevation: 0, distance: 4, spread: 0 });
  const c = eng.speakers.find((s) => s.spec.id === 'C').panner;
  const pos = [c.positionX.value, c.positionY.value, c.positionZ.value];
  const l = eng.ctx.listener;

  const rightOf = () => {
    const f = [l.forwardX.value, l.forwardY.value, l.forwardZ.value];
    const u = [l.upX.value, l.upY.value, l.upZ.value];
    const right = [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]];
    return pos[0] * right[0] + pos[1] * right[1] + pos[2] * right[2];
  };

  eng.setHeadPose(0, 0, 0);
  ok(close(rightOf(), 0, 1e-6), 'facing it: speaker is neither left nor right');
  eng.setHeadPose(90, 0, 0);
  ok(rightOf() < -1, 'turn head right -> speaker moves to your left', `proj=${rightOf().toFixed(2)}`);
  eng.setHeadPose(-90, 0, 0);
  ok(rightOf() > 1, 'turn head left -> speaker moves to your right', `proj=${rightOf().toFixed(2)}`);
  eng.setHeadPose(0, 0, 0);
}

console.log('\n10. Impulse response shape');
{
  eng.setRoom({ rt60: 2.0, roomSize: 1.0, wetness: 0.3 });
  const buf = eng.convolver.buffer;
  ok(buf.length === Math.floor(48000 * 2.5), `IR length tracks rt60 (${buf.length} samples)`);
  const a = buf.getChannelData(0);
  const b = buf.getChannelData(1);
  let same = 0;
  for (let i = 0; i < 2000; i++) if (a[i] === b[i]) same++;
  ok(same < 50, `channels are decorrelated (${same}/2000 identical samples)`);
  const head = a.slice(0, 4800).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const tail = a.slice(a.length - 4800).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  ok(head > tail * 4, `energy decays over the tail (${head.toFixed(3)} -> ${tail.toFixed(4)})`);
  eng.setRoom({ rt60: 3.5 });
  ok(eng.convolver.buffer.length === Math.floor(48000 * 4), 'IR capped at 4 s for the longest rt60');
}

console.log('\n11. Every preset applies without error');
{
  for (const [k, p] of Object.entries(PRESETS)) {
    try {
      eng.setGeometry(p);
      eng.setRoom(p);
      eng.setIntensity(p.intensity);
      ok(true, `preset "${k}" (${p.label}) applied`);
    } catch (err) {
      ok(false, `preset "${k}"`, err.message);
    }
  }
}

console.log('\n12. Legacy Safari path (no AudioParam on panner/listener)');
{
  // Older Safari exposes only setPosition/setOrientation. Make sure we fall back.
  class LegacyPanner extends Node {
    constructor(ctx) { super('panner', ctx); this.pos = null; }
    setPosition(x, y, z) { this.pos = [x, y, z]; }
  }
  class LegacyCtx extends MockCtx {
    constructor() {
      super();
      this.listener = { setOrientation: (...a) => { this.orient = a; } };
    }
    createPanner() { return new LegacyPanner(this); }
  }
  global.window = { AudioContext: LegacyCtx };
  const legacy = new SpatialEngine();
  await legacy.init({});
  ok(legacy.speakers.every((s) => Array.isArray(s.panner.pos)), 'setPosition fallback used for all speakers');
  legacy.setHeadPose(30, 0, 0);
  ok(Array.isArray(legacy.ctx.orient) && legacy.ctx.orient.length === 6, 'setOrientation fallback used');
}

console.log(`\n${fails === 0 ? 'ALL TESTS PASSED' : fails + ' TEST(S) FAILED'}\n`);
process.exit(fails === 0 ? 0 : 1);
