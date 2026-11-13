import { LOCATION } from '../config/portMiami.js';

/** The project's name bar. No navigation in it yet — there is one screen. */
export function TopNav({ project }) {
  return (
    <header className="app-nav">
      <div className="app-nav-identity">
        <h1>{project.name}</h1>
        <p>{project.subtitle}</p>
      </div>
      <p className="app-nav-place">
        {LOCATION.label}
        <span>{LOCATION.locality}</span>
      </p>
    </header>
  );
}
