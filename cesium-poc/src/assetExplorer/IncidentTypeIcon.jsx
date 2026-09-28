/**
 * The Material icon and colour for one incident type.
 *
 * The family and its colour come from `incidentTypes.js`, which is where the map marker reads them
 * too — this file only says which Material glyph stands for each family, so a card, the type
 * dropdown and the marker over the crash are never three different pictures of the same thing.
 */
import { Box } from '@mui/material';
import LocalFireDepartmentIcon from '@mui/icons-material/LocalFireDepartment';
import CarCrashIcon from '@mui/icons-material/CarCrash';
import DirectionsCarIcon from '@mui/icons-material/DirectionsCar';
import Rotate90DegreesCcwIcon from '@mui/icons-material/Rotate90DegreesCcw';
import ShieldIcon from '@mui/icons-material/Shield';
import FenceIcon from '@mui/icons-material/Fence';
import FloodIcon from '@mui/icons-material/Flood';
import DirectionsWalkIcon from '@mui/icons-material/DirectionsWalk';
import UTurnLeftIcon from '@mui/icons-material/UTurnLeft';
import MergeTypeIcon from '@mui/icons-material/MergeType';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import SensorsIcon from '@mui/icons-material/Sensors';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import ReportProblemIcon from '@mui/icons-material/ReportProblem';
import { incidentVisual } from './incidentTypes.js';

const FAMILY_ICONS = Object.freeze({
  fire: LocalFireDepartmentIcon,
  pedestrian: DirectionsWalkIcon,
  wrongWay: UTurnLeftIcon,
  multiVehicle: CarCrashIcon,
  rearEnd: DirectionsCarIcon,
  rollover: Rotate90DegreesCcwIcon,
  attenuator: ShieldIcon,
  guardrail: FenceIcon,
  barrier: FenceIcon,
  flooding: FloodIcon,
  debris: DeleteSweepIcon,
  device: SensorsIcon,
  sideswipe: MergeTypeIcon,
  laneDeparture: CallSplitIcon,
  crash: CarCrashIcon,
  other: ReportProblemIcon,
});

/** The icon component for an incident type, for callers that place it themselves. */
export const incidentIconFor = incidentType => FAMILY_ICONS[incidentVisual(incidentType).key] ?? ReportProblemIcon;

/**
 * @param {{incidentType: string|null, tinted?: boolean}} props `tinted` keeps the family colour;
 *   set it false where the surrounding component owns the colour (a selected card).
 */
export function IncidentTypeIcon({ incidentType, tinted = true, ...props }) {
  const visual = incidentVisual(incidentType);
  const Icon = FAMILY_ICONS[visual.key] ?? ReportProblemIcon;
  // The family colour wins over an inherited one when tinted: a caller passing a neutral ink for
  // every icon in a row must not quietly strip the one thing that distinguishes these.
  return <Icon {...props} sx={{ ...props.sx, ...(tinted ? { color: visual.color } : null) }} />;
}

/**
 * The same icon on its family's colour, as a filled tile — the form the details panel's heading and
 * the incident cards use, where the icon has to read as the subject of the panel rather than as
 * decoration beside a label.
 */
export function IncidentTypeBadge({ incidentType, size = 44, radius = 1.5 }) {
  const visual = incidentVisual(incidentType);
  const Icon = FAMILY_ICONS[visual.key] ?? ReportProblemIcon;
  return (
    <Box
      aria-hidden
      sx={{
        width: size, height: size, borderRadius: radius, flex: 'none',
        display: 'grid', placeItems: 'center',
        // A tint of the family colour rather than the colour itself: a saturated block this size
        // competes with the live camera image beside it.
        bgcolor: `${visual.color}22`, border: `1px solid ${visual.color}66`, color: visual.color,
      }}
    >
      <Icon sx={{ fontSize: size * 0.55 }} />
    </Box>
  );
}
