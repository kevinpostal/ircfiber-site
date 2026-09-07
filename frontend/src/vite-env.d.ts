/// <reference types="vite/client" />

declare module 'virtual:figlet-meta' {
  /** figlet font name → glyph row height, read from the .flf headers at build time. */
  const rows: Record<string, number>;
  export default rows;
}
