/**
 * A small plan-view preview of an alternative, drawn from its own stored geometry.
 *
 * Not a picture of the port: the existing roads it touches in grey, and each proposed change in
 * the colour the map uses for its operation, fitted to the card. An alternative with nothing
 * drawn says so instead of showing an illustrative road.
 */
import { lonLatToEnu } from '../scenarios/garagePlacement.js';
import { roadOperationOf } from '../designs/designQuantities.js';
import { surfaceRingOf } from '../designs/designReview.js';
import { ROAD_OPERATION_STYLE } from '../cesium/designOverlayLayer.js';

const W = 96, H = 72, PAD = 9;

export function DesignThumbnail({ design, roadsById }) {
  const elements = (design?.elements ?? []).filter(e => e.geometry?.type === 'LineString');
  if (!elements.length) {
    return (
      <span className="rd-thumb is-empty" aria-hidden="true">
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
          <path d="M14 58 C34 40 52 46 82 16" fill="none" stroke="#9fb0c7" strokeWidth="2" strokeDasharray="4 4" />
        </svg>
        <em>Nothing drawn</em>
      </span>
    );
  }

  const baseline = [...new Set(elements.map(e => e.baselineRef?.objectId).filter(Number.isFinite))]
    .map(id => roadsById?.get(id)?.coordinates).filter(Boolean);
  const shapes = elements.map(element => ({
    element,
    line: element.geometry.coordinates,
    ring: surfaceRingOf(element),
    style: ROAD_OPERATION_STYLE[roadOperationOf(element)] ?? ROAD_OPERATION_STYLE.MODIFY,
  }));

  // Fit what the design changes, with a little of the road it changes around it.
  const focus = shapes.flatMap(s => s.ring ?? s.line);
  const origin = focus[0];
  const local = point => lonLatToEnu(origin, point);
  const pts = focus.map(local);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 40) * 1.35;
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const scale = Math.min(W - PAD * 2, H - PAD * 2) / span;
  const toSvg = point => {
    const [x, y] = local(point);
    return `${(W / 2 + (x - cx) * scale).toFixed(1)},${(H / 2 - (y - cy) * scale).toFixed(1)}`;
  };
  const path = line => line.map(toSvg).join(' ');

  return (
    <span className="rd-thumb" aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
        <defs>
          <clipPath id={`clip-${design.id}`}><rect width={W} height={H} rx="6" /></clipPath>
        </defs>
        <g clipPath={`url(#clip-${design.id})`}>
          <rect width={W} height={H} fill="#24364f" />
          {baseline.map((line, i) => (
            <polyline key={i} points={path(line)} fill="none" stroke="#8a94a6" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" opacity="0.8" />
          ))}
          {shapes.map(({ element, ring, line, style }) => (
            <g key={element.id}>
              {ring && <polygon points={path(ring)} fill={style.fill} fillOpacity="0.55" stroke={style.line} strokeWidth="1" />}
              <polyline points={path(line)} fill="none" stroke={style.line} strokeWidth={ring ? 1.4 : 3}
                strokeDasharray={roadOperationOf(element) === 'CLOSE' ? '4 3' : undefined} strokeLinecap="round" />
            </g>
          ))}
        </g>
      </svg>
    </span>
  );
}
