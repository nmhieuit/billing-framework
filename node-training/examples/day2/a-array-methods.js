const amounts = [10, 20, 30, 40];

const doubled = amounts.map((amount) => amount * 2);
const big = amounts.filter((amount) => amount >= 30);
const total = amounts.reduce((sum, amount) => sum + amount, 0);

console.log(doubled);
console.log(big);
console.log(total);
