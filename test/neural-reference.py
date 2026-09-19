"""Independent PyTorch CPU reference for the shipped compact graph.

Uses deterministic UNTRAINED test weights. Never a visual-quality benchmark.
Produces gold fixtures consumed by neural-conformance.html on actual WebGPU.
"""
import json
from pathlib import Path
import numpy as np
import torch
import torch.nn.functional as F

torch.set_num_threads(1)
ROOT = Path(__file__).parent / 'fixtures'
manifest = json.loads((ROOT/'model.json').read_text())
raw = np.fromfile(ROOT/'model.bin', dtype='<f4')
params = {k: torch.tensor(raw[v['offset']:v['offset']+int(np.prod(v['shape']))].reshape(v['shape'])) for k,v in manifest.items()}
MW = MH = 32
SW, SH = 64, 48

def grid(w, h):
    y, x = torch.meshgrid(torch.arange(h), torch.arange(w), indexing='ij')
    return torch.stack(((x+.5)/w, (y+.5)/h), -1)[None].float()

def sample(image, uv):
    return F.grid_sample(image, uv*2-1, mode='bilinear', padding_mode='border', align_corners=False)

def run(a, b, t, half=False):
    cast = lambda x: x.half().float() if half else x
    def conv(x, base, stride=1, skip=None):
        y = F.conv2d(x, cast(params[base+'.0.weight']), params[base+'.0.bias'], stride=stride, padding=1)
        y = F.prelu(y, params[base+'.1.weight'])
        if skip is not None: y = y+skip
        return cast(y)
    uv = grid(MW//4, MH//4)
    x = cast(torch.cat([sample(a,uv)[:,[2,1,0]], sample(b,uv)[:,[2,1,0]]],1))
    x = conv(x,'block0.conv0.0',2)
    skip = conv(x,'block0.conv0.1',2)
    x = skip
    for i in range(6): x = conv(x,f'block0.convblock.{i}')
    affine = F.linear(F.relu(F.linear(torch.tensor([[t]]),params['film.0.weight'],params['film.0.bias'])),params['film.2.weight'],params['film.2.bias']).flatten()
    c = x.shape[1]
    x = cast(x*(1+affine[:c][None,:,None,None])+affine[c:][None,:,None,None])
    x = conv(x,'block0.convblock.6')
    x = conv(x,'block0.convblock.7',skip=skip)
    d = F.conv_transpose2d(x,cast(params['block0.lastconv.weight']),params['block0.lastconv.bias'],stride=2,padding=1).half().float()
    # The intermediate textures are rgba16float even on the FP32 activation path.
    flow, mask = d[:,:4], d[:,4:5]
    rin = torch.zeros((1,11,MH//4,MW//4))
    y,x = torch.meshgrid(torch.arange(MH//4),torch.arange(MW//4),indexing='ij')
    scale = torch.tensor([MW,MH])[None,None,None,:]
    for dy in [1,2]:
        for dx in [1,2]:
            uv = torch.stack(((x*4+dx+.5)/MW,(y*4+dy+.5)/MH),-1)[None].float()
            ff = sample(flow,uv)*8
            wa = sample(a,uv+ff[:,:2].permute(0,2,3,1)/scale)[:,[2,1,0]]
            wb = sample(b,uv+ff[:,2:].permute(0,2,3,1)/scale)[:,[2,1,0]]
            rin[:,:3] += wa*.25; rin[:,3:6] += wb*.25
            rin[:,6:7] += torch.sigmoid(sample(mask,uv))*.25
            rin[:,7:] += ff*(.25*.25/20)
    x = cast(rin)
    for i in range(3):
        x = cast(F.prelu(F.conv2d(x,cast(params[f'refine.c{i}.weight']),params[f'refine.c{i}.bias'],padding=1),params[f'refine.a{i}.weight']))
    residual = (torch.sigmoid(F.conv2d(F.pad(x,(1,1,1,1),mode='replicate'),params['refine.c3.weight'],params['refine.c3.bias']))*2-1).half().float()
    uv = grid(SW,SH); ff = sample(flow,uv)*8
    wa = sample(a,uv+ff[:,:2].permute(0,2,3,1)/scale)[:,[2,1,0]]
    wb = sample(b,uv+ff[:,2:].permute(0,2,3,1)/scale)[:,[2,1,0]]
    mk = torch.sigmoid(sample(mask,uv))
    out = torch.clamp(wa*mk+wb*(1-mk)+sample(residual,uv),0,1)[:,[2,1,0]]
    if t == 0: out=a
    if t == 1: out=b
    assert torch.isfinite(out).all()
    rgba = torch.cat([out,torch.ones((1,1,SH,SW))],1)[0].permute(1,2,0)
    return np.rint(rgba.numpy()*255).astype(np.uint8)

# Asymmetric RGB pattern catches orientation and RGB/BGR channel mistakes.
y,x = np.mgrid[:SH,:SW]
a = np.stack([(x*4)%256,(y*5)%256,((x+y)*3)%256,np.full_like(x,255)],-1).astype(np.uint8)
b = np.roll(a,5,axis=1).copy(); b[:15,10:30,:3]=[220,30,60]
(ROOT/'input-a.rgba').write_bytes(a.tobytes()); (ROOT/'input-b.rgba').write_bytes(b.tobytes())
ta=torch.from_numpy(a[:,:,:3].copy()).permute(2,0,1)[None].float()/255
tb=torch.from_numpy(b[:,:,:3].copy()).permute(2,0,1)[None].float()/255
cases=[]
for half in [False,True]:
    for t in [0.,.25,.5,.75,1.]:
        out=run(ta,tb,t,half); name=f"gold-{'f16' if half else 'f32'}-{int(t*100):02d}.rgba"
        (ROOT/name).write_bytes(out.tobytes())
        cases.append({'half':half,'t':t,'file':name,'finite':True})
        if t == 0: assert np.array_equal(out,a)
        if t == 1: assert np.array_equal(out,b)
(ROOT/'reference.json').write_text(json.dumps({'kind':'untrained mathematical fixture, not quality evidence','torch':torch.__version__,'modelWidth':MW,'modelHeight':MH,'sourceWidth':SW,'sourceHeight':SH,'cases':cases},indent=2))
print('PASS: independent CPU graph, 10 FP32/FP16-emulated phase fixtures, finite output, exact asymmetric endpoints')
