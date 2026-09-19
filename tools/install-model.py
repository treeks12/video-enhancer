"""Download only pinned model data for an offline build. Never downloads code.
Requires Python 3 and Node.js. Explicit noncommercial-license acknowledgement.
"""
from pathlib import Path
import argparse, hashlib, json, subprocess, tempfile, urllib.request
ROOT=Path(__file__).resolve().parents[1]
BASE='https://cdn.jsdelivr.net/npm/framegen@1.4.0/weights/'

def download(name, limit):
    request=urllib.request.Request(BASE+name,headers={'User-Agent':'VideoEnhancer-ModelInstaller/0.0.63'})
    with urllib.request.urlopen(request,timeout=60) as r:
        if r.geturl()!=BASE+name: raise RuntimeError('Unexpected model redirect')
        data=r.read(limit+1)
        if len(data)>limit: raise RuntimeError(name+' exceeds the byte limit')
        return data

if __name__=='__main__':
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--accept-noncommercial-license',action='store_true');args=ap.parse_args()
    if not args.accept_noncommercial_license: ap.error('Read third_party/framegen/WEIGHTS_LICENSE.md and acknowledge with --accept-noncommercial-license')
    raw=download('rt_v7s.json',128*1024); binary=download('rt_v7s.bin',8*1024*1024);json.loads(raw)
    # Validate using exactly the extension's architecture validator before install.
    with tempfile.TemporaryDirectory() as tmp:
        p=Path(tmp);(p/'model.json').write_bytes(raw);(p/'model.bin').write_bytes(binary)
        code="const fs=require('fs'),R=require(process.argv[1]);const b=fs.readFileSync(process.argv[3]);console.log(R.validateModel(JSON.parse(fs.readFileSync(process.argv[2])),b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),{production:true}));"
        subprocess.run(['node','-e',code,str(ROOT/'fi-neural-runtime.js'),str(p/'model.json'),str(p/'model.bin')],check=True)
    output=ROOT/'models';output.mkdir(exist_ok=True)
    (output/'rt_v7s.json').write_bytes(raw);(output/'rt_v7s.bin').write_bytes(binary)
    print('Installed model data. SHA-256 (local integrity, not publisher signature): '+hashlib.sha256(binary).hexdigest())
    print('Run python tools/package.py to create offline packages. Do not build concurrently with this installer.')
