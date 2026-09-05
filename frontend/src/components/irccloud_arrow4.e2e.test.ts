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
function makeMsgs(n:number, now:number){
  const arr=[];
  for(let i=0;i<n;i++) arr.push(createMessage({text:`msg-${i} `+'x'.repeat(40), t:now-(n-i)*1000, msgid:`m-${i}`, eid:1000+i, nick:'user'}));
  return arr;
}

describe('live message while reading - IRCCloud parity', ()=>{
  beforeEach(reset);

  it('scrollbar parity: read up 160px then a new message does not yank', async ()=>{
    const net=createNetwork({networkId:'net1'});
    net.buffers.push(createBuffer({name:'#chan',type:'channel'}));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId='net1';
    ircState.activeBuffer.bufferName='#chan';
    ircState.messages['net1:#chan']=makeMsgs(600, Date.now());
    flushSync();
    const onLoadMore=vi.fn(async()=>false);
    render(MessageList,{props:{onLoadMore}});
    flushSync();
    await nextFrame(); await delay(400);
    const c=document.getElementById('messages') as HTMLDivElement;
    c.style.height='400px'; c.style.overflowY='auto'; c.focus();
    await nextFrame(); await delay(300);
    // Reach the reading state the way a user can today (arrow keys no
    // longer scroll the log): wheel/scrollbar 160px up from the bottom.
    c.scrollTop = Math.max(0, c.scrollTop - 160);
    c.dispatchEvent(new Event('scroll'));
    await delay(80); await nextFrame();
    const midTop=c.scrollTop;
    expect(c.scrollHeight - midTop - c.clientHeight > 100).toBe(true);
    // inject new live message like IRCCloud bufferMessage while reading
    const nm=createMessage({text:'live', t:Date.now(), msgid:'m-live', eid:9999, nick:'other'});
    ircState.messages['net1:#chan']=[...(ircState.messages['net1:#chan']??[]), nm];
    flushSync();
    await delay(300); await nextFrame();
    expect(Math.abs(c.scrollTop - midTop) < 15, `new msg must not yank reading position mid=${midTop} now=${c.scrollTop}`).toBe(true);
  },20000);
});
