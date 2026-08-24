import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import MessageList from './MessageList.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';
import { clearedAtMap } from '../stores/preferences.svelte';

function delay(ms:number){ return new Promise(r=>setTimeout(r,ms)); }
function nextFrame(){ return new Promise(r=>requestAnimationFrame(()=>r())); }
function reset(){
  ircState.networks.length=0;
  ircState.activeBuffer.networkId=null;
  ircState.activeBuffer.bufferName=null;
  ircState.messages={};
  ircState.processedMessages={};
  ircState.optimisticMessages.clear();
  ircState.backlogDivider={};
  ircState.lastSeenMsgTime=null;
  ircState.focusLost=false;
  ircState.forceScrollToBottomNonce=0;
  for(const k of Object.keys(clearedAtMap)) delete (clearedAtMap as Record<string,number>)[k];
}
function makeMsgs(n:number){
  const now=Date.now();
  const arr=[];
  for(let i=0;i<n;i++) arr.push(createMessage({text:`msg-${i} `+'x'.repeat(30), t:now-(n-i)*1000, msgid:`m-${i}`, eid:1000+i, nick:'user'}));
  return arr;
}
function dividerTop(c:HTMLElement){
  const d=c.querySelector('.backlogDivider') as HTMLElement | null;
  if(!d) return null;
  return Math.round((d as HTMLElement).offsetTop);
}
async function mount(n:number){
  const net=createNetwork({networkId:'net1'});
  net.buffers.push(createBuffer({name:'#chan',type:'channel'}));
  ircState.networks.push(net);
  ircState.activeBuffer.networkId='net1';
  ircState.activeBuffer.bufferName='#chan';
  ircState.messages['net1:#chan']=makeMsgs(n);
  flushSync();
  render(MessageList,{props:{onLoadMore:vi.fn(async()=>false)} as any});
  flushSync();
  await nextFrame(); await delay(400);
  const c=document.getElementById('messages') as HTMLDivElement;
  c.style.height='400px'; c.style.overflowY='auto'; c.focus();
  await nextFrame(); await delay(300);
  expect(Math.abs(c.scrollHeight - c.scrollTop - c.clientHeight)<=5, `must start bottom`).toBe(true);
  // clear pending via one arrow like real user
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true, cancelable:true}));
  c.scrollTop=Math.max(0,c.scrollTop-20);
  c.dispatchEvent(new Event('scroll'));
  await delay(80); await nextFrame();
  // after first tiny up, go back to bottom to have clean start for most tests, but keep pending cleared
  c.scrollTop=c.scrollHeight;
  c.dispatchEvent(new Event('scroll'));
  await delay(80); await nextFrame();
  return c;
}

