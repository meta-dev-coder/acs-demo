import { useCallback, useEffect, useRef, useState } from 'react';
import { displayName, roadClassLabel, LENGTH_UNIT } from '../roads/roadModel.js';

/**
 * A windowed list. 2,362 rows is enough that rendering them all makes every keystroke in the search
 * box janky, so only the visible slice plus a small overscan is in the DOM. Row height is fixed and
 * declared in both places — here and in app.css as `--road-row-h` — because the window maths needs
 * a number, not a measurement.
 *
 * Written by hand rather than pulled in: one dependency for forty lines is a poor trade, and the
 * project is meant to stay small.
 */
const ROW_HEIGHT = 56;
const OVERSCAN = 6;

export function RoadList({ roads, selectedId, onSelect }) {
  const viewportRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    observer.observe(element);
    setHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  // A new result set starts at the top; otherwise the scroll position points into nothing.
  useEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [roads]);

  const onScroll = useCallback(event => setScrollTop(event.currentTarget.scrollTop), []);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil((height || 400) / ROW_HEIGHT) + OVERSCAN * 2;
  const slice = roads.slice(first, first + visibleCount);

  if (roads.length === 0) {
    return <p className="road-empty">No road matches these filters.</p>;
  }

  return (
    <div className="road-list" ref={viewportRef} onScroll={onScroll}>
      <div className="road-list-sizer" style={{ height: roads.length * ROW_HEIGHT }}>
        <ol className="road-list-window" style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
          {slice.map(road => (
            <li key={road.objectId}>
              <button
                type="button"
                className="road-row"
                aria-current={road.objectId === selectedId ? 'true' : undefined}
                onClick={() => onSelect(road.objectId)}
              >
                <span className="road-row-name">{displayName(road)}</span>
                <span className="road-row-meta">
                  <span>ID {road.objectId}</span>
                  <span>{roadClassLabel(road.classCode)}</span>
                  {road.lengthFeet != null && <span>{Math.round(road.lengthFeet).toLocaleString('en-US')} {LENGTH_UNIT}</span>}
                  {road.isPortAccess && <span className="road-row-tag">Port access</span>}
                  {road.isTunnel && <span className="road-row-tag is-tunnel">Tunnel</span>}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
