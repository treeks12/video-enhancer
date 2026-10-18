# Video Enhancer — Sharper Video & Smoother Motion

Make video look smoother and sharper directly in your browser. Video Enhancer can generate an intermediate frame between source frames for **up to 2× the displayed frame rate**, while local WebGL/WebGPU processing improves detail and perceived clarity.

- **Sharper image:** choose Original, FSR1, or RAVU-lite with adjustable RCAS sharpening.
- **Smoother motion:** GPU frame interpolation with a stable buffered presentation clock.
- **Local and private:** frames stay in the browser; no video upload, telemetry, or remote processing.
- **Simple:** install the extension, open a video, and enable the controls from the popup.

Feed navigation is handled as a continuous compositor. Each video source gets
its own session, stale frame callbacks and neural results are rejected when a
feed reuses or replaces a `<video>` element, and video presentation continues
while the next interpolation pair is prepared. Spatial
enhancement remains active during that handoff.

The neural model and size-independent shaders stay loaded across resolution and
aspect-ratio changes. Bounded caches reuse neural shapes and exact-size spatial
textures; obsolete inference stops submitting work between small GPU batches.
Flow warping and refinement share uniform-driven programs across scales and
directions, reducing shader preparation without changing the model arithmetic.
Startup weight conversion uses short, cancellable CPU tasks and a bit-exact
float16 lookup table. IFRNet preparation skips the legacy CPU frame readback and
unused legacy shaders. A rolling display clock and feasible-tick selection keep
interpolation from getting stuck after source or refresh-rate changes.
Neural execution also observes each pair's presentation deadline. Small GPU work
quanta share time with the spatial compositor; expired work stops before the next
submission and drains its outstanding fence before another job starts. This
protects source playback without changing the selected model or resolution.
IFRNet prefers WebGPU and retains immutable decoded frames locally. A shared
document device is allocated only when interpolation is enabled and a video
exists. Eligible spatial pages can discover the adapter before decoded playback,
without allocating a device or loading the model. On browsers with coarse completion notifications, a bounded,
cooperative empty-submit pump refreshes pending fences without blocking JS.
That measured device path also uses bounded storage tiles for convolution,
avoiding expensive initialization of large workgroup arrays during preparation.
Its shared Quality and Balanced kernels stage each input tile once in a separate dispatch,
then reuse it across output channels. This reduces individual shader complexity
and repeated texture reads within the convolution.
The model weights, resolution and convolution arithmetic remain the same.
The WebGL2 backend uses the smallest supported positive sync timeout when needed.
If video callbacks consistently lag healthy decoder progress,
the compositor switches to display-refresh sampling for that video session.
It keeps spatial processing and the loaded model active during the switch.
Fence waits also bound fast polling and yield to browser timers. RAVU requests
parallel shader compilation where supported, without synchronous status queries
before compilation finishes. Without parallel compilation, its classifier,
filter and reconstruction programs are prepared in separate tasks.

The WebGPU compositor presents source anchors and neural predictions through
the same GPU API, including RAVU and RCAS. It avoids copying every neural image
back into WebGL. Its spatial cache has a 96 MiB admission budget; unsupported
sizes and FSR enlargement retain the WebGL spatial path. The selected IFRNet
model is preserved across that presentation fallback. Exported diagnostics
identify the inference and presentation backends separately.
IFRNet playback at roughly 40 fps and above uses two source frames of presentation delay when
the display has room for additional frames. Three rotating RGB anchors and two
stored midpoint targets let the next inference run while a completed midpoint
is displayed. Callback timestamps are projected onto the display clock without
changing a prediction's inferred phase. Lower-cadence sources retain one frame
of delay. Fully completed
encoder features can serve the next adjacent pair even if its predecessor's
decoder misses its deadline; partially computed features are never reused.

IFRNet-S is the default interpolation engine. Framegen v7-small is bundled as an experimental alternative and may be more demanding or less stable. WebGL2 runs the same bundled model when WebGPU is unavailable; Analytic Flow is the fallback when neural inference cannot run. Results depend on the browser, GPU, source video and motion complexity. Occlusions, scene cuts and very fast movement can still produce artifacts.

