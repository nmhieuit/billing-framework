export async function callPayment(url: string, amount: number): Promise<string> {
  const response = await fetch(`${url}/charges`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount }),
  });
  if (response.status !== 202) {
    throw new Error(`payment responded ${response.status}`);
  }
  const body = (await response.json()) as { chargeId: string };
  return body.chargeId;
}
