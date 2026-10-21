const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const saved = new Map<string, string>();
let charges = 0;

async function topupOnce(key: string): Promise<string> {
  const previous = saved.get(key);
  if (previous) {
    return previous;
  }
  charges += 1;
  const chargeNo = charges;
  await sleep(50);
  const result = `charge-${chargeNo}`;
  saved.set(key, result);
  return result;
}

const results = await Promise.all([topupOnce('k1'), topupOnce('k1')]);
console.log(results, 'số lần trừ tiền:', charges);