[Install for Firefox](https://addons.mozilla.org/en-US/firefox/addon/video-enhancer-for-firefox/) · [Download releases](https://github.com/treeks12/video-enhancer/releases) · [Project website](https://treeks12.github.io/video-enhancer/)

## Development

The extension runs directly from the source files. No JavaScript compilation or
runtime package installation is required. Load manifest.json as a temporary
Firefox add-on, or manifest.chromium.json as the manifest for a Chromium checkout.

### Build

Requires Python 3.10 or newer, using only its standard library. From the repository
root, run:

```sh
python tools/package.py
```

On Windows, `./build.ps1` runs the same builder. Packages are written to `dist/`.
The unified release bundles IFRNet-S and Framegen v7-small. No model download is required. Framegen weights retain their noncommercial/personal-use license; see the included notices.

### Validation

Requires Node.js for the logic tests and Python for packaging checks:

```sh
node test/run.cjs
python test/packaging.py
```

Most browser tests in `test/` require Playwright and a compatible browser/GPU.
`node test/stability.cjs` exercises video playback, source transitions and recovery.
`node test/feed-resize.cjs` exercises the bundled IFRNet model during feed changes;
set `FEED_HD=1` for 720p/1080p sources. `node test/spatial-resize.cjs` isolates
FSR1 and RAVU with interpolation disabled, including paused-player resizing.
`node test/neural-startup.cjs` measures cold-start responsiveness while spatial
enhancement stays active. Set `STARTUP_CPU=4` to simulate a slower CPU; optional
`BASELINE_REF` comparisons require Git history.
`node test/neural-budget.cjs` stresses actual GPU convolutions while comparing
60 fps source playback with spatial enhancement alone and with interpolation.
It also checks deadline cancellation and recovery on a subsequent feasible
source. Set `BUDGET_LOAD=1 BUDGET_PROFILE=balanced` for the lighter 60 fps case;
the default repeated-convolution fixture emulates a slower GPU without artificial
inference sleeps. It does not reproduce every browser/driver configuration.
`node test/neural-browser.cjs` instead uses Puppeteer Core, FFmpeg and an installed
Firefox (default) or Chromium browser (`TEST_BROWSER=chromium`). It decodes a real
720p H.264 fixture, compares native callbacks and spatial-only playback, then
counts successfully presented IFRNet frames in five consecutive one-second
windows. Set `SOURCE_FPS=24`, `30` or `60`, and `FI_PROFILE=quality` or `balanced`.
`FIREFOX_PATH`, `CHROMIUM_PATH` and `FFMPEG_PATH` override executable locations.
The fixture uses an isolated temporary profile and does not install an extension
or modify an existing browser profile. It measures frame gaps and browser refresh
stalls during cold spatial preparation, model loading and steady playback, so a
high average FPS cannot hide a long pause. `HEADLESS=0` runs the desktop compositor
path. Headless video composition differs from
desktop playback, so these measurements are regression checks, not universal
performance claims.
Mock GPU tests validate lifecycle behavior, not visual quality or real GPU speed.
`node test/neural-addon.cjs` installs the actual Store package into a disposable
native browser profile. Set `ADDON_FEED=1` to exercise source replacement, portrait
and landscape changes, and rapid transitions through real extension APIs.
Set `ADDON_MIXED_FEED=1` for several retained players with portrait, square and
wide sources, a hidden preloaded player, delayed pauses after scrolling, CSS-only
resizing and rapid scrolling. `ADDON_INIT_PHASED=1` starts interpolation while
upscaling is already playing. The standard benchmark includes this combined case
with `ADDON_INTERACTION=quality` and `smooth`, and native CSS visibility checks
in both browsers.
`node test/ifrnet-webgpu-conformance.cjs` checks trained operations and external
frame sampling against WebGL. `node test/ifrnet-webgpu-integration.cjs` checks
the full checkpoint, encoder reuse, debug views and resizing.
`node test/webgpu-compositor-conformance.cjs` compares spatial output, orientation,
comparison anchors and rounding against the existing GL pipeline.
Live-site playback and interpolation quality still require manual validation.

### Autonomous benchmark matrix

Run the complete native-browser matrix with one command:

```sh
node test/benchmark.cjs --preset full --install-deps
```

The runner discovers Node, Python, FFmpeg, installed Firefox/Chromium and the
Puppeteer Core test dependency. The optional dependency installation uses a
pinned version in a temporary cache; it does not install browser binaries or
change extension dependencies. Python, FFmpeg and browser executables must
already be installed. Their paths can be supplied through `PYTHON_PATH`,
`FFMPEG_PATH`, `FIREFOX_PATH` and `CHROMIUM_PATH`.

GPU cases execute serially in disposable profiles. The full preset covers
resolution, cadence, neural profiles, spatial-only baselines, playback rates,
explicit WebGL fallback, canvas interop, synthetic callback/main-thread stress,
content patterns, real-package feed transitions, layout and numerical checks.
Videos are encoded once before measurements and pinned by SHA-256. The source
snapshot, browser/dependency versions, configuration and actual adapters/backends
are retained with every run. Application startup is measured separately from
steady playback; driver shader caches are not cleared.

Results go to a timestamped temporary directory by default. `--output PATH`
chooses another directory. Each case retains raw output, structured results and
all retries; assertion failures do not stop later cases. An unverified process
cleanup stops the run to avoid contaminating subsequent GPU measurements.
`report.html`, `results.csv`, `summary.json` and `journal.jsonl` provide both
individual evidence and matched configuration groups. Failed/unavailable cases
are never turned into successful measurements.

```sh
node test/benchmark.cjs --preset full --dry-run
node test/benchmark.cjs --preset full --repetitions 2
node test/benchmark.cjs --resume PATH
```

Resume requires matching source, fixture and environment identities. To stop at
a case boundary, create `stop.request` in the output directory. A small pilot can
use `--preset smoke --browsers chromium --limit 4`; it is not full coverage.
Submitted draw cadence is not a physical-display FPS measurement, and synthetic
stress is not a substitute for testing other GPUs or real-site visual quality.


See [third-party notices](THIRD_PARTY_NOTICES.txt) for component licenses and
[the model card](neural/MODEL-CARD.md) for the bundled neural model.
