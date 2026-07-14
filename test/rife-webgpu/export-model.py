import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch


HEIGHT, WIDTH = 384, 640
SCALES = [32, 16, 8, 4, 1]
SOURCE_COMMIT = "17d8c7a1005b37f4c97bfee04e316aaec7fdc536"
CHECKPOINT_SHA256 = "81CDBA223FE72A120130CC8552E5D2ECAC824259D406F0C15323B3DECF96B8B1"


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def deduplicate_constants(graph):
    seen, aliases, kept = {}, {}, []
    for node in graph.node:
        tensors = [a.t for a in node.attribute if a.HasField("t")]
        if node.op_type == "Constant" and len(node.output) == 1 and len(tensors) == 1:
            key = hashlib.sha256(tensors[0].SerializeToString(deterministic=True)).digest()
            if key in seen:
                aliases[node.output[0]] = seen[key]
                continue
            seen[key] = node.output[0]
        kept.append(node)
    for node in kept:
        for index, name in enumerate(node.input):
            node.input[index] = aliases.get(name, name)
    removed = len(graph.node) - len(kept)
    del graph.node[:]
    graph.node.extend(kept)
    return removed


def prune_final_features(model):
    old = model.net.block4.lastconv[0]
    new = torch.nn.ConvTranspose2d(
        old.in_channels, 20, old.kernel_size, old.stride, old.padding,
        old.output_padding, old.groups, old.bias is not None, old.dilation,
        old.padding_mode,
    )
    with torch.no_grad():
        new.weight.copy_(old.weight[:, :20])
        if old.bias is not None:
            new.bias.copy_(old.bias[:20])
    model.net.block4.lastconv[0] = new.eval()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("work", type=Path, help="Pasta com source/ e checkpoint/train_log/")
    parser.add_argument("--web-lite", action="store_true", help="Remove features não usadas do último estágio")
    args = parser.parse_args()
    work = args.work.resolve()
    source = work / "source"
    train_log = work / "checkpoint" / "train_log"
    checkpoint = train_log / "flownet.pkl"
    suffix = "-web-lite" if args.web_lite else ""
    output = work / f"rife-4.25-lite{suffix}-384x640-opset18.onnx"
    if sha256(checkpoint) != CHECKPOINT_SHA256:
        raise RuntimeError("checkpoint 4.25 Lite inesperado")

    sys.path[:0] = [str(source), str(work / "checkpoint")]
    from train_log.IFNet_HDv3 import IFNet

    class Midpoint(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.net = IFNet().eval()

        def forward(self, frames):
            _, _, merged = self.net(
                frames, timestep=0.5, scale_list=SCALES,
                training=False, fastmode=True, ensemble=False,
            )
            return merged[-1]

    torch.manual_seed(425)
    torch.set_grad_enabled(False)
    model = Midpoint()
    raw = torch.load(checkpoint, map_location="cpu", weights_only=True)
    state = {
        key.removeprefix("module."): value
        for key, value in raw.items()
        if key.startswith("module.")
        and not key.startswith(("module.teacher.", "module.caltime."))
    }
    incompatible = model.net.load_state_dict(state, strict=False)
    if incompatible.missing_keys or incompatible.unexpected_keys:
        raise RuntimeError(f"checkpoint incompatível: {incompatible}")

    frames = torch.rand(1, 6, HEIGHT, WIDTH, dtype=torch.float32)
    reference = model(frames).numpy()
    pruning_delta = np.zeros(1, dtype=np.float32)
    if args.web_lite:
        prune_final_features(model)
        pruned = model(frames).numpy()
        pruning_delta = np.abs(reference - pruned)
        if pruning_delta.max() != 0:
            raise RuntimeError(f"poda alterou a saída: max={pruning_delta.max()}")
        reference = pruned
    torch.onnx.export(
        model, (frames,), output, export_params=True, opset_version=18,
        do_constant_folding=True, input_names=["input"], output_names=["output"],
        dynamo=False,
    )
    graph = onnx.load(output)
    removed = deduplicate_constants(graph.graph)
    onnx.save(graph, output)
    onnx.checker.check_model(onnx.load(output))

    session = ort.InferenceSession(str(output), providers=["CPUExecutionProvider"])
    actual = session.run(["output"], {"input": frames.numpy()})[0]
    delta = np.abs(reference - actual)
    mse = float(np.mean((reference - actual) ** 2))
    result = {
        "source_commit": SOURCE_COMMIT,
        "checkpoint_sha256": sha256(checkpoint),
        "onnx_sha256": sha256(output),
        "onnx_bytes": output.stat().st_size,
        "input_shape": [1, 6, HEIGHT, WIDTH],
        "output_shape": list(actual.shape),
        "opset": 18,
        "scales": SCALES,
        "web_lite": args.web_lite,
        "pruning_max_abs_error": float(pruning_delta.max()),
        "constants_removed": removed,
        "mean_abs_error": float(delta.mean()),
        "p99_abs_error": float(np.quantile(delta, 0.99)),
        "max_abs_error": float(delta.max()),
        "psnr_db": float(-10 * np.log10(mse)),
    }
    if result["mean_abs_error"] > 1e-3 or result["psnr_db"] < 60:
        raise RuntimeError(f"paridade insuficiente: {result}")
    validation = work / ("validation-web-lite.json" if args.web_lite else "validation.json")
    validation.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
