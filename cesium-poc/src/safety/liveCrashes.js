/**
 * The crashes the corridor is reporting now, as the safety picture counts them.
 *
 * Safety's register comes from the DataConnect incident class. The FL511 feed is a SECOND source:
 * an incident that happened this week is in the feed, cleared, long before it is ever written to
 * the register. Leaving it out made the recent periods empty of exactly the events an operator
 * opens this screen to look at — the four cleared incidents Live Ops was already showing.
 *
 * Only crashes. The same feed carries closures, roadworks and congestion, and those are Live Ops'
 * business; see `isCrashRecord` for the same rule applied to the register's own rows.
 *
 * Pure: events in, crash records out. No DOM, no Cesium, no fetching.
 */

/**
 * FL511's severity words, mapped to the tiers the hotspot score is weighted by.
 *
 * The feed publishes Minor / Intermediate / Major and carries no injury or fatality columns at all,
 * so its events cannot be graded by the register's rule (a fatality, then injuries, then a lane
 * closure). `severe` is deliberately unreachable from the feed: that tier means a death, and the
 * feed never says so. Major maps to `high`, which is the strongest thing the feed's own words
 * actually support.
 */
export const LIVE_CRASH_TIERS = Object.freeze({
  MAJOR: 'high', SEVERE: 'high', INTERMEDIATE: 'intermediate', MODERATE: 'intermediate', MINOR: 'minor',
});

/** The feed's word for how bad it was, as a tier. Anything unrecognised is the mildest claim. */
export const liveCrashTier = severity =>
  LIVE_CRASH_TIERS[String(severity ?? '').trim().toUpperCase()] ?? 'minor';

/**
 * One live event as a crash record, in the shape the register's records already have.
 *
 * `createdDate` is when it was REPORTED, not when it cleared — the period filters and the monthly
 * trend are both asking when the crash happened. `crashTier` is carried explicitly because the
 * grading rule the register uses cannot be applied to a feed that publishes no injury columns.
 */
export const crashFromLiveEvent = event => Object.freeze({
  id: event.id,
  longitude: event.longitude,
  latitude: event.latitude,
  title: event.title || 'Incident',
  createdDate: event.startTime ?? event.lastUpdated ?? event.clearedAt ?? null,
  segmentName: event.nearestSegmentLabel ?? null,
  live: true,
  cleared: Boolean(event.cleared),
  crashTier: liveCrashTier(event.severity),
  related: Object.freeze({ eventType: event.type, severity: event.severity ?? null }),
});

/**
 * Every crash in a live-events payload, cleared or still running.
 *
 * Cleared ones are kept deliberately: a crash that has been cleared still happened there, and the
 * safety question is where the corridor hurts people, not what is blocking it this minute. An event
 * with no coordinates is dropped rather than placed at (0,0) — it cannot be a point on a map.
 *
 * @param {object[]} events the feed's events
 * @returns {object[]} crash records, oldest-to-newest order preserved from the feed
 */
export function crashesFromLiveEvents(events) {
  return (events ?? [])
    .filter(event => event?.type === 'INCIDENT'
      && Number.isFinite(event.longitude) && Number.isFinite(event.latitude))
    .map(crashFromLiveEvent);
}

/**
 * The register's crashes with the feed's merged in, without double-counting.
 *
 * The same incident can reach both: the sync writes feed events into the Live classes, and the
 * register may already carry it. Feed ids win on a clash, because they are the fresher copy.
 */
export function mergeCrashSources(registerCrashes, liveCrashes) {
  const live = liveCrashes ?? [];
  const seen = new Set(live.map(crash => String(crash.id)));
  return [...(registerCrashes ?? []).filter(crash => !seen.has(String(crash.id))), ...live];
}
