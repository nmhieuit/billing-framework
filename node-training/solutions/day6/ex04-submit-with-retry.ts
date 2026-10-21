export type ChargeOutcome =
  | { outcome: 'created'; chargeId: string }
  | { outcome: 'rejected'; status: number }
  | { outcome: 'unavailable' };

export async function submitWithRetry(
  attempt: () => Promise<ChargeOutcome>,
  delaysMs: number[],
  sleep: (ms: number) => Promise<void>,
): Promise<ChargeOutcome & { attempts: number }> {
  for (let count = 1; ; count += 1) {
    const result = await attempt();
    if (result.outcome !== 'unavailable') {
      return { ...result, attempts: count };
    }
    const delay = delaysMs[count - 1];
    if (delay === undefined) {
      return { ...result, attempts: count };
    }
    await sleep(delay);
  }
}
