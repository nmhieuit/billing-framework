const amounts = [10, 20, 30];
amounts.push(40);

let total = 0;
for (const amount of amounts) {
  total = total + amount;
}

console.log(amounts.length, total);
console.log(amounts[0], amounts[amounts.length - 1]);
