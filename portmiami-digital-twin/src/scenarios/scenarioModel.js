/**
 * What a scenario IS: a site, a set of assumptions, and nothing that pretends to be verified.
 *
 * A scenario never carries a copy of a registry record. It carries the asset's ID and, for a new
 * garage or a surface reconfiguration, a candidate geometry the user drew. The verified facts —
 * the garage's name, address, footprint and links — stay in the registry and are read through it,
 * so editing a hypothetical can never overwrite a sourced one.
 *
 * Validation returns reasons, not booleans. "Run Simulation" is refused with the reason shown,
 * because a run on a half-configured scenario would produce numbers that look like answers.
 */
import {
  DATA_MODE, SCENARIO_TYPE, SEED_SCENARIOS, SITE_KIND, defaultAssumptions,
} from '../config/scenarioPlanner.js';

let counter = 0;
const nextId = prefix => {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
};

/** A scenario with its defaults. The site is deliberately empty: the user picks it. */
export function createScenario({ key = null, name, type, additionalSpaces, addedFloors, note = null } = {}) {
  const assumptions = defaultAssumptions();
  if (Number.isFinite(additionalSpaces)) assumptions.additionalSpaces = additionalSpaces;
  if (Number.isFinite(addedFloors)) assumptions.addedFloors = addedFloors;
  return {
    id: nextId('scenario'),
    key,
    name: name ?? 'New scenario',
    type: type ?? SCENARIO_TYPE.EXPAND_EXISTING,
    note,
    site: { kind: SITE_KIND.NONE, assetId: null, buildingObjectId: null, point: null, footprint: null, label: null },
    /** The access road the scenario's trips are assigned to. Nominated, never inferred. */
    accessRoad: null,
    /**
     * Where `existingCapacity` came from, when it came from a published record rather than the
     * placeholder. Null means the assumption is still the default placeholder.
     */
    capacitySource: null,
    /**
     * Where `existingHeightM` came from. Null means it is still the untouched placeholder, which
     * lets the planner offer the measured value once; anything else means a person or a
     * measurement has set it and it is left alone.
     */
    heightSource: null,
    assumptions,
    dataMode: DATA_MODE.SYNTHETIC,
    createdAt: new Date().toISOString(),
  };
}

/** The three alternatives from the concept slide, as editable starting points. */
export const seedScenarios = () => SEED_SCENARIOS.map(seed => createScenario(seed));

/** A copy, with its own id and no run history attached. */
export const duplicateScenario = scenario => ({
  ...structuredClone(scenario),
  id: nextId('scenario'),
  key: null,
  name: `${scenario.name} (copy)`,
  createdAt: new Date().toISOString(),
});

/** Reset a scenario's assumptions to the defaults, keeping its identity and site. */
export const resetAssumptions = scenario => ({
  ...scenario,
  assumptions: { ...defaultAssumptions(), additionalSpaces: scenario.assumptions.additionalSpaces },
});

/**
 * What stops this scenario being simulated.
 *
 * @returns {{ok: boolean, blocking: string[], warnings: string[]}}
 */
export function validateScenario(scenario, {
  assets = [], linksFor = () => ({ buildingLinks: [] }), placementCapacity = null,
} = {}) {
  const blocking = [], warnings = [];
  const site = scenario?.site ?? {};

  if (scenario?.type === SCENARIO_TYPE.EXPAND_EXISTING) {
    if (!site.assetId) {
      blocking.push('Select the registered garage to expand.');
    } else {
      const asset = assets.find(a => a.id === site.assetId);
      if (!asset) blocking.push('The selected garage is no longer in the registry.');
      else {
        const confirmed = (linksFor(asset.id).buildingLinks ?? [])
          .filter(link => link.status === 'CONFIRMED');
        // A missing footprint does not block the arithmetic, and it is already stated in the
        // Plan tab's geometry block — repeating it here as a warning said the same thing twice.

      }
    }
  }

  if (scenario?.type === SCENARIO_TYPE.NEW_GARAGE && !site.point) {
    blocking.push('Pick a candidate site on the map for the new garage.');
  }
  /*
   * A proposed garage whose geometry cannot hold the spaces being simulated.
   *
   * The simulation runs on `additionalSpaces`, the REQUESTED figure, because that is the question
   * the scenario asks. Saying nothing here would let a 2,000-space result come out of a building
   * modelled with room for 1,850, and the result would look like a finding rather than an
   * unreconciled input. So it travels with the run as a warning: the number is still the one you
   * asked for, and it is not the one this shape supports.
   */
  if (placementCapacity?.meetsTarget === false) {
    warnings.push(`The proposed building supports about ${placementCapacity.estimatedSpaces.toLocaleString()} `
      + `spaces at ${placementCapacity.grossAreaPerSpaceM2} m² per space, `
      + `${Math.abs(placementCapacity.differenceSpaces).toLocaleString()} short of the `
      + `${placementCapacity.targetSpaces.toLocaleString()} this run will use. The simulation uses the `
      + 'requested figure; enlarge the building, lower the target, or record that the shortfall '
      + 'is accepted.');
  }
  if (scenario?.type === SCENARIO_TYPE.OPTIMIZE_SURFACE && !site.point && !site.assetId) {
    blocking.push('Select a surface lot, or pick the area on the map.');
  }
  if (!scenario?.accessRoad) {
    warnings.push('No access road nominated, so no traffic result is produced. Pick one on the '
      + 'map or from the garage’s road links — trips are never assigned to a road on their own.');
  }

  const required = ['existingCapacity', 'additionalSpaces', 'utilisationPct', 'baseDemandSpaces'];
  for (const key of required) {
    if (!Number.isFinite(Number(scenario?.assumptions?.[key]))) {
      blocking.push(`Assumption “${key}” is not a number.`);
    }
  }
  return { ok: blocking.length === 0, blocking, warnings };
}

/** A scenario whose only purpose is to be the thing the others are compared against. */
export function baselineScenario(from) {
  const base = createScenario({ name: 'Baseline', type: SCENARIO_TYPE.BASELINE, additionalSpaces: 0, addedFloors: 0 });
  return {
    ...base,
    key: 'BASE',
    note: 'No change. The same demand and the same assumed existing capacity, so the alternatives '
      + 'are read against something rather than against nothing.',
    site: from?.site ? { ...from.site } : base.site,
    accessRoad: from?.accessRoad ?? null,
    assumptions: { ...(from?.assumptions ?? base.assumptions), additionalSpaces: 0, addedFloors: 0 },
  };
}
