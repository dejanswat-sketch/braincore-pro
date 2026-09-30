import { BudgetExceededError } from './errors.js';

/**
 * Budžet jednog run-a: novac, tokeni, koraci, vrijeme.
 * Provjera je "fail-closed": ako ne možemo da dokažemo da je dozvoljeno — prekidamo.
 */
export function createBudget({
  runUsd = Infinity,
  monthlyUsd = Infinity,
  spentThisMonthUsd = 0,
  maxSteps = 12,
  maxTokens = Infinity,
  maxWallMs = 180_000,
} = {}) {
  const startedAt = Date.now();
  const state = {
    runUsd,
    monthlyUsd,
    spentThisMonthUsd,
    maxSteps,
    maxTokens,
    maxWallMs,
    steps: 0,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    estimatedNextUsd: 0,
  };

  const api = {
    get state() {
      return { ...state, elapsedMs: Date.now() - startedAt };
    },

    /** Pozovi prije svakog koraka/LLM poziva. */
    assertCanContinue({ estimatedUsd = 0, label = 'korak' } = {}) {
      state.estimatedNextUsd = estimatedUsd;
      if (state.steps >= state.maxSteps) {
        throw new BudgetExceededError(`Prekoračen broj koraka (${state.maxSteps})`, { limit: 'maxSteps', ...api.state });
      }
      if (Date.now() - startedAt > state.maxWallMs) {
        throw new BudgetExceededError(`Prekoračeno vrijeme run-a (${state.maxWallMs}ms)`, { limit: 'maxWallMs', ...api.state });
      }
      if (state.usd + estimatedUsd > state.runUsd) {
        throw new BudgetExceededError(`Run budžet prekoračen (${state.usd.toFixed(4)} + ${estimatedUsd.toFixed(4)} > ${state.runUsd} USD)`, {
          limit: 'runUsd',
          ...api.state,
        });
      }
      if (state.spentThisMonthUsd + state.usd + estimatedUsd > state.monthlyUsd) {
        throw new BudgetExceededError(`Mjesečni budžet tenantа prekoračen (${state.monthlyUsd} USD)`, { limit: 'monthlyUsd', ...api.state });
      }
      if (state.tokensIn + state.tokensOut >= state.maxTokens) {
        throw new BudgetExceededError(`Prekoračen broj tokena (${state.maxTokens})`, { limit: 'maxTokens', ...api.state });
      }
      return true;
    },

    addStep() {
      state.steps += 1;
      return state.steps;
    },

    /**
     * Podigne limit koraka (nikad ne snižava).
     * Koristi se kad multi-agent pattern (team, debate) traži više koraka od jednog agenta —
     * budžet se računa po patternu, ne po jednom pozivu.
     */
    setMaxSteps(n) {
      const value = Number(n);
      if (Number.isFinite(value) && value > state.maxSteps) state.maxSteps = value;
      return state.maxSteps;
    },

    /** Zabilježi stvarnu potrošnju. */
    spend({ usd = 0, tokensIn = 0, tokensOut = 0 } = {}) {
      state.usd += usd;
      state.tokensIn += tokensIn;
      state.tokensOut += tokensOut;
      return api.state;
    },

    remainingUsd: () => Math.max(0, state.runUsd - state.usd),
    isExhausted: () => state.steps >= state.maxSteps || state.usd >= state.runUsd,
  };

  return api;
}
