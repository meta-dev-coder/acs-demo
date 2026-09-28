/**
 * The Material icon and colour for one FL511 live event.
 *
 * The colour comes from `liveEventPresentation.js`, which takes it from Live Ops' own icon set — so
 * the badge at the top of the panel is the colour of the pin the operator just clicked. Only the
 * glyph is chosen here, and an FL511 incident borrows the crash taxonomy's icon rather than a
 * generic warning triangle, because "vehicle fire" is what it actually is.
 */
import { Box } from '@mui/material';
import ReportProblemIcon from '@mui/icons-material/ReportProblem';
import BlockIcon from '@mui/icons-material/Block';
import ConstructionIcon from '@mui/icons-material/Construction';
import TrafficIcon from '@mui/icons-material/Traffic';
import CarRepairIcon from '@mui/icons-material/CarRepair';
import { incidentIconFor } from './IncidentTypeIcon.jsx';
import { liveEventVisual } from './liveEventPresentation.js';

const TYPE_ICONS = Object.freeze({
  INCIDENT: ReportProblemIcon,
  CLOSURE: BlockIcon,
  CONSTRUCTION: ConstructionIcon,
  CONGESTION: TrafficIcon,
  DISABLED: CarRepairIcon,
});

/** The icon component for one event: its crash type where it has one, its category otherwise. */
export function liveEventIconFor(event) {
  if (event?.type === 'INCIDENT' && liveEventVisual(event).key !== 'incidents') return incidentIconFor(event.title);
  return TYPE_ICONS[event?.type] ?? ReportProblemIcon;
}

/** The filled tile the panel's heading leads with — the same form the incident badge takes. */
export function LiveEventBadge({ event, size = 44, radius = 1.5 }) {
  const visual = liveEventVisual(event);
  const Icon = liveEventIconFor(event);
  return (
    <Box
      aria-hidden
      sx={{
        width: size, height: size, borderRadius: radius, flex: 'none',
        display: 'grid', placeItems: 'center',
        // A tint rather than the colour itself: a saturated block this size competes with the
        // camera image beside it.
        bgcolor: `${visual.color}22`, border: `1px solid ${visual.color}66`, color: visual.color,
      }}
    >
      <Icon sx={{ fontSize: size * 0.55 }} />
    </Box>
  );
}
