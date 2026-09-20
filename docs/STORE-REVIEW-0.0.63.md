# Store artifact review notes

Version: 0.0.63. Status: unsigned experimental candidate, not submitted or approved.

Build with Python 3.10+ standard library: `python tools/package.py --flavor store`.
No network access, npm packages, downloaded code, model installation or minification
is required by the builder. The full source contains personal-only regions; the
store builder removes those explicitly marked regions and selects an allowlist.
The resulting JavaScript remains readable.

Permissions: `storage`. Content scripts match HTTP/HTTPS pages to locate the video.
No optional download host permissions, model options page, service worker, native
messaging or neural runtime is included in the store artifact. Preferences naming
optional models normalize to the independent analytic engine. See automated checks
in `test/packaging.py`.

Processing: reads accessible HTML video frames locally and draws an overlay. It
uses WebGL2 and, optionally for the legacy LK comparison, WebGPU. The original video
remains painted. Inaccessible sources are not bypassed. No telemetry or video upload
is added. Save diagnostics is a user-initiated local JSON download.

The independent estimator and synthesis are in `fi-analytic.js`, licensed MIT under
the scoped `LICENSE-ANALYTIC.txt`. There are no pretrained neural interpolation
weights. RAVU's existing trained LUT remains in the spatial upscaler, with its LGPL
license, GPL companion text and preferred hook source. FSR1 attribution is retained.
See `THIRD_PARTY_NOTICES.txt`; do not represent the whole artifact as all-MIT.

Manual functional review: load the unpacked artifact, open an accessible non-DRM
video, enable Original + Frame interpolation, select Analytic Flow / Balanced.
Select RAVU or FSR1 afterwards. Test pause, seek, fullscreen, scrolling, resize and
source change. Check effective backend, support, timings and rendered midpoint rate
in Advanced. A denied float-buffer capability must preserve the original video.

Validation supplied: eight shipping shaders executed in EGL/GLES on Mesa software;
48 synthetic scene/phase combinations across two source scales; host lifecycle,
controller, packaging and mocked-extension popup tests. No physical GPU benchmark,
real browser WebGL execution or learned-model quality comparison is claimed.

Remaining release gates: sustained real-browser playback on target AMD/Intel/NVIDIA
hardware, meaningful comparison with the personal neural baseline, resource/cadence
under overload, and review of the complete distribution obligations. The name
"Store" identifies the dependency-minimized artifact, not approval by a store.

Primary policy/provenance URLs reviewed on 2026-09-19:

```
https://extensionworkshop.com/documentation/publish/add-on-policies/
https://extensionworkshop.com/documentation/publish/firefox-add-on-distribution-agreement/
https://extensionworkshop.com/documentation/publish/third-party-library-usage/
https://github.com/MONZikWasTaken/Framegen/blob/83a3e338cb3b9391b05c4d85a5fd8534a8aafa32/WEIGHTS_LICENSE.md
https://github.com/ltkong218/IFRNet
https://github.com/nihui/ifrnet-ncnn-vulkan
https://github.com/bjin/mpv-prescalers
```
