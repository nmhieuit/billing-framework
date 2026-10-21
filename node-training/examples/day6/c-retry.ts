const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function retry<T>(task: () => Promise<T>, delaysMs: number[]): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      const delay = delaysMs[attempt];
      if (delay === undefined) {
        throw error;
      }
      console.log(`lần ${attempt + 1} hỏng, chờ ${delay}ms rồi thử lại`);
      await sleep(delay);
    }
  }
}

let calls = 0;
const flaky = async () => {
  calls += 1;
  if (calls < 3) throw new Error('payment unavailable');
  return `thành công ở lần ${calls}`;
};

console.log(await retry(flaky, [100, 200, 400]));
