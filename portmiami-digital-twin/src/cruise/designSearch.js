/**
 * The smallest expansion of a garage that eliminates its modelled shortage.
 *
 * NOT A SUBTRACTION. Peak demand minus capacity understates the need: cars turned away earlier in
 * the week stay away for their whole voyage, and spaces added on Monday change what is parked on
 * Thursday. So each candidate is run through the full 15-minute simulation and allocation, and
 * the search keeps the smallest whole number of spaces that leaves no shortage — doubling until a
 * feasible value is found, then halving the gap to one space, then checking one space fewer still
 * fails. `evaluate(n)` is the caller's run of the design with `n` added spaces.
 */
export const SEARCH_STATUS = Object.freeze({
  FOUND: 'FOUND', NONE_NEEDED: 'NONE_NEEDED', INFEASIBLE: 'INFEASIBLE', UNKNOWN_CAPACITY: 'UNKNOWN_CAPACITY',
});

const resolved = r => r.maxShortage === 0 && r.turnedAway === 0;

/**
 * @param {(n: number) => Promise<{maxShortage: number, turnedAway: number}>|{maxShortage: number, turnedAway: number}} evaluate
 * @param {{ upper?: number, start?: number }} options
 */
export async function findMinimumExpansion(evaluate, { upper = 20000, start = 64 } = {}) {
  const seen = new Map();
  const ok = async n => {
    if (!seen.has(n)) seen.set(n, await evaluate(n));
    return resolved(seen.get(n));
  };
  if (await ok(0)) return { status: SEARCH_STATUS.NONE_NEEDED, minimum: 0, evaluations: seen.size };
  let lo = 0, hi = start;
  while (hi < upper && !(await ok(hi))) { lo = hi; hi *= 2; }
  if (hi >= upper) {
    hi = upper;
    if (!(await ok(hi))) return { status: SEARCH_STATUS.INFEASIBLE, minimum: null, tried: upper, at: seen.get(upper), evaluations: seen.size };
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await ok(mid)) hi = mid; else lo = mid;
  }
  // The answer is the smallest that works and one fewer does not — checked, not assumed.
  const confirmed = (await ok(hi)) && !(await ok(hi - 1));
  return { status: SEARCH_STATUS.FOUND, minimum: hi, confirmed, before: seen.get(hi - 1), evaluations: seen.size };
}
