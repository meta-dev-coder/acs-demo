/**
 * FL511's marker-detail endpoint (/tooltip/{layerId}/{id}) answers with an HTML fragment rather
 * than JSON, so this module reduces that fragment to the label/value pairs FL511 actually printed.
 * It never infers: an absent row stays absent, and a fragment we cannot recognise returns null so
 * the caller keeps serving the marker with mapIcons fields only.
 */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#160': ' ' };

const decodeEntities = text => text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, name) => {
  if (Object.hasOwn(ENTITIES, name)) return ENTITIES[name];
  if (/^#x/i.test(name)) return String.fromCodePoint(parseInt(name.slice(2), 16));
  if (/^#/.test(name)) return String.fromCodePoint(parseInt(name.slice(1), 10));
  return match;
});

/** Visible text of an HTML chunk: tags become spaces so adjacent words never fuse. */
const textOf = html => decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

const stripNonContent = html => String(html)
  .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');

/**
 * @param {string} html
 * @returns {{title?: string, description?: string, fields: {label: string, value: string}[]} | null}
 */
export function parseTooltipHtml(html) {
  if (typeof html !== 'string' || html.trim() === '') return null;
  const body = stripNonContent(html);

  const heading = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(body);
  const title = heading ? textOf(heading[1]) : '';

  const fields = [];
  let description = '';
  for (const [row] of body.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
    const header = /<th\b[^>]*>([\s\S]*?)<\/th>/i.exec(row);
    if (header) {
      const cell = /<td\b[^>]*>([\s\S]*?)<\/td>/i.exec(row);
      const label = textOf(header[1]).replace(/:$/, ''), value = cell ? textOf(cell[1]) : '';
      if (label && value) fields.push({ label, value });
      continue;
    }
    // A label-less full-width row is FL511's free-text description. Rows that only host the
    // camera carousel or action buttons carry no event information, so they are skipped.
    if (description) continue;
    const cell = /<td\b[^>]*>([\s\S]*?)<\/td>/i.exec(row);
    if (!cell || /<(?:button|video|iframe|img)\b|cctvCameraCarousel/i.test(cell[1])) continue;
    const text = textOf(cell[1]);
    if (text) description = text;
  }

  if (!title && !description && fields.length === 0) return null;
  const cameras = parseCarouselCameras(body);
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    fields,
    ...(cameras.length ? { cameras } : {}),
  };
}

const attr = (html, name) => {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(html);
  const value = match ? textOf(match[1] ?? match[2]) : '';
  return value || null;
};

/**
 * The cameras FL511 lists in the tooltip's camera carousel, in its order: FL511 camera id, title,
 * description and the DIVAS channel of its video stream (…/chan-<n>_h/…), null when absent.
 * @returns {{cameraId: string, title: string|null, description: string|null, divasChanId: string|null}[]}
 */
export function parseCarouselCameras(html) {
  if (typeof html !== 'string') return [];
  const cameras = [];
  const seen = new Set();
  const blocks = html.split(/(?=<div\b[^>]*\bid\s*=\s*["']carouselDiv-)/i);
  for (const block of blocks) {
    const cameraId = /^<div\b[^>]*\bid\s*=\s*["']carouselDiv-(\d+)["']/i.exec(block)?.[1];
    if (!cameraId || seen.has(cameraId)) continue;
    seen.add(cameraId);
    const video = attr(block, 'data-videourl');
    cameras.push({
      cameraId,
      title: attr(block, 'data-fs-title'),
      description: attr(block, 'data-fs-desc'),
      divasChanId: /\/chan-(\d+)_/i.exec(video ?? '')?.[1] ?? null,
    });
  }
  return cameras;
}

/** Case-insensitive lookup of one FL511 row, or undefined when FL511 did not print it. */
export function fieldValue(detail, label) {
  const match = detail?.fields?.find(field => field.label.toLowerCase() === label.toLowerCase());
  return match?.value || undefined;
}
