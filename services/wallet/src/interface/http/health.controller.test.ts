import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('reports ok with the service name', () => {
    expect(new HealthController().check()).toEqual({ status: 'ok', service: 'wallet' });
  });
});
