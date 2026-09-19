from playwright.sync_api import sync_playwright
from pathlib import Path
import re,json
root=Path(__file__).resolve().parents[1]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=__import__('os').environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':420,'height':850},device_scale_factor=1)
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 html=(root/'popup.html').read_text(); html=re.sub(r'<script[^>]*>.*?</script>','',html,flags=re.S)
 page.set_content(html)
 page.evaluate('''() => {
 window.events=[]; window.mockState={status:'ok',visible:true,hasVideo:true,pipeline:'RAVU · FI neural',canvasWidth:1920,canvasHeight:1080,settings:{mode:'ravu',strength:35,quality:'high',interaction:'smooth',fiInfra:true,fiEngine:'neural',fiProfile:'balanced',fiDebug:0},metrics:{videoFps:30,fps:30,midFps:28,cpuMs:2,renderScale:1},fi:{backend:'WebGPU compact neural',actualEngine:'neural',presentationDelayMs:33.3,computeMs:11.2,confidence:null,hasPair:true,midPerSec:28,realPerSec:30,neural:{p95:13.2,completed:100,late:2,modelSize:{width:640,height:352}}}};
 window.chrome={runtime:{getManifest:()=>({version:'0.0.62'}),openOptionsPage:async()=>events.push('modelSetup')},tabs:{query:async()=>[{id:1}],sendMessage:async(id,msg)=>{if(msg.settings)Object.assign(mockState.settings,msg.settings);return structuredClone(mockState);},reload:async()=>{}},storage:{local:{set:async v=>events.push(v)}}};
 }''')
 page.add_script_tag(content=(root/'popup.js').read_text())
 page.wait_for_timeout(50)
 assert page.locator('#fiEngine').input_value()=='neural'
 assert page.locator('#fiConfidence').text_content()=='—'
 page.select_option('#fiProfile','quality')
 assert page.evaluate('mockState.settings.fiProfile')=='quality'
 page.click('#modelSetup')
 assert 'modelSetup' in page.evaluate('events')
 page.screenshot(path=str(root/'release-evidence/popup.png'),full_page=True)
 page.evaluate("mockState.fi.fallbackReason='Model not installed. Open Model setup.'; render(mockState)")
 assert page.locator('#fiStatusTitle').inner_text()=='Neural fallback: classical engine'
 page.locator('#advanced').evaluate('(e)=>e.open=true')
 page.screenshot(path=str(root/'release-evidence/popup-fallback.png'),full_page=True)
 assert page.evaluate('document.documentElement.scrollWidth') <=420
 assert not errors,errors
 print(json.dumps({'ui':'PASS','tested':['popup render','profile change','model setup action','neural confidence not fabricated','fallback explanation','no horizontal overflow'],'browser':browser.version,'gpuAvailable':False,'note':'Synthetic state for UI only. Screenshot metrics are fixtures, not measured performance.'},indent=2))
 browser.close()
