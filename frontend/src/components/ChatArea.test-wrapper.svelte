<script lang="ts">
  import { setContext } from 'svelte';
  import ChatArea from './ChatArea.svelte';
  import { make_mock_irc_state } from '../test/mocks/ircState.mock';

  interface Props {
    onNickClick?: (nick: string, event: MouseEvent) => void;
  }
  let { onNickClick }: Props = $props();

  const state = make_mock_irc_state();
  setContext('ircState', state);
</script>

<ChatArea {onNickClick} />
