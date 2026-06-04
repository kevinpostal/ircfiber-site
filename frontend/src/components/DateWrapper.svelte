<script lang="ts">
  import DateChange from './DateChange.svelte';

  interface Props {
    date: string;
    visible: boolean;
  }
  let { date, visible }: Props = $props();
</script>

<div class="dateWrapper" style:display={visible ? 'block' : 'none'}>
  <DateChange {date} />
</div>
