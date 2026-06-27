<script lang="ts">
  // IRCCloud .mainSpin equivalent — a simple centered spinner shown until
  // the WebSocket sync delivers the initial state.  No sidebar placeholders,
  // no partial UI — matches IRCCloud's pattern of "spinner or full app."

  let { networkNames }: { networkNames: string[] } = $props();
</script>

<div class="main-spin">
  <div class="main-spin__ring"></div>
  <div class="main-spin__text">Connecting to IRC Fiber…</div>
</div>

<style>
  .main-spin {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 16px;
    color: #8b949e;
    font-family: "Source Sans Pro", -apple-system, sans-serif;
    background: #0d1117;
  }

  .main-spin__ring {
    width: 36px;
    height: 36px;
    border: 3px solid #21262d;
    border-top-color: #58a6ff;
    border-radius: 50%;
    animation: main-spin-rotate 0.8s linear infinite;
  }

  @keyframes main-spin-rotate {
    to { transform: rotate(360deg); }
  }

  .main-spin__text {
    font-size: 13px;
    letter-spacing: 0.02em;
  }
</style>
