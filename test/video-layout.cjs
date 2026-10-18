'use strict';
// Exercise the shipping layout functions with known CSS replaced-element geometry.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../content.js'),'utf8');
const start=source.indexOf('function videoObjectPosition('),end=source.indexOf('\nfunction fiLeaveDirectCompositor(',start);
assert.ok(start>0&&end>start);
const body={},win={scrollX:0,scrollY:0,devicePixelRatio:1};
let aligned=0;
const ctx=vm.createContext({window:win,document:{body},getComputedStyle:e=>e.computed,
 stopped:false,currentVideo:null,canvas:null,layoutDirty:true,targetWidth:0,targetHeight:0,
 settings:{quality:'high',compare:false},renderScale:1,effectiveRenderScale:()=>1,
 fiGpuEngine:{compositor:{align(){aligned++;}}},attachCanvasTo(){throw Error('unexpected reparent');}});
vm.runInContext(source.slice(start,end),ctx);
const plain=v=>JSON.parse(JSON.stringify(v));
function near(actual,expected,label){assert.ok(Math.abs(actual-expected)<1e-7,`${label}: ${actual} != ${expected}`);}
function rect(args,expected){const actual=ctx.videoObjectRect(...args);for(const [k,v]of Object.entries(expected))near(actual[k],v,k);}
rect([1600,900,640,480,'contain','50% 50%'],{x:200,y:0,width:1200,height:900});
rect([1600,900,640,480,'cover','center'],{x:0,y:-150,width:1600,height:1200});
rect([1600,900,640,480,'fill','center'],{x:0,y:0,width:1600,height:900});
rect([1600,900,640,480,'none','right bottom'],{x:960,y:420,width:640,height:480});
rect([1600,900,640,480,'scale-down','center'],{x:480,y:210,width:640,height:480});
rect([320,180,640,480,'scale-down','center'],{x:40,y:0,width:240,height:180});
rect([1600,900,0,0,'contain','center'],{x:0,y:0,width:1600,height:900});
for(const [position,expected]of [
 ['center',[200,100]],['top',[200,0]],['bottom right',[400,200]],['25% 75%',[100,150]],
 ['12px 18px',[12,18]],['calc(50% - 20px) calc(100% - 10px)',[180,190]],
 ['right 20px bottom',[380,200]],['left top 15px',[0,15]],
 ['bottom 10px right 25%',[300,190]],['right 20px bottom 10px',[380,190]],
 ['center bottom 10px',[200,190]]])assert.deepEqual(plain(ctx.videoObjectPosition(position,400,200)),expected,position);
const base={width:'1600px',height:'900px',boxSizing:'content-box',objectFit:'contain',objectPosition:'50% 50%',
 borderLeftWidth:'0',borderRightWidth:'0',borderTopWidth:'0',borderBottomWidth:'0',
 paddingLeft:'0',paddingRight:'0',paddingTop:'0',paddingBottom:'0'};
function video(style={},bounds={left:0,top:0,width:1600,height:900}){return{computed:{...base,...style},videoWidth:640,videoHeight:480,offsetWidth:1600,offsetHeight:900,getBoundingClientRect:()=>bounds};}
let v=video(),overlay={offsetParent:null};
let result=ctx.videoOverlayGeometry(v,overlay);
assert.deepEqual(plain(result),{left:200,top:0,width:1200,height:900,screenWidth:1200,screenHeight:900,clip:'inset(0px 0px 0px 0px)'});
win.scrollX=50;win.scrollY=120;
result=ctx.videoOverlayGeometry(v,overlay);near(result.left,250,'document scroll left');near(result.top,120,'document scroll top');
// Static body is the initial containing block, rather than the body's margin box.
body.computed={position:'static',transform:'none',filter:'none',perspective:'none',contain:'none',willChange:'auto'};
overlay.offsetParent=body;result=ctx.videoOverlayGeometry(v,overlay);near(result.left,250,'static body left');near(result.top,120,'static body top');
// Actual containing block has border + scrolling and a 2x ancestor transform.
const parent={computed:{position:'relative'},offsetWidth:1000,offsetHeight:800,clientLeft:4,clientTop:6,scrollLeft:10,scrollTop:20,
 getBoundingClientRect:()=>({left:100,top:200,width:2000,height:1600})};
overlay.offsetParent=parent;
v=video({width:'1640px',height:'940px',boxSizing:'border-box',borderLeftWidth:'5px',borderRightWidth:'5px',borderTopWidth:'5px',borderBottomWidth:'5px',paddingLeft:'15px',paddingRight:'15px',paddingTop:'15px',paddingBottom:'15px'},
 {left:140,top:260,width:3280,height:1880});
