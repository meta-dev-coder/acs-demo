/**
 * Per-question data-source scope (config/askTwin/sources.json). Dan's ask: a maintenance team should
 * get answers about only its own assets, while an executive toggles in tolling and revenue to weigh
 * trade-offs. A scope is a focus, not a permission: it narrows what this question may read, it
 * never widens anything, and every answer says which sources it used and which were toggled off,
 * so a maintenance-only answer is never mistaken for the full picture.
 */
import SOURCES from '../../config/askTwin/sources.json' with { type: 'json' };

export const SOURCE_IDS = Object.freeze(Object.keys(SOURCES.sources));
export const PERSONA_PRESETS = Object.freeze(SOURCES.personaPresets);

const sourceOfClass = new Map();
const sourceOfTool = new Map();
for (const [id, def] of Object.entries(SOURCES.sources)) {
  for (const name of def.classes) sourceOfClass.set(name.toLowerCase(), id);
  for (const name of def.tools) sourceOfTool.set(name, id);
}

export const labelOf = id => SOURCES.sources[id]?.label ?? id;
/** The source a class belongs to, or null when it is always available. */
export const classSource = className => sourceOfClass.get(String(className ?? '').trim().toLowerCase()) ?? null;
/** The source a tool belongs to, or null when it is always available. */
export const toolSource = name => sourceOfTool.get(name) ?? null;

/** The browser's selection, whitelisted; absent or empty means every source (the de-siloed default). */
export function sanitizeSources(value) {
  if (!Array.isArray(value)) return null;
  const picked = [...new Set(value.filter(id => SOURCE_IDS.includes(id)))];
  return picked.length ? picked.sort((a, b) => SOURCE_IDS.indexOf(a) - SOURCE_IDS.indexOf(b)) : null;
}

/**
 * The scope for one question.
 * @param {string[]|null} selected  sanitized source ids, or null for all
 */
export function createScope(selected) {
  const on = new Set(selected ?? SOURCE_IDS);
  const excluded = SOURCE_IDS.filter(id => !on.has(id));
  const gapFor = (id, what) => ({ gap: { type: 'out_of_scope', source: id, detail: `${what} belongs to "${labelOf(id)}", which is toggled off for this question. Say so; do not infer it.` } });
  return {
    selected: SOURCE_IDS.filter(id => on.has(id)),
    excluded,
    all: excluded.length === 0,
    key: excluded.length ? SOURCE_IDS.filter(id => on.has(id)).join('+') : 'all',
    allowsClass: className => { const id = classSource(className); return !id || on.has(id); },
    allowsTool: name => { const id = toolSource(name); return !id || on.has(id); },
    has: id => on.has(id),
    /** A typed gap when the tool or the class it names is outside the scope; null when allowed. */
    refusal(name, input = {}) {
      const tool = toolSource(name);
      if (tool && !on.has(tool)) return gapFor(tool, `The lookup ${name}`);
      const cls = input?.class_name ? classSource(input.class_name) : null;
      if (cls && !on.has(cls)) return gapFor(cls, `The class ${input.class_name}`);
      return null;
    },
    /** Source ids that the given lookups drew on (by tool, then by class). */
    usedBy(calls) {
      const used = new Set();
      for (const call of calls) {
        const id = toolSource(call.name) ?? (call.input?.class_name ? classSource(call.input.class_name) : null);
        if (id) used.add(id);
        for (const extra of call.output?.sourcesUsed ?? []) used.add(extra);
      }
      return SOURCE_IDS.filter(id => used.has(id));
    },
  };
}

/** The scope as a block of the system prompt, so the model knows what it may and may not draw on. */
export function scopePrompt(scope) {
  if (scope.all) return '';
  const off = scope.excluded.map(id => `${labelOf(id)} (${SOURCES.sources[id].classes.join(', ') || 'no record classes'})`).join('; ');
  return `DATA SOURCES FOR THIS QUESTION (chosen by the user): ${scope.selected.map(labelOf).join(', ')}.
TOGGLED OFF: ${off}. Lookups on these are refused with an out_of_scope gap. Answer from the sources in scope only. If the question needs a toggled-off source, answer what you can and list the missing source under "gaps" (e.g. "Tolling & revenue is toggled off, so revenue impact is not included"). Never estimate toggled-off data.`;
}
