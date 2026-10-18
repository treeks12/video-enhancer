// Autonomous, serial native-browser matrix. No changes to installed add-ons.
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const cp=require('node:child_process'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function csvCell(value){let s=String(value??'');if(/^[\s]*[=+@-]|^[\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
function cleanEnvironment(parent={},caseEnv={},commonEnv={}){
 const env={...parent};
 const exact=new Set(['HEADLESS','WARM_MS','STEADY_MS','SPATIAL_MODE','PLAYBACK_RATE','LOAD_PATTERN','BASELINE_REF','TEST_BROWSER','BENCH_RESULT_FILE','BENCH_CASE_ID','BENCH_SOURCE_HASH','BENCH_RUN_ID','NODE_OPTIONS']);
 for(const key of Object.keys(env))if(exact.has(key.toUpperCase())||/^(FI_|SOURCE_|IFRNET_|BUDGET_|CALLBACK_|NEURAL_|ADDON_)/i.test(key))delete env[key];
 return {...env,...commonEnv,...caseEnv};
}
function parseJsonObjects(text){
 const out=[];let start=-1,depth=0,quoted=false,escaped=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];if(start<0){if(c==='{'){start=i;depth=1;quoted=escaped=false;}continue;}
  if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
  if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){try{out.push(JSON.parse(text.slice(start,i+1)));}catch{}start=-1;}
 }
 return out;
}
function classifyAttempt(a){
 if(a.timedOut)return 'timeout';
 if(a.cleanupOk===false)return 'failed';
 const r=a.report;
 if(!r||r.schemaVersion!==1||!r.config||typeof r.config!=='object'||!['passed','failed'].includes(r.status)||(!r.result&&!Array.isArray(r.failures)))return 'invalid-report';
 const messages=stable(r.failures||[])+'\n'+(a.stderr||'');
 if(/No WebGPU adapter is available|Native WebGPU adapter unavailable|WebGPU unavailable|ENOENT|Browser was not found/i.test(messages))return 'unavailable';
 return a.exitCode===0&&r.status==='passed'?'passed':'failed';
}
function buildPlan({preset='standard',browsers=['firefox','chromium'],repetitions=1,seed=20261017}={}){
 if(!['smoke','standard','full'].includes(preset)||!Number.isInteger(repetitions)||repetitions<1||repetitions>10)throw Error('Invalid matrix preset/repetitions');
 const cases=[];
 const add=(kind,scenario,script,env={},extra={})=>{
  const n=kind==='playback'?repetitions:1;
  for(let repetition=1;repetition<=n;repetition++){
   const identity={kind,scenario,script,env,repetition};
   cases.push({...identity,id:kind+'-'+hash(stable(identity)).slice(0,14),synthetic:false,timeoutMs:kind==='playback'?150000:kind==='addon'?180000:300000,...extra});
  }
 };
 add('logic','unit','test/run.cjs');add('packaging','packages','test/packaging.py');
 const sizes=preset==='full'?['640x360','1280x720','1920x1080']:['1280x720'];
 const fps=preset==='smoke'?[30,60]:[24,30,60];
 const profiles=preset==='smoke'?['quality']:['balanced','quality'];
 for(const browser of browsers){
  for(const sourceSize of sizes)for(const sourceFps of fps){
   const base={TEST_BROWSER:browser,SOURCE_SIZE:sourceSize,SOURCE_FPS:String(sourceFps),PLAYBACK_RATE:'1',SPATIAL_MODE:'ravu',FI_PROFILE:'quality',FI_ENABLED:'1',SOURCE_PATTERN:'motion'};
   for(const profile of profiles)add('playback','neural','test/neural-browser.cjs',{...base,FI_PROFILE:profile});
   add('playback','spatial-baseline','test/neural-browser.cjs',{...base,FI_ENABLED:'0'});
  }
  if(preset!=='smoke'){
   const base={TEST_BROWSER:browser,SOURCE_SIZE:'1280x720',SOURCE_FPS:'60',PLAYBACK_RATE:'1',SPATIAL_MODE:'ravu',FI_PROFILE:'quality',FI_ENABLED:'1',SOURCE_PATTERN:'motion'};
   for(const sourceFps of [30,60])for(const mode of ['native','fsr'])add('playback','spatial-mode','test/neural-browser.cjs',{...base,SOURCE_FPS:String(sourceFps),SPATIAL_MODE:mode});
   for(const sourceFps of [24,30,60])add('playback','webgl-reference','test/neural-browser.cjs',{...base,SOURCE_FPS:String(sourceFps),FI_API:'webgl2'});
   for(const sourceFps of preset==='full'?[24,30]:[30])for(const rate of [.75,4/3,1.5])add('playback','playback-rate','test/neural-browser.cjs',{...base,SOURCE_FPS:String(sourceFps),PLAYBACK_RATE:String(rate)});
   for(const sourceFps of preset==='full'?[24,30]:[24])add('playback','callback-jitter','test/neural-browser.cjs',{...base,SOURCE_FPS:String(sourceFps),CALLBACK_JITTER_MS:'20'},{synthetic:true});
   if(preset==='full'){
    for(const sourceFps of [30,60]){
     add('playback','canvas-interop','test/neural-browser.cjs',{...base,SOURCE_FPS:String(sourceFps),FI_CANVAS_COPY:'1'});
     add('playback','main-thread-load','test/neural-browser.cjs',{...base,SOURCE_FPS:String(sourceFps),LOAD_PATTERN:'periodic-main-thread'},{synthetic:true});
    }
    for(const pattern of ['static','pan','scene-cut'])add('playback','content-pattern','test/neural-browser.cjs',{...base,SOURCE_FPS:'30',SOURCE_PATTERN:pattern});
   }
  }
  add('layout','fits-and-fullscreen','test/video-layout-browser.cjs',{TEST_BROWSER:browser});
  add('layout','feed-visibility','test/feed-selection-browser.cjs',{TEST_BROWSER:browser});
  add('addon','real-package-feed','test/neural-addon.cjs',{TEST_BROWSER:browser,ADDON_FEED:'1'});
  if(preset!=='smoke'){
   add('addon','real-package-steady','test/neural-addon.cjs',{TEST_BROWSER:browser,ADDON_FEED:'0'});
   add('addon','real-package-paused-start','test/neural-addon.cjs',
    {TEST_BROWSER:browser,ADDON_PAUSED_START:'1',ADDON_INIT_PHASED:'1'});
   for(const interaction of ['quality','smooth'])add('addon','real-package-mixed-feed','test/neural-addon.cjs',
    {TEST_BROWSER:browser,ADDON_MIXED_FEED:'1',ADDON_INIT_PHASED:'1',ADDON_FI_PROFILE:'quality',ADDON_INTERACTION:interaction});
  }
  if(preset==='full')for(const script of ['test/ifrnet-webgpu-conformance.cjs','test/ifrnet-webgpu-integration.cjs','test/webgpu-compositor-conformance.cjs'])add('numerical',path.basename(script,'.cjs'),script,{TEST_BROWSER:browser});
 }
 // Reproducible ordering interleaves browser/configuration and time-of-run effects.
 let state=seed>>>0;const random=()=>{state=(Math.imul(1664525,state)+1013904223)>>>0;return state/4294967296;};
 const gpu=cases.filter(c=>!['logic','packaging'].includes(c.kind));
 for(let i=gpu.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[gpu[i],gpu[j]]=[gpu[j],gpu[i]];}
 const plan=[...cases.filter(c=>['logic','packaging'].includes(c.kind)),...gpu];
 if(preset==='full')for(let repetition=repetitions+1;repetition<=repetitions+2;repetition++)for(const browser of browsers){
  const anchor=cases.find(c=>c.kind==='playback'&&c.scenario==='neural'&&c.env.TEST_BROWSER===browser&&c.env.SOURCE_FPS==='60'&&c.env.SOURCE_SIZE==='1280x720'&&c.env.FI_PROFILE==='quality');
  const identity={...anchor,repetition};delete identity.id;plan.push({...identity,id:'playback-'+hash(stable(identity)).slice(0,14),sentinel:true});
 }
 return plan;
}
function metrics(record){
 const report=record.attempts?.at(-1)?.report,r=report?.result;
 if(!r)return {};
 const maxPhase=object=>{const samples=Object.entries(object||{}).filter(([p,v])=>p!=='device'&&Number.isFinite(v.maxMs)).map(([,v])=>v.maxMs);return samples.length?Math.max(...samples):null;};
 return {source:r.sourceRate,mid:r.midRate,sourceGap:r.maxSourceGapMs,computeP50:r.p50,computeP95:r.p95,
  rafMax:maxPhase(r.responsiveness),queueMax:maxPhase(r.gpuResponsiveness),steadyRaf:r.responsiveness?.steady?.maxMs,
  steadyQueue:r.gpuResponsiveness?.steady?.maxMs,backend:r.fi?.backend,model:r.fi?.neural?.modelSize,
  displayHz:r.fi?.displayHz,report};
}
const median=values=>{const v=values.filter(Number.isFinite).sort((a,b)=>a-b);return v.length?v[Math.floor(v.length/2)]:null;};
function summarize(results){
 const counts={},groupMap=new Map();
 const cases=results.map(entry=>{const c={...entry,env:entry.env||{}};counts[c.status]=(counts[c.status]||0)+1;const m=metrics(c),last=c.attempts?.at(-1);
  const notes=[];if(Number.isFinite(m.source))notes.push(`Submitted anchors ${m.source.toFixed(2)}/s; neural midpoints ${(m.mid||0).toFixed(2)}/s`);
  if(Number.isFinite(m.sourceGap))notes.push(`Largest source submission gap ${m.sourceGap.toFixed(2)} ms`);
  if(last?.report?.failures?.length)notes.push(...last.report.failures.map(f=>f.message));
  if(c.synthetic)notes.push('Synthetic stress; not a reproduction of another GPU or a live site');
  const row={...c,analysis:notes,metrics:{...m,report:undefined}};
  if(c.kind==='playback'&&Number.isFinite(m.source)){
   const key=stable({scenario:c.scenario,browser:c.env.TEST_BROWSER,size:c.env.SOURCE_SIZE,fps:c.env.SOURCE_FPS,rate:c.env.PLAYBACK_RATE,profile:c.env.FI_PROFILE,
    spatial:c.env.SPATIAL_MODE,fi:c.env.FI_ENABLED,api:c.env.FI_API||'auto',capture:c.env.FI_CANVAS_COPY||'direct',pattern:c.env.SOURCE_PATTERN,
    load:c.env.LOAD_PATTERN||'none',jitter:c.env.CALLBACK_JITTER_MS||'0',actualBackend:m.backend,model:m.model,screen:m.report?.environment?.screen,
    adapter:m.report?.environment?.adapterObservations?.find(a=>a.available)?.info||null});
   if(!groupMap.has(key))groupMap.set(key,[]);groupMap.get(key).push(row);
  }return row;
 });
 const groups=[...groupMap].map(([key,rows])=>({config:JSON.parse(key),runs:rows.length,ids:rows.map(r=>r.id),statuses:rows.map(r=>r.status),
  submittedSourceMedian:median(rows.map(r=>r.metrics.source)),submittedMidMedian:median(rows.map(r=>r.metrics.mid)),
  medianOfRunComputeP95:median(rows.map(r=>r.metrics.computeP95)),maxSourceGap:Math.max(...rows.map(r=>r.metrics.sourceGap).filter(Number.isFinite))}));
 return {counts,cases,groups};
}
function atomic(file,value){const temp=file+'.writing';fs.writeFileSync(temp,JSON.stringify(value,null,2));fs.renameSync(temp,file);}
function recoverJournal(file){
 const recovered=new Map();if(!fs.existsSync(file))return [];
 const bytes=fs.readFileSync(file);let offset=0;
 while(offset<bytes.length){const end=bytes.indexOf(10,offset);if(end<0)break;const line=bytes.subarray(offset,end).toString('utf8');if(line){let event;try{event=JSON.parse(line);}catch{throw Error('Corrupt interior benchmark journal at byte '+offset);}if(event.type==='case')recovered.set(event.result.id,event.result);}offset=end+1;}
 if(offset<bytes.length){fs.writeFileSync(file+'.interrupted-tail-'+Date.now(),bytes.subarray(offset));fs.truncateSync(file,offset);}
 return [...recovered.values()];
}
function compactReport(report){
 if(!report?.result)return report;const result={...report.result};
 for(const key of ['timeline','videoCallbacks','refreshTimeline','pipelines','slowCalls','longTasks'])if(Array.isArray(result[key])){result[key+'Count']=result[key].length;delete result[key];}
 return {...report,result};
}
function command(command,args,options={}){const r=cp.spawnSync(command,args,{cwd:root,encoding:'utf8',windowsHide:true,timeout:30000,...options});if(r.error||r.status!==0)throw Error(`${command}: ${r.error?.message||r.stderr||r.stdout}`);return r.stdout.trim();}
function executable(candidates){for(const item of candidates.filter(Boolean))try{if(fs.existsSync(item))return fs.realpathSync(item);const found=command(process.platform==='win32'?'where.exe':'which',[item]).split(/\r?\n/)[0];if(found)return found;}catch{}return null;}
function sourceSnapshot(excludedRoot=null){
 let files;try{files=command('git',['ls-files','--cached','--others','--exclude-standard','-z']).split('\0');}catch{throw Error('Run from a Git checkout so benchmark inputs can be fingerprinted.');}
 const inputs=files.filter(f=>f&&/\.(?:js|cjs|json|bin|wgsl|glsl|html|css|py|ps1)$/.test(f)&&
  (!excludedRoot||!path.resolve(root,f).startsWith(excludedRoot+path.sep))&&fs.existsSync(path.join(root,f))).sort();
 const hashes=inputs.map(file=>({file,sha256:hash(fs.readFileSync(path.join(root,file))),size:fs.statSync(path.join(root,file)).size}));
 return {sha256:hash(stable(hashes)),files:hashes,stats:inputs.map(file=>({file,mtime:fs.statSync(path.join(root,file)).mtimeMs,size:fs.statSync(path.join(root,file)).size}))};
}
function verifySource(snapshot){for(const entry of snapshot.stats){const file=path.join(root,entry.file),stat=fs.statSync(file);if(stat.size!==entry.size||stat.mtimeMs!==entry.mtime)throw Error('Source changed during the matrix: '+entry.file);} }
function discover(options){
 const python=executable([process.env.PYTHON_PATH,'python','python3']),ffmpeg=executable([process.env.FFMPEG_PATH,'ffmpeg']);
 const browserPaths={firefox:executable([process.env.FIREFOX_PATH,'C:/Program Files/Mozilla Firefox/firefox.exe','firefox','/Applications/Firefox.app/Contents/MacOS/firefox']),
  chromium:executable([process.env.CHROMIUM_PATH,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','microsoft-edge','chromium','google-chrome'])};
 if(!python||!ffmpeg)throw Error('Python and FFmpeg must be installed or provided as PYTHON_PATH / FFMPEG_PATH.');
 const dependencyRoots=[root,...(process.env.NODE_PATH||'').split(path.delimiter).filter(Boolean).map(p=>path.dirname(p)),path.join(os.tmpdir(),'video-enhancer-firefox-tests'),path.join(os.tmpdir(),'video-enhancer-benchmark-deps')];
 let puppet;for(const folder of dependencyRoots)try{puppet=require.resolve('puppeteer-core/package.json',{paths:[folder]});break;}catch{}
 if(!puppet&&options.installDeps){
  const cache=path.join(os.tmpdir(),'video-enhancer-benchmark-deps');fs.mkdirSync(cache,{recursive:true});
  const npm=executable(['npm.cmd','npm']);
  const cli=npm&&path.join(path.dirname(npm),'node_modules','npm','bin','npm-cli.js');
  if(!cli||!fs.existsSync(cli))throw Error('Pinned dependency bootstrap requires npm-cli.js beside Node/npm. Install Puppeteer Core in a test cache and provide NODE_PATH.');
  command(process.execPath,[cli,'install','--prefix',cache,'--no-save','--package-lock=false','--ignore-scripts','puppeteer-core@25.14.0'],{timeout:180000});
  puppet=require.resolve('puppeteer-core/package.json',{paths:[cache]});
 }
 if(!puppet)throw Error('Puppeteer Core missing. Run again with --install-deps to install the pinned test dependency in the temporary cache.');
 const dependencyPath=path.dirname(path.dirname(puppet));
 const versions={node:process.version,python:command(python,['--version']),ffmpeg:command(ffmpeg,['-version']).split('\n')[0],puppeteer:JSON.parse(fs.readFileSync(puppet)).version,browsers:{}};
 for(const [kind,file]of Object.entries(browserPaths))if(file){
  if(process.platform==='win32')versions.browsers[kind]=command('powershell.exe',['-NoProfile','-NonInteractive','-Command','(Get-Item -LiteralPath $env:VE_BENCH_EXE).VersionInfo.ProductVersion'],{env:{...process.env,VE_BENCH_EXE:file}});
  else versions.browsers[kind]=command(file,['--version']);
 }
 let hardware={};if(process.platform==='win32')try{hardware=JSON.parse(command('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$gpu=Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate; $cpu=Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors; @{gpu=@($gpu);cpu=@($cpu)} | ConvertTo-Json -Depth 4"]));}catch(error){hardware={unavailable:error.message};}
 return {python,ffmpeg,browserPaths,dependencyPath,versions,hardware,os:{platform:process.platform,release:os.release(),arch:os.arch(),totalMemory:os.totalmem()},headed:!options.headless};
}
function terminateOwned(child,script,program=process.execPath){
 if(!child?.pid)return true;
 if(process.platform==='win32'){
  const check=cp.spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$env:VE_BENCH_PID); if ($null -eq $p) { exit 2 }; if ($p.ExecutablePath -ne $env:VE_BENCH_NODE -or -not $p.CommandLine.Contains($env:VE_BENCH_SCRIPT)) { exit 3 }; exit 0"],{encoding:'utf8',windowsHide:true,timeout:15000,env:{...process.env,VE_BENCH_PID:String(child.pid),VE_BENCH_NODE:program,VE_BENCH_SCRIPT:script}});
  if(check.status!==0)return false;
  return cp.spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:15000}).status===0;
 }
 try{const rows=command('ps',['-eo','pid=,ppid=']).split('\n').map(s=>s.trim().split(/\s+/).map(Number));const ids=[child.pid];for(let i=0;i<ids.length;i++)for(const [pid,parent]of rows)if(parent===ids[i]&&!ids.includes(pid))ids.push(pid);for(const pid of ids.reverse())try{process.kill(pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}return true;}catch{return false;}
}
async function runChild({program,args,env,folder,timeoutMs}){
 fs.mkdirSync(folder,{recursive:true});const startedAt=new Date().toISOString();
 const stdoutFile=path.join(folder,'stdout.log'),stderrFile=path.join(folder,'stderr.log'),out=fs.createWriteStream(stdoutFile),err=fs.createWriteStream(stderrFile);
 const child=cp.spawn(program,args,{cwd:root,env,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',timedOut=false,cleanupOk=true,spawnError;child.stdout.on('data',b=>{out.write(b);stdout+=b;});child.stderr.on('data',b=>{err.write(b);stderr+=b;});
 const timer=setTimeout(()=>{timedOut=true;cleanupOk=terminateOwned(child,args[0],program);if(!cleanupOk)child.kill();},timeoutMs);
 const abort=()=>{cleanupOk=terminateOwned(child,args[0],program);if(!cleanupOk)child.kill();};process.once('SIGINT',abort);process.once('SIGTERM',abort);
 const exitCode=await new Promise(resolve=>{child.once('error',error=>{spawnError=error.message;resolve(-1);});child.once('close',code=>resolve(code??-1));});
 clearTimeout(timer);process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);await Promise.all([new Promise(r=>out.end(r)),new Promise(r=>err.end(r))]);
 return {exitCode,timedOut,cleanupOk,spawnError,startedAt,finishedAt:new Date().toISOString(),stdout,stderr,stdoutFile,stderrFile};
}
async function prepareFixtures(plan,output,environment){
 const fixtures=new Map();fs.mkdirSync(path.join(output,'fixtures'),{recursive:true});
 const indexFile=path.join(output,'fixtures','index.json'),generator=hash(prepareFixtures.toString()+environment.versions.ffmpeg);
 let cache;try{cache=JSON.parse(fs.readFileSync(indexFile));}catch{}if(cache?.generator!==generator)cache={generator,files:{}};
 for(const c of plan.filter(c=>c.kind==='playback')){
  const spec={size:c.env.SOURCE_SIZE,fps:c.env.SOURCE_FPS,pattern:c.env.SOURCE_PATTERN},key=stable(spec);if(fixtures.has(key))continue;
  const file=path.join(output,'fixtures',hash(key).slice(0,16)+'.mp4');
  if(!fs.existsSync(file)||cache.files[key]?.sha256!==hash(fs.readFileSync(file))){
   const [w,h]=spec.size.split('x').map(Number);let filter=`testsrc2=size=${spec.size}:rate=${spec.fps}`;
   if(spec.pattern==='static')filter=`color=c=gray:size=${spec.size}:rate=${spec.fps},drawgrid=width=32:height=32:thickness=2:color=white`;
   if(spec.pattern==='pan')filter=`testsrc2=size=${w*2}x${h}:rate=${spec.fps},crop=${w}:${h}:x='(iw-ow)*mod(t,8)/8':y=0`;
   if(spec.pattern==='scene-cut')filter+=",negate=enable='gte(mod(t,2),1)'";
   console.log('Preparing fixture',spec.size,spec.fps,spec.pattern);
   const partial=file+'.partial.mp4';
   command(environment.ffmpeg,['-y','-hide_banner','-loglevel','error','-f','lavfi','-i',filter,'-t','60','-c:v','libx264','-threads','2','-preset','ultrafast','-crf','28','-pix_fmt','yuv420p','-movflags','+faststart','-an',partial],{timeout:180000});
   fs.renameSync(partial,file);cache.files[key]={sha256:hash(fs.readFileSync(file))};atomic(indexFile,cache);
  }
  fixtures.set(key,{...spec,file,sha256:hash(fs.readFileSync(file)),bytes:fs.statSync(file).size});
 }
 return [...fixtures.values()];
}
function writeReports(output,manifest,results,terminal=false){
 const pending=manifest.plan.filter(c=>!results.some(r=>r.id===c.id)).map(c=>({...c,attempts:[],status:terminal?'not-run':'pending'}));
 const summary=summarize([...results,...pending]);atomic(path.join(output,'checkpoint.json'),{manifestHash:manifest.identity,results,updatedAt:new Date().toISOString()});
 atomic(path.join(output,'summary.json'),summary);
 const columns=['id','status','kind','scenario','browser','size','fps','rate','profile','source','mid','sourceGap','computeP50','computeP95','steadyRaf','steadyQueue','backend','attempts'];
 const rows=summary.cases.map(c=>[c.id,c.status,c.kind,c.scenario,c.env.TEST_BROWSER,c.env.SOURCE_SIZE,c.env.SOURCE_FPS,c.env.PLAYBACK_RATE,c.env.FI_PROFILE,c.metrics.source,c.metrics.mid,c.metrics.sourceGap,c.metrics.computeP50,c.metrics.computeP95,c.metrics.steadyRaf,c.metrics.steadyQueue,c.metrics.backend,c.attempts.length]);
 fs.writeFileSync(path.join(output,'results.csv'),[columns,...rows].map(row=>row.map(csvCell).join(',')).join('\n'));
 const table=summary.cases.map(c=>`<tr><td>${escapeHtml(c.id)}</td><td>${escapeHtml(c.status)}</td><td>${escapeHtml(c.env.TEST_BROWSER||c.kind)}</td><td>${escapeHtml(c.scenario)}</td><td>${escapeHtml(c.env.SOURCE_SIZE)} / ${escapeHtml(c.env.SOURCE_FPS)} fps / ${escapeHtml(c.env.FI_PROFILE)}</td><td>${Number.isFinite(c.metrics.source)?c.metrics.source.toFixed(2):'—'}</td><td>${Number.isFinite(c.metrics.mid)?c.metrics.mid.toFixed(2):'—'}</td><td><a href="cases/${encodeURIComponent(c.id)}/case.json">JSON</a><details><summary>Findings / attempts</summary><ul>${c.analysis.map(s=>'<li>'+escapeHtml(s)+'</li>').join('')}</ul>${c.attempts.map((a,i)=>`<p>Attempt ${i+1}: ${escapeHtml(a.status)} — <a href="cases/${encodeURIComponent(c.id)}/attempt-${i+1}/stdout.log">stdout</a> / <a href="cases/${encodeURIComponent(c.id)}/attempt-${i+1}/stderr.log">stderr</a></p>`).join('')}</details></td></tr>`).join('\n');
 fs.writeFileSync(path.join(output,'report.html'),`<!doctype html><meta charset="utf-8"><title>Video Enhancer benchmark</title><style>body{font:15px system-ui;background:#101725;color:#edf3ff;margin:28px}a{color:#91beff}table{border-collapse:collapse;width:100%}td,th{padding:9px;border-bottom:1px solid #34435b;text-align:left}details{max-width:550px}input{padding:10px;width:320px}</style><h1>Video Enhancer benchmark</h1><p>${escapeHtml(manifest.startedAt)} · ${results.length}/${manifest.plan.length} cases · ${terminal?'Finished':'Running'}</p><pre>${escapeHtml(JSON.stringify(summary.counts,null,2))}</pre><p>Cadence counts submitted anchor/midpoint draws, not photons or guaranteed physical display FPS. Queue timings include browser notification delay. New profiles are application startup tests; driver shader caches are not cleared. Synthetic load is not another GPU. One-machine results do not establish portability or perceptual interpolation quality.</p><p><a href="run-manifest.json">Environment and frozen matrix</a> · <a href="summary.json">Full analysis</a> · <a href="results.csv">CSV</a></p><input id="filter" placeholder="Filter cases"><table><thead><tr>${['Case','Status','Browser','Scenario','Configuration','Anchors/s','Midpoints/s','Evidence'].map(s=>'<th>'+s+'</th>').join('')}</tr></thead><tbody>${table}</tbody></table><script>document.getElementById('filter').oninput=function(){for(const r of document.querySelectorAll('tbody tr'))r.hidden=!r.textContent.toLowerCase().includes(this.value.toLowerCase());};</script>`);
 return summary;
}
function parseArgs(args){
 const o={preset:'standard',browsers:['firefox','chromium'],repetitions:1,seed:20261017,headless:false,installDeps:false,dryRun:false,resume:null,output:null,limit:null};
 for(let i=0;i<args.length;i++){const a=args[i];if(a==='--help'){o.help=true;continue;}if(a==='--headless'){o.headless=true;continue;}if(a==='--install-deps'){o.installDeps=true;continue;}if(a==='--dry-run'){o.dryRun=true;continue;}
  const key={'--preset':'preset','--browsers':'browsers','--repetitions':'repetitions','--seed':'seed','--output':'output','--resume':'resume','--limit':'limit'}[a];if(!key||!args[i+1])throw Error('Unknown/missing option: '+a);o[key]=args[++i];}
 o.browsers=typeof o.browsers==='string'?o.browsers.split(','):o.browsers;if(!o.browsers.length||o.browsers.some(b=>!['firefox','chromium'].includes(b)))throw Error('Invalid browsers');
 for(const key of ['repetitions','seed','limit'])if(o[key]!==null)o[key]=Number(o[key]);return o;
}
async function main(args=process.argv.slice(2)){
 let options=parseArgs(args);if(options.help){console.log('node test/benchmark.cjs --preset full [--repetitions 2] [--install-deps] [--output PATH]\nnode test/benchmark.cjs --resume PATH\n--dry-run lists the complete matrix; --limit N is a runner smoke test, not full coverage.\nRuns browsers serially in disposable profiles. Existing profiles/extensions are untouched.');return;}
 const output=path.resolve(options.resume||options.output||path.join(os.tmpdir(),'video-enhancer-benchmark',new Date().toISOString().replace(/[:.]/g,'-')));fs.mkdirSync(output,{recursive:true});
 if(output===root||root.startsWith(output+path.sep))throw Error('Choose a dedicated result directory, not the source root or its parent.');
 if(!options.resume&&fs.existsSync(path.join(output,'run-manifest.json')))throw Error('Output already contains a run. Use --resume or a new output directory.');
 const lock=path.join(output,'RUNNING.lock');try{fs.writeFileSync(lock,String(process.pid),{flag:'wx'});}catch{const pid=Number(fs.readFileSync(lock));try{process.kill(pid,0);throw Error('This result directory is already in use by PID '+pid);}catch(e){if(e.code!=='ESRCH')throw e;}fs.writeFileSync(lock,String(process.pid));}
 let manifest,results=[],terminal='completed';
 try{
  const prior=options.resume?JSON.parse(fs.readFileSync(path.join(output,'run-manifest.json'))):null;if(prior)options=prior.options;
  let plan=buildPlan(options);if(options.limit){if(!Number.isInteger(options.limit)||options.limit<1)throw Error('Invalid limit');plan=plan.slice(0,options.limit);}
  if(options.dryRun){atomic(path.join(output,'plan.json'),{options,plan});console.log(JSON.stringify({output,count:plan.length,plan},null,2));return;}
  const environment=discover(options),source=sourceSnapshot(output);
  const identity=hash(stable({options,plan,source:source.sha256,environment}));
  if(prior&&identity!==prior.identity)throw Error('Resume refused: source, harness, dependency, browser, environment or matrix changed. Start a new output directory.');
  const fixtures=prior?.fixtures||await prepareFixtures(plan,output,environment);
  for(const fixture of fixtures)if(hash(fs.readFileSync(fixture.file))!==fixture.sha256)throw Error('Fixture changed: '+fixture.file);
  manifest=prior||{schemaVersion:1,identity,startedAt:new Date().toISOString(),options,plan,environment,source,fixtures,measurementNotes:['Submitted draw cadence; not a physical display or quality certification.','Queue completion includes callback notification latency.','Fresh browser profiles do not clear driver shader caches.','Synthetic workload does not emulate another GPU.','Failed attempts and strict timing assertions are preserved.']};
  manifest.source.stats=source.stats;
  atomic(path.join(output,'run-manifest.json'),manifest);
  const journal=path.join(output,'journal.jsonl');if(prior)results=recoverJournal(journal);
  const append=event=>{const fd=fs.openSync(journal,'a');try{fs.writeSync(fd,JSON.stringify(event)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
  let interrupted=false;const stop=()=>{interrupted=true;};process.on('SIGINT',stop);process.on('SIGTERM',stop);
  console.log(`Autonomous matrix: ${plan.length} cases, ${fixtures.length} pinned fixtures. Output: ${output}`);
  writeReports(output,manifest,results);
  for(const c of plan){
   if(results.some(r=>r.id===c.id))continue;
   if(interrupted||fs.existsSync(path.join(output,'stop.request'))){terminal='interrupted';break;}
   verifySource(manifest.source);const caseFolder=path.join(output,'cases',c.id);fs.mkdirSync(caseFolder,{recursive:true});
   const record={...c,attempts:[],status:'failed'};
   const browserMissing=c.env.TEST_BROWSER&&!environment.browserPaths[c.env.TEST_BROWSER];
   console.log(`[${results.length+1}/${plan.length}] ${c.id} ${c.env.TEST_BROWSER||''} ${c.scenario} ${c.env.SOURCE_SIZE||''} ${c.env.SOURCE_FPS||''}`);
   for(let attempt=1;attempt<=2;attempt++){
    const folder=path.join(caseFolder,'attempt-'+attempt),reportFile=path.join(folder,'result.json');
    const fixture=fixtures.find(f=>f.size===c.env.SOURCE_SIZE&&f.fps===c.env.SOURCE_FPS&&f.pattern===c.env.SOURCE_PATTERN);
    const common={NODE_PATH:environment.dependencyPath,PYTHON_PATH:environment.python,FFMPEG_PATH:environment.ffmpeg,HEADLESS:options.headless?'1':'0',
     ...(environment.browserPaths.firefox?{FIREFOX_PATH:environment.browserPaths.firefox}:{}),...(environment.browserPaths.chromium?{CHROMIUM_PATH:environment.browserPaths.chromium}:{}),
     STEADY_MS:'6000',WARM_MS:'1500',NEURAL_TIMELINE:'1',CALLBACK_TIMELINE:'1',BENCH_RESULT_FILE:reportFile,BENCH_CASE_ID:c.id,BENCH_RUN_ID:manifest.startedAt,BENCH_SOURCE_HASH:source.sha256,
     ...(fixture?{SOURCE_FILE:fixture.file,SOURCE_HASH:fixture.sha256}:{}),PATH:path.dirname(environment.python)+path.delimiter+process.env.PATH};
    const env=cleanEnvironment(process.env,c.env,common);const script=path.join(root,c.script);
    let a;if(browserMissing){fs.mkdirSync(folder,{recursive:true});a={exitCode:-1,cleanupOk:true,timedOut:false,stdout:'',stderr:'Browser was not found: '+c.env.TEST_BROWSER};}
    else a=await runChild({program:c.kind==='packaging'?environment.python:process.execPath,args:[script],env,folder,timeoutMs:c.timeoutMs});
    if(c.kind==='playback'&&!browserMissing){try{a.report=JSON.parse(fs.readFileSync(reportFile));}catch{} }
    else{const parsed=parseJsonObjects(a.stdout||'');a.report={schemaVersion:1,test:c.kind,status:a.exitCode===0?'passed':'failed',config:c.env,result:parsed.at(-1)||{stdoutLines:(a.stdout||'').split('\n').length},failures:a.exitCode===0?[]:[{message:a.stderr||'Test process exited '+a.exitCode}]};}
    if(c.kind==='playback'&&a.report){
     const cfg=a.report.config||{},expected={browser:c.env.TEST_BROWSER,sourceSize:c.env.SOURCE_SIZE,sourceFps:Number(c.env.SOURCE_FPS),playbackRate:Number(c.env.PLAYBACK_RATE),spatialMode:c.env.SPATIAL_MODE,fiEnabled:c.env.FI_ENABLED==='1',profile:c.env.FI_PROFILE,steadyMs:Number(common.STEADY_MS),warmMs:Number(common.WARM_MS),headless:options.headless,loadPattern:c.env.LOAD_PATTERN||'none'};
     a.configMismatch=Object.entries(expected).some(([key,value])=>cfg[key]!==value);
     const identity=a.report.identity||{};a.identityMismatch=identity.caseId!==c.id||identity.runId!==manifest.startedAt||identity.sourceHash!==source.sha256||a.report.fixture?.sha256!==fixture?.sha256;
     const exp=cfg.experiments||{};a.configMismatch||=(exp.api||null)!==(c.env.FI_API||null)||!!exp.canvasCopy!==(c.env.FI_CANVAS_COPY==='1')||exp.callbackJitterMs!==Number(c.env.CALLBACK_JITTER_MS||0);
     if(a.configMismatch||a.identityMismatch){atomic(path.join(folder,'rejected-report.json'),a.report);a.report=null;}
     if(a.report?.status==='passed'&&(!Number.isFinite(a.report.result?.sourceRate)||!Number.isFinite(a.report.result?.midRate)||!Number.isFinite(a.report.result?.maxSourceGapMs)||!a.report.result?.windows?.length))a.report=null;
    }
    if(a.report?.failures?.some(f=>f.name==='browser-cleanup'))a.cleanupOk=false;
    a.status=classifyAttempt(a);a.report=compactReport(a.report);delete a.stdout;delete a.stderr;atomic(path.join(folder,'attempt.json'),a);record.attempts.push(a);append({type:'attempt',id:c.id,attempt,data:a});
    if(a.cleanupOk===false){record.status='failed';terminal='unsafe-cleanup';break;}
    if(attempt===1&&a.status==='unavailable'&&!browserMissing)continue;
    record.status=a.status==='passed'&&record.attempts.length>1?'flaky':a.status;break;
   }
   if(interrupted){terminal='interrupted';atomic(path.join(caseFolder,'interrupted-case.json'),record);break;}
   results.push(record);atomic(path.join(caseFolder,'case.json'),record);append({type:'case',result:record});writeReports(output,manifest,results);
   console.log(`  ${record.status}${record.attempts.length>1?' (first attempt retained)':''}`);
   if(terminal==='unsafe-cleanup')break;
  }
  process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  verifySource(manifest.source);const summary=writeReports(output,manifest,results,true);
  atomic(path.join(output,'RUN_COMPLETE.json'),{status:terminal,finishedAt:new Date().toISOString(),planned:plan.length,completed:results.length,counts:summary.counts,sourceHash:source.sha256});
  console.log(JSON.stringify({output,status:terminal,planned:plan.length,completed:results.length,counts:summary.counts},null,2));
  if(terminal!=='completed'||results.some(r=>r.status!=='passed'))process.exitCode=1;
 }catch(error){atomic(path.join(output,'RUN_ERROR.json'),{error:error.message,stack:error.stack,at:new Date().toISOString()});throw error;}
 finally{fs.rmSync(lock,{force:true});}
}
module.exports={buildPlan,cleanEnvironment,parseJsonObjects,classifyAttempt,summarize,escapeHtml,csvCell,parseArgs,recoverJournal};
if(require.main===module)main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
