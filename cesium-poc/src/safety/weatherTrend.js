/**
 * Crashes grouped by the weather they happened in.
 *
 * The question is whether the corridor hurts people more in some conditions than others. That is a
 * correlation, not a cause — rain does not cause a crash, and a bar being tall may only mean it
 * rains often here. The chart shows how many crashes fell in each condition and says nothing more
 * than that; it is read beside the other trends, never on its own.
 *
 * Two sources spell weather differently, so both are read:
 *   - the DataConnect register writes a category outright ("Clear", "Storm Recovery"),
 *   - the FL511 feed writes a sentence ("Overcast · 24.4 °C · wind 5 km/h N").
 *
 * Pure: records in, buckets out. No DOM, no Cesium.
 */

/**
 * The register's own vocabulary, in the order the chart shows it.
 *
 * Fair weather first, then progressively worse, so the bars read left to right as conditions
 * deteriorate rather than by whichever happened to be common. Taken from the instance, where these
 * seven account for 178 of 182 records.
 */
export const WEATHER_GROUPS = Object.freeze(['Clear', 'Humid', 'Windy', 'Overcast', 'Light Rain', 'Rain', 'Storm Recovery']);

const known = new Map(WEATHER_GROUPS.map(group => [group.toLowerCase(), group]));

/**
 * The weather a crash happened in, or null when it carries none.
 *
 * The feed's sentence is cut at its first separator, which is where its condition ends and the
 * temperature begins. A condition the register has never used is kept as itself rather than forced
 * into the nearest known group — inventing a synonym would be putting a word in the data's mouth,
 * and a new condition showing up as its own bar is the honest outcome.
 */
export function weatherOf(record) {
  const attributes = (record?.source ?? record)?.raw?.attributes ?? {};
  const direct = String(attributes.weather ?? '').trim();
  if (direct && !/^na$/i.test(direct)) return known.get(direct.toLowerCase()) ?? direct;

  const sentence = String(record?.related?.sdna?.weather_at_event ?? '').trim();
  if (!sentence || /^na$/i.test(sentence)) return null;
  const condition = sentence.split(/[·,|]/)[0].trim();
  if (!condition) return null;
  return known.get(condition.toLowerCase()) ?? condition;
}

/**
 * Crashes per weather group, worst-known conditions last.
 *
 * Every known group is present even at zero — a missing bar would read as "no data" when the
 * truthful answer is "none in that weather". Conditions the register has not used are appended in
 * the order they were met, so a new one from the feed is visible rather than silently dropped.
 *
 * @param {object[]} crashes
 * @returns {{points: {key: string, label: string, count: number, crashes: object[]}[],
 *            total: number, peak: number, unknown: number}}
 */
export function weatherTrend(crashes) {
  const buckets = new Map(WEATHER_GROUPS.map(group => [group, { key: group, label: group, count: 0, crashes: [] }]));
  let unknown = 0;
  for (const crash of crashes ?? []) {
    const group = weatherOf(crash);
    if (!group) { unknown += 1; continue; }
    if (!buckets.has(group)) buckets.set(group, { key: group, label: group, count: 0, crashes: [] });
    const bucket = buckets.get(group);
    bucket.count += 1;
    bucket.crashes.push(crash);
  }
  const points = [...buckets.values()];
  return {
    points,
    total: points.reduce((sum, point) => sum + point.count, 0),
    peak: points.reduce((most, point) => Math.max(most, point.count), 0),
    unknown,
  };
}
