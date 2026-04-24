// src/lib/budget.ts
import { estimateTokensV2 } from "../engine/token-estimator.js";

/** @deprecated v1 estimator kept for backward compatibility. Use estimateTokensV2 for accuracy. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export { estimateTokensV2 };

export interface BudgetState {
  budget: number;
  spent: number;
  floor: number;
}

export function checkBudget(state: BudgetState, estimatedCost: number): boolean {
  const remaining = state.budget - state.spent;
  return remaining - estimatedCost >= state.floor;
}

export function computeRefill(currentSpent: number, refillAmount: number): number {
  return Math.max(0, currentSpent - refillAmount);
}
