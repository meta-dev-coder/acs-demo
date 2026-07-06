/*---------------------------------------------------------------------------------------------
 * Scenario A′ data source — three-tier fetch, keep-previous-on-failure (matches src/data/
 * loader.ts's pattern used by Scenarios A/B/C's bring-your-own-data sources):
 *
 *   (a) ?dc=<base> query param present  -> live DataConnect API (dataconnectClient.ts), the
 *       same login()+fetchClass() pagination/timeout/refresh-once-on-401 logic ported from
 *       cesium-poc/src/dataconnect.js.
 *   (b) else a static snapshot fetch at "<BASE_URL>../twin/dataconnect-data/<class>.json" — the
 *       DEPLOYED layout (this app is served from /acs-demo/acs/, the twin + its DataConnect
 *       data from /acs-demo/twin/). Resolved against the build-time BASE_URL, not the page URL
 *       (see snapshotUrl below — the post-OAuth page URL can lack its trailing slash, which
 *       silently re-anchors a page-relative fetch one directory up).
 *   (c) else "/dataconnect-data/<class>.json" (site-root) — local dev fallback, tried only when
 *       (b) fails (e.g. running this app standalone, not under the deployed /acs-demo/ tree).
 *
 * The 6 DataConnect class JSONs (~5 MB total: asset_registry, work_orders, 3 inspection classes,
 * incidents_v3 — see tools/dataconnect_export.py) are NOT copied into this app's public/. Local
 * dev options for tier (c):
 *   - Point straight at the presenter shim (tier (a), no local files needed at all):
 *       python3 tools/dataconnect_shim.py   then load the app with  ?dc=http://localhost:8787
 *   - Or symlink cesium-poc's copy so tier (c) resolves locally:
 *       ln -s ../../cesium-poc/public/dataconnect-data public/dataconnect-data
 *
 * A failure of every tier for a class throws; loadAssetsPrime() (below) is the keep-previous-on-
 * failure boundary — it leaves storeAPrime's previous assets/tier untouched and only records a
 * sourceError, exactly like Scenarios A/B/C's applyXSource() functions in ../data/loader.ts.
 *--------------------------------------------------------------------------------------------*/
import { scoreAssets } from "../scenarioA/scoring";
import { adaptDataConnectAssets } from "./adapter";
import { createDataConnectClient } from "./dataconnectClient";
import { storeAPrime } from "./storeAPrime";
import type { DcRow, DataConnectClasses, ScoredAssetPrime } from "./types";

/** DataConnect class names, in the join shape adaptDataConnectAssets() expects. */
export const DC_CLASSES = {
  assetRegistry: "asset_registry",
  workOrders: "work_orders",
  safetyInspections: "safety_inspections_v3",
  roadwayInspections: "roadway_inspections_v3",
  itsInspections: "its_inspections_v3",
  incidents: "incidents_v3",
} as const;

export type DcTier = "live" | "snapshot" | "local";

export interface DcLoadResult {
  classes: DataConnectClasses;
  tier: DcTier;
}

/** Read the `dc` query param from a search string. Defaults to the browser's current location
 *  when available (undefined in node-env tests — callers there always pass an explicit string,
 *  which keeps this module DOM-free for testing purposes). */
export function resolveDcBaseUrl(search?: string): string | null {
  const raw = search ?? (typeof window !== "undefined" ? window.location.search : "");
  const params = new URLSearchParams(raw);
  const dc = params.get("dc");
  return dc ? dc.replace(/\/$/, "") : null;
}

function currentSearch(search?: string): string {
  return search ?? (typeof window !== "undefined" ? window.location.search : "");
}

async function fetchJsonArray(url: string): Promise<DcRow[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status} ${url}`);
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("json")) throw new Error(`fetch did not return JSON: ${url}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error(`expected a JSON array: ${url}`);
  return body as DcRow[];
}

