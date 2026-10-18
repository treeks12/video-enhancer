# IFRNet-S GoPro browser port

This is inference with an existing pretrained model, not a model trained for this extension.
The browser runtime implements the small IFRNet encoder/decoder and learned visibility /
RGB residual reconstruction. It does not use optical flow under a neural label.

## Identity and attribution

Architecture: Lingtong Kong et al., IFRNet, CVPR 2022.
Official source: https://github.com/ltkong218/IFRNet (MIT; LICENSE-IFRNet.txt).
Preprocessing and checkpoint layout reference: https://github.com/nihui/ifrnet-ncnn-vulkan
(MIT repository; LICENSE-ncnn-port.txt).

- Checkpoint: `models/IFRNet_S_GoPro/ifrnet.bin`.
- Repository revision containing this asset: `7e54b1caa8c9f94a052a7148a56a2f57b685609e`.
- Byte count: `5921992`.
- Git blob SHA-1: `cae4a9270b508eb0fc51c9570b3fa0c8d7d3c773`.
- Verification: SHA-1 of ASCII `blob 5921992\0` followed by the complete binary.
- Parsed parameter count, removing the duplicated encoder branch: `2803610`.
- The two encoder branches must be identical; the loader checks this invariant.

Both Store and Personal packages bundle this checkpoint as `models/ifrnet.bin`.
The content-side loader verifies its size and pinned Git blob hash before use.
Store packages contain no model installer, download endpoint or background model
service. No video upload, telemetry, API key, native helper, Python or ONNX runtime
is used at playback. The optional Personal installer also verifies imported or
downloaded weights before storing them; failed verification preserves the prior model.

Weight conversion shares one parser between synchronous validation and cooperative
runtime loading. The runtime yields after a short CPU budget and checks cancellation
inside large arrays. A fully initialized 256 KiB float16 lookup table preserves
every decoded parameter bit; regression hashes also cover packed GPU weights.
IFRNet startup performs no legacy CPU luma readback or legacy warp-shader compilation.

## Numerical implementation

WebGPU with WebGL2 fallback; RGBA16F feature atlases; FP32 packed weights/accumulation; fused PReLU;
stride-2 transposed convolution with parity-aware gathering; border-clamped bilinear
feature warping; four refinement stages; sigmoid before mask upsampling; full source
RGB warp plus resized learned residual. Fixed RGB centering at 0.5 follows the maintained
ncnn port, rather than the pair-mean variant in the original PyTorch entry point.

The current frame's fully fenced encoder features are reused as the previous
frame's features for the next adjacent pair, including when the decoder of the
earlier prediction is cancelled. Partial encoders are never cached. Features
are invalidated on seek/reset/gaps. The preferred path keeps inference, retained
RGB predictions and source presentation on WebGPU. Immutable VideoFrames remain
owned until their submitted readers drain. RAVU/RCAS spatial composition uses a
separate canvas aligned with the player, retaining comparison anchors and the
original RGBA8/RGBA16F quantization stages. Unsupported spatial sizes and FSR
enlargement use the WebGL presentation path with the same neural model. The
WebGL inference fallback shares its context with spatial enhancement. Only four
scene-statistic floats are read back; WebGPU computes them with a workgroup
histogram and FP32 reduction, with small reduction-order rounding differences.
Model weights and size-independent shader
programs persist across source-size changes. Two neural shapes are cached within
a 256 MiB runtime budget. Inference groups cheap operations and splits expensive
ones into bounded atlas regions within a measured work budget. The full viewport
and shader arithmetic are preserved. Task yields between quanta let the compositor
continue; work stops when its pair is replaced or its presentation deadline expires.
The final outstanding fence is drained before the job releases ownership, so
cancelled attempts cannot accumulate GPU submissions. The time target is bounded
by the source interval (up to 4 ms); measured fence turnaround includes browser
polling and shared work and is not reported as pure GPU time.
The runtime queries `MAX_CLIENT_WAIT_TIMEOUT_WEBGL` once and uses a 1 ns timeout
where supported, otherwise zero. Firefox's positive-timeout path refreshes sync
status rather than waiting for its periodically updated zero-timeout cache.
The requested GPU wait is minimal; browser/driver communication can still take
longer, so this is not a guarantee of a nonblocking JavaScript call.
For WebGL, at most eight fast polls run before a 1 ms timer yield. Intervening message tasks
avoid accumulated timer nesting; cancelled jobs still drain their submitted work.
WebGPU uses a shared document device and at most four disjoint inference
submission buffers. A calibrated empty-submit pump refreshes coarse completion
callbacks only while work is pending; MessageChannel tasks preserve timer
fairness. Turnaround measurements include browser notification latency and
other queue work. They are not hardware GPU timestamps.
Devices with measured completion notifications above 8 ms use reusable storage
tiles for the same convolution math, avoiding large workgroup-array compiler
initialization. Scratch allocation stays within the 256 MiB runtime budget and
the device's storage binding limit; at 512x288 its maximum is about 21.52 MiB.
External-texture handles are refreshed immediately before encoding each use.
Different VideoFrame wrappers can share a browser texture, so closing one must
not leave another retained frame using an expired handle. Frame ownership still
lasts through the submitted queue fence; external bind groups are not cached.
Separate GL spatial targets use a 96 MiB cache budget, retaining only the active
working set if it alone exceeds that budget. The direct WebGPU compositor has
a strict 96 MiB admission budget including two retained RGB predictions, and
returns to GL presentation for unsupported dimensions.

