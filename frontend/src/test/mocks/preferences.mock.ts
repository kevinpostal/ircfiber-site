export function make_mock_preferences() {
  return {
    clearedAtMap: {} as Record<string, number>,
    unreadMap: {} as Record<string, number>,
    highlightMap: {} as Record<string, boolean>,
    archivedMap: {} as Record<string, boolean>,
    ignoreList: [] as string[],
    highlightWords: [] as string[],
    membersCollapsedMap: {} as Record<string, boolean>,
  };
}
