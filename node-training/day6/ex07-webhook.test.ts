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
  expect(state.handleWebhook({ eventId: 'e1', topupId: 't1', result: 'succeeded' })).toBe('applied');

  // Topup chuyển sang SUCCEEDED và balance = 100
  expect(state.statusOf('t1')).toBe('SUCCEEDED');
  expect(state.balance()).toBe(100);
});

// Payment gửi lại CÙNG một webhook (cùng eventId) -> không được cộng tiền hai lần
test('webhook trùng eventId: không cộng hai lần', () => {
  const state = setup();

  // Lần 1: xử lý bình thường
  state.handleWebhook({ eventId: 'e1', topupId: 't1', result: 'succeeded' });

  // Lần 2: cùng eventId 'e1' -> bị nhận ra là trùng
  expect(state.handleWebhook({ eventId: 'e1', topupId: 't1', result: 'succeeded' })).toBe('duplicate');

  // Balance vẫn là 100, không phải 200
  expect(state.balance()).toBe(100);
});

// Payment báo thất bại -> không cộng tiền
test('failed -> FAILED, không cộng tiền', () => {
  const state = setup();

  state.handleWebhook({ eventId: 'e1', topupId: 't2', result: 'failed' });

  expect(state.statusOf('t2')).toBe('FAILED');
  expect(state.balance()).toBe(0);
});

// Webhook đến sai thứ tự: 'failed' tới trước, 'succeeded' tới sau
// Payment là nguồn sự thật nên vẫn phải chấp nhận 'succeeded'
test('succeeded đến muộn sau failed: vẫn được chấp nhận', () => {
  const state = setup();

  // Trước tiên topup bị đánh dấu FAILED
  state.handleWebhook({ eventId: 'e1', topupId: 't1', result: 'failed' });

  // Sau đó 'succeeded' (eventId khác) đến muộn -> vẫn 'applied'
  expect(state.handleWebhook({ eventId: 'e2', topupId: 't1', result: 'succeeded' })).toBe('applied');

  // Topup đổi từ FAILED sang SUCCEEDED và tiền được cộng đúng một lần
  expect(state.statusOf('t1')).toBe('SUCCEEDED');
  expect(state.balance()).toBe(100);
});

// Hai webhook 'succeeded' có eventId KHÁC nhau cho cùng một topup
// (eventId khác nên không bị coi là duplicate, nhưng vẫn không được cộng lần hai)
test('succeeded khác eventId gửi lần hai: không cộng lần hai', () => {
  const state = setup();

  state.handleWebhook({ eventId: 'e1', topupId: 't1', result: 'succeeded' });

  // Topup đã SUCCEEDED rồi nên webhook thứ hai bị bỏ qua -> 'ignored'
  expect(state.handleWebhook({ eventId: 'e2', topupId: 't1', result: 'succeeded' })).toBe('ignored');
  expect(state.balance()).toBe(100);
});

// 'failed' đến sau khi topup đã SUCCEEDED -> không được phá trạng thái thành công
test('failed đến sau khi đã SUCCEEDED: bỏ qua', () => {
  const state = setup();

  state.handleWebhook({ eventId: 'e1', topupId: 't1', result: 'succeeded' });

  // Webhook 'failed' (eventId khác) bị bỏ qua
  expect(state.handleWebhook({ eventId: 'e2', topupId: 't1', result: 'failed' })).toBe('ignored');

  // Trạng thái vẫn là SUCCEEDED
  expect(state.statusOf('t1')).toBe('SUCCEEDED');
});

// Webhook nhắc tới topup không tồn tại ('zz') -> phải ném lỗi
test('topup lạ', () => {
  expect(() => setup().handleWebhook({ eventId: 'e1', topupId: 'zz', result: 'succeeded' })).toThrow('unknown topup: zz');
});
