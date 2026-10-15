# Video Enhancer — Sharper Video & Smoother Motion

Make video look smoother and sharper directly in your browser. Video Enhancer can generate an intermediate frame between source frames for **up to 2× the displayed frame rate**, while local WebGL/WebGPU processing improves detail and perceived clarity.

- **Smoother motion:** GPU frame interpolation for 24/30 fps sources, with a stable one-frame presentation delay.
- **Sharper image:** choose Original, FSR1, or RAVU-lite with adjustable RCAS sharpening.
- **Local and private:** frames stay in the browser; no video upload, telemetry, or remote processing.
- **Simple:** install the extension, open a video, and enable the controls from the popup.

Feed navigation is handled as a continuous compositor. Each video source gets
its own session, stale frame callbacks and neural results are rejected when a
feed reuses or replaces a `<video>` element, and the current source frame is
rendered immediately while the next interpolation pair is prepared. Spatial
enhancement remains active during that handoff.

The neural model and size-independent shaders stay loaded across resolution and
aspect-ratio changes. Bounded caches reuse neural shapes and exact-size spatial
textures; obsolete inference stops submitting work between small GPU batches.
Startup weight conversion uses short, cancellable CPU tasks and a bit-exact
float16 lookup table. IFRNet preparation skips the legacy CPU frame readback and
unused legacy shaders. A rolling display clock and feasible-tick selection keep
interpolation from getting stuck after source or refresh-rate changes.
Neural execution also observes each pair's presentation deadline. Small GPU work
quanta share time with the spatial compositor; expired work stops before the next
submission and drains its outstanding fence before another job starts. This
protects source playback without changing the selected model or resolution.

IFRNet-S is the default interpolation engine in the Store build, with Analytic Flow as an automatic fallback when the neural model cannot run. The result depends on the browser, GPU, source video and motion complexity. Occlusions, scene cuts and very fast movement can still produce artifacts; the extension bypasses uncertain pairs instead of freezing the playback clock.

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
The Store edition bundles IFRNet-S and excludes the optional Personal Framegen
backend. No model download is required for Store packages.

### Validation

Requires Node.js for the logic tests and Python for packaging checks:

```sh
node test/run.cjs
python test/packaging.py
```

Browser tests in `test/` require Playwright and a compatible browser/GPU.
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
Mock GPU tests validate lifecycle behavior, not visual quality or real GPU speed.
Live-site playback and interpolation quality still require manual validation.

See [third-party notices](THIRD_PARTY_NOTICES.txt) for component licenses and
[the model card](neural/MODEL-CARD.md) for the bundled neural model.
