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

describe('fast scroll up to load more', ()=>{
  beforeEach(reset);

  it('rapid top hits 3x must load 3 batches without wedge', async ()=>{
    const net=createNetwork({networkId:'net1'});
    net.buffers.push(createBuffer({name:'#chan',type:'channel'}));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId='net1';
    ircState.activeBuffer.bufferName='#chan';
    ircState.messages['net1:#chan']=makeMsgs(1000);
    flushSync();
    const onLoadMore=vi.fn(async()=>false);
    render(MessageList,{props:{onLoadMore}});
    flushSync();
    await nextFrame(); await delay(400);
    const c=document.getElementById('messages') as HTMLDivElement;
    c.style.height='400px'; c.style.overflowY='auto'; c.focus();
    await nextFrame(); await delay(300);
    expect(Math.abs(c.scrollHeight - c.scrollTop - c.clientHeight)<=5).toBe(true);
    const startH=c.scrollHeight;
    c.scrollTop = Math.max(0, c.scrollTop - 100);
    c.dispatchEvent(new Event('scroll'));
    await delay(80); await nextFrame();
    for(let batch=0; batch<3; batch++){
      // hammer top: set to 0, wait for half-way to settle before next batch (IRCCloud fetched half-way)
      c.scrollTop=0;
      c.dispatchEvent(new Event('scroll'));
      await delay(180);
      await nextFrame();
      const dist=c.scrollHeight - c.scrollTop - c.clientHeight;
      expect(dist>50, `batch ${batch}: must stay off bottom dist=${dist} top=${c.scrollTop}`).toBe(true);
      expect(c.scrollTop>30, `batch ${batch}: half-way not 0`).toBe(true);
      expect(c.querySelector('.backlogDivider')).not.toBeNull();
    }
    await delay(300); await nextFrame();
    expect(c.scrollHeight > startH + 1000, `must have loaded 3 batches: ${startH} -> ${c.scrollHeight}`).toBe(true);
    const maxScroll=c.scrollHeight - c.clientHeight;
    expect(c.scrollTop > 100 && c.scrollTop < maxScroll - 100).toBe(true);
  },20000);
});
