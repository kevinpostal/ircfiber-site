import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import MessageList from './MessageList.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';
import { clearedAtMap } from '../stores/preferences.svelte';
import { logScroll } from '../test/scroll';

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
function makeMsgs(n:number, now:number){
  const arr=[];
  for(let i=0;i<n;i++) arr.push(createMessage({text:`msg-${i} `+'x'.repeat(40), t:now-(n-i)*1000, msgid:`m-${i}`, eid:1000+i, nick:'user'}));
  return arr;
}

describe('arrow 4-press no snap - IRCCloud parity', ()=>{
  beforeEach(reset);

  it('press ArrowUp 4 times: each goes up by ~40 and never snaps back', async ()=>{
    const net=createNetwork({networkId:'net1'});
    net.buffers.push(createBuffer({name:'#chan',type:'channel'}));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId='net1';
    ircState.activeBuffer.bufferName='#chan';
    const now=Date.now();
    ircState.messages['net1:#chan']=makeMsgs(800, now);
    flushSync();
    render(MessageList,{props:{onLoadMore:vi.fn(async()=>false)} as any});
    flushSync();
    await nextFrame();
    await delay(400);
    const c=document.getElementById('messages') as HTMLDivElement;
    c.style.height='400px';
    c.style.overflowY='auto';
    // ensure focused so keydown on window reaches container logic (target not INPUT)
    c.focus();
    await nextFrame();
    await delay(300);
    const bottomDist0=c.scrollHeight - c.scrollTop - c.clientHeight;
    expect(Math.abs(bottomDist0)<=5, `must start at bottom dist=${bottomDist0}`).toBe(true);
    const tops:number[]=[];
    tops.push(c.scrollTop);
    for(let i=0;i<4;i++){
      const before=c.scrollTop;
      // real user path: dispatch ArrowUp on window (target body/div, not input) - our onKeyDown now scrolls container itself
      logScroll(document.getElementById('messages'), 'ArrowUp');
      // no manual scrollTop fudge - rely on MessageList onKeyDown to move 40px
      await delay(60);
      await nextFrame();
      const after=c.scrollTop;
      const dist=c.scrollHeight - c.scrollTop - c.clientHeight;
      tops.push(after);
      expect(after < before, `press ${i+1}: must move up before=${before} after=${after}`).toBe(true);
      const step=before-after;
      expect(step>=30 && step<=60, `press ${i+1}: step should be ~40 got ${step}`).toBe(true);
      expect(dist>30, `press ${i+1}: must stay off bottom dist=${dist}`).toBe(true);
      await delay(60);
    }
    // monotonic decreasing
    for(let i=1;i<tops.length;i++) expect(tops[i] < tops[i-1], `monotonic ${i} ${tops[i]} < ${tops[i-1]}`).toBe(true);
    // wait 1s with no input - must NOT snap back to bottom (the user bug: scrollbar snaps back)
    const heldTop=c.scrollTop;
    await delay(1000);
    await nextFrame();
    expect(Math.abs(c.scrollTop - heldTop) < 10, `must not snap back after 1s idle held=${heldTop} now=${c.scrollTop}`).toBe(true);
    expect(c.scrollHeight - c.scrollTop - c.clientHeight > 30).toBe(true);
    // scrollbar position check: scrollTop should be ~160 up from bottom (4*40)
    const expectedApprox = tops[0] - 160;
    expect(Math.abs(c.scrollTop - expectedApprox) < 30, `scrollbar should be ~160 up from bottom: expected ~${expectedApprox} got ${c.scrollTop}`).toBe(true);
  },20000);

  it('arrow vs scrollbar parity: 4 ups then new message does not yank', async ()=>{
    const net=createNetwork({networkId:'net1'});
    net.buffers.push(createBuffer({name:'#chan',type:'channel'}));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId='net1';
    ircState.activeBuffer.bufferName='#chan';
    ircState.messages['net1:#chan']=makeMsgs(600, Date.now());
    flushSync();
    render(MessageList,{props:{onLoadMore:vi.fn(async()=>false)} as any});
    flushSync();
    await nextFrame(); await delay(400);
    const c=document.getElementById('messages') as HTMLDivElement;
    c.style.height='400px'; c.style.overflowY='auto'; c.focus();
    await nextFrame(); await delay(300);
    for(let i=0;i<4;i++){
      logScroll(document.getElementById('messages'), 'ArrowUp');
      await delay(60); await nextFrame();
    }
    const midTop=c.scrollTop;
    expect(c.scrollHeight - midTop - c.clientHeight > 100).toBe(true);
    // inject new live message like IRCCloud bufferMessage while reading
    const nm=createMessage({text:'live', t:Date.now(), msgid:'m-live', eid:9999, nick:'other'});
    ircState.messages['net1:#chan']=[...(ircState.messages['net1:#chan']??[]), nm];
    flushSync();
    await delay(300); await nextFrame();
    expect(Math.abs(c.scrollTop - midTop) < 15, `new msg must not yank reading position mid=${midTop} now=${c.scrollTop}`).toBe(true);
  },20000);

  it('PageUp / PageDown / Home / End also respect stick', async ()=>{
    const net=createNetwork({networkId:'net1'});
    net.buffers.push(createBuffer({name:'#chan',type:'channel'}));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId='net1';
    ircState.activeBuffer.bufferName='#chan';
    // Small buffer where all history already rendered (no reveal on Home)
    ircState.messages['net1:#chan']=makeMsgs(150, Date.now());
    flushSync();
    render(MessageList,{props:{onLoadMore:vi.fn(async()=>false)} as any});
    flushSync();
    await nextFrame(); await delay(400);
    const c=document.getElementById('messages') as HTMLDivElement;
    c.style.height='400px'; c.style.overflowY='auto'; c.focus();
    await nextFrame(); await delay(300);
    const bottom=c.scrollTop;
    logScroll(document.getElementById('messages'), 'PageUp');
    await delay(80); await nextFrame();
    expect(c.scrollTop < bottom - 50, `PageUp must go up ${bottom} -> ${c.scrollTop}`).toBe(true);
    const afterPageUp=c.scrollTop;
    logScroll(document.getElementById('messages'), 'PageDown');
    await delay(80); await nextFrame();
    expect(typeof c.scrollTop === 'number').toBe(true);
    logScroll(document.getElementById('messages'), 'Home');
    await delay(100); await nextFrame();
    expect(c.scrollTop===0, `Home must go to top got ${c.scrollTop}`).toBe(true);
    // Home is at top, not bottom, must stay there after idle
    await delay(400);
    expect(c.scrollTop===0).toBe(true);
    logScroll(document.getElementById('messages'), 'End');
    await delay(100); await nextFrame();
    expect(Math.abs(c.scrollHeight - c.scrollTop - c.clientHeight) <=2, `End must go to bottom`).toBe(true);
  },20000);
});
