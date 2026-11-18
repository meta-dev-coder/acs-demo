/**
 * The workspace rail.
 *
 * Two workspaces over ONE Cesium viewer: the Digital Twin Explorer (everything built before this)
 * and the Parking Scenario Planner. Switching changes which panels are mounted over the map; the
 * viewer, its camera and every layer stay exactly where they were, so a switch never costs a
 * reload or a re-fly.
 *
 * COLLAPSING follows the pattern the sdna-quasar frontend uses for its drawer: the rail never
 * goes away, it narrows to an icon-only strip, and one chevron on its edge toggles between the
 * two widths. Collapsed, each item keeps its icon and its `title`, so the rail is still
 * navigable; the label text is what goes. The choice is remembered per browser, because a rail
 * that reopened on every reload would undo the space the user just asked for.
 */
import { useCallback, useEffect, useState } from 'react';

const COLLAPSE_KEY = 'portmiami.rail.collapsed.v1';

const ITEMS = Object.freeze([
  {
    id: 'EXPLORER',
    label: 'Digital Twin Explorer',
    hint: 'Roads, buildings, infrastructure, live traffic',
    glyph: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c3 3 3 14 0 17-3-3-3-14 0-17z" /></>,
  },
  {
    id: 'PLANNER',
    label: 'Parking Scenario Planner',
    hint: 'Plan, simulate and compare expansion options',
    glyph: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M9.5 16V8h3.2a2.6 2.6 0 0 1 0 5.2H9.5" /></>,
  },
  {
    id: 'DESIGNS',
    label: 'Road Design Studio',
    hint: 'Plan, visualize and compare proposed road infrastructure changes',
    glyph: <><path d="M3 20h18" /><path d="M6 20V8l6-4 6 4v12" /><path d="M9.5 20v-5h5v5" /><path d="M3 11l3-2M21 11l-3-2" /></>,
  },
]);

/** The remembered state. A browser that refuses storage simply starts expanded. */
function rememberedCollapsed() {
  try {
    return globalThis.localStorage?.getItem(COLLAPSE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function WorkspaceSidebar({ workspace, onChange, forceCollapsed = false }) {
  const [collapsed, setCollapsed] = useState(rememberedCollapsed);
  /** Presentation mode collapses the rail without overwriting the user's own preference. */
  const shown = forceCollapsed || collapsed;

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(COLLAPSE_KEY, String(collapsed));
    } catch {
      // Storage being unavailable costs the preference, not the rail.
    }
  }, [collapsed]);

  const toggle = useCallback(() => setCollapsed(value => !value), []);

  return (
    <nav className={`workspace-rail${shown ? ' is-collapsed' : ''}`} aria-label="Workspaces">
      <div className="workspace-brand">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
          strokeWidth="1.7" aria-hidden="true" focusable="false">
          <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
        </svg>
        <span className="workspace-brand-name">
          SuperDNA
          <em>3D Lab</em>
        </span>
      </div>
      <ul>
        {ITEMS.map(item => (
          <li key={item.id}>
            <button
              type="button"
              className="workspace-item"
              aria-current={workspace === item.id ? 'page' : undefined}
              onClick={() => onChange(item.id)}
              title={shown ? `${item.label} — ${item.hint}` : item.hint}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
                strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {item.glyph}
              </svg>
              <span className="workspace-item-label">{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
      {/* Hidden in presentation mode: the rail is collapsed deliberately there, and a control
          that would undo it is a control someone can press by accident mid-demo. */}
      {!forceCollapsed && (
        <button
          type="button"
          className="workspace-toggle"
          onClick={toggle}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand the menu' : 'Collapse the menu'}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={collapsed ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'} />
          </svg>
          <span className="sr-only">{collapsed ? 'Expand the menu' : 'Collapse the menu'}</span>
        </button>
      )}
    </nav>
  );
}
