/**
 * FL511 dynamic message signs in the study area.
 *
 * The parser is ACS's (`cesium-poc/server/messageSigns.mjs` → `parseMessageSignDetail`), ported
 * unchanged and re-verified against a live fragment on 2026-11-16. A sign's CURRENT MESSAGE is not
 * in the mapIcons feed — the feed gives an id, a position and an empty title — so the message
 * arrives only with the sign's own detail fragment. A sign whose fragment has not been read yet
 * has `message: null`, which the UI prints as "not read yet", never as a blank sign.
 *
 * Nothing in this module composes sign text. If FL511 published no message, there is no message.
 */
import { associateAt } from './cameras.mjs';

const textOf = html => String(html)
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, (match, key) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (named[key.toLowerCase()]) return named[key.toLowerCase()];
    const code = key.toLowerCase().startsWith('#x') ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  })
  .replace(/\s+/g, ' ').trim();

/**
 * Ported from ACS unchanged. Throws on an unrecognised fragment rather than returning a partial
 * sign, so an FL511 markup change surfaces as "could not read" instead of as a blank message.
 */
export function parseMessageSignDetail(html) {
  const cells = [...String(html).matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)];
  const messageCell = cells.find(([, attributes]) => /\bmsgContent\b/i.test(attributes));
  if (!messageCell) throw new Error('Unrecognized FL511 message sign detail.');
  const titleCell = cells.find(([, , body]) => /<b\b/i.test(body));
  const index = cells.indexOf(messageCell);
  return {
    title: titleCell ? textOf(titleCell[2]) : null,
    message: textOf(messageCell[2]),
    updatedAt: cells[index + 1] ? textOf(cells[index + 1][2]) : null,
  };
}

export function buildMessageSigns(items, network, region) {
  return items.map(item => {
    const association = associateAt(network, {
      id: `FL511-DMS-${item.itemId}`, latitude: item.latitude, longitude: item.longitude,
      text: item.title ?? '',
    });
    return {
      id: item.itemId,
      source: 'FL511',
      regionId: region.id,
      latitude: item.latitude,
      longitude: item.longitude,
      /** The feed's title, which is empty for every sign in this area. Null, not a placeholder. */
      name: item.title || null,
      /** Read on demand from the sign's own fragment. */
      message: null,
      messageUpdatedAt: null,
      messageRead: false,
      areaMatch: item.areaMatch,
      ...association,
    };
  }).sort((a, b) => Number(a.id) - Number(b.id));
}

/**
 * Fold a parsed fragment onto a listed sign, and re-run the association on the name it carries.
 *
 * A sign's own name ("I-95 NB beyond SW 8th Street") is the only road evidence it has — the feed's
 * title is empty — so until the fragment is read the nearest centreline can only be a CANDIDATE.
 */
export const describeMessageSign = (sign, detail, { network } = {}) => {
  const name = detail?.title || sign.name;
  const association = network && name
    ? associateAt(network, { id: `FL511-DMS-${sign.id}`, latitude: sign.latitude, longitude: sign.longitude, text: name })
    : null;
  return {
    ...sign,
    ...(association ?? {}),
    name,
    message: detail?.message ?? null,
    messageUpdatedAt: detail?.updatedAt ?? null,
    messageRead: Boolean(detail),
  };
};
