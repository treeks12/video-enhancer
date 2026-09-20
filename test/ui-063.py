"""Test each actual packaged popup with mock extension APIs. Metrics are fixtures."""
import re,json,zipfile
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];out=ROOT/'test/results063';out.mkdir(exist_ok=True)
results=[]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 for edition in ['store','personal']:
  z=zipfile.ZipFile(ROOT/f'dist/video-enhancer-0.0.63-{edition}-chromium.zip')
  page=browser.new_page(viewport={'width':420,'height':900});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content(re.sub(r'<script[^>]*>.*?</script>','',z.read('popup.html').decode(),flags=re.S))
  page.evaluate('''()=>{
    window.events=[];window.allowed=false;
    window.mockState={status:'ok',visible:true,hasVideo:true,pipeline:'RAVU + Analytic (fixture)',settings:{mode:'ravu',strength:35,quality:'high',interaction:'smooth',fiInfra:true,fiEngine:'analytic',fiProfile:'balanced',fiDebug:0},metrics:{videoFps:30,fps:30,midFps:0,renderScale:1},fi:{backend:'Analytic Flow (WebGL2; no neural weights)',actualEngine:'analytic',hasPair:true,explain:'UI test fixture, not a hardware measurement',computeMs:0,midPerSec:0,analytic:{completed:0,late:0,p95:0,coverage:0},sample:'320 × 180 dense flow'}};
    window.chrome={runtime:{getManifest:()=>({version:'0.0.63'}),openOptionsPage:async()=>events.push('modelSetup'),sendMessage:async m=>{events.push(m);return {ok:true};}},permissions:{request:async()=>allowed},tabs:{query:async()=>[{id:1}],sendMessage:async(id,m)=>{if(m.settings)Object.assign(mockState.settings,m.settings);return structuredClone(mockState);},reload:async()=>{}},storage:{local:{set:async m=>events.push(m),get:async()=>({})}}};
  }''')
  for name in ['build-flavor.js','popup.js']:page.add_script_tag(content=z.read(name).decode())
  page.wait_for_timeout(50)
  assert page.locator('#fiEngine').input_value()=='analytic'
  assert edition.capitalize() in page.locator('#version').inner_text()
  page.select_option('#fiProfile','quality');assert page.evaluate('mockState.settings.fiProfile')=='quality'
  assert page.locator('#fiHalfLuma').is_disabled()
  if edition=='store':
   assert page.locator('#fiEngine option').count()==2
   assert page.locator('#modelSetup').count()==0 and page.locator('#ifrSetup').count()==0
  else:
   assert page.locator('#fiEngine option').count()==4
   # Install/remove moved to models.html; the popup only warns about missing weights.
   assert page.locator('#ifrDownload').count()==0 and page.locator('#ifrImport').count()==0
   page.click('#modelSetup');assert 'modelSetup'in page.evaluate('events')
   warn=page.locator('#modelWarn');page.wait_for_timeout(150)
   page.select_option('#fiEngine','ifrnet');page.wait_for_timeout(60)
   assert warn.is_visible() and 'not installed' in warn.inner_text().lower()
   page.evaluate("chrome.runtime.sendMessage=async m=>({ok:true,installed:true})")
   page.select_option('#fiEngine','analytic');page.select_option('#fiEngine','ifrnet');page.wait_for_timeout(60)
   assert warn.is_hidden()
   page.select_option('#fiEngine','neural');page.wait_for_timeout(60)
   assert warn.is_visible() and 'not installed' in warn.inner_text().lower()
   page.evaluate("chrome.storage.local.get=async()=>({fvNeuralModelV1:{id:'framegen-1.4.0-v7-small'}})")
   page.select_option('#fiEngine','analytic');page.select_option('#fiEngine','neural');page.wait_for_timeout(60)
   assert warn.is_hidden()
   page.select_option('#fiEngine','ifrnet');assert page.evaluate('mockState.settings.fiEngine')=='ifrnet'
   page.select_option('#fiEngine','neural');assert page.evaluate('mockState.settings.fiEngine')=='neural'
   page.select_option('#fiEngine','analytic')
  with page.expect_download() as event:page.click('#saveDiagnostics')
  file=event.value;file.save_as(out/(edition+'-ui-fixture-diagnostics.json'));diag=json.loads((out/(edition+'-ui-fixture-diagnostics.json')).read_text());assert diag['edition']==edition
  assert page.evaluate('document.documentElement.scrollWidth')<=420
  page.screenshot(path=str(out/(edition+'-popup.png')),full_page=True)
  page.evaluate("mockState.fi={backend:'unavailable',backendError:'Deliberate test failure'};render(mockState)")
  assert page.locator('#fiStatusTitle').inner_text()=='Motion backend unavailable'
  assert not errors,errors
  results.append({'edition':edition,'result':'PASS','browser':browser.version});page.close()
 browser.close()
print(json.dumps({'results':results,'note':'Packaged UI only, extension APIs mocked. No browser WebGL/WebGPU context available. Screenshot metrics are fixtures, not performance results.'},indent=2))
