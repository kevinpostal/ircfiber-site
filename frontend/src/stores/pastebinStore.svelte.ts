/** Shared state for opening the snippet dialog from a text-file upload.
 *  App/DropTarget/UploadMenu set this via `openFromFile`; InputArea watches it
 *  and mirrors into its local PastebinDialog props. Keeps a single dialog
 *  instance (the one in InputArea) as the render site so we don't duplicate
 *  the IRCCloud paste UI.
 */

export const pastebinStore = $state({
  open: false,
  text: '',
  filename: '',
  language: 'text' as string,
  networkId: '',
  target: '',
});

// Called by uploadFlow when a single text file is dropped/picked.
export function openFromFile(opts: {
  text: string;
  filename: string;
  language: string;
  networkId: string;
  target: string;
}): void {
  pastebinStore.text = opts.text;
  pastebinStore.filename = opts.filename;
  pastebinStore.language = opts.language;
  pastebinStore.networkId = opts.networkId;
  pastebinStore.target = opts.target;
  pastebinStore.open = true;
}

export function closeFromFile(): void {
  pastebinStore.open = false;
}
