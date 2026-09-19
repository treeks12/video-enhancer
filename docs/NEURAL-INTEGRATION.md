# Neural integration map and outstanding gates

## Public interfaces

`FiQuality`: pure half conversion, profile geometry, slot selection and guided
outlier rejection. `FiNeuralRuntime.create(device, options)` builds the fixed
t-factored graph. `prepPair(A,B)` submits the time-independent trunk;
`runT(t, outTexture, debug)` runs FiLM, remaining blocks, flow/mask, dense refinement
and source-resolution composition. Textures use top-down UV convention; input and
output must not alias. Runtime calls are serialized by the owning engine.

`FiNeuralModel`: fixed-version data loader, explicit storage and bounded downloads.
It does not accept ONNX graphs, JS or WGSL from the network. Tensor layout, offsets,
finite values, dimensions and resource-size caps are validated. The small fixed
architecture is compiled from local code. Install-time SHA-256 is local integrity,
not authenticated provenance; no publisher checksum was available in this build.

`FiNeural.Engine`: four-texture capture ring, optional FP16 device, initialization
and cleanup, one inference in flight, source snapshot before any await, same-pair
validity callback, OffscreenCanvas output and job timing. On source-size change,
resources are rebuilt; on reset, prior work cannot be presented.

`content.js`: integrates the opt-in backend into the existing one-frame-delayed
presentation clock. `fiPairAnchorTime` selects the inferred phase;
`fiNeuralTarget` bounds its presentation slot. Serial, video identity and deadline
are checked before and after rendering. A completed frame is not re-timed. Missing
models or backend failure explicitly fall back to classical WebGPU. Half packing
and the comparison fix also apply without neural inference.

## Fixed graph

BGR endpoints -> quarter-grid sampling -> stride-2 conv/PReLU -> stride-2
conv/PReLU -> six conv/PReLU blocks -> FiLM(t) -> two conv/PReLU blocks with final
residual -> transposed convolution -> intermediate four-channel flow and mask.
The refinement input has 11 channels (two BGR warps, mask, four normalized flow
channels); three convolution/PReLU layers and an output layer predict a residual.
RGB is sampled directly from native-resolution source textures for composition.

There are 19 compute dispatches per pair/phase in this dense implementation,
split into a 9-dispatch trunk and a 10-dispatch head/refinement/composition. Kernel
workgroup memory is bounded by the portable 16 KiB floor even on FP32 stride-2
convolutions. Actual shader compilation and arithmetic still require the GPU gate.

## Not implemented or not claimed

- No training of original pretrained weights; no clean-commercial model license.
- No vendor runtime, sparse-refinement port or hardware autotuning.
- No whole-extension migration from WebGL to WebGPU.
- No neural SR, temporal upscaling, monitor-rate multi-mid fan-out or audio retiming.
- No offline benchmark at playback resolution; no cross-browser GPU playback pass.
- No claim that the existing classical occlusion shader is completely repaired.

## Next gate, before optimization

Run the included WebGPU conformance page against PyTorch reference outputs. It
must not report PASS when no adapter is available. Cover both FP32 and FP16 where
supported. Validate actual pretrained manifest and weights installation from the
pinned upstream package; record the installed hashes. Then validate the live
video -> WebGPU -> canvas -> WebGL orientation/color path using an asymmetric
pattern, and compare real difficult clips with the 0.0.61 snapshot and corrected
classical mode. Only after parity and visual A/B should kernels be optimized.

Performance measurements must include capture, queueing, synthesis, API interop
and upscale at actual output frame rate. The UI's job p95 is CPU wall time including
waits, not GPU timestamp-query timing. Report presented mids together with error
and fallback. GPU test fixture wall times include harness overhead and are not
playback benchmarks. A persistent lack of timely mids is a failed performance
gate, not a clean-motion success.
