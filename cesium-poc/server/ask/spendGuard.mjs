/**
 * A daily token budget for Ask the Twin: once the day's model usage reaches it, questions get a plain
 * "limit reached" answer until midnight UTC instead of a growing bill. Built-in answers (navigation,
 * TMC, drawn area) never reach the model and keep working.
 *
 * Usage is weighted roughly by price: cache reads cost about a tenth of fresh input, so they count a
 * tenth. The day's total is kept in memory and, when `statePath` is given, in a small JSON file so a
 * restart does not reset it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const dayOf = ms => new Date(ms).toISOString().slice(0, 10);

/** Weighted tokens of one usage object (as the orchestrator sums it). */
export function weightedTokens(usage = {}) {
  const n = key => Number(usage?.[key]) || 0;
  return n('input_tokens') + n('output_tokens') + n('cache_creation_input_tokens') + 0.1 * n('cache_read_input_tokens');
}

/**
 * @param {{dailyTokens?: number, statePath?: string|null, now?: () => number, logger?: Console}} options
 *   dailyTokens 0 or unset = no limit
 */
export function createSpendGuard({ dailyTokens = 0, statePath = null, now = Date.now, logger = console } = {}) {
  let state = { day: dayOf(now()), tokens: 0, questions: 0 };
  if (statePath && existsSync(statePath)) {
    try {
      const saved = JSON.parse(readFileSync(statePath, 'utf8'));
      if (saved?.day === state.day) state = { ...state, ...saved };
    } catch { /* a corrupt file starts the day at zero rather than blocking questions */ }
  }
  const roll = () => { if (state.day !== dayOf(now())) state = { day: dayOf(now()), tokens: 0, questions: 0 }; };
  const save = () => {
    if (!statePath) return;
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(`${statePath}.tmp`, JSON.stringify(state));
      renameSync(`${statePath}.tmp`, statePath);
    } catch (error) { logger.warn?.(`ask-the-twin: spend state not saved: ${error.message}`); }
  };
  return {
    limit: dailyTokens,
    /** Null when a question may go to the model, else the reason it may not. */
    blocked() {
      roll();
      return dailyTokens > 0 && state.tokens >= dailyTokens
        ? `Ask the Twin has reached today's usage limit. Built-in answers (navigation, TMC, drawn areas) still work; free-form questions resume at 00:00 UTC.` : null;
    },
    record(usage) {
      roll();
      state.tokens += weightedTokens(usage);
      state.questions += 1;
      save();
      if (dailyTokens > 0 && state.tokens >= dailyTokens) logger.warn?.(`ask-the-twin: daily token limit reached (${Math.round(state.tokens)} of ${dailyTokens})`);
    },
    status: () => { roll(); return { day: state.day, tokens: Math.round(state.tokens), questions: state.questions, limit: dailyTokens || null }; },
  };
}
