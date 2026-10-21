import { expect, test } from 'vitest';
import { fromCents, toCents } from './ex01-cents.js';

test('toCents', () => {
  expect(toCents('12.34')).toBe(1234);
  expect(toCents('5')).toBe(500);
  expect(toCents('0.1')).toBe(10);
  expect(toCents('12.5')).toBe(1250);
  expect(toCents('0.29')).toBe(29);
});

test('fromCents', () => {
  expect(fromCents(1234)).toBe('12.34');
  expect(fromCents(5)).toBe('0.05');
  expect(fromCents(500)).toBe('5.00');
  expect(fromCents(0)).toBe('0.00');
});

test('chuỗi sai dạng', () => {
  for (const bad of ['abc', '1.234', '', '-1']) {
    expect(() => toCents(bad)).toThrow(`invalid money: ${bad}`);
  }
});

test('không bị sai số của số thập phân', () => {
  expect(fromCents(toCents('0.10') + toCents('0.20'))).toBe('0.30');
});
