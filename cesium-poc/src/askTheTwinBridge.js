/**
 * How the rest of the app asks the Twin a question.
 *
 * The incident panel is React and Ask the Twin is a vanilla module mounted on the body; neither
 * holds a reference to the other, and threading one through every component between them would
 * couple a details panel to a chat widget. A document event is the seam: anything can ask, and Ask
 * the Twin listens without knowing who asked.
 *
 * Kept in its own module so both sides import the name rather than repeating the string.
 */
export const ASK_THE_TWIN_EVENT = 'i595:ask-the-twin';

/**
 * Ask the Twin a question from anywhere.
 *
 * Does nothing when Ask the Twin is not mounted — a panel offering a question it cannot deliver is
 * a dead button, so callers check `canAskTheTwin()` before offering one.
 */
export function askTheTwin(question) {
  const text = String(question ?? '').trim();
  if (!text) return false;
  document.dispatchEvent(new CustomEvent(ASK_THE_TWIN_EVENT, { detail: { question: text } }));
  return true;
}

/** Whether Ask the Twin is on the page at all; its button is what the operator would otherwise use. */
export const canAskTheTwin = () => Boolean(document.querySelector('.ask-twin-btn'));
