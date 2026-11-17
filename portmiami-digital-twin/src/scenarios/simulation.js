/**
 * The deterministic run: inputs in, a ScenarioRun out.
 *
 * Same inputs, same outputs, every time. No randomness, no clock inside a formula, and no model
 * anywhere near a number — an LLM is not permitted to produce, adjust or round a result here. The
 * only non-deterministic fields are the run's id and `executedAt`, which describe when it was
 * run rather than what it found.
 *
 * Every run carries `inputSnapshot`: the assumptions AS THEY WERE at the moment it ran. A saved
 * run therefore stays readable after the scenario is edited, and a result can always be traced to
 * the numbers that produced it. `modelVersion` goes with it, so a run made by older formulas is
 * identifiable rather than silently compared with a newer one.
 */
import { DATA_MODE, MODEL_VERSION, SCENARIO_TYPE } from '../config/scenarioPlanner.js';
import { capacityResult } from './capacityModel.js';
import { demandResult, forecastDemand, demandSeries } from './demandModel.js';
import { generatedTrips, roadCapacity, trafficResult } from './trafficModel.js';

let runCounter = 0;
const nextRunId = () => {
  runCounter += 1;
  return `run-${Date.now().toString(36)}-${runCounter}`;
};

/**
 * Run one scenario.
 *
 * @param {object} scenario
 * @param {object} context
 * @param {Array} context.assets                the registry, for the site's record
 * @param {Map} context.buildingsById           footprints, for a geometry-based capacity estimate
 * @param {Function} context.linksFor           the asset's links
 * @param {string} [context.now]                injectable timestamp, so tests are deterministic
 * @returns {object} ScenarioRun
 */
