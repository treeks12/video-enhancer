'use strict';
// Replay the shipped selector with real visibility API results and geometry.
// Browser playback/scrolling is covered separately by ADDON_MIXED_FEED=1.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../content.js'),'utf8');
const extract=name=>{
 const start=source.indexOf('function '+name+'('),end=source.indexOf('\nfunction ',start+1);
 assert.ok(start>=0&&end>start,name+' must come from production');return source.slice(start,end);
};
function harness(styleReader){
 const context=vm.createContext(styleReader?{getComputedStyle:styleReader}:{});
 vm.runInContext(['visibleArea','playingWeight','pickLargestVideo'].map(extract).join('\n')+'\nglobalThis.pick=pickLargestVideo;',context);
 return context.pick;
}
const video=(name,rect,extra={})=>({name,readyState:4,paused:false,ended:false,
 getBoundingClientRect:()=>({left:0,top:0,width:600,height:340,...rect}),...extra});
const pick=harness(),current=video('visible landscape'),hidden=video('hidden preloaded video',{width:1000,height:700},
 {checkVisibility:options=>{assert.equal(options.visibilityProperty,true);assert.equal(options.opacityProperty,true);return false;}});
assert.equal(pick([current,hidden],1100,750),current,'a large CSS-hidden preload cannot steal the active video');
const transparent=video('transparent video',{width:1000,height:700},{checkVisibility:()=>false});
assert.equal(pick([transparent,current],1100,750),current,'a transparent player cannot cover the visible feed');
assert.equal(pick([hidden,transparent],1100,750),null,'no invisible candidate becomes the selected video');
const offscreen=video('offscreen',{top:900},{checkVisibility:()=>{throw Error('offscreen candidates need no style check');}});
assert.equal(pick([offscreen,current],1100,750),current);
const fallback=harness(v=>v.computed||{visibility:'visible',opacity:'1'});
for(const computed of [{visibility:'hidden',opacity:'1'},{visibility:'collapse',opacity:'1'},{visibility:'visible',opacity:'0'}]){
 const masked=video('CSS fallback',{width:1000,height:700},{computed});
 assert.equal(fallback([masked,current],1100,750),current,'older visibility APIs keep the visible feed selected');
}
const paused=video('paused larger video',{width:900,height:600},{paused:true});
assert.equal(pick([paused,current],1100,750),current,'visible playing video retains its existing priority');
const portrait=video('portrait',{left:400,top:400,width:320,height:800});
assert.equal(pick([current,portrait],1100,750),current,'viewport clipping still determines the visible area');
console.log('PASS feed selection: hidden/transparent preloads, CSS fallback, viewport clipping and playing priority');
