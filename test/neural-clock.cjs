// Controller replay with independent decoder callback and display clocks.
// Reuse the symbolic GPU fixture; no browser, real GPU or predicted pixels.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
const fixture = fs.readFileSync(path.join(__dirname, 'neural-buffered.cjs'), 'utf8');
const prefixEnd = fixture.indexOf('(async()=>{');
assert.ok(prefixEnd > 0, 'existing symbolic controller fixture');
const extract = name => {
  const begin = source.indexOf('function ' + name + '('), end = source.indexOf('\nfunction ', begin + 1);
  assert.ok(begin >= 0 && end > begin, 'shipped function ' + name);
  return source.slice(begin, end);
};
const anchorBegin = source.indexOf('const expected = Number(options.videoMetadata?.expectedDisplayTime);', source.indexOf('function draw('));
const anchorEnd = source.indexOf('gpuPairPending = fiAfterVideoUpload(currentVideo);', anchorBegin);
assert.ok(anchorBegin >= 0 && anchorEnd > anchorBegin, 'shipped source-upload anchor code');
const anchorCode = source.slice(anchorBegin, anchorEnd + 'gpuPairPending = fiAfterVideoUpload(currentVideo);'.length);
const flush = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
const D = 1000 / 60, P = 1000 / 165, base = 1000;

// Instrument only the fixture's environment. All timing and ownership decisions
// come from the current content.js functions that the fixture extracts.
const instrumentedVm = { ...vm, runInContext(code, context, ...options) {
  if (code.includes('globalThis.api={')) {
    const stub="const fiScheduleMidFrame=()=>{throw new Error('Buffered jobs use their own presentation scheduler');};";
    assert.ok(code.includes(stub));
    code=code.replace(stub,()=>extract('fiScheduleMidFrame'));
  }
  const result = vm.runInContext(code, context, ...options);
  if (code.includes('globalThis.api={')) vm.runInContext(`
    const fiDisplayLeads = [];
    let feedSessionManager = null, activeFeedSession = null;
    ${extract('ensureFeedSessionManager')}
    ${extract('beginFeedSession')}
    ${extract('fiObserveDisplayLead')}
    ${extract('fiObserveDisplayCallback')}
    const scheduleSingle = fiScheduleMidFrame;
    const originalEstimate = engine.estimate.bind(engine);
    engine.estimate = (...args) => {
      const promise = originalEstimate(...args), job = jobs[jobs.length - 1];
      job.started = now; job.slot = fiNeuralTarget; job.epoch = fiBufferedEpoch; job.buffered = fiBufferedMode;
      return promise;
    };
    draw = options => {
      if (fiRenderMidToOut(options.fiPhase, options.fiBuffered, options.fiPresentationTime)) presented.push({
        at:now, serial:options.fiBuffered?.serial ?? fiPairSerial, phase:options.fiPhase,
        pixel:fiOutTexture.pixel, compare:fiPresentedAnchor?.pixel, busy:engine.busy,
        currentSerial:fiPairSerial, epoch:fiBufferedEpoch
      });
    };
    Object.assign(api, {
      reference(time) { fiDisplayReference = time; },
      observe(time, metadata) { fiObserveDisplayLead(time, metadata); },
      leadState: () => ({lead:fiDisplayLeadMs, samples:[...fiDisplayLeads]}),
      setLead(value) { fiDisplayLeadMs = value; },
      observeCallback(time,executedAt) { now=executedAt;fiObserveDisplayCallback(time); },
      callbackState: () => ({delay:fiDisplayCallbackDelayMs,samples:[...fiDisplayCallbackDelays]}),
      estimateMs(value) { engine.stats.ms = value; },
      timing: () => engine.presentationTiming,
      seedTiming(samples,last,misses=0) {
        engine.stats.ms=last;
        engine.presentationTiming.samples=[...samples];
        engine.presentationTiming.deadlineMisses=misses;
      },
      tune(options) {
        if(options.profile!==undefined)settings.fiProfile=options.profile;
        if(options.debug!==undefined)settings.fiDebug=options.debug;
        if(options.model)engine.modelSize=options.model;
      },
      captureVideo(pixel,time,metadata,w=80,h=48) {
        now=time; currentVideo.videoWidth=w; currentVideo.videoHeight=h;
        textureWidth=w; textureHeight=h; texture.pixel=pixel;
        fiObserveDisplayLead(time, metadata);
        const options={frameTime:time,videoMetadata:metadata};let gpuPairPending;
        ${anchorCode}
        return {serial:fiPairSerial, requested:gpuPairPending, anchor:fiPairAnchorTime};
      },
      beginSource() { beginFeedSession(currentVideo,{force:true});resetFiPairState(); },
      sameSource() {
        feedSessionManager={ensure:()=>({id:feedSessionId,video:currentVideo})};
        beginFeedSession(currentVideo);
      },
      scheduleSingle: () => scheduleSingle(fiPairSerial,{expectedDisplayTime:fiPairAnchorTime}),
      clock: () => ({anchor:fiPairAnchorTime, reference:fiDisplayReference, lead:fiDisplayLeadMs,
        slot:fiNeuralTarget, serial:fiPairSerial, epoch:fiBufferedEpoch, session:feedSessionId})
    });
  `, context);
  return result;
} };
const fixtureScope = { assert, __dirname, require: name => name === 'node:vm' ? instrumentedVm : require(name), setImmediate };
vm.runInNewContext(fixture.slice(0, prefixEnd) + '\nglobalThis.makeClockHarness=harness;', fixtureScope, { filename: 'neural-clock-fixture.cjs' });
const harness = fixtureScope.makeClockHarness;