Balanced caps the inference long edge at 320; High quality caps it at 512.
Dimensions preserve aspect ratio and pad
to multiples of 32 in centered space. Final color is sampled from the full-resolution
anchors; the output is not merely an enlarged low-resolution RGB midpoint.

Each pair predicts one fixed time selected from the presentation cadence. A prediction
is not relabeled as a different time when it arrives late. This remains a maximum-2x
scheduler, not arbitrary 24-to-60/120 temporal resampling. Audio is not delayed to match
the visual buffer. It holds one source frame for lower-cadence playback and two
for high-cadence IFRNet sources when the display has extra slots. At 60 fps, two
frames add approximately 33 ms of visual delay. Three rotating full-resolution
RGB anchors and two private synthesized targets decouple the current inference
from presentation of the preceding prediction. Output keeps its inferred phase;
hard serial, source, shape and epoch checks reject stale results even if an early
video callback arrives before the numerical deadline. Scene cuts omit that pair's
midpoint while preserving the same anchor timeline.
The display clock is continuously resampled. Callback-to-display lead is frozen
with each prediction, and CPU deadlines use the corresponding inverse projection.
A prediction targets an available
display tick within its usable phase range, accounting for the last measured cost;
a cold slow prediction cannot permanently prevent future attempts. This scheduling
does not make inference faster than a device can execute it.
Cancelled partial runs have separate diagnostics and never count as completed
predictions or replace the measured cost of a full inference. On hardware unable
to meet the deadline, source playback can continue without neural midpoints.

## Validation boundary

The GLSL graph was executed through Mesa EGL/OpenGL ES with deterministic **untrained**
fixture weights and compared with independent PyTorch operation implementations.
This verifies the numerical port and graph, not the visual quality of the pretrained
checkpoint. The fixture is deliberately rejected by the production checksum gate.

The browser regression suite also executes the bundled pretrained model in real
WebGL2, using synthetic moving sources, resolution/aspect-ratio changes, interrupted
preparation and rapid video replacement. Resized-kernel output is compared with the
prior fixed-shape implementation, including forced X/Y tiling and interleaved GL
state changes. A repeated-convolution fixture exercises actual GPU overload at
60 fps, deadline cancellation and subsequent recovery without artificial inference
sleeps. Spatial-only browser tests exercise FSR1/RAVU and
paused-player resizing. Extension APIs are mocked in these fixtures; resource tests
mock WebGL and do not measure shader speed.
The native-browser series fixture uses an H.264 decoder and verifies sustained
successful IFRNet presentation, source cadence and GL errors in Firefox and
Chromium. It also compares native video-callback delivery with decoder progress;
consistently sparse callbacks select the display-refresh sampling path without
unloading the model. Headless composition has browser-specific limitations and
does not replace desktop playback validation.

Native conformance fixtures compare individual trained WebGPU operations and
the complete checkpoint against the GL implementation. They cover immutable
external frames, encoder reuse, phases, debug views and repeated shapes. Spatial
conformance compares RAVU/RCAS quantization, orientation and comparison anchors.
The real-package fixture installs the Store artifact into a disposable profile,
uses actual extension storage/messaging and exercises rapid feed changes.

These checks verify lifecycle behavior and numerical regression, not perceptual
quality across live sites or a hardware compatibility matrix. Faces, hair, crossing
objects, occlusions, subtitles, flashes, scene cuts, anime holds, noise and long
playback still need real-video visual validation on target devices. Compare generated,
presented and late counts so skipped frames do not masquerade as artifact removal.
