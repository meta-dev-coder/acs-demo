/**
 * The six lighting categories in DataConnect's `Asset Category` field, shown exactly as the source
 * names them. The ids are only stable handles for the layer controls; the label is the source value.
 * A test checks this list against the committed snapshot, so a new category cannot slip past.
 */
export const LIGHTING_CATEGORIES = Object.freeze([
  { id: 'lighting-general', source: 'Lighting' },
  { id: 'lighting-under-deck', source: 'Lighting - Under Deck' },
  { id: 'lighting-navigation', source: 'Lighting - Nav. Lights' },
  { id: 'lighting-street', source: 'Lighting - Street Light' },
  { id: 'lighting-load-center', source: 'Lighting - Load Center' },
  { id: 'lighting-sign-structure', source: 'Lighting - Sign Structure' },
].map(category => Object.freeze({ ...category, label: category.source })));

/** Any `Asset Category` DataConnect files under lighting, known to this list or not. */
export const isLightingCategory = name => /^Lighting\b/.test(String(name ?? ''));

export function lightingRecords(rows, { logger = console } = {}) {
  if (!Array.isArray(rows)) throw new Error('Invalid DataConnect asset registry');
  const categories = new Map(LIGHTING_CATEGORIES.map(c => [c.source, c]));
  const ids = new Set(), unknown = new Set();
  const records = rows.flatMap(source => {
    const category = categories.get(source['Asset Category']);
    if (!category) {
      if (isLightingCategory(source['Asset Category'])) unknown.add(source['Asset Category']);
      return [];
    }
    const id = String(source['Asset ID'] ?? '').trim();
    const longitude = source['X Coordinates'], latitude = source['Y Coordinates'];
    if (!id || ids.has(id)) throw new Error('Missing or duplicate lighting ID');
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) return [];
    ids.add(id);
    return [{ id, longitude, latitude, categoryId: category.id, categoryLabel: category.label, source }];
  });
  // Reported rather than guessed into a category: it needs a layer control of its own.
  if (unknown.size) logger.warn?.(`[lighting] unrecognised DataConnect lighting categories skipped: ${[...unknown].join(', ')}`);
  return records;
}
