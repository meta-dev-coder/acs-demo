import { useCallback, useEffect, useRef, useState } from 'react';
import { buildingLabel, buildingTypeLabel } from '../buildings/buildingModel.js';

/** Same windowed list as the road explorer; ROW_HEIGHT must match --road-row-h in app.css. */
const ROW_HEIGHT = 56;
const OVERSCAN = 6;

export function BuildingList({ buildings, selectedId, onSelect }) {
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

  useEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [buildings]);

  const onScroll = useCallback(event => setScrollTop(event.currentTarget.scrollTop), []);
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const slice = buildings.slice(first, first + Math.ceil((height || 400) / ROW_HEIGHT) + OVERSCAN * 2);

  if (buildings.length === 0) return <p className="road-empty">No building matches these filters.</p>;

  return (
    <div className="road-list" ref={viewportRef} onScroll={onScroll}>
      <div className="road-list-sizer" style={{ height: buildings.length * ROW_HEIGHT }}>
        <ol className="road-list-window" style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
          {slice.map(building => (
            <li key={building.objectId}>
              <button
                type="button"
                className="road-row"
                aria-current={building.objectId === selectedId ? 'true' : undefined}
                onClick={() => onSelect(building.objectId)}
              >
                <span className="road-row-name">{buildingLabel(building)}</span>
                <span className="road-row-meta">
                  <span>{buildingTypeLabel(building.type)}</span>
                  {building.yearUpdate != null && <span>{building.yearUpdate}</span>}
                  {building.groundAreaM2 != null && <span>{Math.round(building.groundAreaM2).toLocaleString('en-US')} m²</span>}
                  {building.height === null
                    ? <span className="road-row-muted">no height</span>
                    : <span className="road-row-tag">h {building.height}</span>}
                  {building.geometryType === 'MultiPolygon' && <span className="road-row-tag is-tunnel">Multi</span>}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
