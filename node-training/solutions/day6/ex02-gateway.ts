export type ChargeOutcome =
  | { outcome: 'created'; chargeId: string }
  | { outcome: 'rejected'; status: number }
  | { outcome: 'unavailable' };

export async function createCharge(url: string, amount: number, timeoutMs: number): Promise<ChargeOutcome> {
  try {
    const response = await fetch(`${url}/charges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 202) {
      const body = (await response.json()) as { chargeId: string };
      return { outcome: 'created', chargeId: body.chargeId };
    }
    if (response.status >= 400 && response.status < 500) {
      return { outcome: 'rejected', status: response.status };
    }
    return { outcome: 'unavailable' };
  } catch {
    return { outcome: 'unavailable' };
  }
}