async function replay({ captures = 102, callbackLead = P, cost = () => 13, rate = 60 } = {}) {
  const h = harness(), duration = 1000 / rate;
  h.period(duration); h.display(165);
  let capture = 0, raf = 0, seen = 0, resolved = 0, cancelled = 0, steps = 0;
  const pending = [], budgets = [], outcomes = [], timings=[];
  while (capture < captures || pending.length) {
    assert.ok(++steps < 20000, 'bounded replay');
    const expected = base + Math.ceil(capture * duration / P) * P;
    const sourceAt = capture < captures ? expected - callbackLead : Infinity;
    const rafAt = base + raf * P, completionAt = pending[0]?.at ?? Infinity;
    const at = Math.min(sourceAt, rafAt, completionAt);
    h.time(at);
    // rVFC precedes rAF in a shared display turn. Sorting these in the opposite
    // order conceals the serial S+2 cancellation that caused the regression.
    if (sourceAt === at) {
      h.captureVideo('frame-' + capture, at, { expectedDisplayTime: expected });
      h.latency(); if (h.inspect().buffered) h.schedule(); else h.scheduleSingle(); capture++;
    }
    if (completionAt === at) {
      const completion = pending.shift(), job = h.jobs()[completion.index];
      const valid = completion.finished && job.options.valid();
      h.resolve(completion.index, { valid, elapsedMs:completion.elapsed, cachedEncoder:true, reason:!completion.finished&&job.options.valid()?"deadline":valid?undefined:"pair replaced" });
      outcomes.push({index:completion.index,valid,elapsed:completion.elapsed});
      if (valid) resolved++; else cancelled++;
      await flush();
    }
    if (rafAt === at) { h.reference(at); h.tick(at); raf++; }
    await flush();
    while (seen < h.jobs().length) {
      const index = seen++, job = h.jobs()[index], compute = cost(index), budget = job.options.deadline - job.started;
      budgets.push(budget);
      pending.push({index,at:Math.min(job.started+compute,job.options.deadline),elapsed:Math.min(compute,budget),finished:compute<=budget});
    }
    pending.sort((a,b)=>a.at-b.at);
    if(h.timing())timings.push(plain(h.timing()));
    assert.ok(at <= base + captures * duration + 1000, 'jobs eventually drain');
  }
  const state = h.inspect(), bySerial = new Map(h.jobs().map(job => [job.serial, job]));
  for (const shown of state.presented) {
    const job = bySerial.get(shown.serial); assert.ok(job, 'presented prediction belongs to a requested job');
    assert.equal(shown.phase, job.phase, 'display-clock conversion never relabels inferred phase');
    assert.equal(shown.pixel.phase, job.phase);
    assert.equal(shown.epoch, job.epoch, 'presentation stays in the source epoch');
    if (job.buffered) assert.equal(shown.currentSerial, shown.serial + 1, 'only the adjacent buffered history may present');
    else assert.equal(shown.currentSerial, shown.serial, 'one-frame path retains its same-pair guard');
    assert.ok(shown.at + job.slot.leadMs >= job.slot.time - .5, 'presentation does not precede the projected display slot');
    assert.ok(shown.at + job.slot.leadMs <= job.slot.expires, 'presentation does not use an expired projected display slot');
  }
  return {h,state,resolved,cancelled,budgets,outcomes,timings};
}

