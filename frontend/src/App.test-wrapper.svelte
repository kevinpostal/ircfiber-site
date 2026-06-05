<script lang="ts">
  import { setContext } from 'svelte';
  import App from './App.svelte';
  import { make_mock_irc_state } from './test/mocks/ircState.mock';

  const state = make_mock_irc_state();
  setContext('ircState', state);
</script>

<App />
