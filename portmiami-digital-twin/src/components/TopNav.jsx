import { LOCATION } from '../config/portMiami.js';

/**
 * The project's name bar, and the one piece of navigation there is: Ask the Twin.
 *
 * `scenario` names what is being evaluated right now. It is here rather than only in the panel
 * because the panel can be minimised or closed, and the first question anyone asks of a screen
 * like this is "which alternative am I looking at?".
 */
export function TopNav({ project, askOpen, onToggleAsk, scenario, presenting, onPresent }) {
  return (
    <header className="app-nav">
      <div className="app-nav-identity">
        <h1>{project.name}</h1>
        <p>{project.subtitle}</p>
      </div>
      {scenario && (
        <p className="app-nav-scenario" title="The alternative currently being evaluated">
          <span>Evaluating</span>
          {scenario}
        </p>
      )}
      <div className="app-nav-actions">
        {onPresent && (
          <button
            type="button"
            className="app-nav-present"
            aria-pressed={presenting}
            title={presenting ? 'Leave presentation mode' : 'Presentation mode — clear the screen for the map'}
            onClick={onPresent}
          >
            {presenting ? 'Exit presentation' : 'Present'}
          </button>
        )}
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
      </div>
    </header>
  );
}
