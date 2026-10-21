export function totalsByType(transactions) {
  const totals = {};
  for (const tx of transactions) {
    if (totals[tx.type] === undefined) {
      totals[tx.type] = 0;
    }
    totals[tx.type] = totals[tx.type] + tx.amount;
  }
  return totals;
}
