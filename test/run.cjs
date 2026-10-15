const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');let failed=false;
for(const name of fs.readdirSync(root).filter(n=>n.endsWith('.js'))){const r=cp.spawnSync(process.execPath,['--check',name],{cwd:root,encoding:'utf8'});if(r.status){console.error(r.stderr);failed=true;}}
for(const name of ['content.js','fi-core.js','test/feed-session.cjs','test/spatial-cache.cjs','test/cadence.cjs','test/quality.cjs','test/half-oracle.cjs','test/model.cjs','test/model-storage.cjs','test/neural-runtime.cjs','test/neural-lifecycle.cjs','test/neural-init.cjs','test/ifrnet-host.cjs','test/analytic-host.cjs','test/analytic-controller.cjs']){
 console.log('\n> node '+name);const r=cp.spawnSync(process.execPath,[name],{cwd:root,encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);if(r.status)failed=true;
}
if(failed)process.exitCode=1;else console.log('\nPASS: complete Node test suite. GPU shader execution is a separate test.');
