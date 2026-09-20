# Current development delivery: 0.0.63

See **[LEIA-0.0.63.md](LEIA-0.0.63.md)** for the Store/Personal build split, independent Analytic Flow backend, preserved optional neural models and measured limitations. The historical README below describes earlier versions; do not use its old build commands for 0.0.63.

---

## 0.0.62 experimental: optional compact neural backend

This snapshot adds a local WebGPU implementation of Framegen's compact t-factored
inference graph, an explicit model installer, Balanced/High quality motion
profiles, source-resolution RGB reconstruction, stale-frame cancellation, and
classical fallback. It also fixes half-float subnormal corruption and the EASU
comparison bypass. The existing upscalers remain in place.

**Not GPU-homologated:** the build environment provided neither WebGPU nor WebGL2.
Pretrained weights were not downloaded or evaluated here. No new quality or
real-time-performance claim is made. See `LEIA_PRIMEIRO-0.0.62.md` and
`release-evidence/validation-status.json` for exact scope, setup and limitations.

Weights are optional data, installed on explicit consent; their noncommercial
license is separate from the MIT runtime attribution. No remote executable code
is fetched. This is a new dense runtime, not Framegen's tuned/sparse implementation.

Run `node test/run.cjs`. Then serve the repository locally and run
`test/neural-conformance.html` on a WebGPU-enabled browser **before** promotion.
Fixtures are untrained mathematical references, not quality benchmarks.
Build unsigned packages with `python tools/package.py`.

---

The sections below describe the preceding 0.0.61 and earlier implementation.

# Video Enhancer

[Website](https://treeks12.github.io/video-enhancer/) · [Releases](https://github.com/treeks12/video-enhancer/releases)

## What it does

Enhances the main video on a page locally with WebGL2:

- FSR1 (EASU + RCAS) for upscaling and sharpening;
- RAVU-lite + RCAS for adaptive reconstruction;
- WebGPU frame interpolation up to 2×.

There is no telemetry or data collection. The only permission is `storage`, used to save local preferences.

## How to use

1. Download the ZIP for Firefox or Chromium from [Releases](https://github.com/treeks12/video-enhancer/releases).
2. Install it from your browser's extension store. For local testing, use `about:debugging#/runtime/this-firefox` in Firefox or enable Developer mode and **Load unpacked** in Chromium browsers.
3. Open a page with video and enable **Frame interpolation** in the main popup.
4. Choose Original, FSR1, or RAVU for image processing. **Disable all** turns both off.

## Known bugs

- Interpolation can produce ghosting or distortion around occlusions, extreme motion, and scene cuts.
- DRM-protected or CORS-blocked video may reject processing.
- Only the main video in the top-level document is processed; videos inside iframes are unsupported.
- RAVU and interpolation can be reduced or cancelled when they do not fit the GPU budget.

## Stability update (0.0.57)

- Keep the original video painted under the overlay to avoid suppressing frame delivery.
- Recover from stalled video callbacks, source changes and temporary frame-upload failures.
- Hide the overlay during smooth scrolling and when a source is unavailable.
- Fix interpolation timing without callback metadata and confidence for stationary backgrounds.

## WebGPU interpolation (0.0.60)

Interpolation now uses a bundled WebGPU compute module (`fi-webgpu.js`) for dense
pyramidal Lucas–Kanade optical flow in both directions. It uses a 320×176-ish luma
sample by default (up to 480×264 with the larger sample). Flow is estimated every
2 pixels instead of one CPU block vector per 8 pixels. WebGL2 still performs the
final warp/upscale; luma upload and flow readback bridge the two APIs.
At each finer scale, poor coarse matches receive a bounded local search with wider
spatial support before refinement, reducing aliases in repetitive textures.

## Interpolation quality update (0.0.61)

Midpoints no longer average the two warped endpoints by default. The warp checks
forward–backward consistency (the two flow directions must cancel at one point;
when they do not, the region is occluded or mis-estimated) and photometric
agreement after the warp. Where either test fails, the midpoint shows the more
confident, nearer endpoint instead of a ghost average — the same conservative
behavior hardware interpolators use for occlusions. Motion vectors are uploaded
as half-float values instead of 8-bit packed, removing 0.25 px quantization steps
that made slow pans stutter.

There
is no service, native companion, runtime download, extra permission or browser
flag required; the Store edition bundles the MIT-licensed IFRNet-S model natively,
with Analytic Flow as its fallback engine. When WebGPU is unavailable, computation is late, or the display has
no useful intermediate slot, the extension shows original frames.
It does not fall back to simple frame blending. Device loss also falls back to original
frames. Computation is single-flight and results are checked against the source/pair
that requested them; old results cannot be shown after seeks or source changes.
After three consecutive slow results the motion sample is reduced automatically,
down to half the selected width/height. There is no timed cooldown between attempts;
toggling interpolation settings starts a new quality probe.

Presentation keeps one source frame of delay once interpolation starts (about 33 ms
at 30 fps). Late, busy, low-confidence or missed-frame pairs no longer switch to the
current frame and back to the delayed timeline. Uncertain regions hold the previous
anchor locally; average confidence no longer disables the entire interpolated frame.
Scene cuts still bypass motion synthesis on that same presentation clock. Audio is
not delayed. If compute misses its deadline, the missing midpoint can still be visible
as a repeated frame; preserving the clock does not remove hardware limits.

The popup promotes interpolation to the main panel, separates image controls, and
keeps diagnostics collapsed. It reports presentation delay and WebGPU availability.

This is an optical-flow prototype, not RIFE and not a guarantee of film-quality
interpolation. Thin details, occlusions and repetitive textures remain difficult.
A 60 fps source needs a sufficiently fast display to benefit from extra frames.

## Validation

- `node content.js` and `node fi-core.js`: pure decision checks.
- `node test/cadence.cjs`: real scheduler with deterministic 24/30/60 fps clocks.
- `node test/webgpu-integration.cjs`: asynchronous ownership, late results, device
  failure, no-blend fallback, no queue backlog and display-capacity checks.
- `node test/presentation-clock.cjs`: rendered pixels across slow, stale and missed pairs.
- `node test/popup.cjs`: controls, saved settings, polling and popup preview.
- `node test/webgpu-core.cjs`: real WGSL compile/compute, displacement and lifecycle.
- `node test/webgpu-quality.cjs`: reference midpoints rendered with the production
  estimator and final warp shader. Synthetic references, not a real-film evaluation.
- `node test/stability.cjs`: actual browser video, midpoint pixels, callback stalls,
  source changes, pause/resume and upload errors.

Browser tests require Playwright. They default to Edge without special browser flags.
The runtime extension has no Playwright dependency. Run them with a compatible GPU;
a machine without WebGPU can validate native fallback but cannot validate compute.

Set `FI_REPORT=test/webgpu-current.json` and `FI_VISUAL_REPORT=test/webgpu-report.html`
when running the quality test to regenerate the [visual report](test/webgpu-report.html).
Measured times include the asynchronous GPU/CPU roundtrip, not just GPU shader time.
The [0.0.58 report](test/interpolation-report.html) remains a historical comparison.
Streaming sites and Firefox still require manual validation.

Run `./build.ps1` to create Firefox and Chromium packages in `dist/`.
