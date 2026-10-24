import { SpatialEngine, PRESETS, sphericalToCartesian } from './engine.js';

const engine = new SpatialEngine();
const audio = document.getElementById('audio');

const el = (id) => document.getElementById(id);
const ui = {
  picker: el('picker'),
  pickBtn: el('pickBtn'),
  playlist: el('playlist'),
  title: el('title'),
  sub: el('sub'),
  play: el('play'),
  prev: el('prev'),
  next: el('next'),
  seek: el('seek'),
  elapsed: el('elapsed'),
  duration: el('duration'),
  radar: el('radar'),
  presets: el('presets'),
  presetHint: el('presetHint'),
  azimuth: el('azimuth'),
  distance: el('distance'),
  elevation: el('elevation'),
  spread: el('spread'),
  rt60: el('rt60'),
  wetness: el('wetness'),
  intensity: el('intensity'),
  azimuthV: el('azimuthV'),
  distanceV: el('distanceV'),
  elevationV: el('elevationV'),
  spreadV: el('spreadV'),
  rt60V: el('rt60V'),
  wetnessV: el('wetnessV'),
  intensityV: el('intensityV'),
  track: el('trackBtn'),
  recentre: el('recentreBtn'),
  trackState: el('trackState'),
  meter: el('meter'),
  banner: el('banner'),
};

let tracks = [];
let current = -1;
let objectUrl = null;

/* ------------------------------------------------------------------ library */

ui.pickBtn.addEventListener('click', () => ui.picker.click());

ui.picker.addEventListener('change', () => {
  const picked = Array.from(ui.picker.files || []);
  if (!picked.length) return;
  tracks = tracks.concat(picked);
  renderPlaylist();
  if (current < 0) load(tracks.length - picked.length);
});

function renderPlaylist() {
  ui.playlist.innerHTML = '';
  tracks.forEach((file, i) => {
    const li = document.createElement('li');
    li.className = 'row' + (i === current ? ' on' : '');
    li.textContent = file.name.replace(/\.[^.]+$/, '');
    li.addEventListener('click', () => { load(i); start(); });
    ui.playlist.appendChild(li);
  });
  ui.playlist.hidden = tracks.length === 0;
}

function load(i) {
  if (i < 0 || i >= tracks.length) return;
  current = i;
  const file = tracks[i];
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  audio.src = objectUrl;
  ui.title.textContent = file.name.replace(/\.[^.]+$/, '');
  ui.sub.textContent = `${i + 1} of ${tracks.length}`;
  renderPlaylist();
}

/* ---------------------------------------------------------------- transport */

/**
 * The AudioContext has to be built inside a real user gesture or iOS leaves it
 * suspended, and a suspended context produces silence with no error.
 */
async function start() {
  if (current < 0) { ui.picker.click(); return; }
  await engine.init(audio);
  await engine.resume();
  syncEngineFromUI();
  try {
    await audio.play();
  } catch (err) {
    banner(`Playback was blocked: ${err.message}`);
    return;
  }
  selfTest();
}

ui.play.addEventListener('click', async () => {
  if (audio.paused) await start();
  else audio.pause();
});

ui.prev.addEventListener('click', () => { load(current - 1); start(); });
ui.next.addEventListener('click', () => { load(current + 1); start(); });
audio.addEventListener('ended', () => {
  if (current + 1 < tracks.length) { load(current + 1); start(); }
});

audio.addEventListener('play', () => { ui.play.textContent = 'Pause'; });
audio.addEventListener('pause', () => { ui.play.textContent = 'Play'; });

