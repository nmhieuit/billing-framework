function wait(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

async function loadAmount() {
  console.log('bắt đầu tải');
  const amount = await wait(100, 250);
  console.log('tải xong:', amount);
  return amount;
}

async function main() {
  try {
    const amount = await loadAmount();
    console.log('tổng:', amount * 2);
    throw new Error('lỗi giả để thử try/catch');
  } catch (error) {
    console.log('bắt được:', error.message);
  }
}

main();
console.log('dòng này in TRƯỚC "tải xong"');
