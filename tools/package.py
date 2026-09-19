"""Build deterministic, unsigned development packages. Python standard library only."""
from pathlib import Path
import argparse, hashlib, json, re, zipfile
ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ['content.js','fi-quality.js','fi-core.js','fi-webgpu.js','fi-neural-runtime.js','neural-model.js','fi-neural.js','popup.html','popup.js','models.html','models.js','models.css','THIRD_PARTY_NOTICES.txt']

def build(output: Path):
    output.mkdir(parents=True, exist_ok=True)
    manifests = {k: json.loads((ROOT/v).read_text()) for k,v in [('firefox','manifest.json'),('chromium','manifest.chromium.json')]}
    version = manifests['firefox']['version']
    if not re.fullmatch(r'\d+(?:\.\d+){0,3}', version) or version != manifests['chromium']['version']:
        raise ValueError('Manifest versions differ or are invalid')
    paths = [ROOT/f for f in RUNTIME]
    for folder in ['_locales','icons','third_party']:
        paths += sorted(p for p in (ROOT/folder).rglob('*') if p.is_file())
    model_files = [ROOT/'models/rt_v7s.json',ROOT/'models/rt_v7s.bin']
    if any(p.exists() for p in model_files):
        if not all(p.exists() for p in model_files): raise ValueError('Offline model is incomplete')
        paths += model_files
    if (ROOT/'third_party/ravu-lite/ravu-lite-lut3.bin').stat().st_size != 59904:
        raise ValueError('RAVU LUT size mismatch')
    for p in paths:
        if not p.is_file(): raise FileNotFoundError(p)
    results=[]
    for browser,manifest in manifests.items():
        if not model_files[0].exists():
            # Avoid dangling web-accessible resources in no-weights packages.
            manifest['web_accessible_resources'][0]['resources'] = [r for r in manifest['web_accessible_resources'][0]['resources'] if not r.startswith('models/')]
        name=f'video-enhancer-{browser}-{version}.zip'; target=output/name
        with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
            entries=[('manifest.json',(json.dumps(manifest,indent=2)+'\n').encode())]+[(str(p.relative_to(ROOT)).replace('\\','/'),p.read_bytes()) for p in paths]
            for entry,data in sorted(entries):
                info=zipfile.ZipInfo(entry,date_time=(2026,9,19,0,0,0)); info.compress_type=zipfile.ZIP_DEFLATED; info.external_attr=0o644<<16
                z.writestr(info,data)
        with zipfile.ZipFile(target) as z:
            assert z.testzip() is None
            for script in manifest['content_scripts'][0]['js']: assert script in z.namelist()
            assert not any(p.startswith('test/') or p.startswith('.git/') for p in z.namelist())
        row={'file':name,'bytes':target.stat().st_size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'modelBundled':model_files[0].exists()}
        results.append(row); print(json.dumps(row))
    (output/'build-manifest.json').write_text(json.dumps(results,indent=2)+'\n')
    return results

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--output',type=Path,default=ROOT/'dist');args=ap.parse_args();build(args.output)
