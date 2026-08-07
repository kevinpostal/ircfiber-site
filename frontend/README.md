# Frontend — IRC Fiber Svelte SPA

Vite + Svelte 5 + TypeScript UI for IRC Fiber.

## Layout
```
frontend/
├── src/
│   ├── components/      Svelte components
│   ├── lib/             Utilities (formatting, message handling)
│   ├── stores/          Svelte stores (ircStore, wsConnection, preferences)
│   ├── styles/          SCSS partials (base, components, layout, themes)
│   ├── admin/           Admin SPA (pages, components, stores)
│   ├── App.svelte
│   ├── main.ts
│   └── types.ts
├── public/              (sibling ../public) — static assets + Vite build output
├── index.html
├── vite.config.ts       publicDir: ../public, outDir: ../public/dist
├── svelte.config.js
├── tsconfig.json
└── package.json
```

## Dev
```bash
npm install
npm run dev              # Vite HMR, proxies /api + /ws to http://127.0.0.1:8090
npm run dev:local
npm run dev:tailnet
npm run build            # Vite build → ../public/dist + inject-manifest.js → ../engine/views/index.dt
npm run check            # svelte-check
npm test                 # vitest
```

## Integration
- `vite.config.ts` builds to `../public/dist` (shared with engine).
- `inject-manifest.js` post-build injects hashed asset URLs into `../engine/views/index.dt`.
- Top-level `make frontend` and `make frontend-dev` delegate here.
