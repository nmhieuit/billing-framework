function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(() => resolve('xong'), ms);
  });
}

function failAfter(ms) {
  return new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error('hỏng rồi')), ms);
  });
}

wait(100).then((value) => console.log('wait:', value));
failAfter(50).catch((error) => console.log('failAfter:', error.message));
console.log('đã đăng ký xong, chưa có kết quả nào');
