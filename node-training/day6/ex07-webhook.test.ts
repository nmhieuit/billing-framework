import { expect, test } from 'vitest';
import { createWalletState } from './ex07-webhook.js';

function setup() {
  const state = createWalletState();
  state.addTopup('t1', 100);
  state.addTopup('t2', 50);
  return state;
}

test('succeeded cộng tiền', () => {
  const state = setup();
  expect(state.handleWebhook({ eventId: 'e1', topupId: 't1', result: 'succeeded' })).toBe('applied');
  expect(state.statusOf('t1')).toBe('SUCCEEDED');
  expect(state.balance()).toBe(100);
});

test('webhook trùng eventId: không cộng hai lần', () => {
  const state = setup();
  state.handleWebhook({ eventId: 'e1', topupId: 't1', result: 'succeeded' });
  expect(state.handleWebhook({ eventId: 'e1', topupId: 't1', result: 'succeeded' })).toBe('duplicate');
  expect(state.balance()).toBe(100);
});

test('failed -> FAILED, không cộng tiền', () => {
  const state = setup();
  state.handleWebhook({ eventId: 'e1', topupId: 't2', result: 'failed' });
  expect(state.statusOf('t2')).toBe('FAILED');
  expect(state.balance()).toBe(0);
});

test('succeeded đến muộn sau failed: vẫn được chấp nhận', () => {
  const state = setup();
  state.handleWebhook({ eventId: 'e1', topupId: 't1', result: 'failed' });
  expect(state.handleWebhook({ eventId: 'e2', topupId: 't1', result: 'succeeded' })).toBe('applied');
  expect(state.statusOf('t1')).toBe('SUCCEEDED');
  expect(state.balance()).toBe(100);
});

test('succeeded khác eventId gửi lần hai: không cộng lần hai', () => {
  const state = setup();
  state.handleWebhook({ eventId: 'e1', topupId: 't1', result: 'succeeded' });
  expect(state.handleWebhook({ eventId: 'e2', topupId: 't1', result: 'succeeded' })).toBe('ignored');
  expect(state.balance()).toBe(100);
});

test('failed đến sau khi đã SUCCEEDED: bỏ qua', () => {
  const state = setup();
  state.handleWebhook({ eventId: 'e1', topupId: 't1', result: 'succeeded' });
  expect(state.handleWebhook({ eventId: 'e2', topupId: 't1', result: 'failed' })).toBe('ignored');
  expect(state.statusOf('t1')).toBe('SUCCEEDED');
});

test('topup lạ', () => {
  expect(() => setup().handleWebhook({ eventId: 'e1', topupId: 'zz', result: 'succeeded' })).toThrow('unknown topup: zz');
});
