// Shared vitest browser-project setup (referenced from vite.config.ts
// `setupFiles`). Resets the module-level IRC store between tests so
// suites that seed `ircState` don't leak into each other — browser tests
// run with `fileParallelism: false` and share module state.
//
// The store is imported lazily inside the hook: a static import here
// would hoist above each test file's `vi.mock('/src/stores/wsConnection.svelte.ts')`
// / api mocks and silently defeat them (symptom: `sendRawMock.mockClear is
// not a function`).
import { beforeEach } from 'vitest';

beforeEach(async () => {
  const { ircState } = await import('../stores/ircStore.svelte');
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  for (const k of Object.keys(ircState.messages)) delete ircState.messages[k];
  for (const k of Object.keys(ircState.processedMessages)) delete ircState.processedMessages[k];
  ircState.contextMenu.visible = false;
});
