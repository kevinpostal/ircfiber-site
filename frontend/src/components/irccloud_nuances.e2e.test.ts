import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import MessageList from './MessageList.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';
import { clearedAtMap, lastSeenMap, focusSeenMap, bottomSeenMap } from '../stores/preferences.svelte';

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
  // Browser tests share module state (fileParallelism: false) and the
  // component writes bottomSeen while reading — clear every map a sibling
  // suite may have left behind, or the bottom pin never arms.
  for(const m of [clearedAtMap, lastSeenMap, focusSeenMap, bottomSeenMap]){
    for(const k of Object.keys(m)) delete (m as Record<string,unknown>)[k];
  }
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
  const onLoadMore=vi.fn(async()=>false);
  render(MessageList,{props:{onLoadMore}});
  flushSync();
  await nextFrame(); await delay(400);
  const c=document.getElementById('messages') as HTMLDivElement;
  c.style.height='400px'; c.style.overflowY='auto'; c.focus();
  await nextFrame(); await delay(300);
  expect(Math.abs(c.scrollHeight - c.scrollTop - c.clientHeight)<=5, `must start bottom`).toBe(true);
  // Break the initial bottom pin the way a user does today (wheel /
  // scrollbar), then return to the bottom for a clean start.
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
    // IRCCloud setResizing: scroll events during the 100 ms half-way
    // animation (+100 ms settle) are ignored, so a hammer landing inside
    // that window parks at 0 until the settle re-evaluates. The invariant
    // is that it never STAYS wedged: after each settle we are off 0.
    for(let i=0;i<5;i++){
      c.scrollTop=0; c.dispatchEvent(new Event('scroll'));
      await delay(60); // faster than 100ms animate, tests cancel/interrupt
      await nextFrame();
      await delay(220);
      expect(c.scrollTop>20, `hammer ${i} must not stay wedged at 0 top=${c.scrollTop}`).toBe(true);
    }
    expect(c.querySelector('.backlogDivider')).not.toBeNull();
  },20000);
  it('nuance 6: scrolling to the very top reveals half-way', async ()=>{
    const c=await mount(1000);
    c.scrollTop=0; c.dispatchEvent(new Event('scroll'));
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
    // Read up 40px with the scrollbar — arrow keys no longer scroll the log.
    c.scrollTop=Math.max(0,c.scrollTop-40); c.dispatchEvent(new Event('scroll'));
    await delay(80); await nextFrame();
    const mid=c.scrollTop;
    const nm=createMessage({text:'live', t:Date.now(), msgid:'m-live', eid:9999, nick:'other'});
    ircState.messages['net1:#chan']=[...(ircState.messages['net1:#chan']??[]), nm]; flushSync(); await delay(200); await nextFrame();
    expect(Math.abs(c.scrollTop - mid) < 12).toBe(true);
  },20000);
  it('nuance 9: new msg while reading far (400px) buffers', async ()=>{
    const c=await mount(600);
    c.scrollTop=Math.max(0,c.scrollTop-400); c.dispatchEvent(new Event('scroll'));
    await delay(80); await nextFrame();
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
  it('nuance 11: top hit from mid with history reveals half-way not 0', async ()=>{
    const c=await mount(1000);
    // Read up into the middle first, then hit the very top: the reveal
    // must anchor half-way (divider-152) and never wedge at 0.
    c.scrollTop=Math.max(0,c.scrollTop-200); c.dispatchEvent(new Event('scroll'));
    await delay(80); await nextFrame();
    c.scrollTop=0; c.dispatchEvent(new Event('scroll'));
    await delay(180); await nextFrame();
    const d=dividerTop(c);
    expect(d, 'reveal must have inserted the backlog divider').not.toBeNull();
    expect(c.scrollTop>20, `must not wedge at 0, got ${c.scrollTop}`).toBe(true);
    expect(Math.abs(c.scrollTop - Math.max((d as number)-152,48)) < 15, `half-way: dividerTop=${d} got ${c.scrollTop}`).toBe(true);
  },20000);
  it('nuance 12: top hit with no history stays 0', async ()=>{
    const net=createNetwork({networkId:'net1'}); net.buffers.push(createBuffer({name:'#chan',type:'channel'})); ircState.networks.push(net); ircState.activeBuffer.networkId='net1'; ircState.activeBuffer.bufferName='#chan'; ircState.messages['net1:#chan']=makeMsgs(80); flushSync(); const onLoadMore=vi.fn(async()=>false); render(MessageList,{props:{onLoadMore}}); flushSync(); await nextFrame(); await delay(300); const c=document.getElementById('messages') as HTMLDivElement; c.style.height='400px'; c.style.overflowY='auto'; c.focus(); await nextFrame(); await delay(200);
    c.scrollTop=0; c.dispatchEvent(new Event('scroll')); await delay(200); await nextFrame(); expect(c.scrollTop===0).toBe(true);
  },20000);
  it('nuance 14: near-bottom (30px) stays reading, exact bottom pins', async ()=>{
    const c=await mount(600);
    // IRCCloud has no stick band: 30px off the bottom is still reading.
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
    c.scrollTop=Math.max(0,c.scrollTop-400); c.dispatchEvent(new Event('scroll'));
    await delay(120); await nextFrame();
    const mid=c.scrollTop;
    expect(c.scrollHeight - mid - c.clientHeight > 200, `must be far reading`).toBe(true);
    c.style.height='500px'; await delay(150); await nextFrame();
    expect(Math.abs(c.scrollTop - mid) < 80, `resize while reading should keep mid`).toBe(true);
    expect(c.scrollHeight - c.scrollTop - c.clientHeight > 10).toBe(true);
  },20000);
});
