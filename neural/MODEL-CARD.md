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

WebGL2; RGBA16F feature atlases; FP32 packed weights/accumulation; fused PReLU;
stride-2 transposed convolution with parity-aware gathering; border-clamped bilinear
feature warping; four refinement stages; sigmoid before mask upsampling; full source
RGB warp plus resized learned residual. Fixed RGB centering at 0.5 follows the maintained
ncnn port, rather than the pair-mean variant in the original PyTorch entry point.

The current frame's encoder features are reused as the previous frame's features for
the next adjacent pair. Features are invalidated on seek/reset/gaps. Inference and
spatial enhancement share one WebGL context; only four scene-statistic floats are
read back after a nonblocking fence. Model weights and size-independent shader
programs persist across source-size changes. Two neural shapes are cached within
a 256 MiB runtime budget; inference yields between batches of eight operations
so a source reset can stop obsolete submissions. Separate exact-size spatial
targets use a 96 MiB cache budget, retaining only the active working set if it
alone exceeds that budget.

Balanced caps the inference long edge at 320; High quality caps it at 512.
Dimensions preserve aspect ratio and pad
to multiples of 32 in centered space. Final color is sampled from the full-resolution
anchors; the output is not merely an enlarged low-resolution RGB midpoint.

Each pair predicts one fixed time selected from the presentation cadence. A prediction
is not relabeled as a different time when it arrives late. This remains a maximum-2x
scheduler, not arbitrary 24-to-60/120 temporal resampling. Audio is not delayed to match
the existing approximately one-source-frame visual buffer.
The display clock is continuously resampled. A prediction targets an available
display tick within its usable phase range, accounting for the last measured cost;
a cold slow prediction cannot permanently prevent future attempts. This scheduling
does not make inference faster than a device can execute it.

## Validation boundary

The GLSL graph was executed through Mesa EGL/OpenGL ES with deterministic **untrained**
fixture weights and compared with independent PyTorch operation implementations.
This verifies the numerical port and graph, not the visual quality of the pretrained
checkpoint. The fixture is deliberately rejected by the production checksum gate.

The browser regression suite also executes the bundled pretrained model in real
WebGL2, using synthetic moving sources, resolution/aspect-ratio changes, interrupted
preparation and rapid video replacement. Resized-kernel output is compared with the
prior fixed-shape implementation. Spatial-only browser tests exercise FSR1/RAVU and
paused-player resizing. Extension APIs are mocked in these fixtures; resource tests
mock WebGL and do not measure shader speed.

These checks verify lifecycle behavior and numerical regression, not perceptual
quality across live sites or a hardware compatibility matrix. Faces, hair, crossing
objects, occlusions, subtitles, flashes, scene cuts, anime holds, noise and long
playback still need real-video visual validation on target devices. Compare generated,
presented and late counts so skipped frames do not masquerade as artifact removal.
