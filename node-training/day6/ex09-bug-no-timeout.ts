// Bài 9 (Sửa lỗi): payment chậm làm cả chương trình bị "treo" theo.
// ping(url, timeoutMs) phải trả 'ok' nếu payment trả lời kịp, ngược lại 'timeout'.
// Lỗi gốc: gọi fetch mà thiếu tham số signal nên fetch chờ vô thời hạn.
// Bản sửa: thêm signal: AbortSignal.timeout(timeoutMs).

export async function ping(url: string, timeoutMs: number): Promise<'ok' | 'timeout'> {
  try {
    // Địa chỉ đầy đủ của endpoint. Debug: log biến này nếu request đi sai địa chỉ.
    const requestUrl = `${url}/charges`;

    // Body thử nghiệm: số tiền 1
    const requestPayload = { amount: 1 };
    const requestBody = JSON.stringify(requestPayload);

    // Header báo cho server biết body là JSON
    const requestHeaders = { 'content-type': 'application/json' };

    // Quá timeoutMs mili-giây thì request bị hủy và fetch ném lỗi (nhảy xuống catch)
    const timeoutSignal = AbortSignal.timeout(timeoutMs);

    const requestOptions = {
      method: 'POST',
      headers: requestHeaders,
      body: requestBody,
      signal: timeoutSignal,
    };

    // Gửi request và chờ phản hồi. Kết quả không được dùng: chỉ cần có phản hồi là đủ.
    // Lưu ý: mã trạng thái KHÔNG được kiểm tra, nên phản hồi 500 cũng vẫn trả 'ok'.
    await fetch(requestUrl, requestOptions);

    // Nhánh có phản hồi kịp thời
    return 'ok';
  } catch {
    // Nhánh quá thời gian chờ hoặc lỗi mạng (bất kỳ lỗi nào đều thành 'timeout')
    return 'timeout';
  }
}
