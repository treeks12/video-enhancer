"""Fail-closed edition boundaries, reproducibility and source preservation."""
from pathlib import Path
import importlib.util, tempfile, subprocess, json, hashlib
from unittest import mock
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('packager',ROOT/'tools/package.py');p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
counts=[]
for browser in ['firefox','chromium']:
 for flavor in ['store','personal','unified']:
  entries=p.entries_for(browser,flavor);manifest=json.loads(entries['manifest.json'])
  with tempfile.TemporaryDirectory() as directory:
   d=Path(directory)
   for n,v in entries.items():(d/n).parent.mkdir(parents=True,exist_ok=True);(d/n).write_bytes(v)
   for n in entries:
    if n.endswith('.js'):subprocess.run(['node','--check',str(d/n)],check=True)
   source=entries['content.js'].decode();a=source.index('const DEFAULT_SETTINGS');b=source.index('// Shaders',a)
   script=entries['build-flavor.js'].decode()+'\n'+source[a:b]+'''\nconst assert=require('node:assert/strict');
     assert.equal(normalizeSettings({fiEngine:'classic'}).fiEngine,'classic');
     assert.equal(normalizeSettings({fiEngine:'invalid'}).fiEngine,'ifrnet');
     assert.equal(normalizeSettings({fiEngine:'ifrnet'}).fiEngine,'ifrnet');
     assert.equal(normalizeSettings({fiEngine:'neural'}).fiEngine,VE_BUILD.personal?'neural':'ifrnet');
   '''
   subprocess.run(['node','-e',script],check=True)
   p.write_zip(d/'one.zip',entries);p.write_zip(d/'two.zip',entries);assert (d/'one.zip').read_bytes()==(d/'two.zip').read_bytes()
  if flavor in ('personal','unified'):
   for n in ['fi-neural-runtime.js','neural-model.js','fi-neural.js','neural/runtime.js','neural/graph.js','neural/background.js']:
    assert entries[n]==(ROOT/n).read_bytes(),'Optional runtime modified by builder: '+n
  else:
   for group in manifest['content_scripts']:
    for script in group['js']:
     assert not any(t in entries[script] for t in [b'FiNeural.',b'cdn.jsdelivr.net',b'raw.githubusercontent.com'])
   assert 'background'not in manifest and 'options_ui'not in manifest and 'optional_host_permissions'not in manifest
   assert entries['models/ifrnet.bin']==(ROOT/'models/ifrnet.bin').read_bytes()
   assert 'neural/background.js' not in entries and not any(n.startswith('third_party/framegen/') for n in entries)
   assert b'value="neural"'not in entries['popup.html'] and b'value="ifrnet"' in entries['popup.html']
  if flavor=='unified':
   assert entries['models/rt_v7s.bin']==(ROOT/'models/rt_v7s.bin').read_bytes()
   assert entries['models/rt_v7s.json']==(ROOT/'models/rt_v7s.json').read_bytes()
   assert entries['third_party/framegen/WEIGHTS_LICENSE.md']==(ROOT/'third_party/framegen/WEIGHTS_LICENSE.md').read_bytes()
   assert 'optional_host_permissions' not in manifest
   assert b'value="neural"' in entries['popup.html']
   assert b'install AI weights' not in entries['popup.html']
   assert b'no model installation is required' in entries['models.html']
   for n in entries:
    if n.startswith('_locales/') and n.endswith('/messages.json'):
     assert json.loads(entries[n])['extensionName']==json.loads((ROOT/n).read_bytes())['extensionName']
  counts.append({'browser':browser,'edition':flavor,'files':len(entries),'result':'PASS'})
for invalid in ['/* PERSONAL_ONLY_END */','/* PERSONAL_ONLY_BEGIN */','<!-- PERSONAL_ONLY_BEGIN --><!-- PERSONAL_ONLY_BEGIN --><!-- PERSONAL_ONLY_END -->']:
 try:p.strip_personal(invalid);raise AssertionError('Malformed marker accepted')
 except ValueError:pass
read_bytes=Path.read_bytes
def windows_model_spec(path):
 data=read_bytes(path)
 return data.replace(b'\r\n',b'\n').replace(b'\n',b'\r\n') if path==ROOT/'neural/model-spec.js' else data
with mock.patch.object(Path,'read_bytes',windows_model_spec):
 assert b'cdn.jsdelivr' not in p.entries_for('firefox','store')['neural/model-spec.js']
print(json.dumps({'result':'PASS','cases':counts,'checks':['exact allowlist','no framegen runtime, installer or download permissions in store; IFRNet-S bundled','untrusted stored engine names normalize','runtimes preserved in personal','all shipped JavaScript syntax','byte-reproducible ZIPs','malformed markers fail closed','Windows source-archive line endings']},indent=2))

