export interface Charge {
  id: string;
  amount: number;
  status: 'succeeded' | 'failed' | 'pending';
  createdAt: number;
}

export function summarize(charges: Charge[]) {
  let succeededTotal = 0;
  let failedCount = 0;
  let latest: Charge | null = null;

  for (const charge of charges) {
    if (charge.status === 'succeeded') {
      succeededTotal += charge.amount;
    }
    if (charge.status === 'failed') {
      failedCount += 1;
    }
    if (latest === null || charge.createdAt > latest.createdAt) {
      latest = charge;
    }
  }

  return { succeededTotal, failedCount, latestId: latest ? latest.id : null };
}
