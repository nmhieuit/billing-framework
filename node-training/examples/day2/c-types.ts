interface Transaction {
  type: 'deposit' | 'withdraw';
  amount: number;
}

function describe(tx: Transaction): string {
  return `${tx.type}: ${tx.amount}`;
}

console.log(describe({ type: 'deposit', amount: 100 }));
