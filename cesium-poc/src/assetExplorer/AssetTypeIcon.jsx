import DvrOutlinedIcon from '@mui/icons-material/DvrOutlined';
/** One place that maps an asset type to its Material icon, so cards, lists and panels agree. */
import VideocamOutlinedIcon from '@mui/icons-material/VideocamOutlined';
import LightbulbOutlinedIcon from '@mui/icons-material/LightbulbOutlined';
import HandymanOutlinedIcon from '@mui/icons-material/HandymanOutlined';
import ConfirmationNumberOutlinedIcon from '@mui/icons-material/ConfirmationNumberOutlined';
import ChecklistOutlinedIcon from '@mui/icons-material/ChecklistOutlined';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import LocationOnOutlinedIcon from '@mui/icons-material/LocationOnOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined';
import CarRepairOutlinedIcon from '@mui/icons-material/CarRepairOutlined';
import TrafficOutlinedIcon from '@mui/icons-material/TrafficOutlined';
import EngineeringOutlinedIcon from '@mui/icons-material/EngineeringOutlined';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import HorizontalRuleOutlinedIcon from '@mui/icons-material/HorizontalRuleOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import GppMaybeOutlinedIcon from '@mui/icons-material/GppMaybeOutlined';
import { IncidentTypeIcon } from './IncidentTypeIcon.jsx';

const ICONS = {
  workOrder: HandymanOutlinedIcon,
  ticket: ConfirmationNumberOutlinedIcon,
  task: ChecklistOutlinedIcon,
  inspection: FactCheckOutlinedIcon,
  incidentRecord: WarningAmberOutlinedIcon,
  damagedAsset: ReportProblemOutlinedIcon,
  lighting: LightbulbOutlinedIcon,
  messageSign: DvrOutlinedIcon,
  gantry: AccountTreeOutlinedIcon,
  camera: VideocamOutlinedIcon,
  bridge: HorizontalRuleOutlinedIcon,
  incident: WarningAmberOutlinedIcon,
  closure: BlockOutlinedIcon,
  construction: EngineeringOutlinedIcon,
  congestion: TrafficOutlinedIcon,
  disabledVehicle: CarRepairOutlinedIcon,
  // A clock, matching the Cleared KPI card: this is the one type that is already over.
  clearedEvent: HistoryOutlinedIcon,
  // A shield with a warning: the asset itself is fine, what has happened to it is not.
  riskAsset: GppMaybeOutlinedIcon,
};

/**
 * @param {{assetType: string, asset?: object, tinted?: boolean}} props An incident's icon is its
 *   crash type's, not the class's: fifteen identical amber triangles told an operator nothing about
 *   which of them was a fire. `asset` is what carries the type, so callers that only know the class
 *   (a rail button, a layer legend) still get the generic icon.
 */
export function AssetTypeIcon({ assetType, asset = null, tinted = true, ...props }) {
  if (assetType === 'incidentRecord' && asset?.source?.title) {
    return <IncidentTypeIcon incidentType={asset.source.title} tinted={tinted} {...props} />;
  }
  // Live Ops browses incidents and disabled vehicles together. The record remains an incident-list
  // item, but its source type keeps the blue vehicle glyph visible in the slider.
  const visualType = assetType === 'incident' && asset?.source?.type === 'DISABLED' ? 'disabledVehicle' : assetType;
  const Icon = ICONS[visualType] ?? LocationOnOutlinedIcon;
  return <Icon {...props} />;
}
