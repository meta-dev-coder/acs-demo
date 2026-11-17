import { LOCATION } from '../config/portMiami.js';

/** The project's name bar, and the one piece of navigation there is: Ask the Twin. */
export function TopNav({ project, askOpen, onToggleAsk }) {
  return (
    <header className="app-nav">
      <div className="app-nav-identity">
        <h1>{project.name}</h1>
        <p>{project.subtitle}</p>
      </div>
      {onToggleAsk && (
        <button
          type="button"
          className="app-nav-ask"
          aria-pressed={askOpen}
          onClick={onToggleAsk}
        >
          Ask the Twin
        </button>
      )}
      <p className="app-nav-place">
        {LOCATION.label}
        <span>{LOCATION.locality}</span>
      </p>
    </header>
  );
}
