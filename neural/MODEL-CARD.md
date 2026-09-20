# IFRNet-S GoPro browser port, experimental 0.0.62

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

The 0.0.62 packages contain runtime code and attribution, **not the binary weights**.
Use the model setup page's explicit Download model or Import .bin operation. Downloads request
optional access only to cdn.jsdelivr.net (GitHub mirror of the pinned revision,
byte-identical blob), omit credentials and referrer, and verify the pinned
revision hash before installation. No remote executable code, model URL supplied by a page,
video upload, telemetry, API key, native helper, Python or ONNX runtime is used at playback.
Weights are verified before IndexedDB storage and again in the content-side loader.
A failed verification leaves the prior installed model intact.

## Numerical implementation

WebGL2; RGBA16F feature atlases; FP32 packed weights/accumulation; fused PReLU;
stride-2 transposed convolution with parity-aware gathering; border-clamped bilinear
feature warping; four refinement stages; sigmoid before mask upsampling; full source
RGB warp plus resized learned residual. Fixed RGB centering at 0.5 follows the maintained
ncnn port, rather than the pair-mean variant in the original PyTorch entry point.

The current frame's encoder features are reused as the previous frame's features for
the next adjacent pair. Features are invalidated on seek/reset/gaps. Inference and
spatial enhancement share one WebGL context; only four scene-statistic floats are
read back after a nonblocking fence. Textures and shader programs are reused.

Balanced caps the inference long edge at 320, then 288/256 under repeated overload.
High quality starts at 512, then 448/384/320. Dimensions preserve aspect ratio and pad
to multiples of 32 in centered space. Final color is sampled from the full-resolution
anchors; the output is not merely an enlarged low-resolution RGB midpoint.

Each pair predicts one fixed time selected from the presentation cadence. A prediction
is not relabeled as a different time when it arrives late. This remains a maximum-2x
scheduler, not arbitrary 24-to-60/120 temporal resampling. Audio is not delayed to match
the existing approximately one-source-frame visual buffer.

## Validation boundary

The GLSL graph was executed through Mesa EGL/OpenGL ES with deterministic **untrained**
fixture weights and compared with independent PyTorch operation implementations.
This verifies the numerical port and graph, not the visual quality of the pretrained
checkpoint. The fixture is deliberately rejected by the production checksum gate.

The external binary could not be obtained in the implementation environment. No full
pretrained-model inference, browser extension installation, real-video visual A/B,
AMD/Intel/NVIDIA timing or Firefox/Chromium GPU compatibility was validated here.
DOM tests mock extension APIs; lifecycle tests mock WebGL resource APIs; numerical
shader tests use native GLES, not a browser. These distinctions are intentional.

Treat this as an engineering preview. Do not promote the default based on synthetic
parity alone. Validate faces, hair, crossing objects, occlusions, subtitles, flashes,
scene cuts, anime holds, noise and long playback on the target devices. Keep generated /
presented / late counts with quality comparisons, so skipped frames do not masquerade
as artifact removal. Download/service-worker behavior also needs a live-browser test.
