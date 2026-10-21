export async function ping(url: string, timeoutMs: number): Promise<'ok' | 'timeout'> {
  try {
    await fetch(`${url}/charges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 1 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return 'ok';
  } catch {
    return 'timeout';
  }
}