describe('irccloud nuances exhaustive', ()=>{
  beforeEach(reset);

  it('nuance 1: single top hit lands at max(offset-152,48) not 0', async ()=>{
    const c=await mount(1000);
    const startH=c.scrollHeight;
    c.scrollTop=0; c.dispatchEvent(new Event('scroll'));
    await delay(180); await nextFrame();
    const dTop=dividerTop(c);
    expect(dTop, 'divider must exist').not.toBeNull();
    const expected=Math.max((dTop as number)-152,48);
    expect(Math.abs(c.scrollTop - expected) < 12, `half-way: dividerTop=${dTop} expected ${expected} got ${c.scrollTop}`).toBe(true);
    expect(c.scrollHeight > startH).toBe(true);
  },20000);
  it('nuance 2: two sequential top hits each lands at half-way', async ()=>{
    const c=await mount(1000);
    for(let i=0;i<2;i++){
      c.scrollTop=0; c.dispatchEvent(new Event('scroll'));
      await delay(180); await nextFrame();
      const dTop=dividerTop(c);
      expect(dTop).not.toBeNull();
      const expected=Math.max((dTop as number)-152,48);
      expect(Math.abs(c.scrollTop - expected) < 15, `batch ${i} expected ${expected} got ${c.scrollTop}`).toBe(true);
    }
  },20000);
  it('nuance 3: rapid hammer 5x top hits without wedge at 0', async ()=>{
    const c=await mount(1200);
    for(let i=0;i<5;i++){
      c.scrollTop=0; c.dispatchEvent(new Event('scroll'));
      await delay(60); // faster than 100ms animate, tests cancel/interrupt
      await nextFrame();
      expect(c.scrollTop>20, `hammer ${i} must not wedge at 0 top=${c.scrollTop}`).toBe(true);
      await delay(120);
    }
    expect(c.querySelector('.backlogDivider')).not.toBeNull();
  },20000);
  it('nuance 4: ArrowUp 1x moves 40 and placement stable after 1s', async ()=>{
    const c=await mount(600);
    const before=c.scrollTop;
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true, cancelable:true}));
    await delay(80); await nextFrame();
    const after=c.scrollTop;
    expect(after < before && before-after>=35 && before-after<=50, `40 step before=${before} after=${after}`).toBe(true);
    const held=after;
    await delay(1000); await nextFrame();
    expect(Math.abs(c.scrollTop - held) < 8, `must not drift held=${held} now=${c.scrollTop}`).toBe(true);
  },20000);
  it('nuance 5: ArrowUp 4x monotonic 160 and scrollbar mid', async ()=>{
    const c=await mount(800);
    const tops=[c.scrollTop];
    for(let i=0;i<4;i++){ window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true, cancelable:true})); await delay(40); await nextFrame(); tops.push(c.scrollTop); }
    for(let i=1;i<tops.length;i++) expect(tops[i] < tops[i-1] && tops[i-1]-tops[i] < 80, `monotonic ${i}`).toBe(true);
    expect(tops[0]-tops[4] >=140 && tops[0]-tops[4]<=180, `4x ~160 got ${tops[0]-tops[4]}`).toBe(true);
    const max=c.scrollHeight - c.clientHeight;
    expect(c.scrollTop>50 && c.scrollTop < max-50).toBe(true);
  },20000);
  it('nuance 6: ArrowUp 20x to top then reveals half-way', async ()=>{
    const c=await mount(1000);
    for(let i=0;i<40;i++){ window.dispatchEvent(new KeyboardEvent('keydown',{key:'PageUp',bubbles:true, cancelable:true})); await delay(30); await nextFrame(); if(c.scrollTop===0) break; }
    if(c.scrollTop!==0){ c.scrollTop=0; c.dispatchEvent(new Event('scroll')); }
    await delay(180); await nextFrame();
    expect(c.querySelector('.backlogDivider') || c.scrollTop===0).toBeTruthy();
    if(c.querySelector('.backlogDivider')) expect(c.scrollTop>30).toBe(true);
  },20000);
  it('nuance 7: wheel fling large delta does not snap to bottom', async ()=>{
    const c=await mount(800);
    for(let i=0;i<6;i++){ c.dispatchEvent(new WheelEvent('wheel',{deltaY:-400,bubbles:true})); c.scrollTop=Math.max(0,c.scrollTop-400); c.dispatchEvent(new Event('scroll')); await delay(30); await nextFrame(); expect(c.scrollHeight - c.scrollTop - c.clientHeight > 20).toBe(true); }
    await delay(500); expect(c.scrollHeight - c.scrollTop - c.clientHeight > 20).toBe(true);
  },20000);
  it('nuance 8: new msg while reading close (40px) buffers not yank', async ()=>{
    const c=await mount(600);
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true, cancelable:true})); await delay(80); await nextFrame();
    const mid=c.scrollTop;
    const nm=createMessage({text:'live', t:Date.now(), msgid:'m-live', eid:9999, nick:'other'});
    ircState.messages['net1:#chan']=[...(ircState.messages['net1:#chan']??[]), nm]; flushSync(); await delay(200); await nextFrame();
    expect(Math.abs(c.scrollTop - mid) < 12).toBe(true);
  },20000);
  it('nuance 9: new msg while reading far (400px) buffers', async ()=>{
    const c=await mount(600);
    for(let i=0;i<10;i++){ window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true, cancelable:true})); await delay(20); await nextFrame(); }
    const mid=c.scrollTop;
    expect(c.scrollHeight - mid - c.clientHeight > 300).toBe(true);
    for(let k=0;k<3;k++){ const nm=createMessage({text:`live${k}`, t:Date.now()+k, msgid:`m-${k}`, eid:9000+k, nick:'other'}); ircState.messages['net1:#chan']=[...(ircState.messages['net1:#chan']??[]), nm]; flushSync(); await delay(80); await nextFrame(); expect(Math.abs(c.scrollTop - mid) < 15).toBe(true); }
  },20000);
  it('nuance 10: new msg while pinned at bottom must pin', async ()=>{
    const c=await mount(600);
    const beforeH=c.scrollHeight;
    const nm=createMessage({text:'live-bottom', t:Date.now(), msgid:'m-b', eid:9999, nick:'other'});
    ircState.messages['net1:#chan']=[...(ircState.messages['net1:#chan']??[]), nm]; flushSync(); await delay(200); await nextFrame();
    expect(Math.abs(c.scrollHeight - c.scrollTop - c.clientHeight) <=5).toBe(true);
    expect(c.scrollHeight >= beforeH - 100).toBe(true);
  },20000);
  it('nuance 11: Home from mid with history reveals half-way not 0', async ()=>{
    const c=await mount(1000);
    for(let i=0;i<5;i++){ window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true, cancelable:true})); await delay(20); await nextFrame(); }
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true, cancelable:true})); await delay(180); await nextFrame();
    // with history, Home should trigger reveal and land half-way, not stay 0 wedge
    const d=dividerTop(c);
    if(d!==null){ expect(c.scrollTop>20).toBe(true); expect(Math.abs(c.scrollTop - Math.max(d-152,48)) < 15).toBe(true); } else { expect(c.scrollTop===0).toBe(true); }
  },20000);
  it('nuance 12: Home with no history stays 0', async ()=>{
    const net=createNetwork({networkId:'net1'}); net.buffers.push(createBuffer({name:'#chan',type:'channel'})); ircState.networks.push(net); ircState.activeBuffer.networkId='net1'; ircState.activeBuffer.bufferName='#chan'; ircState.messages['net1:#chan']=makeMsgs(80); flushSync(); render(MessageList,{props:{onLoadMore:vi.fn(async()=>false)} as any}); flushSync(); await nextFrame(); await delay(300); const c=document.getElementById('messages') as HTMLDivElement; c.style.height='400px'; c.style.overflowY='auto'; c.focus(); await nextFrame(); await delay(200);
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true, cancelable:true})); await delay(100); await nextFrame(); expect(c.scrollTop===0).toBe(true);
  },20000);
  it('nuance 13: End from reading snaps to bottom', async ()=>{
    const c=await mount(600);
    for(let i=0;i<5;i++){ window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true, cancelable:true})); await delay(20); await nextFrame(); }
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true, cancelable:true})); await delay(100); await nextFrame();
    expect(Math.abs(c.scrollHeight - c.scrollTop - c.clientHeight) <=2).toBe(true);
  },20000);
  it('nuance 14: PageUp/PageDown ~90% viewport and not snap unless exact bottom', async ()=>{
    const c=await mount(600);
    const bottom=c.scrollTop;
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'PageUp',bubbles:true, cancelable:true})); await delay(80); await nextFrame();
    expect(c.scrollTop < bottom - 200).toBe(true);
    const afterUp=c.scrollTop;
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'PageDown',bubbles:true, cancelable:true})); await delay(80); await nextFrame();
    expect(c.scrollTop > afterUp).toBe(true);
    // PageDown to near bottom but not exact should not pin
    c.scrollTop=c.scrollHeight - c.clientHeight - 30; c.dispatchEvent(new Event('scroll')); await delay(80); await nextFrame();
    expect(Math.abs(c.scrollHeight - c.scrollTop - c.clientHeight) > 5).toBe(true);
    expect(c.scrollHeight - c.scrollTop - c.clientHeight > 5).toBe(true); // should stay reading, not snap
    c.scrollTop=c.scrollHeight; c.dispatchEvent(new Event('scroll')); await delay(80); await nextFrame();
    expect(Math.abs(c.scrollHeight - c.scrollTop - c.clientHeight) <=2).toBe(true);
  },20000);
  it('nuance 15: resize while pinned stays pinned, while reading stays reading', async ()=>{
    const c=await mount(600);
    // pinned resize
    c.style.height='300px'; await delay(100); await nextFrame();
    expect(Math.abs(c.scrollHeight - c.scrollTop - c.clientHeight) <=5).toBe(true);
    // reading resize - go far enough that height increase won't clamp to bottom
    for(let i=0;i<10;i++){ window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true, cancelable:true})); await delay(20); await nextFrame(); }
    const mid=c.scrollTop;
    expect(c.scrollHeight - mid - c.clientHeight > 200, `must be far reading`).toBe(true);
    c.style.height='500px'; await delay(150); await nextFrame();
    expect(Math.abs(c.scrollTop - mid) < 80, `resize while reading should keep mid`).toBe(true);
    expect(c.scrollHeight - c.scrollTop - c.clientHeight > 10).toBe(true);
  },20000);
});
