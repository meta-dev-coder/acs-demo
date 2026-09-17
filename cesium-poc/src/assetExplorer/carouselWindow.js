/**
 * How many asset cards are on screen, and which slice of the list they show.
 *
 * Kept out of the component so the paging rule can be tested without a DOM: it decides what the
 * user can see of a 47-asset corridor, which is worth asserting directly.
 */
/** How many cards are on screen at once. A corridor of 47 cameras is browsed, not scanned. */
export const VISIBLE_CARDS = 3;

/**
 * Which slice of the list is on screen, given the selection.
 *
 * The window follows the selection rather than the selection jumping to a page: stepping past the
 * edge slides the window by one, which keeps the neighbouring assets — the ones either side on the
 * road — where the eye expects them. Pure, so the paging rule is testable on its own.
 *
 * @returns {number} the index the window starts at
 */
export function cardWindowStart(total, selectedIndex, size = VISIBLE_CARDS, previousStart = 0) {
  if (total <= size) return 0;
  const maxStart = total - size;
  const start = Math.min(Math.max(previousStart, 0), maxStart);
  if (selectedIndex < 0) return start;
  if (selectedIndex < start) return selectedIndex;
  if (selectedIndex >= start + size) return Math.min(selectedIndex - size + 1, maxStart);
  return start;
}

