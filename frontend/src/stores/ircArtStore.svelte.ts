export const ircArtPanelOpen = $state({ value: false });
export function openIrcArtPanel() { ircArtPanelOpen.value = true; }
export function closeIrcArtPanel() { ircArtPanelOpen.value = false; }
