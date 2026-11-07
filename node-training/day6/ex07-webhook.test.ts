import { expect, test } from 'vitest';
import { createWalletState } from './ex07-webhook.js';

// Tạo sẵn một ví có 2 topup đang PENDING để mỗi test dùng lại:
//   t1 = 100, t2 = 50
// Mỗi test gọi setup() riêng nên không ảnh hưởng lẫn nhau.
function setup() {
  const state = createWalletState();
  state.addTopup('t1', 100);
  state.addTopup('t2', 50);
  return state;
}

// Trường hợp bình thường: payment báo thành công -> tiền được cộng
test('succeeded cộng tiền', () => {
  const state = setup();

  // Webhook thành công -> kết quả 'applied'
  const result = state.handleWebhook({ eventId: 'e1', topupId: 't1', result: 'succeeded' });
  expect(result).toBe('applied');

  // Topup chuyển sang SUCCEEDED và balance = 100
  const status = state.statusOf('t1');
  const balance = state.balance();
  expect(status).toBe('SUCCEEDED');
  expect(balance).toBe(100);
});

// Payment gửi lại CÙNG một webhook (cùng eventId) -> không được cộng tiền hai lần
test('webhook trùng eventId: không cộng hai lần', () => {
  const state = setup();

  // Lần 1: xử lý bình thường (kết quả không dùng tới)
  state.handleWebhook({ eventId: 'e1', topupId: 't1', result: 'succeeded' });

  // Lần 2: cùng eventId 'e1' -> bị nhận ra là trùng
  const secondResult = state.handleWebhook({ eventId: 'e1', topupId: 't1', result: 'succeeded' });
  expect(secondResult).toBe('duplicate');

  // Balance vẫn là 100, không phải 200
  const balance = state.balance();
  expect(balance).toBe(100);
});

// Payment báo thất bại -> không cộng tiền
test('failed -> FAILED, không cộng tiền', () => {
  const state = setup();

  state.handleWebhook({ eventId: 'e1', topupId: 't2', result: 'failed' });

  const status = state.statusOf('t2');
  const balance = state.balance();
  expect(status).toBe('FAILED');
  expect(balance).toBe(0);
});

// Webhook đến sai thứ tự: 'failed' tới trước, 'succeeded' tới sau
// Payment là nguồn sự thật nên vẫn phải chấp nhận 'succeeded'
test('succeeded đến muộn sau failed: vẫn được chấp nhận', () => {
  const state = setup();

  // Trước tiên topup bị đánh dấu FAILED
  state.handleWebhook({ eventId: 'e1', topupId: 't1', result: 'failed' });

  // Sau đó 'succeeded' (eventId khác) đến muộn -> vẫn 'applied'
  const lateResult = state.handleWebhook({ eventId: 'e2', topupId: 't1', result: 'succeeded' });
  expect(lateResult).toBe('applied');

  // Topup đổi từ FAILED sang SUCCEEDED và tiền được cộng đúng một lần
  const status = state.statusOf('t1');
  const balance = state.balance();
  expect(status).toBe('SUCCEEDED');
  expect(balance).toBe(100);
});

// Hai webhook 'succeeded' có eventId KHÁC nhau cho cùng một topup
// (eventId khác nên không bị coi là duplicate, nhưng vẫn không được cộng lần hai)
test('succeeded khác eventId gửi lần hai: không cộng lần hai', () => {
  const state = setup();

  state.handleWebhook({ eventId: 'e1', topupId: 't1', result: 'succeeded' });

  // Topup đã SUCCEEDED rồi nên webhook thứ hai bị bỏ qua -> 'ignored'
  const secondResult = state.handleWebhook({ eventId: 'e2', topupId: 't1', result: 'succeeded' });
  expect(secondResult).toBe('ignored');

  const balance = state.balance();
  expect(balance).toBe(100);
});

// 'failed' đến sau khi topup đã SUCCEEDED -> không được phá trạng thái thành công
test('failed đến sau khi đã SUCCEEDED: bỏ qua', () => {
  const state = setup();

  state.handleWebhook({ eventId: 'e1', topupId: 't1', result: 'succeeded' });

  // Webhook 'failed' (eventId khác) bị bỏ qua
  const secondResult = state.handleWebhook({ eventId: 'e2', topupId: 't1', result: 'failed' });
  expect(secondResult).toBe('ignored');

  // Trạng thái vẫn là SUCCEEDED
  const status = state.statusOf('t1');
  expect(status).toBe('SUCCEEDED');
});

// Webhook nhắc tới topup không tồn tại ('zz') -> phải ném lỗi
test('topup lạ', () => {
  // Hàm gom các bước gây lỗi, để expect(...).toThrow() tự gọi và bắt lỗi
  function handleUnknownTopup() {
    const state = setup();
    return state.handleWebhook({ eventId: 'e1', topupId: 'zz', result: 'succeeded' });
  }

  expect(handleUnknownTopup).toThrow('unknown topup: zz');
});
