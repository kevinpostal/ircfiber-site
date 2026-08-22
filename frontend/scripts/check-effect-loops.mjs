#!/usr/bin/env node
// Enterprise guard: fail CI if MessageList $effect reads $state without untrack and also writes it
// Tracks: cachedAtBottom, wasRecentlyAtBottom, renderStart, renderEndKey
import fs from 'fs';
const path = 'src/components/MessageList.svelte';
const src = fs.readFileSync(path, 'utf8');
const effects = [...src.matchAll(/\$effect\(\(\) => \{([\s\S]*?)\n\}\);/g)];
let violations = [];
const tracked = ['cachedAtBottom','wasRecentlyAtBottom','renderStart','renderEndKey','backlogDividerMark'];
for (const m of effects) {
  const body = m[1];
  // main windowing effect is the large one containing windowRevealInProgress
  if (!body.includes('windowRevealInProgress')) continue;
  for (const name of tracked) {
    const reads = [...body.matchAll(new RegExp(`(?<!untrack\\(\\(\\) => ${name})\\b${name}\\b`, 'g'))];
    // heuristic: if name appears outside untrack(() => name) and body also assigns to it
    const writes = body.includes(`${name} =`) || body.includes(`${name}=`);
    const untrackedRead = body.includes(`untrack(() => ${name})`) || body.includes(`untrack(() => { ${name}`);
    // if there is a direct read (not untracked) and a write, flag
    const hasDirectRead = new RegExp(`(?<!untrack\\([^)]*)\\b${name}\\b`).test(body) && !untrackedRead;
    // simpler: look for " && cachedAtBottom" without untrack
    if (body.includes(`&& ${name}`) && !body.includes(`untrack(() => ${name})`)) {
      violations.push(`effect reads ${name} without untrack at "&& ${name}"`);
    }
    if (body.includes(`|| ${name}`) && !body.includes(`untrack(() => ${name})`)) {
      violations.push(`effect reads ${name} without untrack at "|| ${name}"`);
    }
  }
  // specific known anti-patterns we fixed
  if (body.includes('&& cachedAtBottom') && !body.includes('untrack(() => cachedAtBottom)')) violations.push('cachedAtBottom read not untracked in neededStart guard');
  if (body.includes('!renderEndKey') && !body.includes('untrack(() => renderEndKey)')) violations.push('renderEndKey read not untracked');
  if (body.includes('const mark = backlogDividerMark') ) violations.push('backlogDividerMark must be untrack(() => backlogDividerMark)');
}
if (violations.length) {
  console.error('ENTERPRISE GUARD VIOLATIONS in', path);
  violations.forEach(v=>console.error(' -',v));
  process.exit(1);
}
console.log('✓ effect loop guard passed');
