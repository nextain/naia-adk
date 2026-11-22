// Discard a late response when the user has already changed the selection.
export async function loadSelectedMessages(roomId, fetchMessages, currentSelection, expectedSelection = roomId) {
  const messages = await fetchMessages(roomId)
  return currentSelection() === expectedSelection ? messages : null
}
