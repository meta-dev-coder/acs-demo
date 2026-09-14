/**
 * Floating panels the user can move out of the way.
 *
 * Every panel on this map is pinned by CSS to a corner it shares with the scene, and the thing a
 * user most often wants is to look at what is underneath it. Dragging by the panel's own heading
 * lets them put it anywhere, while a clamp keeps a strip of the heading on screen so a panel can
 * never be thrown somewhere it cannot be retrieved from.
 *
 * The panel keeps its dragged position for as long as it lives, so reopening it does not undo the
 * arrangement the user made. `reset()` returns it to wherever the stylesheet puts it.
 */

/** How much of the panel must stay within the viewport, in pixels. */
const KEEP_VISIBLE_PX = 56;

/** Controls inside a heading stay clickable: a drag must never swallow Close or Minimise. */
const INTERACTIVE = 'button, a, input, select, textarea, [role="button"]';

/** Below this the stylesheet docks panels to the screen edges, and dragging would fight it. */
const DOCKED_WIDTH_PX = 700;

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/**
 * @param {HTMLElement} panel   the floating element, positioned by CSS
 * @param {HTMLElement} handle  the part that is grabbed — normally the panel's heading
 * @param {{keepVisible?: number, isEnabled?: () => boolean}} [options]
 * @returns {{reset: () => void, destroy: () => void, moved: () => boolean}}
 */
export function makeDraggable(panel, handle, { keepVisible = KEEP_VISIBLE_PX, isEnabled } = {}) {
  if (!panel || !handle) return { reset() {}, destroy() {}, moved: () => false };
  let pointerId = null, grabX = 0, grabY = 0, moved = false;

  const enabled = () => (isEnabled ? isEnabled() : innerWidth > DOCKED_WIDTH_PX);

  /** Keep the handle reachable however the window is resized or wherever it was dropped. */
  function place(left, top) {
    const width = panel.offsetWidth, height = panel.offsetHeight;
    panel.style.left = `${clamp(left, keepVisible - width, innerWidth - keepVisible)}px`;
    panel.style.top = `${clamp(top, 0, Math.max(0, innerHeight - keepVisible))}px`;
    // The stylesheet pins these; a dragged panel is positioned from its top-left instead.
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function onPointerDown(event) {
    if (event.button !== 0 || !enabled() || event.target.closest(INTERACTIVE)) return;
    const rect = panel.getBoundingClientRect();
    grabX = event.clientX - rect.left;
    grabY = event.clientY - rect.top;
    pointerId = event.pointerId;
    handle.setPointerCapture?.(pointerId);
    panel.classList.add('is-dragging');
    // Stop the gesture reaching the globe underneath, which would spin the camera.
    event.preventDefault();
    event.stopPropagation();
  }

  function onPointerMove(event) {
    if (event.pointerId !== pointerId) return;
    moved = true;
    place(event.clientX - grabX, event.clientY - grabY);
  }

  function onPointerUp(event) {
    if (event.pointerId !== pointerId) return;
    handle.releasePointerCapture?.(pointerId);
    pointerId = null;
    panel.classList.remove('is-dragging');
  }

  // A window that shrinks must not strand a panel outside it.
  const onResize = () => {
    if (!moved) return;
    const rect = panel.getBoundingClientRect();
    place(rect.left, rect.top);
  };

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', onPointerUp);
  handle.addEventListener('pointercancel', onPointerUp);
  addEventListener('resize', onResize);
  handle.classList.add('panel-drag-handle');

  return {
    moved: () => moved,
    /** Hand the panel back to the stylesheet. */
    reset() {
      moved = false;
      for (const property of ['left', 'top', 'right', 'bottom']) panel.style.removeProperty(property);
    },
    destroy() {
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerUp);
      handle.removeEventListener('pointercancel', onPointerUp);
      removeEventListener('resize', onResize);
      handle.classList.remove('panel-drag-handle');
    },
  };
}
