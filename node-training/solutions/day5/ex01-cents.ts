export function toCents(text: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new Error(`invalid money: ${text}`);
  }
  const [whole = '0', fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export function fromCents(cents: number): string {
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, '0');
  return `${whole}.${fraction}`;
}
