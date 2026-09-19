# Compact model and runtime provenance

- Upstream: https://github.com/MONZikWasTaken/Framegen
- Pinned release: v1.4.7; commit 83a3e338cb3b9391b05c4d85a5fd8534a8aafa32.
- Upstream graph reference: web/rt/rt.js, blob 6cf8b1bc889813ab19675c08b7608a5a5f05af36.
- Model data: framegen@1.4.0/weights/rt_v7s.bin and rt_v7s.json.
- Download source: https://cdn.jsdelivr.net/npm/framegen@1.4.0/weights/
- npm stopped publishing framegen after 1.4.0. The 1.4.0 tarball weights are
  byte-identical to the v1.4.7 tag assets (git blobs 727489fb8bb9dffbb7a32a2efef07c2bfacc843f
  and e8fc44e2fc0183505bdfb269f69197a3f54e1405), verified 2026-09-19.
- Licenses: MIT for adapted code; separate noncommercial weights terms.

The runtime here is a dense, tiled, compact graph implementation. It is not the
original optimized runtime, does not include its sparse refinement or autotuning,
and has no measured real-time performance claim. The architecture uses a
time-independent trunk, FiLM timestep conditioning, intermediate flow/mask and
a learned refinement residual. Source RGB reconstruction is at source resolution,
independent of internal model dimensions.

The original pretrained binary was not available in the build environment.
It is not bundled and has not been executed here. The model installer validates
shapes, offsets, length, finiteness and a fixed architecture before storage.
The SHA-256 computed at installation is a local integrity check, NOT an
independently verified publisher signature. Version-pinned HTTPS and explicit
consent establish the installation trust boundary. Only data is fetched; all
JavaScript/WGSL graph code is packaged in the extension.

Test fixture weights are randomly generated mathematical test inputs. They are
not pretrained, are not a substitute for rt_v7s and are not in installable ZIPs.