/** Deployed-snapshot URL for one DataConnect class. Resolved against the app's build-time
 *  BASE_URL ("/acs-demo/acs/" on Pages, "/" locally), NOT the page URL: after the OAuth
 *  redirect the SPA can sit at a no-trailing-slash URL (/acs-demo/acs), where a page-relative
 *  "../twin/…" fetch shifts up one directory to /twin/… and 404s — the exact "assets load on
 *  my machine but not on a fresh one" failure (a cached IMS session skips the redirect, so the
 *  trailing slash survives and the old relative fetch happened to work). */
export function snapshotUrl(
  name: string,
  base: string = import.meta.env?.BASE_URL || "/"
): string {
  return new URL(`../twin/dataconnect-data/${name}.json`, new URL(base, "http://resolve.invalid"))
    .pathname;
}

function zipClasses(names: string[], rowsList: DcRow[][]): DataConnectClasses {
  const byName = new Map(names.map((n, i) => [n, rowsList[i]]));
  return {
    assetRegistry: byName.get(DC_CLASSES.assetRegistry) ?? [],
    workOrders: byName.get(DC_CLASSES.workOrders) ?? [],
    safetyInspections: byName.get(DC_CLASSES.safetyInspections) ?? [],
    roadwayInspections: byName.get(DC_CLASSES.roadwayInspections) ?? [],
    itsInspections: byName.get(DC_CLASSES.itsInspections) ?? [],
    incidents: byName.get(DC_CLASSES.incidents) ?? [],
  };
}

/**
 * Fetch all 6 DataConnect classes needed by adaptDataConnectAssets(), selecting the tier ONCE
 * for the whole batch (mirrors cesium-poc/src/main.js's loadDcAssets()/loadDcSnapshot() split).
 */
export async function fetchAllClasses(search?: string): Promise<DcLoadResult> {
  const names = Object.values(DC_CLASSES);
  const dcBase = resolveDcBaseUrl(search);

  if (dcBase) {
    const qs = new URLSearchParams(currentSearch(search));
    const client = createDataConnectClient(dcBase, {
      username: qs.get("dcuser") || undefined,
      password: qs.get("dcpass") || undefined,
      // ?dctoken= — pre-acquired IMS OIDC bearer token; the production DataConnect deployment
      // has no /api/authenticate (IMS-only), so this is the live-tier path for the real instance.
      bearerToken: qs.get("dctoken") || undefined,
    });
    await client.login();
    const rows = (await Promise.all(
      names.map((n) => client.fetchClass(n, { pageSize: 500 }))
    )) as DcRow[][];
    return { classes: zipClasses(names, rows), tier: "live" };
  }

  try {
    const rows = await Promise.all(names.map((n) => fetchJsonArray(snapshotUrl(n))));
    return { classes: zipClasses(names, rows), tier: "snapshot" };
  } catch {
    const rows = await Promise.all(names.map((n) => fetchJsonArray(`/dataconnect-data/${n}.json`)));
    return { classes: zipClasses(names, rows), tier: "local" };
  }
}

/**
 * Load Scenario A′'s DataConnect dataset end-to-end: resolve tier -> fetch the 6 classes ->
 * adapt (adapter.ts) -> score (REUSED ../scenarioA/scoring.ts engine, unchanged) -> push into
 * storeAPrime. On any failure, storeAPrime's *previous* assets/tier are left untouched — only
 * sourceError is set (keep-previous-on-failure, matching ../data/loader.ts's applyAssetSource).
 */
export async function loadAssetsPrime(search?: string): Promise<void> {
  storeAPrime.setLoading(true);
  try {
    const { classes, tier } = await fetchAllClasses(search);
    const raw = adaptDataConnectAssets(classes);
    // scoreAsset() spreads `{...a, ...}` so raw's lon/lat/_related survive the reused engine at
    // runtime; ScoredAssetPrime is a subtype of the engine's declared ScoredAsset return type,
    // so this narrowing assertion just gives that runtime shape back its static type.
    const scored = scoreAssets(raw, []) as ScoredAssetPrime[];
    storeAPrime.loadAssets(scored, tier);
  } catch (e) {
    storeAPrime.setSourceError(
      e instanceof Error ? e.message : "Could not load the DataConnect asset dataset."
    );
  }
}
