'use strict';
// Pure runner contract tests: never launch a browser, GPU, packaging or child process.
const assert=require('node:assert/strict');
const {buildPlan,cleanEnvironment,parseJsonObjects,classifyAttempt,summarize,escapeHtml,csvCell}=require('./benchmark.cjs');
const options={preset:'standard',browsers:['firefox','chromium'],repetitions:1,seed:123};
const standard=buildPlan(options),repeat=buildPlan({...options});
assert.ok(Array.isArray(standard)&&standard.length>0,'benchmark plan contains cases');
assert.deepEqual(repeat,standard,'same options produce byte-equivalent case ordering');
assert.ok(standard.some(c=>c.scenario==='playback-rate'&&c.env.SOURCE_FPS==='30'&&Number(c.env.PLAYBACK_RATE)===4/3),
 'the standard matrix covers 40 fps playback near the buffered-mode boundary');
for(const browser of options.browsers){
 assert.ok(standard.some(c=>c.scenario==='real-package-paused-start'&&c.env.TEST_BROWSER===browser&&c.env.ADDON_PAUSED_START==='1'),
  'asynchronous startup captures paused decoded media in '+browser);
 assert.ok(standard.some(c=>c.scenario==='feed-visibility'&&c.env.TEST_BROWSER===browser),
  'native CSS visibility runs in '+browser);
 for(const interaction of ['quality','smooth'])assert.ok(standard.some(c=>c.scenario==='real-package-mixed-feed'&&c.env.TEST_BROWSER===browser&&
  c.env.ADDON_MIXED_FEED==='1'&&c.env.ADDON_INIT_PHASED==='1'&&c.env.ADDON_INTERACTION===interaction),
  'the installed add-on covers retained players, mixed dimensions and phased model loading in '+browser+' / '+interaction);
}
assert.equal(new Set(standard.map(c=>c.id)).size,standard.length,'case IDs are unique');
const allowed=new Set(['playback','addon','layout','numerical','logic','packaging']);
for(const entry of standard){
 assert.ok(typeof entry.id==='string'&&entry.id.length>0);assert.ok(allowed.has(entry.kind),entry.kind);
 assert.ok(typeof entry.script==='string'&&entry.script.length>0);
 assert.ok(entry.env&&typeof entry.env==='object');assert.ok(Number.isInteger(entry.repetition));
 assert.ok(entry.scenario);assert.equal(typeof entry.synthetic,'boolean');assert.ok(entry.timeoutMs>0);
}
const smoke=buildPlan({...options,preset:'smoke'}),full=buildPlan({...options,preset:'full'});
assert.ok(full.length>standard.length,'full executes more cases than standard');
assert.ok(standard.length>=smoke.length,'smoke stays bounded');
const twice=buildPlan({...options,repetitions:2});
assert.equal(twice.length,standard.length+standard.filter(c=>c.kind==='playback').length,'only playback cases repeat; one-off validation stays once');
assert.equal(new Set(twice.map(c=>c.id)).size,twice.length,'repetitions have distinct IDs');
// Parent shell settings must not leak one experimental pipeline into another.
const parent={PATH:'keep-path',TEMP:'keep-temp',HOME:'keep-home',NODE_PATH:'keep-node',
 FI_UNLISTED:'poison',SOURCE_UNLISTED:'poison',IFRNET_UNLISTED:'poison',BUDGET_UNLISTED:'poison',
 CALLBACK_UNLISTED:'poison',NEURAL_UNLISTED:'poison',ADDON_UNLISTED:'poison',HEADLESS:'1',WARM_MS:'1',
 STEADY_MS:'1',SPATIAL_MODE:'native',PLAYBACK_RATE:'8',LOAD_PATTERN:'poison',BASELINE_REF:'poison'};
const before={...parent},caseEnv={FI_ENGINE:'ifrnet',WARM_MS:'2000'},common={FI_ENGINE:'common',SOURCE_FPS:'30'};
const clean=cleanEnvironment(parent,caseEnv,common);
assert.deepEqual(parent,before,'cleaning does not mutate the parent environment');
for(const key of Object.keys(parent))if(parent[key]==='poison'||['HEADLESS','STEADY_MS','SPATIAL_MODE','PLAYBACK_RATE'].includes(key))assert.ok(!(key in clean),key+' cannot leak');
assert.equal(clean.PATH,'keep-path');assert.equal(clean.NODE_PATH,'keep-node');assert.equal(clean.HOME,'keep-home');
assert.equal(clean.FI_ENGINE,'ifrnet','case overrides common values');assert.equal(clean.SOURCE_FPS,'30');assert.equal(clean.WARM_MS,'2000');
assert.deepEqual(caseEnv,{FI_ENGINE:'ifrnet',WARM_MS:'2000'});assert.deepEqual(common,{FI_ENGINE:'common',SOURCE_FPS:'30'});
const objects=[{schemaVersion:1,config:{name:'quotes " and braces { } and slash \\',nested:{a:[1,2]}},result:{ok:true}},
 {failure:{message:'<script>bad</script> literal } { braces'},schemaVersion:1}];
