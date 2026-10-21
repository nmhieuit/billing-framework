export async function totalAmount(ids: string[], loadAmount: (id: string) => Promise<number>): Promise<number> {
  let total = 0;
  for (const id of ids) {
    total += await loadAmount(id);
  }
  return total;
}
