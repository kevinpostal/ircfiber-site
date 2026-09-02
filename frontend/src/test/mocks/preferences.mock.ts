export function make_mock_preferences() {
  return {
    clearedAtMap: {} as Record<string, number>,
    unseenMap: {} as Record<string, number>,
    unseenHighlightsMap: {} as Record<string, number[]>,
    archivedMap: {} as Record<string, boolean>,
    ignoreList: [] as string[],
    highlightWords: [] as string[],
    membersCollapsedMap: {} as Record<string, boolean>,
  };
}
