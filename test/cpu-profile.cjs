'use strict';
const assert=require('node:assert/strict');
const createCpuProfiler=require('./cpu-profile-helper.cjs');
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} should be close to ${expected}`);

(async()=>{
 let now=100,phase='warm';
 const profiler=createCpuProfiler({now:()=>now,phase:()=>phase});
 const serializedFactory=(0,eval)('('+createCpuProfiler.toString()+')');
 let serializedNow=0;const serializedProfiler=serializedFactory({now:()=>serializedNow});
 assert.equal(serializedProfiler.wrap('serialized',()=>{serializedNow+=.5;})(),undefined);near(serializedProfiler.snapshot().byLabel.serialized.totalMs,.5);
 const receiver={base:10};
 function sum(left,right){now+=.5;return this.base+left+right;}
 const wrappedSum=profiler.wrap('receiver.sum',sum);
 assert.equal(wrappedSum.name,'sum','the wrapper preserves the function name');
 assert.equal(wrappedSum.call(receiver,2,3),15,'the wrapper preserves this, arguments, and the return value');
 assert.equal(profiler.snapshot().byLabel['receiver.sum'].count,1);
 near(profiler.snapshot().byLabel['receiver.sum'].totalMs,.5);

 let priorWrapperCalls=0;
 const target={base:4,add(value){now+=.25;return this.base+value;}};
 const prewrapped=target.add;target.add=function(...args){priorWrapperCalls++;return prewrapped.apply(this,args);};
 const existing=target.add;
 assert.equal(profiler.wrapMethod(target,'add','method.add'),true);
 assert.notEqual(target.add,existing,'wrapMethod wraps the already-installed method');
 assert.equal(target.add(3),7,'method wrapping preserves this and return value');assert.equal(priorWrapperCalls,1,'an existing wrapper remains in the call chain');

 const expectedError=new Error('synchronous failure');
 const throwing=profiler.wrap('throws',function(){now+=2.5;throw expectedError;});
 assert.throws(()=>throwing('not retained'),error=>error===expectedError,'synchronous exceptions pass through unchanged');
 near(profiler.snapshot().byLabel.throws.maxMs,2.5);

 let resolvePending;
 const pending=new Promise(resolve=>{resolvePending=resolve;});
 const returnsPromise=profiler.wrap('promise-return',function(value){assert.equal(value,'kept');now+=.375;return pending;});
 const beforePromise=now,returned=returnsPromise('kept');
 assert.equal(returned,pending,'a Promise is returned directly without awaiting or replacing it');
 near(now-beforePromise,.375);
 const promiseStatsBefore=profiler.snapshot().byLabel['promise-return'];
 now+=100;phase='steady';resolvePending('done');assert.equal(await returned,'done');
 const promiseStatsAfter=profiler.snapshot().byLabel['promise-return'];
 assert.equal(promiseStatsAfter.count,promiseStatsBefore.count,'time spent awaiting a returned Promise is not recorded');
 near(promiseStatsAfter.totalMs,.375);

 let histogramNow=0;
 const histogramProfiler=createCpuProfiler({now:()=>histogramNow,phase:()=>phase});
 for(let index=1;index<=20;index++){
  const duration=index/8;histogramProfiler.wrap('samples',()=>{histogramNow+=duration;})();
 }
 const histogram=histogramProfiler.snapshot(),samples=histogram.byLabel.samples;
 assert.equal(samples.count,20);near(samples.totalMs,26.25);near(samples.maxMs,2.5);
 assert.equal(samples.p95Ms,4,'p95 rounds up to the selected histogram bucket bound');
 assert.equal(histogram.histogramRounding,'upper-bound');
 assert.equal(samples.histogram.counts.reduce((sum,count)=>sum+count,0),20);
 assert.ok(histogram.slowExamples.length<=20);assert.ok(histogram.slowExamples.every(example=>example.durationMs>=2&&example.phase==='steady'));
 assert.deepEqual(Object.keys(histogram.slowExamples[0]).sort(),['durationMs','label','phase','time']);

 for(let index=0;index<30;index++)histogramProfiler.wrap('slow-bound',()=>{histogramNow+=2;})();
 const bounded=histogramProfiler.snapshot();
 assert.equal(bounded.slowExamples.length,20,'slow examples have a fixed maximum');
 assert.equal(bounded.byLabel['slow-bound'].count,30);
 histogramProfiler.wrap('overflow',()=>{histogramNow+=300;})();
 assert.equal(histogramProfiler.snapshot().byLabel.overflow.histogram.overflowCount,1,'histogram storage remains bounded above its final bucket');

 const originalSnapshot=histogramProfiler.snapshot();
 const mutableSnapshot=histogramProfiler.snapshot();
 mutableSnapshot.byLabel.samples.totalMs=-1;mutableSnapshot.byLabel.samples.histogram.counts[0]=-1;
 mutableSnapshot.slowExamples[0].label='mutated';mutableSnapshot.slowExamples.length=0;
 assert.deepEqual(histogramProfiler.snapshot(),originalSnapshot,'each snapshot returns independent copies');

 let nestedNow=0;const nested=createCpuProfiler({now:()=>nestedNow});
 const inner=nested.wrap('nested.inner',()=>{nestedNow+=2;});
 const outer=nested.wrap('nested.outer',()=>{nestedNow+=1;inner();nestedNow+=1;});
 outer();const nestedSnapshot=nested.snapshot();
 near(nestedSnapshot.byLabel['nested.inner'].totalMs,2);near(nestedSnapshot.byLabel['nested.outer'].totalMs,4);
 assert.equal(nestedSnapshot.durationScope,'synchronous-inclusive','nested calls are measured inclusively, not as exclusive CPU time');

 let phaseNow=0,callPhase='model';const phaseProfiler=createCpuProfiler({now:()=>phaseNow,phase:()=>callPhase});
 for(let index=0;index<15;index++)phaseProfiler.wrap('slow',()=>{phaseNow+=2.5;})();
 callPhase='steady';for(let index=0;index<15;index++)phaseProfiler.wrap('slow',()=>{phaseNow+=2.5;})();
 const phaseExamples=phaseProfiler.snapshot().slowExamples;
 assert.equal(phaseExamples.length,20);assert.equal(phaseExamples.filter(example=>example.phase==='model').length,10);
 assert.equal(phaseExamples.filter(example=>example.phase==='steady').length,10,'bounded slow examples retain early preparation and recent steady calls');

 let labelsNow=0;const boundedLabels=createCpuProfiler({now:()=>labelsNow});
 for(let index=0;index<100;index++)boundedLabels.wrap(`label-${index}`,()=>{labelsNow+=.1;})();
 assert.ok(Object.keys(boundedLabels.snapshot().byLabel).length<=64,'per-label histograms have a fixed memory bound');
 console.log('CPU profile helper checks passed (fake clock; synchronous durations only).');
})().catch(error=>{console.error(error);process.exitCode=1;});
