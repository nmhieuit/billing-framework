const wallet = { owner: 'An', balance: 100 };
wallet.balance = wallet.balance + 50;
console.log(wallet.owner, wallet.balance);

const transactions = [
  { type: 'deposit', amount: 100 },
  { type: 'withdraw', amount: 30 },
];
for (const tx of transactions) {
  console.log(tx.type, tx.amount);
}

function withdraw(wallet, amount) {
  if (amount > wallet.balance) {
    throw new Error('Không đủ tiền');
  }
  wallet.balance = wallet.balance - amount;
}
withdraw(wallet, 1000);
