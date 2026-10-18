'use strict';

function createCpuProfiler(options={}){
 const upperBoundsMs=[.1,.25,.5,1,2,4,8,16,32,64,128,256];
 const maxLabels=64,earlyExamples=10,recentExamples=10,slowThresholdMs=2,maxLabelLength=96;
 const now=typeof options.now==='function'?options.now:()=>performance.now();
 const readPhase=typeof options.phase==='function'?options.phase:()=>null;
 const records=new Map(),firstSlowExamples=[],recentSlowExamples=[];const wrappedMethods=new WeakMap();
 const safeNow=()=>{try{const value=now();return Number.isFinite(value)?value:null;}catch{return null;}};
 const normalizedLabel=value=>String(value||'unnamed').slice(0,maxLabelLength);
 const phaseValue=()=>{try{const value=readPhase();return value==null?null:String(value).slice(0,48);}catch{return null;}};
 const getRecord=label=>{
  let key=normalizedLabel(label);
  if(!records.has(key)&&records.size>=maxLabels-1)key='__other__';
  let record=records.get(key);
  if(!record){record={count:0,totalMs:0,maxMs:0,histogram:new Array(upperBoundsMs.length+1).fill(0)};records.set(key,record);}
  return {key,record};
 };
 const bucketFor=durationMs=>{for(let index=0;index<upperBoundsMs.length;index++)if(durationMs<=upperBoundsMs[index])return index;return upperBoundsMs.length;};
 const recordSample=(label,time,durationMs,phase)=>{
  if(!Number.isFinite(durationMs)||durationMs<0)return;
  const {key,record}=getRecord(label);record.count++;record.totalMs+=durationMs;record.maxMs=Math.max(record.maxMs,durationMs);record.histogram[bucketFor(durationMs)]++;
  if(durationMs>=slowThresholdMs){
   const example={label:key,time,durationMs,phase};
   if(firstSlowExamples.length<earlyExamples)firstSlowExamples.push(example);
   else{if(recentSlowExamples.length>=recentExamples)recentSlowExamples.shift();recentSlowExamples.push(example);}
  }
 };
 const wrap=(label,fn)=>{
  if(typeof fn!=='function')return fn;
  const normalized=normalizedLabel(label);
  function profiled(...args){
   const callPhase=phaseValue(),started=safeNow();
   try{return fn.apply(this,args);}
   finally{
    const ended=safeNow();
    if(started!==null&&ended!==null)recordSample(normalized,started,ended-started,callPhase);
   }
  }
  try{Object.defineProperty(profiled,'name',{value:fn.name,configurable:true});}catch{}
  return profiled;
 };
 const wrapMethod=(target,key,label)=>{
  if(target==null)return false;
  let original;
  try{original=target[key];}catch{return false;}
  if(typeof original!=='function')return false;
  let methods=wrappedMethods.get(target);
  if(!methods){methods=new Map();wrappedMethods.set(target,methods);}
  if(methods.get(key)===original)return true;
  const wrapped=wrap(label||String(key),original);
  try{target[key]=wrapped;if(target[key]!==wrapped)return false;}catch{return false;}
  methods.set(key,wrapped);return true;
 };
 const snapshot=()=>{
  const byLabel={};
  for(const [label,record] of records){
   const target=Math.ceil(record.count*.95);let accumulated=0,p95Ms=null;
   for(let index=0;index<record.histogram.length;index++){
    accumulated+=record.histogram[index];
    if(accumulated>=target){p95Ms=index<upperBoundsMs.length?upperBoundsMs[index]:null;break;}
   }
   Object.defineProperty(byLabel,label,{enumerable:true,configurable:true,writable:true,value:{count:record.count,totalMs:record.totalMs,maxMs:record.maxMs,p95Ms,
    histogram:{upperBoundsMs:upperBoundsMs.slice(),counts:record.histogram.slice(),overflowCount:record.histogram.at(-1)}}});
  }
  return {enabled:true,clock:'performance.now',durationScope:'synchronous-inclusive',slowThresholdMs,histogramRounding:'upper-bound',byLabel,
   slowExamples:[...firstSlowExamples,...recentSlowExamples].map(example=>({...example}))};
 };
 return {wrap,wrapMethod,snapshot};
}

module.exports=createCpuProfiler;
