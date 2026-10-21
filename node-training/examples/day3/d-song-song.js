function wait(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

async function main() {
  let start = Date.now();
  const a = await wait(200, 'a');
  const b = await wait(200, 'b');
  console.log('lần lượt:', a, b, `${Date.now() - start}ms`);

  start = Date.now();
  const results = await Promise.all([wait(200, 'a'), wait(200, 'b')]);
  console.log('song song:', results, `${Date.now() - start}ms`);
}

main();
