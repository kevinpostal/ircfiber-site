import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import MessageList from './MessageList.svelte';
import { createMessage, createNetwork, createBuffer } from '../test/factories';
import { ircState, prependMessages } from '../stores/ircStore.svelte';
import { clearedAtMap } from '../stores/preferences.svelte';

function reset() {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.messages = {};
  ircState.processedMessages = {};
  ircState.optimisticMessages.clear();
  ircState.backlogDivider = {};
}

describe('history anchor clean', () => {
  beforeEach(reset);
  it('scroll top preserves', async () => {
    await fetch('/login', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({username:'admin', password:'REDACTED'} as any), credentials:'include' });
    const netId='net1', buf='#superbowl', now=Date.now();
    const initial:any[]=[]; for(let i=0;i<600;i++) initial.push(createMessage({ text:`msg-${i}`, t: now-(600-i)*1000, msgid:`m-${i}`, eid:1000+i, nick:'user' }));
    const net=createNetwork({networkId:netId}); net.buffers.push(createBuffer({name:buf, type:'channel'})); ircState.networks.push(net); ircState.activeBuffer.networkId=netId; ircState.activeBuffer.bufferName=buf;
    ircState.messages[`${netId}:${buf}`]=initial; flushSync();
    const onLoadMore=vi.fn(async()=>{ const ex=ircState.messages[`${netId}:${buf}`]??[]; const oldest:any=ex[0]; if(!oldest||oldest.eid<=0) return false; const older:any[]=[]; const oldestT=oldest.t??now; for(let i=0;i<100;i++){const eid=oldest.eid-100+i; older.push(createMessage({text:`older-${eid}`, t: oldestT-(100-i)*1000, msgid:`m-${eid}`, eid, nick:'user'}));} prependMessages(netId,buf,older); return true; });
    render(MessageList,{props:{onLoadMore} as any}); flushSync();
    await new Promise(r=>requestAnimationFrame(r)); await new Promise(r=>setTimeout(r,200));
    const c=document.getElementById('messages') as HTMLDivElement; c.style.height='400px'; c.style.overflowY='auto';
    await new Promise(r=>requestAnimationFrame(r)); await new Promise(r=>setTimeout(r,300));
    console.log('initial', c.scrollTop, c.scrollHeight, c.scrollHeight-c.scrollTop-c.clientHeight);
    expect(Math.abs(c.scrollHeight-c.scrollTop-c.clientHeight)<=5).toBe(true);
    c.scrollTop=0; c.dispatchEvent(new Event('scroll')); await new Promise(r=>setTimeout(r,500)); await new Promise(r=>requestAnimationFrame(r));
    console.log('after1', c.scrollTop, c.scrollHeight, c.scrollHeight-c.scrollTop-c.clientHeight);
    expect(c.scrollHeight-c.scrollTop-c.clientHeight > 100).toBe(true);
    c.scrollTop=0; c.dispatchEvent(new Event('scroll')); await new Promise(r=>setTimeout(r,500)); await new Promise(r=>requestAnimationFrame(r));
    console.log('after2', c.scrollTop, c.scrollHeight, c.scrollHeight-c.scrollTop-c.clientHeight);
    expect(c.scrollHeight-c.scrollTop-c.clientHeight > 100).toBe(true);
    // network
    const hBefore=c.scrollHeight;
    c.scrollTop=0; c.dispatchEvent(new Event('scroll')); await new Promise(r=>setTimeout(r,900)); await new Promise(r=>requestAnimationFrame(r));
    console.log('afterNetwork', c.scrollTop, c.scrollHeight, c.scrollHeight-c.scrollTop-c.clientHeight, 'delta', c.scrollHeight-hBefore);
    expect(c.scrollHeight).toBeGreaterThan(hBefore);
    expect(c.scrollHeight-c.scrollTop-c.clientHeight > 100).toBe(true);
  }, 10000);
});
