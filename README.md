# Spatialize

Play ordinary stereo music as if it were coming from a loudspeaker somewhere in
the room — the same trick as Apple's **Spatialize Stereo** on AirPods, rebuilt
from scratch.

Two implementations of one idea:

| | [`docs/`](docs/) — web app | [`ios/`](ios/) — native app |
|---|---|---|
| Renderer | Web Audio `PannerNode` (HRTF) | `AVAudioEnvironmentNode` (`HRTFHQ`) |
| Runs on | any iPhone, from a URL | iPhone, built from Xcode |
| **AirPods head tracking** | ✗ not possible in Safari | ✓ `CMHeadphoneMotionManager` |
| Motion lock | phone orientation only | real head pose |
| Install | open the link, Add to Home Screen | needs a Mac |

**Use headphones.** The whole effect is binaural. Over a speaker the two ears mix
in the air and it collapses back to ordinary stereo.

---

## What Apple's feature actually does

Spatialize Stereo is undocumented, so this is reverse-engineered from its
observable behaviour plus one very large hint in Apple's own API docs.

The hint is in [`AVAudioEnvironmentNode`](https://developer.apple.com/documentation/avfaudio/avaudioenvironmentnode):

> Spatialization applies only to inputs with a **mono** channel connection
> format. This class **doesn't spatialize stereo inputs** and doesn't support
> inputs with connection formats of more than two channels.

That single sentence rules out the obvious guess. A binaural renderer works by
convolving a **point source** with a head-related transfer function — the
measured way your head, shoulders and ear folds colour a sound arriving from one
specific direction. A stereo file is not a point. It is two channels with no
direction attached to either.

So "spatialize stereo" cannot mean *run HRTF on the stereo file*. It has to mean:

1. **Invent** a set of mono virtual loudspeakers out of the two channels,
2. **place** them at fixed points around the listener,
3. **HRTF-render each one separately**, and
4. **counter-rotate** the whole rig against head motion so it stays put in the
   room.

That is the pipeline both implementations here follow.

### Stage 1 — Mid/side decomposition

Split the stereo pair into what the channels *agree* on and what they
*disagree* on:

```
M = (L + R) / 2      the correlated part: lead vocal, kick, snare, bass
S = (L − R) / 2      the decorrelated part: reverb, strings, stereo widening
```

This matters because the two halves want different treatment. **M** is the
content a real loudspeaker would radiate from one physical point, so it should
come from one tight location. **S** is already decorrelated — exactly the
material that makes a room feel wide — so it belongs in the surrounds. Feeding
the raw L and R into surround positions instead would just smear the lead vocal
around your skull.

### Stage 2 — The virtual loudspeaker bed

Five mono point sources, on the angles a 5.0 cinema layout uses:

| Speaker | Azimuth | Fed from | Why |
|---|---|---|---|
| L / R | ∓30° | L, R | the standard stereo triangle |
| C | 0° | M | **the one that sells it** — see below |
| Ls / Rs | ∓110° | S (delayed) | envelopment, from already-decorrelated material |

The **centre** channel is what makes this sound like a speaker rather than like
widened headphones. In plain stereo, anything panned centre is a *phantom*
image: identical in both ears, which your brain reads as "inside my head,"
because no real sound outside your head ever arrives perfectly identically at
both ears. Routing M to a real virtual source at 0° gives the vocal a genuine
HRTF signature with proper interaural time and level differences. The image
leaves your head and lands in front of you.

### Stage 3 — Distance and the room

Direction alone does not give distance. Three cues do, and all three are needed:

- **Inverse-square rolloff** — level falls as 1/d. On its own, this only sounds
  like someone turned it down.
- **Air absorption** — high frequencies attenuate faster over distance, so a
  low-pass opens and closes with the slider.
- **Direct-to-reverberant ratio** — the big one. In a real room the reverberant
  field is roughly uniform everywhere, while the direct sound falls off with
  distance. So the *ratio* shifts toward reverb as the source recedes. This is
  the cue that actually encodes distance; without it you get a quiet, muffled
  sound that is still obviously stuck to your ears.

The reverb is a procedurally generated stereo impulse response: a sparse early
reflection pattern from a shoebox image-source approximation, then an
exponentially decaying diffuse tail that loses highs as it decays. Nothing is
downloaded; the app ships no audio assets.

### Stage 4 — World-locking (head tracking)

The virtual speakers live in **room** coordinates. The listener is rotated to
the measured head pose, so when you turn your head the whole image sweeps past
you and the speaker appears to stay nailed to one spot in the room.

This is the cue that convinces people. Static binaural audio is easy to dismiss
as EQ; a source that stays put while you turn your head is not.

### Stage 5 — Decorrelation

The two surrounds get different short fractional delays (11 ms and 17 ms). They
are both fed from the same S signal, so without this they would sum into a
phantom image directly behind your head instead of spreading out. The delays
double as crude early reflections.

---

## The web app

**Open it on your iPhone, pick a song, press play.** Add it to the Home Screen
and it runs full-screen with no browser chrome.

Files are read straight off the device — nothing is uploaded, and there is no
server component beyond static hosting.

- **Drag on the radar** to move the speaker around you.
- **Presets** — "Behind me" is the quickest proof that it works.
- **Effect amount → 0** A/Bs instantly against the untouched file.
- **Motion lock** world-locks the rig. Safari can only read the *phone's*
  sensors, never the AirPods IMU, so you have to turn the handset with you. It
  demonstrates the principle; the native app does it properly.

### Run it locally

Any static server works — ES modules won't load over `file://`:

```bash
cd docs && python3 -m http.server 8000
```

### Tests

The DSP graph and the spatial maths run headless against a mocked Web Audio API:

```bash
cd test && node engine.test.mjs
```

48 assertions covering the coordinate transforms, graph construction, speaker
placement, the distance cues, the bypass crossfade, impulse-response shape, and
— the important one — that turning your head right really does move a
front-facing speaker to your left.

---

## The native app

This is the version with **real AirPods head tracking**, which no website can
do. You need a Mac with Xcode 16+ to build it.

```bash
open ios/SpatializeStereo.xcodeproj
```

Set your signing team on the target, pick your iPhone, and run. A free Apple ID
works — the build just expires after 7 days and needs reinstalling.

If your Xcode is older than 16, regenerate the project instead:

```bash
brew install xcodegen && cd ios && xcodegen generate
```

### A note on the head-tracking entitlement

`AVAudioEnvironmentNode` has an `isListenerHeadTrackingEnabled` property that
does all of Stage 4 for you. It is unusable here: Apple's docs state it requires
the `com.apple.developer.coremotion.head-pose` entitlement, which is not granted
to ordinary developer accounts.

So [`HeadTracker.swift`](ios/SpatializeStereo/HeadTracker.swift) drives the
listener by hand from `CMHeadphoneMotionManager`, which needs only an
`NSMotionUsageDescription` string and therefore works on a free account.
`CMAttitude.multiply(byInverseOf:)` supplies the re-centring behaviour that
Apple's own "Fixed" frame of reference has.

Head tracking needs AirPods (3rd gen or later), AirPods Pro, AirPods Max or
Beats Fit Pro. Everything else works on any headphones.

### Build status

The Swift target has **not been compiled** — it was written on Windows, which
has no Xcode. The audio graph follows the documented AVFoundation API surface
and the project file passes structural validation, but expect to fix the odd
compile error on first build. The web app is the tested one.

---

## Things worth knowing

**Turn off Apple's Spatial Audio** for your headphones while using either app
(Control Centre → press and hold the volume slider), or Apple's renderer and
this one stack and the result is mush.

**Why it may sound better or worse by track.** The effect lives on mid/side
separation. A wide, modern stereo mix has a lot to work with. An old mono-ish or
heavily mid-focused master has almost no S signal, so the surrounds stay quiet
and you mostly hear the front bed.

**Generic HRTFs.** Apple can scan your ears with the TrueDepth camera and pick a
personalised HRTF. These apps use the renderer's built-in generic one, which is
measured from a dummy head. Front/back confusion and a slightly elevated front
image are normal with a generic HRTF and are the main audible gap versus Apple's
version. Head tracking covers for most of it — the brain resolves front/back
ambiguity through motion.

---

## Layout

```
docs/                 the web app, served by GitHub Pages
  engine.js           the five-stage spatialiser
  app.js              UI, transport, radar, motion
  index.html  style.css  sw.js  manifest.webmanifest
ios/
  SpatializeStereo/
    SpatialPlayer.swift   AVAudioEngine graph, mid/side, chunked streaming
    HeadTracker.swift     CMHeadphoneMotionManager -> listener pose
    ContentView.swift     SwiftUI
  SpatializeStereo.xcodeproj
  project.yml             XcodeGen fallback
test/engine.test.mjs      headless DSP tests
```

## Licence

MIT — see [LICENSE](LICENSE).

Not affiliated with or endorsed by Apple. "Spatial Audio", "Spatialize Stereo",
"AirPods" and "AirPods Pro" are trademarks of Apple Inc. Nothing here uses
Apple's spatial audio implementation; it is an independent reconstruction built
on public APIs.
