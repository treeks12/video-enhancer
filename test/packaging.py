"""Fail-closed edition boundaries, reproducibility and source preservation."""
from pathlib import Path
import importlib.util, tempfile, subprocess, json, hashlib
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('packager',ROOT/'tools/package.py');p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
counts=[]
for browser in ['firefox','chromium']:
 for flavor in ['store','personal']:
  entries=p.entries_for(browser,flavor);manifest=json.loads(entries['manifest.json'])
  with tempfile.TemporaryDirectory() as directory:
   d=Path(directory)
   for n,v in entries.items():(d/n).parent.mkdir(parents=True,exist_ok=True);(d/n).write_bytes(v)
   for n in entries:
    if n.endswith('.js'):subprocess.run(['node','--check',str(d/n)],check=True)
   source=entries['content.js'].decode();a=source.index('const DEFAULT_SETTINGS');b=source.index('// --------------------------------------------------------------------------\n// Shaders',a)
   script=entries['build-flavor.js'].decode()+'\n'+source[a:b]+'''\nconst assert=require('node:assert/strict');
     assert.equal(normalizeSettings({fiEngine:'classic'}).fiEngine,'classic');
     assert.equal(normalizeSettings({fiEngine:'invalid'}).fiEngine,'analytic');
     for(const k of ['neural','ifrnet'])assert.equal(normalizeSettings({fiEngine:k}).fiEngine,VE_BUILD.personal?k:'analytic');
   '''
   subprocess.run(['node','-e',script],check=True)
   p.write_zip(d/'one.zip',entries);p.write_zip(d/'two.zip',entries);assert (d/'one.zip').read_bytes()==(d/'two.zip').read_bytes()
  if flavor=='personal':
   for n in ['fi-neural-runtime.js','neural-model.js','fi-neural.js','neural/runtime.js','neural/graph.js','neural/background.js']:
    assert entries[n]==(ROOT/n).read_bytes(),'Optional runtime modified by builder: '+n
  else:
   for script in manifest['content_scripts'][0]['js']:
    assert not any(t in entries[script] for t in [b'FiNeural.',b'VENeural',b'cdn.jsdelivr.net',b'raw.githubusercontent.com'])
   assert 'background'not in manifest and 'options_ui'not in manifest and 'optional_host_permissions'not in manifest
   assert b'value="neural"'not in entries['popup.html'] and b'value="ifrnet"'not in entries['popup.html']
  counts.append({'browser':browser,'edition':flavor,'files':len(entries),'result':'PASS'})
for invalid in ['/* PERSONAL_ONLY_END */','/* PERSONAL_ONLY_BEGIN */','<!-- PERSONAL_ONLY_BEGIN --><!-- PERSONAL_ONLY_BEGIN --><!-- PERSONAL_ONLY_END -->']:
 try:p.strip_personal(invalid);raise AssertionError('Malformed marker accepted')
 except ValueError:pass
print(json.dumps({'result':'PASS','cases':counts,'checks':['exact allowlist','no model files or download permissions in store','untrusted stored engine names normalize','runtimes preserved in personal','all shipped JavaScript syntax','byte-reproducible ZIPs','malformed markers fail closed']},indent=2))
