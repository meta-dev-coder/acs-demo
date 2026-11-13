/** Covers the viewport until the 3D environment answers — success or failure. */
export function LoadingOverlay() {
  return (
    <div className="app-loading" role="status" aria-live="polite">
      <span className="app-loading-ring" aria-hidden="true" />
      <span className="app-loading-title">Loading PortMiami</span>
      <span className="app-loading-note">Preparing the 3D environment…</span>
    </div>
  );
}
