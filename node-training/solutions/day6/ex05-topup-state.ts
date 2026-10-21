export interface Topup {
  id: string;
  amount: number;
  status: 'REQUESTED' | 'PENDING' | 'FAILED';
  attempts: number;
  chargeId: string | null;
  failureCode: string | null;
  nextAttemptAt: Date | null;
}

export type Outcome = { outcome: 'created'; chargeId: string } | { outcome: 'rejected'; status: number } | { outcome: 'unavailable' };

export function newTopup(id: string, amount: number, now: Date): Topup {
  return { id, amount, status: 'REQUESTED', attempts: 0, chargeId: null, failureCode: null, nextAttemptAt: now };
}

export function applyOutcome(topup: Topup, outcome: Outcome, now: Date, delaysSeconds: number[]): Topup {
  if (outcome.outcome === 'created') {
    return { ...topup, status: 'PENDING', chargeId: outcome.chargeId, nextAttemptAt: null };
  }
  if (outcome.outcome === 'rejected') {
    return { ...topup, status: 'FAILED', failureCode: 'PAYMENT_REJECTED', nextAttemptAt: null };
  }
  const attempts = topup.attempts + 1;
  if (attempts <= delaysSeconds.length) {
    const delay = delaysSeconds[attempts - 1] as number;
    return { ...topup, attempts, nextAttemptAt: new Date(now.getTime() + delay * 1000) };
  }
  return { ...topup, attempts, status: 'FAILED', failureCode: 'PAYMENT_UNAVAILABLE', nextAttemptAt: null };
}