const mmss = (s) => {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

audio.addEventListener('loadedmetadata', () => {
  ui.seek.max = String(audio.duration || 0);
  ui.duration.textContent = mmss(audio.duration);
});

let scrubbing = false;
ui.seek.addEventListener('input', () => {
  scrubbing = true;
  ui.elapsed.textContent = mmss(Number(ui.seek.value));
});
ui.seek.addEventListener('change', () => {
  audio.currentTime = Number(ui.seek.value);
  scrubbing = false;
});
audio.addEventListener('timeupdate', () => {
  if (scrubbing) return;
  ui.seek.value = String(audio.currentTime);
  ui.elapsed.textContent = mmss(audio.currentTime);
});

/**
 * Web Audio on iOS fails silently in a few configurations. If the element is
 * advancing but the graph is flat, say so rather than letting it look broken.
 */
function selfTest() {
  const t0 = audio.currentTime;
  let best = 0;
  let n = 0;
  const tick = setInterval(() => {
    best = Math.max(best, engine.peak());
    if (++n < 20) return;
    clearInterval(tick);
    if (best < 1e-5 && audio.currentTime > t0 + 0.3 && !audio.muted) {
      banner('Audio is decoding but the spatial graph is silent. Check the ' +
             'volume and the iOS silent switch, then reload the page.');
    }
  }, 100);
}

function banner(msg) {
  ui.banner.textContent = msg;
  ui.banner.hidden = false;
}

/* ----------------------------------------------------------------- controls */

const slider = (input, out, fmt, apply) => {
  const run = () => {
    out.textContent = fmt(Number(input.value));
    apply(Number(input.value));
  };
  input.addEventListener('input', run);
  return run;
};

const sync = [];
sync.push(slider(ui.azimuth, ui.azimuthV, (v) => `${v}°`,
  (v) => engine.setGeometry({ azimuth: v })));
sync.push(slider(ui.distance, ui.distanceV, (v) => `${v.toFixed(1)} m`,
  (v) => engine.setGeometry({ distance: v })));
sync.push(slider(ui.elevation, ui.elevationV, (v) => `${v}°`,
  (v) => engine.setGeometry({ elevation: v })));
sync.push(slider(ui.spread, ui.spreadV, (v) => `${Math.round(v * 100)}%`,
  (v) => engine.setGeometry({ spread: v })));
sync.push(slider(ui.rt60, ui.rt60V, (v) => `${v.toFixed(1)} s`,
  (v) => engine.setRoom({ rt60: v })));
sync.push(slider(ui.wetness, ui.wetnessV, (v) => `${Math.round(v * 100)}%`,
  (v) => engine.setRoom({ wetness: v })));
sync.push(slider(ui.intensity, ui.intensityV, (v) => `${Math.round(v * 100)}%`,
  (v) => engine.setIntensity(v)));

function syncEngineFromUI() {
  sync.forEach((run) => run());
}

/* ------------------------------------------------------------------ presets */

Object.entries(PRESETS).forEach(([key, p]) => {
  const b = document.createElement('button');
  b.className = 'chip';
  b.textContent = p.label;
  b.addEventListener('click', () => {
    ui.azimuth.value = String(p.azimuth);
    ui.distance.value = String(p.distance);
    ui.elevation.value = String(p.elevation);
    ui.spread.value = String(p.spread);
    ui.rt60.value = String(p.rt60);
    ui.wetness.value = String(p.wetness);
    ui.intensity.value = String(p.intensity);
    syncEngineFromUI();
    ui.presetHint.textContent = p.hint;
    Array.from(ui.presets.children).forEach((c) => c.classList.remove('on'));
    b.classList.add('on');
  });
  ui.presets.appendChild(b);
});

/* ------------------------------------------------- head / device  tracking */

let tracking = false;
let refYaw = null;

/**
 * Safari exposes only *phone* orientation, never the AirPods IMU, so this
 * world-locks the rig against the handset. Real head tracking needs the native
 * app and CMHeadphoneMotionManager.
 */
function onOrientation(e) {
  if (!tracking) return;
  // webkitCompassHeading grows clockwise, which matches "turned to my right".
  // Spec alpha grows counter-clockwise, so it is negated.
  const raw = typeof e.webkitCompassHeading === 'number'
    ? e.webkitCompassHeading
    : (e.alpha == null ? null : -e.alpha);
  if (raw == null) return;
  if (refYaw == null) refYaw = raw;
  let yaw = raw - refYaw;
  while (yaw > 180) yaw -= 360;
  while (yaw < -180) yaw += 360;
  // beta/gamma are noisy held in the hand; damp them well below yaw.
  const pitch = (e.beta == null ? 0 : (e.beta - 90) * 0.25);
  const roll = (e.gamma == null ? 0 : e.gamma * 0.15);
  engine.setHeadPose(yaw, Math.max(-45, Math.min(45, pitch)), roll);
}

ui.track.addEventListener('click', async () => {
  if (tracking) {
    tracking = false;
    refYaw = null;
    engine.setHeadPose(0, 0, 0);
    ui.track.textContent = 'Enable motion lock';
    ui.track.classList.remove('on');
    ui.trackState.textContent = 'Off — the rig turns with you.';
    return;
  }
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) { ui.trackState.textContent = 'This browser exposes no motion sensors.'; return; }
  if (typeof DOE.requestPermission === 'function') {
    try {
      const res = await DOE.requestPermission();
      if (res !== 'granted') {
        ui.trackState.textContent = 'Motion access denied. Enable it in Settings › Safari.';
        return;
      }
    } catch (err) {
      ui.trackState.textContent = `Motion request failed: ${err.message}`;
      return;
    }
  }
  tracking = true;
  refYaw = null;
  window.addEventListener('deviceorientation', onOrientation, true);
  ui.track.textContent = 'Disable motion lock';
  ui.track.classList.add('on');
  ui.trackState.textContent = 'On — the speaker stays put as you turn the phone.';
});

ui.recentre.addEventListener('click', () => {
  refYaw = null;
  engine.setHeadPose(0, 0, 0);
});

/* --------------------------------------------------------------- visualiser */

const ctx2d = ui.radar.getContext('2d');

