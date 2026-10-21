function describeBalance(balance) {
  if (balance > 1000) {
    return 'nhiều';
  }
  return 'ít';
}

console.log(describeBalance(5000));
console.log(describeBalance(200));
console.log(5 === 5, 5 === '5');

function canWithdraw(balance, amount) {
  return amount > 0 && amount <= balance;
}
console.log(canWithdraw(100, 30), canWithdraw(100, 500), !canWithdraw(100, 500));
