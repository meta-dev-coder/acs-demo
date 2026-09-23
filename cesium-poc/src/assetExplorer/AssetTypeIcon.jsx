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
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import HorizontalRuleOutlinedIcon from '@mui/icons-material/HorizontalRuleOutlined';

const ICONS = {
  workOrder: HandymanOutlinedIcon,
  ticket: ConfirmationNumberOutlinedIcon,
  task: ChecklistOutlinedIcon,
  inspection: FactCheckOutlinedIcon,
  incidentRecord: WarningAmberOutlinedIcon,
  lighting: LightbulbOutlinedIcon,
  messageSign: DvrOutlinedIcon,
  gantry: AccountTreeOutlinedIcon,
  camera: VideocamOutlinedIcon,
  bridge: HorizontalRuleOutlinedIcon,
  incident: WarningAmberOutlinedIcon,
  closure: BlockOutlinedIcon,
};

export function AssetTypeIcon({ assetType, ...props }) {
  const Icon = ICONS[assetType] ?? LocationOnOutlinedIcon;
  return <Icon {...props} />;
}
