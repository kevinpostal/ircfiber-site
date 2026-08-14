# WASM vs JS — Message History (2026-08-13)

Evaluation of whether porting message-history formatting/pipeline to WebAssembly would improve "lots of messages slow" (`wasm-message-history-eval-plan.md` Steps 1–2).

## Baseline (Step 1 — DOM-bound)

- `MessageList.svelte` windows DOM to `BATCH_SIZE 200` / `TRIM_THRESHOLD 200` / `TRIM_DETECT 350` + pixel guard `scrollHeight>12000→150`. `messagesWithDates = all.slice(start,end)` is the only DOM source. `perfMark` `processedMessages (cache hit)` already instrumented at `MessageList.svelte:126`.
- `ircState.messages[key]` + `processedMessages[key]` unbounded (Redis caps 5k/buffer, frontend never evicted) → GC + cold `preprocessMessages` O(N) once N=5–10k.
- Per-row work memoised `memoRenderText`/`memoBlockArt` LRU 500 (`formatCache.ts`) + `appendToProcessed` incremental. Cold rebuild still O(N) via `prependReprocess` on 100-row `LoadMore` of a 5k buffer.
- Scripting share in traces: Layout/Recalc Style/Paint dominates due to 200 `MessageRow` Svelte components each emitting dozens of `<span>`; `elementsFromPoint`/`getBoundingClientRect` limited to divider/sticky helpers with `scrollRafPending` coalescing.

Conclusion: bottleneck is DOM count + layout, not JS compute — WASM cannot create/layout DOM.

## Micro-bench (Step 2 — batch, no DOM)

Harness `frontend/bench_message_history.mjs` on Bun 1.3.9 / Node 24.3, synthetic 10k messages mixed formatting/URL/mention (50 nicks), 5 runs median:

| Stage | 10k total | per-msg | 200-row window |
|---|---:|---:|---:|
| `parseIrcFormatting` (ircFormatting.ts state machine `\x02\x1D\x1F\x16\x11\x1E\x0F\x03\x04` + mIRC 0-98/hex) | 10.6 ms | 1.1 µs | — |
| `autolinkHtml` (`splitTextOnLinks` `URL_REGEX`/`EMAIL_REGEX`/chanRegex, `stripTrailingPunc`) | 34.0 ms | 3.4 µs | — |
| `splitTextOnLinks` alone | 28.3 ms | 2.8 µs | — |
| `preprocessMessages` (groupMOTD/groupJoinPart/groupDisconnect) | 2.8 ms | 0.28 µs | — |
| `preprocessMessages` cold 5k | 1.0 ms | 0.20 µs | — |
| Full row render `parse+autolink` 10k | 102.9 ms | 10 µs | 1.52 ms / 200 rows (7.6 µs/msg) |
| WASM crossing proxy `TextEncoder`→`TextDecoder` 10k | 2.24 ms | 0.22 µs overhead baseline | — |

JIT detail: JS `RegExp` (`URL_REGEX`/`EMAIL_REGEX`) runs in V8 Irregexp (JIT C++); `parseIrcFormatting` loop is a tight `while(i < text.length)` scan. Copy cost via `wasm-bindgen` string = `TextEncoder.encode` + allocator + `TextDecoder.decode` dominates at this µs scale.

`200-row window (no cache)` = **1.52 ms = 9.5% of a 16 ms frame**. With LRU cache warm, <1.2 ms. This is already under the 5 ms `perfMeasure` budget for cache-hit.

### Why img2irc WASM wins but history does not

img2irc `wasm_img2irc` (35 KB, `wasm-opt -O4 --enable-simd`) won 13.3× (3271→246 ms) by batching **1.07 M per-cell `best_glyph` calls → 93 `batch_row_palette`/`batch_best_glyph` calls** over pure numeric loops (OKLab blend, palette LUT) with `PAL_CACHE thread_local`. 99.99% call reduction; compute was numeric and dispatch overhead dominated.

History stages are single-pass string scans + JIT regex. Batching still copies each string across the wasm boundary once → `~2.2 ms` crossing cost already ~40% of throughput, and the Rust regex/state-machine is at best parity with Irregexp. No amortisation possible as in img2irc.

## Decision (Step 3)

**Do not port message history to WASM.** Speedup criterion ≥1.5× batch after UTF-8 copy not met; expectation is 0.8–1.1× (variance copy-dominated). Keep JIT regex + LRU memoisation; ship DOM/memory fixes instead.

- `assetsInclude: ['**/*.wasm']` + `worker: {format:'es'}` in `vite.config.ts` unchanged (still covers `wasm-img2irc` `pkg/` dynamic `import('.../pkg/wasm_img2irc.js')` with `hasWasmSync`/`getWasmSync` fallback).
- No new `wasm-pack` step in `Containerfile` (`frontend-builder` stays `node:20 npm ci + build`; WASM `pkg/` pre-built and committed).
- Temptation-point note added at `ircFormatting.ts` header + `MessageRow.svelte` header: "WASM evaluated 2026-08-13 — DOM-bound, not adopted; see `wasm-message-history-report.md`".

## Fix that moves the needle (Step 4)

- **4a Cap JS memory:** `MAX_JS_MESSAGES 5000` FIFO per buffer on `batchAppendMessages`/`setMessages`/`prependMessages`/`appendMessage`; eviction also slices `processedMessages` via `buildProcessedBuffer` tail / `appendToProcessed` keep. Bounds GC + cold `preprocessMessages` to ≤5k. `LoadMore` `beforeid` pagination (`ChatArea.svelte:handleLoadMore` → `prependMessages`) reloads evicted history.
- **4b Harden window:** `contain: layout paint` on `.messages` + per-row `contain: layout` (IRCCloud-parity 200-row window). `content-visibility: auto` evaluated but removed — its `contain-intrinsic-size` estimate broke `scrollHeight` anchoring for `maybeTrim` pixel guard and `dividerPos` (10 MessageList scroll-pin tests failed). Re-evaluate only with a virtualizer that measures per-row intrinsic size.
- **4c Prepend cost:** capped N≤5k makes full `prependReprocess` ≤1 ms (bench 5k cold 1.03 ms median, re-run 0.93 ms window); optional head-group peeling reuses `appendToProcessed` trick but not required.
- **4d Worker optional:** if cold 5k still janks, move `preprocessMessages` to dedicated Worker (`img2irc.worker.ts` pattern) — not shipped.

Build/deploy: gateway-only `make frontend-build` → `make update-gateway` tar pipe to `/opt/ircfiber-src/public` + `docker build --target runtime-gateway`; no engine rebuild.

Verified: 200-row `perfMeasure` cache-hit stayed <2 ms; `document.querySelectorAll(MessageRow)` ≤220 while `ircState.messages[key].length` = 5000; `scrollHeight` bounded via `maybeTrim`; `npm run build` green.
