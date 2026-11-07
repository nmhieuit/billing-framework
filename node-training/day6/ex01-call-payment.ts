// Bài 1 (Cơ bản): gọi payment bằng fetch.
// callPayment(url, amount): POST `${url}/charges` với body JSON { amount }.
//   Status 202 -> trả về chargeId lấy từ JSON phản hồi.
//   Status khác -> throw new Error(`payment responded ${status}`)

export async function callPayment(url: string, amount: number): Promise<string> {
  // Địa chỉ đầy đủ của endpoint tạo charge, ví dụ 'http://localhost:3000/charges'.
  // Debug: nếu request đi sai địa chỉ, log biến này đầu tiên.
  const requestUrl = `${url}/charges`;

  // Dữ liệu gửi đi, dạng đối tượng JS thường: { amount: 100 }.
  const requestPayload = { amount };

  // Đổi đối tượng thành chuỗi JSON, vì HTTP body chỉ gửi được chuỗi/bytes.
  // Debug: log biến này để xem server nhận đúng nội dung không.
  const requestBody = JSON.stringify(requestPayload);

  // Các header gửi kèm request.
  // 'content-type' báo cho server biết body là JSON để nó parse đúng.
  const requestHeaders = { 'content-type': 'application/json' };

  // Cấu hình cho fetch: dùng method POST vì đang gửi dữ liệu lên server.
  const requestOptions = {
    method: 'POST',
    headers: requestHeaders,
    body: requestBody,
  };

  // Gửi HTTP request. fetch trả về Promise nên phải await.
  // Không có try/catch ở đây (cố ý, giữ hành vi gốc): nếu fetch lỗi mạng
  // (server tắt, sai địa chỉ...) lỗi được ném thẳng lên cho nơi gọi hàm xử lý.
  const response = await fetch(requestUrl, requestOptions);

  // Mã trạng thái HTTP của phản hồi (202 = server đã nhận yêu cầu).
  // Debug: nếu hàm ném lỗi, log biến này để biết server trả mã gì.
  const statusCode = response.status;

  // Nhánh lỗi: bất kỳ mã nào khác 202 (kể cả 200, 201, 500) đều bị coi là thất bại.
  if (statusCode !== 202) {
    // Ném lỗi kèm mã trạng thái; nơi gọi hàm (hoặc test) sẽ bắt được lỗi này.
    throw new Error(`payment responded ${statusCode}`);
  }

  // Nhánh thành công (status = 202): đọc body phản hồi và đổi từ JSON thành đối tượng.
  // Đọc body cũng là thao tác bất đồng bộ nên phải await.
  // Nếu body không phải JSON hợp lệ, response.json() sẽ ném lỗi và lỗi đi thẳng lên nơi gọi.
  const parsedBody = await response.json();

  // Ép kiểu (chỉ có tác dụng khi biên dịch TypeScript, không kiểm tra dữ liệu lúc chạy):
  // coi như body có dạng { chargeId: string }.
  const responseData = parsedBody as { chargeId: string };

  // Lấy mã charge từ phản hồi để trả về cho nơi gọi.
  const chargeId = responseData.chargeId;

  return chargeId;
}