(async () => {
  const normal = await replay();
  assert.ok(normal.resolved >= 100, '13ms inference completes nearly every 60fps adjacent pair');
  assert.ok(normal.state.presented.length >= 99, '165Hz projected display clock presents nearly all eligible midpoints');
  assert.ok(normal.state.presented.length <= 100, 'at most one midpoint per eligible delayed pair');
  assert.equal(normal.cancelled, 0);
  for (const rate of [40,45,50]) {
    const paced=await replay({captures:102,rate});
    assert.ok(paced.state.presented.length>=99,rate+' fps preserves alternating source/midpoint presentation');
    assert.equal(paced.cancelled,0,rate+' fps inference fits the buffered window');
    assert.ok(paced.h.jobs().every(job=>job.buffered),rate+' fps uses adjacent buffered history');
  }
  assert.ok(Math.abs(normal.h.leadState().lead - P) < 1e-9, 'learn the observed one-vsync callback lead');
  for (const job of normal.h.jobs()) {
    assert.ok(Math.abs(job.options.deadline - (job.slot.expires - job.slot.leadMs)) < 1e-9,
      'runtime deadline is in CPU time, distinct from the display-time slot');
  }

  // A first inference cannot fit its full cost. It drains at its CPU deadline,
  // leaving a valid cached encoder; subsequent complete costs must be learned.
  const recovering = await replay({captures:300,callbackLead:0,cost:index=>index===0?40:20});
  assert.equal(recovering.outcomes[0].valid,false,'first 40ms job is cancelled rather than counted as complete');
  assert.ok(recovering.budgets[0]<40);
  assert.ok(recovering.cancelled > 0, 'cold overload really exercises deadline cancellation');
  assert.ok(recovering.resolved >= 100, 'a cancelled cold result does not starve later 20ms jobs');
  // A queued pair can start with less budget than its already-known full
  // cost. That deadline miss does not prove GPU throughput became slower
  // and must not repeatedly move subsequent jobs into unusably late slots.
  assert.ok(recovering.state.presented.length >= 87, 'known-cost short budgets cannot trigger probes that lose valid warm presentation slots');
  assert.equal(recovering.state.stats.ms,20,'only full warm completion establishes inference cost');
  assert.ok(recovering.h.jobs().some(job=>job.started>base+3000 && job.settled), 'recovery persists beyond initialization');

  // Exercise the one-frame path with the same observed callback/display lead.
  const single = await replay({captures:80,rate:30});
  assert.ok(single.state.presented.length >= 70, '30fps one-frame neural presentation uses projected display time too');

  // Learn cost increases that still fit a real refresh before the next source
  // anchor; partial work must not become a measured full inference cost.
  const shift = await replay({captures:150,rate:30,cost:index=>index<20?9:23});
  assert.ok(shift.outcomes.slice(-30).filter(o=>o.valid).length>=27,'sustained 23ms inference recovers after learning 9ms regime');
  assert.ok(shift.state.presented.filter(p=>p.at>base+3500).length>=30,'recovery produces visible frames late in replay');
  assert.equal(shift.state.stats.ms,23,'diagnostics retain actual last inference');
  assert.ok(shift.timings.every(t=>t.samples.length<=8),'cost history stays bounded');
  assert.ok(shift.h.timing().samples.every(ms=>ms===23),'cancelled partial times never become complete cost measurements');
  const nearLimit = await replay({captures:150,rate:30,cost:index=>index<20?9:24});
  assert.ok(nearLimit.outcomes.slice(20).filter(o=>!o.valid).length>=2,'24ms increase cancels at least two old-estimate deadlines');
  assert.ok(nearLimit.timings.some(t=>t.deadlineMisses>=2),'repeated genuine misses activate the recovery probe');
  assert.ok(nearLimit.timings.some(t=>t.samples.length===1&&t.samples[0]===24&&t.deadlineMisses===0),'successful probe drops obsolete costs before learning the new regime');
  assert.ok(nearLimit.outcomes.slice(-30).filter(o=>o.valid).length>=27,'near-limit recovery completes sustained new work');
  assert.ok(nearLimit.state.presented.filter(p=>p.at>base+3500).length>=30,'near-limit recovery reaches visible valid refreshes');
  assert.ok(nearLimit.h.timing().samples.every(ms=>ms===24),'partial deadline work is excluded from the recovered full-cost history');
  console.log('PASS near-limit deadline recovery: 9 to 24ms '+nearLimit.state.presented.length+' mids/'+nearLimit.resolved+' completed, '+nearLimit.cancelled+' cancelled.');
  const overWindow = await replay({captures:150,rate:30,cost:index=>index<20?9:32});
  assert.ok(overWindow.outcomes.slice(20).some(o=>!o.valid),'over-capacity cost increase exercises actual deadline cancellation');
  assert.ok(overWindow.state.presented.length>=15,'feasible warm frames were presented before capacity changed');
  assert.equal(overWindow.state.presented.filter(p=>p.at>base+3500).length,0,'32ms work with callback lead is not presented after its valid refresh window');
  assert.equal(overWindow.state.serial,151,'all 150 source captures advance past the initial timeline reset despite infeasible interpolation');
  console.log('PASS learned-cost recovery: 9 to 23ms with callback lead '+shift.state.presented.length+' mids; 32ms outside usable refresh window safely skipped.');
  const alternating = await replay({captures:150,rate:30,cost:index=>index%2?20:9});
  assert.ok(alternating.outcomes.slice(-50).filter(o=>o.valid).length>=47,'alternating warm costs complete consistently');
  assert.ok(alternating.state.presented.length>=125,'stable estimate preserves presentation with alternating execution costs');
  const coldOutlier = await replay({captures:120,rate:30,cost:index=>index===15?30:9});
  assert.ok(coldOutlier.outcomes.slice(-40).every(o=>o.valid),'one expensive inference cannot permanently distort admission');
  assert.ok(coldOutlier.h.timing().samples.every(ms=>ms===9),'rolling window forgets the isolated cold cost');

  // A new key must learn only its own source, model shape and settings regime.
  for(const change of ['source','size','profile','debug','model']) {
    const keyed=harness();keyed.captureVideo('A',1000);keyed.captureVideo('B',1000+D);
    keyed.resolve(0,{elapsedMs:9});await flush();
    const oldTiming=plain(keyed.timing());assert.deepEqual(oldTiming.samples,[9]);
    if(change==='source')keyed.beginSource();
    else if(change==='profile')keyed.tune({profile:'balanced'});
    else if(change==='debug')keyed.tune({debug:1});
    else if(change==='model')keyed.tune({model:{width:320,height:192}});
    const dimensions=change==='size'?[96,64]:[80,48];
    keyed.captureVideo('C',1000+2*D,undefined,...dimensions);
    if(keyed.timing().key===oldTiming.key)keyed.captureVideo('D',1000+3*D,undefined,...dimensions);
    assert.notEqual(keyed.timing().key,oldTiming.key,change+' changes cost identity');
    assert.deepEqual(plain(keyed.timing().samples),[],change+' cannot inherit former complete costs');
  }
  const partial=harness();partial.captureVideo('A',1000);partial.captureVideo('B',1000+D);
  partial.resolve(0,{valid:false,elapsedMs:5,reason:'cancelled'});await flush();
  assert.deepEqual(plain(partial.timing().samples),[],'non-deadline cancellation never populates full history');
  assert.equal(partial.timing().deadlineMisses,0,'source cancellation is not a deadline miss');

  // Native ABBA playback showed that buffering already provides its own
  // timing margin. Smoothed costs and latest-slot probes must not move these
  // 60fps predictions into a refresh overwritten by the next source capture.
  async function bufferedSlot(samples,last,misses=0) {
    const h=harness();h.captureVideo('A',1000);h.captureVideo('B',1000+D);
    h.resolve(0,{elapsedMs:9});await flush();
    h.seedTiming(samples,last,misses);
    h.reference(1003); // Two feasible refresh choices distinguish last-cost selection.
    h.captureVideo('C',1000+2*D);
    const job=h.jobs().at(-1);
    assert.ok(job.serial>h.jobs()[0].serial,'comparison requests a fresh adjacent buffered pair');
    return plain(job.slot);
  }
  const bufferedFast=await bufferedSlot([9],9);
  const bufferedSlowHistory=await bufferedSlot(Array(8).fill(20),9,2);
  assert.deepEqual(bufferedSlowHistory,bufferedFast,'buffered slots follow actual last cost despite slow history and accumulated probe hints');
  const bufferedSlow=await bufferedSlot([26],26);
  const bufferedFastHistory=await bufferedSlot(Array(8).fill(9),26);
  assert.deepEqual(bufferedFastHistory,bufferedSlow,'buffered slots follow last complete cost rather than faster historical samples');
  assert.ok(bufferedSlow.time>bufferedFast.time,'a slower last completion really requests a later feasible buffered slot');
  const bufferedTiming=await replay({captures:300,callbackLead:0,cost:index=>index===0?40:20});
  assert.ok(bufferedTiming.timings.every(t=>t.deadlineMisses===0),'buffered deadline cancellations never accumulate one-frame recovery probes');
  assert.ok(bufferedTiming.state.presented.length>=87,'buffered policy preserves established cold recovery cadence');

  const lead = harness();
  for (const offset of [5.9,6.1,6,5.8,6.2,6.05,5.95,6.08,5.98,6.02,6.04,5.96]) lead.observe(1000,{expectedDisplayTime:1000+offset});
  const learned = plain(lead.leadState());
  assert.equal(learned.samples.length,12);assert.ok(Math.abs(learned.lead-6.02)<1e-8,'rolling median resists callback jitter');
  for (const metadata of [null,{}, {expectedDisplayTime:NaN},{expectedDisplayTime:Infinity},{expectedDisplayTime:1000+P*2+.01},{expectedDisplayTime:1000-P*.25-.01}]) lead.observe(1000,metadata);
  lead.observe(NaN,{expectedDisplayTime:1000});
  assert.deepEqual(plain(lead.leadState()),learned,'invalid/stale/outlier clock samples do not poison calibration');
  lead.observe(1000,{expectedDisplayTime:1000-P*.1});
  assert.equal(lead.leadState().samples.length,12);assert.equal(lead.leadState().samples.at(-1),0,'small negative lead is clamped to zero');
  lead.sameSource();assert.ok(lead.leadState().lead>0,'same feed session retains calibration');
  // A fresh fixture has no manager, so production creates a new source id.
  const fresh = harness();fresh.observe(1000,{expectedDisplayTime:1006});fresh.beginSource();
  assert.deepEqual(plain(fresh.leadState()),{lead:0,samples:[]},'new feed session discards the previous source clock');
  const fallback = harness();fallback.observe(1000,{expectedDisplayTime:1006});
  const fallbackCapture = fallback.captureVideo('fallback',1100,undefined);
  assert.equal(fallbackCapture.anchor,1106,'metadata-free rAF capture anchors to projected display time');
  assert.equal(fallback.captureVideo('metadata',1110,{expectedDisplayTime:1115}).anchor,1115,'rVFC metadata remains the authoritative display anchor');

  // A slot retains the calibration used for inference, even if later samples
  // change the median. Rendering and expiry must use that fixed projection.
  const fixed = harness();fixed.captureVideo('A',1000,{expectedDisplayTime:1006});fixed.latency();
  fixed.captureVideo('B',1000+D,{expectedDisplayTime:1000+D+6});
  const job = fixed.jobs()[0], pair = fixed.pair(job.serial), fixedLead = pair.slot.leadMs;
  fixed.time(job.started+13);fixed.resolve(0,{elapsedMs:13});await flush();
  fixed.captureVideo('C',1000+2*D,{expectedDisplayTime:1000+2*D+6});fixed.latency();
  fixed.setLead(0);fixed.schedule();fixed.tick(pair.slot.time-fixedLead);
  assert.equal(fixed.inspect().presented.length,1,'stored slot lead survives calibration updates');
  assert.equal(fixed.inspect().presented[0].phase,job.phase);
  fixed.time(pair.slot.expires-fixedLead+.01);
  assert.equal(fixed.render(pair,pair.slot.phase),false,'CPU-time rendering expiry uses the same fixed slot lead');

  // Regression from Firefox traces: the refresh is eligible, but execution of
  // its callback starts after expires. The renderer must keep the scheduler's
  // timestamp instead of rejecting that same refresh using performance.now().
  for (const rate of [60,30]) {
    const delayed=harness(),duration=1000/rate;
    delayed.period(duration);
    delayed.captureVideo('A',1000);
    delayed.captureVideo('B',1000+duration);
    const pending=delayed.jobs()[0],slot=pending.slot;
    delayed.time(pending.started+8);delayed.resolve(0);await flush();
    delayed.latency();
    if(rate===60){delayed.captureVideo('C',1000+2*duration);delayed.schedule();}
    else delayed.scheduleSingle();
    delayed.tick(slot.time-slot.leadMs,slot.expires-slot.leadMs+.25);
    assert.equal(delayed.inspect().presented.length,1,rate+'fps keeps the admitted refresh through WebGL rendering');
    assert.equal(delayed.inspect().presented[0].phase,pending.phase,'callback delay cannot relabel the prediction');
    delayed.time(slot.expires-slot.leadMs+.25);
    if(rate===60)assert.equal(delayed.render(delayed.pair(pending.serial),pending.phase),false,'unscheduled expired rendering is still rejected');
  }

  const callback=harness();
  for(const delay of [2.7,2.9,2.8,2.6,3,2.85,2.75,2.88,2.78,2.82,2.84,2.76])callback.observeCallback(1000,1000+delay);
  const measured=plain(callback.callbackState());
  assert.equal(measured.samples.length,12);
  assert.ok(Math.abs(measured.delay-2.82)<1e-8,'learn execution offset from this browser, not its name or hardware');
  for(const [time,actual] of [[NaN,1000],[1000,Infinity],[1000,999],[1000,1100]])callback.observeCallback(time,actual);
  assert.deepEqual(plain(callback.callbackState()),measured,'invalid timestamps and exceptional stalls do not inflate the execution budget');
  callback.beginSource();
  assert.deepEqual(plain(callback.callbackState()),{delay:0,samples:[]},'new source clears callback timing calibration');

  async function slotWithCallbackDelay(delay) {
    const h=harness();h.period(1000/30);
    h.captureVideo('A',1000);h.captureVideo('B',1000+1000/30);
    h.time(1051);h.resolve(0,{elapsedMs:17});await flush();
    h.reference(1003);h.observeCallback(1060,1060+delay);
    h.captureVideo('C',1000+2000/30);
    return h.jobs().at(-1);
  }
  const withoutOffset=await slotWithCallbackDelay(0),withOffset=await slotWithCallbackDelay(3);
  assert.ok(withOffset.slot.time<withoutOffset.slot.time,'execution offset can make an earlier refresh reachable instead of pushing every prediction toward the next anchor');
  assert.ok(withOffset.slot.time-withOffset.slot.leadMs+3>=withOffset.started+17,'earlier refresh still leaves the complete measured inference budget');
  assert.equal(withOffset.phase,withOffset.slot.phase,'phase belongs to the selected refresh');
  assert.equal(withOffset.options.deadline,withOffset.slot.expires-withOffset.slot.leadMs+3,'runtime deadline uses the frozen execution offset');

  const completion=harness();completion.observeCallback(990,995);
  completion.captureVideo('A',1000);completion.captureVideo('B',1000+D);
  const completing=completion.jobs()[0],completionPair=completion.pair(completing.serial);
  completion.captureVideo('C',1000+2*D);completion.latency();completion.schedule();
  const finishedAt=completionPair.slot.time+4;
  assert.ok(finishedAt>completionPair.slot.expires,'fixture finishes beyond the old unconverted deadline');
  completion.time(finishedAt);completion.resolve(0,{elapsedMs:finishedAt-completing.started});await flush();
  assert.equal(completionPair.ready,true,'completion before the delayed callback retains its prediction');
  completion.tick(completionPair.slot.time,completionPair.slot.time+5);
  assert.equal(completion.inspect().presented.length,1,'delayed callback consumes the result using the unchanged display slot');

  const early = harness();early.captureVideo('A',1000,{expectedDisplayTime:1006});
  early.captureVideo('B',1000+D,{expectedDisplayTime:1000+D+6});
  const old = early.jobs()[0];early.captureVideo('C',1000+2*D,{expectedDisplayTime:1000+2*D+6});
  const beforeDeadline = old.options.deadline-.1;
  early.captureVideo('D',beforeDeadline,{expectedDisplayTime:1000+3*D+6});
  assert.ok(beforeDeadline<old.options.deadline);assert.equal(old.options.valid(),false,'hard S+2 guard survives display projection');
  early.resolve(0,{elapsedMs:13});await flush();assert.equal(early.inspect().renders.length,0,'no synthesis from overwritten endpoints');
  const retired = harness();retired.captureVideo('A',1000,{expectedDisplayTime:1006});
  retired.captureVideo('B',1000+D,{expectedDisplayTime:1000+D+6});
  const retiredJob = retired.jobs()[0];retired.beginSource();
  assert.equal(retiredJob.options.valid(),false);assert.equal(retiredJob.options.cacheValid(),false,'old source epoch cannot retain a neural cache');
  retired.resolve(0,{elapsedMs:13});await flush();assert.equal(retired.inspect().renders.length,0);
  console.log('PASS neural clock: 60/165 replay '+normal.state.presented.length+' mids/'+normal.resolved+' completions; cold recovery '+recovering.state.presented.length+' mids/'+recovering.resolved+' completions.');
  console.log('PASS neural clock: fixed display projection, CPU deadlines, exact inferred phase, source/serial guards, median validation and feed reset.');
})().catch(error=>{console.error(error);process.exitCode=1;});
