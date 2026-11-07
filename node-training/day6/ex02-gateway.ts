// Bài 2 (Trung bình): cổng gọi payment có TIMEOUT, trả về kết quả có tên rõ ràng thay vì ném lỗi.
// createCharge(url, amount, timeoutMs) trả về MỘT trong ba dạng:
//   { outcome: 'created', chargeId }     khi payment trả 202
//   { outcome: 'rejected', status }      khi payment trả 4xx (từ chối, thử lại vô ích)
//   { outcome: 'unavailable' }           khi quá thời gian chờ, lỗi mạng, hoặc payment trả 5xx (có thể thử lại)
// Hàm này KHÔNG bao giờ ném lỗi.

// Ba kết quả có thể xảy ra (| nghĩa là "hoặc")
export type ChargeOutcome =
  | { outcome: 'created'; chargeId: string }
  | { outcome: 'rejected'; status: number }
  | { outcome: 'unavailable' };

export async function createCharge(url: string, amount: number, timeoutMs: number): Promise<ChargeOutcome> {
  // Toàn bộ thân hàm nằm trong try để lỗi mạng / timeout không bao giờ ném ra ngoài
  try {
    // Địa chỉ đầy đủ của endpoint tạo charge. Debug: log biến này nếu request đi sai địa chỉ.
    const requestUrl = `${url}/charges`;

    // Dữ liệu gửi đi dạng đối tượng JS, rồi đổi thành chuỗi JSON để làm body
    const requestPayload = { amount };
    const requestBody = JSON.stringify(requestPayload);

    // Header báo cho server biết body là JSON
    const requestHeaders = { 'content-type': 'application/json' };

    // AbortSignal.timeout: tự hủy request nếu quá timeoutMs mili-giây (fetch sẽ ném lỗi)
    const timeoutSignal = AbortSignal.timeout(timeoutMs);

    // Cấu hình cho fetch
    const requestOptions = {
      method: 'POST',
      headers: requestHeaders,
      body: requestBody,
      signal: timeoutSignal,
    };

    // Gửi request. Nếu quá thời gian chờ hoặc lỗi mạng, fetch ném lỗi và nhảy xuống catch bên dưới.
    const response = await fetch(requestUrl, requestOptions);

    // Mã trạng thái HTTP của phản hồi. Debug: log biến này để biết payment trả mã gì.
    const statusCode = response.status;

    // Nhánh 202: payment đã nhận yêu cầu
    if (statusCode === 202) {
      // Đọc body JSON (bất đồng bộ). Nếu body hỏng, lỗi rơi xuống catch và bị báo là 'unavailable'.
      const parsedBody = await response.json();

      // Ép kiểu chỉ có tác dụng lúc biên dịch, không kiểm tra dữ liệu lúc chạy
      const responseData = parsedBody as { chargeId: string };

      const createdResult: ChargeOutcome = { outcome: 'created', chargeId: responseData.chargeId };
      return createdResult;
    }

    // Nhánh 4xx: lỗi do yêu cầu của mình, thử lại cũng vô ích
    if (statusCode >= 400 && statusCode < 500) {
      const rejectedResult: ChargeOutcome = { outcome: 'rejected', status: statusCode };
      return rejectedResult;
    }

    // Nhánh còn lại (5xx...): payment đang gặp sự cố, có thể thử lại sau
    const unavailableResult: ChargeOutcome = { outcome: 'unavailable' };
    return unavailableResult;
  } catch {
    // Quá thời gian chờ hoặc lỗi mạng đều rơi vào đây.
    // Lưu ý: mọi lỗi (kể cả JSON hỏng ở nhánh 202) cũng rơi vào đây và đều thành 'unavailable'.
    const failureResult: ChargeOutcome = { outcome: 'unavailable' };
    return failureResult;
  }
}
