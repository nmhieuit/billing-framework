export function sum(numbers) {
  let total = 0;
  for (const n of numbers) {
    total = total + n;
  }
  return total;
}

export function max(numbers) {
  if (numbers.length === 0) {
    return undefined;
  }
  let best = numbers[0];
  for (const n of numbers) {
    if (n > best) {
      best = n;
    }
  }
  return best;
}
