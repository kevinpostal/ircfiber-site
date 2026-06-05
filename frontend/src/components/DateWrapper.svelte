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

<style>
  .dateWrapper {
    position: sticky;
    top: 0;
    z-index: 10;
  }
</style>