const stdout='server log before\n'+JSON.stringify(objects[0],null,2)+'\nGPU log\n'+JSON.stringify(objects[1])+'\nserver after';
assert.deepEqual(parseJsonObjects(stdout),objects,'balanced parser handles nested objects and braces inside strings');
assert.deepEqual(parseJsonObjects('plain text, no report'),[]);
assert.deepEqual(parseJsonObjects('{not JSON}\n{"valid":true}'),[{valid:true}],'invalid candidate cannot swallow the next valid report');
const quoteObject={message:'escaped quote " } and { stay in string'};
assert.deepEqual(parseJsonObjects(JSON.stringify(quoteObject)+'\n{"next":2}'),[quoteObject,{next:2}], 'escaped quotes do not change object nesting');
const html=escapeHtml('<img src=x onerror="alert(1)"> & \'quoted\'');
assert.ok(!html.includes('<')&&!html.includes('>')&&!html.includes('"')&&!html.includes("'"),'HTML output cannot introduce markup or attribute quotes');
assert.ok(html.includes('&lt;')&&html.includes('&amp;'));
function decodeCell(value){let text=String(value);if(text.startsWith('"')&&text.endsWith('"'))text=text.slice(1,-1).replace(/""/g,'"');return text;}
assert.equal(decodeCell(csvCell('comma, quote " and\nnewline')),'comma, quote " and\nnewline','CSV quoting preserves report text');
for(const value of ['=HYPERLINK("bad")','+SUM(1,2)','-1+2','@SUM(1)','\t=1+1','\r=1+1'])assert.ok(!/^[\s]*[=+@-]/.test(decodeCell(csvCell(value))),'CSV formula must be neutralized: '+JSON.stringify(value));
console.log('PASS benchmark runner: deterministic matrix, clean environments, structured report parsing and safe HTML/CSV output.');
const passedReport={schemaVersion:1,test:'neural-browser',status:'passed',config:{sourceFps:60},result:{sourceRate:60,midRate:25},failures:[]};
const attempt={exitCode:0,timedOut:false,report:passedReport,stdout:'ordinary log',stderr:'',cleanupOk:true};
assert.equal(classifyAttempt(attempt),'passed');
assert.equal(classifyAttempt({...attempt,timedOut:true}),'timeout','timeout takes precedence over a partial successful report');
assert.equal(classifyAttempt({...attempt,exitCode:1}),'failed','nonzero process exit cannot be hidden by a positive report');
for(const report of [null,{}, {...passedReport,schemaVersion:2},{...passedReport,config:null},{...passedReport,status:'unknown'}])assert.equal(classifyAttempt({...attempt,report}),'invalid-report','missing or malformed structured reports cannot pass');
const failure={...passedReport,status:'failed',result:null,failures:[{message:'AssertionError: midpoint cadence fell below minimum'}]};
assert.equal(classifyAttempt({...attempt,exitCode:1,report:failure}),'failed');
assert.equal(classifyAttempt({...attempt,exitCode:1,report:{...failure,failures:[{message:'No WebGPU adapter is available.'}]}}),'unavailable','missing capability is explicit and never a success');
assert.notEqual(classifyAttempt({...attempt,cleanupOk:false}),'passed','failed cleanup invalidates otherwise successful execution');
const attempts=[{status:'failed',exitCode:1,report:failure},{status:'passed',exitCode:0,report:passedReport}];
const cases=[{id:'retry-case',kind:'playback',scenario:'60fps',repetition:1,status:'flaky',attempts},
 {id:'passed-case',kind:'logic',scenario:'unit',repetition:1,status:'passed',attempts:[{status:'passed',exitCode:0}]},
 {id:'missing-case',kind:'playback',scenario:'60fps',repetition:1,status:'unavailable',attempts:[{status:'unavailable',exitCode:1}]}];
