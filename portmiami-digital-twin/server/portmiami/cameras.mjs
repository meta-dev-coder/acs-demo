/**
 * FL511 traffic cameras in the study area.
 *
 * HOW THIS DIFFERS FROM ACS, which matters for what can be claimed:
 *
 * The ACS I-595 twin does not poll a camera feed. Its 74 corridor cameras are a frozen GeoJSON
 * extract (`cesium-poc/public/data/i595_corridor_cameras.geojson`) in which the DIVAS channel id
 * was already resolved for each camera, and `cesium-poc/server/api.mjs` proxies snapshots for that
 * fixed id set. PortMiami has no such extract, so it reads `/map/mapIcons/Cameras` live — the same
 * endpoint family, the same `item2` envelope, verified 2026-11-16.
 *
 * The consequence is the one thing to understand here: **the mapIcons feed does not carry the DIVAS
 * channel.** It gives an FL511 camera id, a position and `videoEnabled`. The channel only appears
 * in the camera's own tooltip fragment, as `data-videourl=".../chan-<n>_h/index.m3u8"`. So a
 * camera's position is known from the list, and its imagery is only known after its detail has
 * been read — which is why `snapshotUrl` is absent until then rather than guessed from the id.
 * No camera URL is ever constructed from anything but a channel FL511 itself published.
 */
import { LINK_STATUS } from './roadAssociation.mjs';

/** The association block, from whatever text is known about the thing at this point. */
export function associateAt(network, { id, latitude, longitude, text }, max = 3) {
  const { associations } = network.associate({ id, latitude, longitude, title: text ?? '' }, { max });
  return {
    roadAssociations: associations,
    roadAssociationStatus: associations.length === 0 ? LINK_STATUS.UNMATCHED
      : associations.some(link => link.status === LINK_STATUS.MATCHED) ? LINK_STATUS.MATCHED
      : LINK_STATUS.CANDIDATE,
  };
}

/** Camera availability, as far as it is actually known. */
export const CAMERA_STATUS = Object.freeze({
  /** FL511 says videoEnabled; imagery not yet requested. */
  LISTED: 'LISTED',
  /** The detail fragment gave a DIVAS channel. */
  FEED_RESOLVED: 'FEED_RESOLVED',
  /** FL511 lists the camera but declares no video for it. */
  NO_VIDEO_DECLARED: 'NO_VIDEO_DECLARED',
  /** A channel was resolved and the image server refused it. */
  FEED_UNAVAILABLE: 'FEED_UNAVAILABLE',
});

/**
 * Study-area cameras as the API publishes them.
 *
 * `title` comes from the feed only when the feed has one — it is empty for every camera in this
 * area, so the real name arrives with the detail fragment and `name` stays null until then. A
 * placeholder like "Camera 409" would read as FL511's name for it, which it is not.
 */
export function buildCameras(items, network, region) {
  return items.map(item => {
    const association = associateAt(network, {
      id: `FL511-CAMERA-${item.itemId}`, latitude: item.latitude, longitude: item.longitude,
      text: item.title ?? '',
    });
    return {
      id: item.itemId,
      source: 'FL511',
      sourceEventId: item.itemId,
      regionId: region.id,
      latitude: item.latitude,
      longitude: item.longitude,
      name: item.title || null,
      /** FL511's own boolean, or null when it published none. Never defaulted to false. */
      videoEnabled: typeof item.videoEnabled === 'boolean' ? item.videoEnabled : null,
      iconUrl: item.iconUrl ?? null,
      status: item.videoEnabled === false ? CAMERA_STATUS.NO_VIDEO_DECLARED : CAMERA_STATUS.LISTED,
      areaMatch: item.areaMatch,
      /**
       * Which road the camera stands on, by the same evidence rule events use — a camera's own
       * name is usually the strongest clue it has ("US-1 at Port Boulevard"), but the name arrives
       * with the detail, so at list time this is almost always proximity-only.
       */
      ...association,
    };
  }).sort((a, b) => Number(a.id) - Number(b.id));
}

/**
 * One camera's detail, from its own tooltip fragment.
 *
 * @param {object} camera          the listed camera
 * @param {{cameraId: string, title: string|null, description: string|null, divasChanId: string|null}[]} carousel
 * @param {{snapshotBase: string, network?: object}} options  our own same-origin snapshot path,
 *        never DIVAS directly, plus the road network so the association can be recomputed.
 */
export function describeCamera(camera, carousel, { snapshotBase, network }) {
  const entry = carousel?.find(item => String(item.cameraId) === String(camera.id)) ?? carousel?.[0] ?? null;
  const channel = entry?.divasChanId ?? null;
  const name = entry?.title ?? camera.name;
  /**
   * Re-run the association now that FL511's own name for the camera is known.
   *
   * At list time the feed's title is empty for every camera here, so there was nothing to match on
   * and the nearest centreline could only ever be a CANDIDATE. The name is the evidence that
   * settles it: camera 425 is "US-1 at Port Boulevard" and PORT BLVD runs 13 m away, which is two
   * signals agreeing — whereas camera 409 is "I-395 East of Bridge Road" standing 3 m from
   * TERMINAL ISLAND, which stays a CANDIDATE exactly as it should.
   */
  const association = network && name
    ? associateAt(network, { id: `FL511-CAMERA-${camera.id}`, latitude: camera.latitude, longitude: camera.longitude, text: name })
    : null;
  return {
    ...camera,
    ...(association ?? {}),
    name,
    /** FL511 prints an internal designation here, e.g. "606-CCTV". Carried verbatim. */
    sourceDescription: entry?.description ?? null,
    divasChannel: channel,
    status: channel ? CAMERA_STATUS.FEED_RESOLVED
      : camera.videoEnabled === false ? CAMERA_STATUS.NO_VIDEO_DECLARED
      : CAMERA_STATUS.LISTED,
    /**
     * Same-origin, so the browser never talks to the image host and no CORS or referrer policy of
     * theirs has to be worked around. Absent when no channel was published — never fabricated.
     */
    snapshotUrl: channel ? `${snapshotBase}/${channel}/snapshot` : null,
    /**
     * FL511's own HLS URL, reported but NOT embedded. It is an https stream on a non-standard port
     * from a third-party host; whether it may be re-broadcast from another page is FL511's and
     * DIVAS's call, not ours, so this app shows the still image it is allowed to proxy and tells
     * the viewer the live stream exists.
     */
    streamUrl: entry && channel ? `https://dis-se10.divas.cloud:8200/chan-${channel}_h/index.m3u8` : null,
    streamNote: channel
      ? 'FL511 serves this camera as an HLS stream from a third-party host. This app shows the '
        + 'still snapshot it proxies same-origin and does not re-broadcast the stream.'
      : null,
  };
}