export function runScenario(scenario, { assets = [], buildingsById = new Map(), linksFor = () => ({ buildingLinks: [] }), now = null } = {}) {
  const a = scenario.assumptions;
  const warnings = [];

  // ---- the site, and the footprint behind it -------------------------------------------------
  const asset = scenario.site.assetId ? assets.find(x => x.id === scenario.site.assetId) ?? null : null;
  const confirmed = asset
    ? (linksFor(asset.id).buildingLinks ?? []).filter(link => link.status === 'CONFIRMED')
    : [];
  const footprint = confirmed.length
    ? buildingsById.get(confirmed[0].buildingObjectId) ?? null
    : null;

  /**
   * A sanity check on the LINK, not on the building.
   *
   * A confirmed footprint of a few dozen square metres is not a parking structure — it is a
   * reviewer who linked the wrong polygon, usually a kiosk or a canopy beside the real one. The
   * planner cannot refuse the link (confirmation is the reviewer's call) but it can refuse to let
   * the number pass unremarked, because every geometry cross-check below is then meaningless.
   */
  const MIN_PLAUSIBLE_GARAGE_M2 = 500;
  if (footprint && Number.isFinite(footprint.groundAreaM2) && footprint.groundAreaM2 < MIN_PLAUSIBLE_GARAGE_M2) {
    warnings.push(`The confirmed footprint (OBJECTID ${footprint.objectId}) is only `
      + `${Math.round(footprint.groundAreaM2).toLocaleString()} m² — too small for a parking `
      + 'structure. Check the link in the Infrastructure explorer; the massing and any '
      + 'geometry cross-check are drawn on this polygon.');
  }

  if (scenario.capacitySource?.verification === 'REPORTED') {
    warnings.push(`The existing capacity of ${scenario.capacitySource.spaces.toLocaleString()} `
      + 'spaces is REPORTED, not verified: it was attributed to a source whose text does not '
      + 'contain it. Every figure below is built on it.');
  } else if (!scenario.capacitySource) {
    warnings.push('No source publishes an existing capacity for this facility, so the baseline is '
      + 'the placeholder assumption. Replace it with the operator’s own figure before using any '
      + 'result.');
  }

  if (asset && !footprint) {
    warnings.push('No confirmed building footprint for this garage, so capacity is taken from the '
      + 'stated assumption rather than estimated from the real floor area.');
  }

  /**
   * The existing height is NEVER taken from the extract's HEIGHT field.
   *
   * 577 of the 6,000 footprints carry a HEIGHT value and 5,423 do not, and the source states no
   * unit, datum or reference for any of them — feet and metres are both plausible, and the
   * difference is a factor of three in a conceptual massing. Reading it as metres would be
   * inventing a verified quantity out of an unlabelled number, so the planner reports only the
   * ADDED height, which comes from the floor assumptions it does control.
   */
  const rawHeight = Number.isFinite(footprint?.height) ? footprint.height : null;
  const existingHeightM = null;
  if (footprint) {
    warnings.push(rawHeight === null
      ? 'The building extract publishes no height for this footprint, so only the ADDED height is '
        + 'reported — there is no verified existing height to add it to.'
      : `The extract carries HEIGHT ${rawHeight} for this footprint but states no unit or datum, `
        + 'so it is not read as metres. Only the ADDED height is reported.');
  }

  // ---- capacity ---------------------------------------------------------------------------------
  const isSurface = scenario.type === SCENARIO_TYPE.OPTIMIZE_SURFACE;
  const capacity = capacityResult({
    existingCapacity: a.existingCapacity,
    additionalSpaces: a.additionalSpaces,
    geometry: null,                                   // stated spaces are the configured path
    utilisationPct: a.utilisationPct,
    addedFloors: isSurface ? 0 : a.addedFloors,       // a surface lot gains no floors
    floorToFloorM: a.floorToFloorM,
    existingHeightM,
  });

  // What the same footprint WOULD hold, as a cross-check on the stated figure. Reported beside
  // it, never substituted for it.
  const geometryCheck = footprint && !isSurface
    ? capacityResult({
      existingCapacity: a.existingCapacity, additionalSpaces: null,
      geometry: {
        footprintAreaM2: footprint.groundAreaM2,
        parkingFloors: a.addedFloors,
        grossAreaPerSpaceM2: a.grossAreaPerSpaceM2,
      },
      utilisationPct: a.utilisationPct, addedFloors: a.addedFloors, floorToFloorM: a.floorToFloorM,
    })
    : null;
  if (geometryCheck?.additionalSpaces != null && capacity.additionalSpaces != null) {
    const stated = capacity.additionalSpaces, estimated = geometryCheck.additionalSpaces;
    if (estimated > 0 && (stated / estimated > 1.5 || stated / estimated < 0.67)) {
      warnings.push(`The stated ${stated.toLocaleString()} additional spaces differs from the `
        + `${estimated.toLocaleString()} this footprint would hold over ${a.addedFloors} floors at `
        + `${a.grossAreaPerSpaceM2} m² gross per space. One of the two assumptions is wrong.`);
    }
  }

  // ---- demand ------------------------------------------------------------------------------------
  const forecast = forecastDemand({
    baseDemandSpaces: a.baseDemandSpaces, annualGrowthPct: a.annualGrowthPct,
    baseYear: a.baseYear, forecastYear: a.forecastYear, peakMultiplier: a.peakMultiplier,
  });
  if (forecast.reason) warnings.push(forecast.reason);
  const demand = demandResult({ usableCapacity: capacity.usableCapacity, forecast });

  // ---- traffic -------------------------------------------------------------------------------------
  const trips = generatedTrips({
    additionalSpaces: capacity.additionalSpaces, utilisationPct: a.utilisationPct,
    peakArrivalSharePct: a.peakArrivalSharePct, peakDepartureSharePct: a.peakDepartureSharePct,
    vehiclesPerSpace: a.vehiclesPerSpace,
  });
  const capacityNow = roadCapacity({
    roadCapacityPerLane: a.roadCapacityPerLane, accessLanes: a.accessLanes,
  });
  const traffic = scenario.accessRoad
    ? trafficResult({
      trips, baselineRoadVolume: a.baselineRoadVolume, capacity: capacityNow,
      analysisMinutes: a.analysisMinutes, road: scenario.accessRoad,
    })
    : {
      road: null, vcRatio: null, addedVehicles: trips.total, totalVolume: null, queue: null,
      reason: 'No access road nominated, so scenario trips are not assigned to any road. '
        + 'Added vehicles are reported; road loading is not.',
    };

  // During construction the same demand meets a reduced approach. Reported separately, as a
  // second state of the same road rather than mixed into the operating result.
  const capacityDuringWorks = roadCapacity({
    roadCapacityPerLane: a.roadCapacityPerLane, accessLanes: a.accessLanes,
    constructionLaneClosurePct: a.constructionLaneClosurePct, duringConstruction: true,
  });
  const construction = scenario.type === SCENARIO_TYPE.BASELINE
    ? { months: 0, capacityLostPct: 0, disruptionIndex: 0, traffic: null }
    : {
      months: a.constructionMonths,
      capacityLostPct: a.constructionLaneClosurePct,
      /** Duration × capacity lost. A relative index for ranking, in no real unit. */
      disruptionIndex: (Number(a.constructionMonths) || 0) * (Number(a.constructionLaneClosurePct) || 0) / 100,
      traffic: scenario.accessRoad
        ? trafficResult({
          trips: { total: 0, arrivals: 0, departures: 0 },   // works happen before the spaces open
          baselineRoadVolume: a.baselineRoadVolume, capacity: capacityDuringWorks,
          analysisMinutes: a.analysisMinutes, road: scenario.accessRoad,
        })
        : null,
    };

  return {
    id: nextRunId(),
    scenarioId: scenario.id,
    scenarioKey: scenario.key,
    scenarioName: scenario.name,
    scenarioType: scenario.type,
    modelVersion: MODEL_VERSION,
    dataMode: DATA_MODE.SYNTHETIC,
    inputSnapshot: {
      assumptions: { ...a },
      // Carried into the run so a saved result records whether its baseline was a published
      // figure or the placeholder, and which source backed it.
      capacitySource: scenario.capacitySource ? { ...scenario.capacitySource } : null,
      site: { ...scenario.site },
      accessRoad: scenario.accessRoad ? { ...scenario.accessRoad } : null,
      footprintObjectId: footprint?.objectId ?? null,
      footprintAreaM2: footprint?.groundAreaM2 ?? null,
    },
    results: {
      capacity,
      geometryCheck: geometryCheck
        ? { additionalSpaces: geometryCheck.additionalSpaces, note: geometryCheck.additionalSpacesNote }
        : null,
      forecast,
      demand,
      trips,
      traffic,
      construction,
      demandCurve: demandSeries({
        baseDemandSpaces: a.baseDemandSpaces, annualGrowthPct: a.annualGrowthPct,
        baseYear: a.baseYear, forecastYear: a.forecastYear, peakMultiplier: a.peakMultiplier,
      }, { step: Math.max(1, Math.round((a.forecastYear - a.baseYear) / 8)) }),
    },
    warnings,
    executedAt: now ?? new Date().toISOString(),
  };
}