const summary=summarize(cases);
assert.equal(summary.counts.flaky,1,'a successful retry retains its initial failure classification');
assert.equal(summary.counts.passed,1);assert.equal(summary.counts.unavailable,1);
const retained=summary.cases.find(c=>c.id==='retry-case');assert.ok(retained,'summary retains individually addressable cases');
assert.deepEqual(retained.attempts,attempts,'all attempt evidence survives summary generation');
assert.equal(cases[0].attempts.length,2,'summarizing cannot discard original retry evidence');
console.log('PASS benchmark runner: malformed reports, unavailable capabilities, timeouts and retries remain visible.');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const {recoverJournal,parseArgs}=require('./benchmark.cjs');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'video-enhancer-runner-unit-'));
try{
 const journal=path.join(temp,'journal.jsonl'),first={id:'case-a',status:'failed',attempts:[{status:'failed'}]},second={id:'case-b',status:'passed',attempts:[{status:'passed'}]};
 const complete=JSON.stringify({type:'case',result:first})+'\n';
 const tail=Buffer.from('{"type":"case","result":{"id":"interrupted","note":"unfinished');
 fs.writeFileSync(journal,Buffer.concat([Buffer.from(complete),tail]));
 assert.deepEqual(recoverJournal(journal),[first],'complete case survives a torn final journal write');
 assert.equal(fs.readFileSync(journal,'utf8'),complete,'only incomplete tail is truncated');
 const backups=fs.readdirSync(temp).filter(name=>name.startsWith('journal.jsonl.interrupted-tail-'));
 assert.equal(backups.length,1);assert.deepEqual(fs.readFileSync(path.join(temp,backups[0])),tail,'incomplete original bytes are preserved separately');
 fs.appendFileSync(journal,JSON.stringify({type:'case',result:second})+'\n');
 assert.deepEqual(recoverJournal(journal),[first,second],'resume append after repair leaves a readable journal');
 assert.deepEqual(recoverJournal(journal),[first,second],'recovery is idempotent');
 const updated={...first,status:'flaky',attempts:[...first.attempts,{status:'passed'}]};
 fs.appendFileSync(journal,JSON.stringify({type:'case',result:updated})+'\n');
 assert.deepEqual(recoverJournal(journal),[updated,second],'latest completed case supersedes an earlier entry without dropping attempts');
 const corrupt=path.join(temp,'corrupt.jsonl');fs.writeFileSync(corrupt,complete+'{invalid}\n'+JSON.stringify({type:'case',result:second})+'\n');
 const corruption=fs.readFileSync(corrupt);assert.throws(()=>recoverJournal(corrupt),/corrupt/i,'interior corruption cannot silently discard following evidence');assert.deepEqual(fs.readFileSync(corrupt),corruption);
 for(const options of [{preset:'unknown'},{repetitions:0},{repetitions:1.5},{repetitions:11}])assert.throws(()=>buildPlan(options),/invalid/i);
 for(const args of [['--unknown'],['--preset'],['--browsers','safari']])assert.throws(()=>parseArgs(args));
 const output=path.join(temp,'dry-run'),cli=cp.spawnSync(process.execPath,[path.join(__dirname,'benchmark.cjs'),'--dry-run','--preset','smoke','--seed','123','--output',output],{cwd:temp,encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(cli.status,0,cli.stderr);const dry=JSON.parse(cli.stdout),saved=JSON.parse(fs.readFileSync(path.join(output,'plan.json'),'utf8'));
 assert.deepEqual(dry.plan,saved.plan,'CLI output agrees with persisted dry-run plan');
 assert.equal(new Set(dry.plan.map(c=>c.id)).size,dry.count);assert.equal(dry.count,dry.plan.length);
 assert.deepEqual(dry.plan,buildPlan({preset:'smoke',browsers:['firefox','chromium'],repetitions:1,seed:123}),'CLI plan is independent of working directory and matches the seeded API');
 assert.deepEqual(fs.readdirSync(output),['plan.json'],'dry-run creates no journal, fixture, browser profile or live run lock');
 const invalid=cp.spawnSync(process.execPath,[path.join(__dirname,'benchmark.cjs'),'--dry-run','--preset','invalid','--output',path.join(temp,'invalid')],{cwd:temp,encoding:'utf8',timeout:10000,windowsHide:true});
 assert.notEqual(invalid.status,0,'CLI rejects invalid presets before execution');
 console.log('PASS benchmark runner: interrupted journals retain evidence, repeated recovery is safe and the real dry-run CLI executes without browser work.');
}finally{
 assert.equal(path.dirname(temp),path.resolve(os.tmpdir()));assert.ok(path.basename(temp).startsWith('video-enhancer-runner-unit-'));
 fs.rmSync(temp,{recursive:true,force:true});
}
