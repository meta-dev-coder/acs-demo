import { rampDetails, rampDisplayType } from './i595RampData.js';
import { createMapDetailsPanel } from './mapDetailsPanel.js';

export function createRampDetailsPanel(onClose) {
  return createMapDetailsPanel({
    title: 'Ramp details', className: 'ramp-details', details: rampDetails,
    tooltipText: ramp => `${rampDisplayType(ramp.rampType)}\n${ramp.fromRoad} → ${ramp.toRoad}`,
    onClose,
  });
}
