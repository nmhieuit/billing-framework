import { describe, expect, it } from 'vitest';
import { DEFAULT_SCENARIO, InvalidScenarioError, parseScenario } from './scenario.js';

describe('parseScenario', () => {
  it.each([undefined, '', '   '])('returns the default scenario for %j', (header) => {
    expect(parseScenario(header)).toEqual({
      fail: null,
      delaySeconds: null,
      webhook: 'normal',
      responseTimeout: false,
    });
    expect(parseScenario(header)).toBe(DEFAULT_SCENARIO);
  });

  it('parses each token', () => {
    expect(parseScenario('fail=card_declined').fail).toBe('card_declined');
    expect(parseScenario('delay=5').delaySeconds).toBe(5);
    expect(parseScenario('delay=3600').delaySeconds).toBe(3600);
    expect(parseScenario('webhook=drop').webhook).toBe('drop');
    expect(parseScenario('webhook=duplicate').webhook).toBe('duplicate');
    expect(parseScenario('response=timeout').responseTimeout).toBe(true);
  });

  it('combines tokens regardless of order or spacing', () => {
    const a = parseScenario('delay=3,fail=insufficient_funds,webhook=duplicate');
    const b = parseScenario(' webhook=duplicate , fail=insufficient_funds,delay=3 ');
    expect(a).toEqual({
      fail: 'insufficient_funds',
      delaySeconds: 3,
      webhook: 'duplicate',
      responseTimeout: false,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it.each([
    'fail',
    'fail=',
    '=x',
    'x',
    ',',
    'fail=Bad',
    'fail=1abc',
    `fail=${'a'.repeat(65)}`,
    'delay=0',
    'delay=3601',
    'delay=1.5',
    'delay=abc',
    'delay=05',
    'delay=-1',
    'webhook=normal',
    'webhook=slow',
    'response=slow',
    'unknown=1',
    'fail=a,fail=b',
    'webhook=drop,webhook=duplicate',
  ])('rejects %j', (header) => {
    expect(() => parseScenario(header)).toThrow(InvalidScenarioError);
  });
});
