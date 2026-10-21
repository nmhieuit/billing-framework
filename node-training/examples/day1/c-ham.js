function describeBalance(balance) {
  if (balance > 1000) {
    return 'nhiều';
  }
  return 'ít';
}

console.log(describeBalance(5000));
console.log(describeBalance(200));
console.log(5 === 5, 5 === '5');
