function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendEmail() {
  await wait(100);
  throw new Error('gửi mail thất bại');
}

function handleRequest() {
  sendEmail().catch((error) => console.log('đã bắt lỗi chạy nền:', error.message));
  return 'trả lời ngay, không chờ email';
}

console.log(handleRequest());
