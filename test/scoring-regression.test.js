import { test } from "node:test";
import assert from "node:assert/strict";
import { ScoringAdapter } from "../web_dance/scoring-adapter.js";
import { scoreEvent } from "../scoring/src/eventScorer.js";
import { distribution, PerfMonitor } from "../pose_capture/perf.js";
import { BONE_DEFS } from "../pose_capture/contract.js";
import { reconstructJoints } from "../pose_capture/playback.js";
const bones = Array.from({length:10},()=>[0,1,0]);
const frame = (t=0) => ({t,bones,conf:Array(10).fill(1)});
const sequence = () => ({meta:{fps:2,durationSec:1},bones:BONE_DEFS,frames:[frame(0),frame(.5),frame(1)],
  chart:{version:'chart/v1',notes:[0,.5,1].map((t,i)=>({id:String(i),t,type:'pose',lane:'body'}))}});
test('zero pose on time is a miss with zero score',()=>{
  const r=scoreEvent({t:1},{t:1,poseScore:0,conf:Array(10).fill(1)},{});
  assert.equal(r.grade,'miss'); assert.equal(r.eventScore,0);
});
test('one hit and two misses cannot earn S / 100%; finalize is idempotent',()=>{
  const s=new ScoringAdapter(sequence()); s.judge(0,frame()); s.advance(.2);
  const r=s.finalize(); assert.equal(r.grade,'D'); assert.equal(r.avgAcc,1/3);
  assert.deepEqual(r.tallies,{perfect:1,great:0,good:0,miss:2});
  assert.deepEqual(s.finalize(),r);
});
test('chart is sole source; final note at duration is settled',()=>{
  const seq=sequence(); seq.chart.notes=[{id:'end',t:1,type:'pose',lane:'body'}];
  const s=new ScoringAdapter(seq); s.judge(1,frame(1));
  const r=s.finalize(); assert.equal(r.tallies.perfect,1); assert.equal(r.tallies.miss,0);
});
test('no player frames still advances misses; no timing-only points',()=>{
  const s=new ScoringAdapter(sequence()); s.advance(2);
  assert.equal(s.finalize().tallies.miss,3); assert.equal(s.score,0);
});
test('equal poses prefer nearest beat and reset starts clean',()=>{
  const s=new ScoringAdapter(sequence()); s.judge(.36,frame(.36)); s.judge(.5,frame(.5));
  s.advance(.7); assert.equal(s.results.find(r=>r.noteId==='1').tier,'PERFECT');
  s.reset(); assert.equal(s.results.length,0); assert.equal(s.score,0);
});
test('low visible completeness cannot earn points',()=>{
  const s=new ScoringAdapter(sequence()); s.judge(.5,{...frame(.5),conf:[1,0,0,0,0,0,0,0,0,0]});
  assert.equal(s.finalize().score,0);
});
test('reference lookup uses actual timestamps',()=>{
  const seq=sequence(); seq.frames=[frame(0),frame(.9),frame(1)];
  assert.equal(new ScoringAdapter(seq).frameAt(.85).t,.9);
});
test('percentiles and bounded invalid samples',()=>{
  assert.deepEqual(distribution([1,2,3,4,100]),{count:5,avgMs:22,p50Ms:3,p95Ms:100,p99Ms:100,maxMs:100});
  const p=new PerfMonitor(); p.record('x',NaN); p.record('x',-1); p.record('x',4);
  assert.equal(p.report().stages.x.count,1);
});
test('shoulders can rotate independently from hips',()=>{
  const j=reconstructJoints({...frame(),rootYaw:0,shoulderAxis:[0,0,1]});
  assert.equal(j.left_shoulder[0],j.right_shoulder[0]);
  assert.ok(j.left_shoulder[2]<j.right_shoulder[2]);
  assert.ok(j.left_hip[0]<j.right_hip[0]);
});