function drawRadar() {
  const dpr = window.devicePixelRatio || 1;
  const size = ui.radar.clientWidth;
  if (ui.radar.width !== size * dpr) {
    ui.radar.width = size * dpr;
    ui.radar.height = size * dpr;
  }
  const g = ctx2d;
  const W = size * dpr;
  const cx = W / 2;
  const cy = W / 2;
  const maxM = Math.max(6, Number(ui.distance.value) * 1.35);
  const scale = (W * 0.42) / maxM;

  g.clearRect(0, 0, W, W);
  const ink = getComputedStyle(document.documentElement)
    .getPropertyValue('--ink').trim() || '#e8eaf0';

  // range rings
  g.strokeStyle = 'rgba(128,140,170,0.22)';
  g.lineWidth = 1 * dpr;
  for (let m = 2; m <= maxM; m += 2) {
    g.beginPath();
    g.arc(cx, cy, m * scale, 0, Math.PI * 2);
    g.stroke();
  }
  g.beginPath();
  g.moveTo(cx, cy - W * 0.46); g.lineTo(cx, cy + W * 0.46);
  g.moveTo(cx - W * 0.46, cy); g.lineTo(cx + W * 0.46, cy);
  g.stroke();

  const yaw = engine.headYaw * Math.PI / 180;

  // The listener, drawn facing their measured heading.
  g.save();
  g.translate(cx, cy);
  g.rotate(yaw);
  g.fillStyle = 'rgba(90,170,255,0.20)';
  g.beginPath();
  g.moveTo(0, 0);
  g.arc(0, 0, W * 0.17, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
  g.closePath();
  g.fill();
  g.fillStyle = '#5aaaff';
  g.beginPath();
  g.arc(0, 0, 6 * dpr, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // Virtual speakers, from the same geometry the engine uses.
  const az = Number(ui.azimuth.value);
  const elv = Number(ui.elevation.value);
  const dist = Number(ui.distance.value);
  const spread = Number(ui.spread.value);
  const bed = [
    { a: -30, r: 5.5, lab: 'L' }, { a: 30, r: 5.5, lab: 'R' },
    { a: 0, r: 6.5, lab: 'C' },
    { a: -110, r: 4, lab: 'Ls' }, { a: 110, r: 4, lab: 'Rs' },
  ];
  g.font = `${11 * dpr}px -apple-system, system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  for (const s of bed) {
    const p = sphericalToCartesian(az + s.a * spread, elv, dist);
    // World -> screen: +x right, -z forward(up on screen).
    const sx = cx + p.x * scale;
    const sy = cy + p.z * scale;
    const behind = p.z > 0;
    g.fillStyle = behind ? 'rgba(255,170,90,0.85)' : 'rgba(120,230,180,0.9)';
    g.beginPath();
    g.arc(sx, sy, s.r * dpr, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(232,234,240,0.55)';
    g.fillText(s.lab, sx, sy - 13 * dpr);
  }

  // level meter
  const p = engine.ready ? engine.peak() : 0;
  ui.meter.style.transform = `scaleX(${Math.min(1, p * 1.6)})`;

  requestAnimationFrame(drawRadar);
}
requestAnimationFrame(drawRadar);

/** Drag on the radar to place the speaker: angle sets azimuth, radius distance. */
function placeFromPointer(ev) {
  const rect = ui.radar.getBoundingClientRect();
  const t = ev.touches ? ev.touches[0] : ev;
  const dx = t.clientX - rect.left - rect.width / 2;
  const dy = t.clientY - rect.top - rect.height / 2;
  const maxM = Math.max(6, Number(ui.distance.value) * 1.35);
  const scale = (rect.width * 0.42) / maxM;

  let deg = Math.atan2(dx, -dy) * 180 / Math.PI;
  deg = Math.round(deg);
  const metres = Math.min(20, Math.max(0.5, Math.hypot(dx, dy) / scale));

  ui.azimuth.value = String(Math.max(-180, Math.min(180, deg)));
  ui.distance.value = String(metres.toFixed(1));
  syncEngineFromUI();
}

let dragging = false;
const down = (e) => { dragging = true; placeFromPointer(e); e.preventDefault(); };
const move = (e) => { if (dragging) { placeFromPointer(e); e.preventDefault(); } };
const up = () => { dragging = false; };
ui.radar.addEventListener('mousedown', down);
ui.radar.addEventListener('mousemove', move);
window.addEventListener('mouseup', up);
ui.radar.addEventListener('touchstart', down, { passive: false });
ui.radar.addEventListener('touchmove', move, { passive: false });
window.addEventListener('touchend', up);

/* ------------------------------------------------------- lock-screen controls */

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => start());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', () => { load(current - 1); start(); });
  navigator.mediaSession.setActionHandler('nexttrack', () => { load(current + 1); start(); });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

syncEngineFromUI();
ui.presetHint.textContent = 'Load a track, then pick a position.';
