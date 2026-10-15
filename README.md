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
Mock GPU tests validate lifecycle behavior, not visual quality or real GPU speed.
Live-site playback and interpolation quality still require manual validation.

See [third-party notices](THIRD_PARTY_NOTICES.txt) for component licenses and
[the model card](neural/MODEL-CARD.md) for the bundled neural model.