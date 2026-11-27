/**
 * Seagirt Ask the Twin: a question the rules did not understand, read by Claude on the server
 * (server/ifcSpatial/interpret.mjs) and asked again in a form the rules know.
 *
 * Pure helpers for networkTwin.js: what is sent, when a rewrite is used, and when an area question only matched the
 * generic inventory. Questions the rules understand never reach these; with the model off, unreachable, over budget
 * or unsure, the rules' own answer is shown, as before.
 */

/** An asset id as Seagirt writes them (TX-M1, BUS-B, STS-05): a rewrite may name only listed ones. */
const ID_LIKE = /\b[A-Z]{1,8}\d*(?:-[A-Z0-9]{1,8})+\b/g;
const MAX_ASSETS = 800;

/**
 * The request body: the question and the small context needed to read it. Never the model, documents or reports.
 * @param {{question: string, assets: Iterable<{id: string, assetType?: string, name?: string}>, previousQuestion?: string|null,
 *   lastAssets?: string[], selectedAssetId?: string|null, area?: {label?: string}|null, typeLabel?: (type: string) => string}} o
 */
export function interpretRequest({ question, assets, previousQuestion = null, lastAssets = [], selectedAssetId = null, area = null, typeLabel = t => t }) {
  return {
    question: String(question ?? '').trim(),
    assets: [...assets].slice(0, MAX_ASSETS).map(a => ({ id: a.id, type: a.assetType ? typeLabel(a.assetType) : '', name: a.name && a.name !== a.id ? a.name : '' })),
    context: {
      previousQuestion: previousQuestion || null,
      lastAssets: (lastAssets ?? []).filter(Boolean).slice(0, 12),
      selectedAssetId: selectedAssetId || null,
      area: area ? { selected: true, label: area.label ?? 'Selected area' } : { selected: false },
    },
  };
}

/**
 * The rewrite to ask, or null: the server's reply checked again here (understood, not the same question, every
 * asset it names is in the open model).
 * @returns {string|null}
 */
export function acceptedRewrite(reply, { question, knownIds }) {
  if (!reply?.understood) return null;
  const rewritten = String(reply.rewritten ?? '').replace(/\s+/g, ' ').trim();
  if (!rewritten || rewritten.length > 300) return null;
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (norm(rewritten) === norm(String(question ?? ''))) return null;
  const named = [...(Array.isArray(reply.assetIds) ? reply.assetIds : []), ...(rewritten.match(ID_LIKE) ?? [])];
  if (named.some(id => !knownIds.has(id))) return null;
  return rewritten;
}

/**
 * An area question the rules only matched as "list the assets" because it said "what" or "which": no category, no
 * asset words. With the model on, Claude reads it first; otherwise (or when Claude is unsure) the inventory answers.
 */
export function isWeakAreaInventory(question, { hasCategory = false } = {}) {
  if (hasCategory) return false;
  return !/\b(assets?|equipment|devices?|items?|things|inventory|how many|count|list|show|everything|all)\b/i.test(String(question ?? ''));
}

/** The note above an answer to a rewritten question: what the twin understood. */
export const understoodNote = rewritten => `Understood as: “${rewritten}”`;