result=ctx.videoOverlayGeometry(v,overlay);
near(result.left,246,'scaled containing block left');near(result.top,64,'scaled containing block top');near(result.width,1200,'scaled local width');near(result.screenWidth,2400,'screen width');
v.computed.objectFit='cover';result=ctx.videoOverlayGeometry(v,overlay);assert.equal(result.clip,'inset(150px 0px 150px 0px)');
// Metadata absence still follows the CSS content box; zero layout waits for layout.
v.videoWidth=v.videoHeight=0;result=ctx.videoOverlayGeometry(v,overlay);near(result.width,1600,'metadata fallback width');near(result.height,900,'metadata fallback height');
assert.equal(ctx.videoOverlayGeometry(video({}, {left:0,top:0,width:0,height:0}),overlay),null);
// No playback callback is needed to resize a paused video's overlay.
win.scrollX=win.scrollY=0;const container={};v=video();v.parentElement=container;v.paused=true;
const canvas={parentNode:container,offsetParent:null,width:0,height:0,style:{}};
ctx.currentVideo=v;ctx.canvas=canvas;ctx.syncLayout();assert.equal(canvas.width,1200);assert.equal(canvas.height,900);assert.equal(canvas.style.left,'200px');assert.equal(aligned,1);
v.getBoundingClientRect=()=>({left:0,top:0,width:800,height:450});v.computed.width='800px';v.computed.height='450px';ctx.layoutDirty=true;ctx.syncLayout();
assert.equal(canvas.width,600);assert.equal(canvas.height,450);assert.equal(canvas.style.left,'100px');assert.equal(aligned,2);
ctx.syncLayout();assert.equal(aligned,2,'clean layout does not repeat work');
console.log('PASS: video layout preserves object fit, position, clipping, transformed/scrolled containing blocks and paused resizing.');
// display:none must not erase the real absolute containing block on resume.
win.scrollX=77;win.scrollY=123;
v=video();v.paused=true;
const hidden={style:{display:'none',visibility:'visible'}};
let measurements=0;
Object.defineProperty(hidden,'offsetParent',{get(){measurements++;return hidden.style.display==='none'?null:parent;}});
const visible={style:{display:'block'},offsetParent:parent};
assert.deepEqual(plain(ctx.videoOverlayGeometry(v,hidden)),plain(ctx.videoOverlayGeometry(v,visible)),'hidden and resumed overlays have identical containing-block geometry');
assert.equal(measurements,2);assert.deepEqual(hidden.style,{display:'none',visibility:'visible'},'measurement preserves visibility policy');
hidden.style.visibility='';ctx.videoOverlayGeometry(v,hidden);assert.equal(hidden.style.visibility,'','empty inline visibility restored');
let accesses=0;const throwing={style:{display:'none',visibility:'collapse'}};
Object.defineProperty(throwing,'offsetParent',{get(){if(++accesses===2)throw Error('measurement failed');return null;}});
assert.throws(()=>ctx.videoOverlayGeometry(v,throwing),/measurement failed/);
assert.deepEqual(throwing.style,{display:'none',visibility:'collapse'},'failed measurement restores both styles');
// Model MutationObserver's scoped delivery, rather than sending impossible events.
let observer,dirty=0,rescans=0;
class MockObserver{
 constructor(callback){this.callback=callback;this.targets=new Map();this.disconnects=0;observer=this;}
 observe(node,options){this.targets.set(node,options);}
 disconnect(){this.disconnects++;this.targets.clear();}
 deliver(record){const opts=this.targets.get(record.target);if(!opts)return;
  if(record.type==='attributes'&&(!opts.attributes||!opts.attributeFilter.includes(record.attributeName)))return;
  if(record.type==='childList'&&!opts.childList)return;
  this.callback([record]);}
}
const ancestor={parentElement:null},player={parentElement:ancestor},active={parentElement:player};
const watch=vm.createContext({MutationObserver:MockObserver,currentVideo:active,layoutObservedVideo:null,layoutObservedParent:null,layoutObservedCandidates:[],videoLayoutObserver:null,
 markDirty(){dirty++;},scheduleRescan(){rescans++;}});
const observeStart=source.indexOf('function observeVideoLayout('),observeEnd=source.indexOf('\nfunction scheduleRescan(',observeStart);
assert.ok(observeStart>0&&observeEnd>observeStart);vm.runInContext(source.slice(observeStart,observeEnd),watch);
watch.observeVideoLayout();assert.equal(observer.targets.size,3);assert.ok(observer.targets.has(active)&&observer.targets.has(player)&&observer.targets.has(ancestor));
const originalDisconnects=observer.disconnects;watch.observeVideoLayout();assert.equal(observer.disconnects,originalDisconnects,'unchanged ancestry does not reconnect');
for(const target of [active,player,ancestor])for(const attributeName of ['style','class'])observer.deliver({type:'attributes',target,attributeName});
assert.equal(dirty,6,'video and ancestor styles dirty layout');assert.equal(rescans,6,'CSS visibility changes must reconsider the selected player');
observer.deliver({type:'attributes',target:active,attributeName:'title'});
observer.deliver({type:'attributes',target:{parentElement:player},attributeName:'style'});
observer.deliver({type:'childList',target:player,addedNodes:[canvas],removedNodes:[]});
assert.equal(dirty,6,'unrelated attributes and overlay insertion do not trigger feedback');
const nextPlayer={parentElement:ancestor};active.parentElement=nextPlayer;
observer.deliver({type:'childList',target:player,addedNodes:[],removedNodes:[active]});
assert.equal(rescans,7);assert.equal(dirty,7);assert.ok(observer.targets.has(nextPlayer));assert.ok(!observer.targets.has(player),'old parent stops being observed after reparent');
observer.deliver({type:'childList',target:ancestor,addedNodes:[],removedNodes:[{contains:node=>node===active}]});
assert.equal(rescans,8,'removing a subtree containing video schedules recovery');
console.log('PASS: hidden layout measurement restores styles; scoped ancestry observation tracks CSS changes and player moves without canvas feedback.');
