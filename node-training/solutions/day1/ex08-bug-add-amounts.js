function toAmount(value) {
  const n = Number(value);
  if (Number.isNaN(n)) {
    throw new Error(`invalid amount: ${value}`);
  }
  return n;
}

export function addAmounts(a, b) {
  return toAmount(a) + toAmount(b);
}
