import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { MissingTenantError, UnknownTenantError } from '../../application/errors.js';
import { TenantId } from '../../domain/tenant-id.js';
import { ApiError } from './errors.js';
import { OpsGuard } from './ops.guard.js';

const acme = TenantId.parse('acme');
const registry = {
  resolve: (raw: string | undefined) => {
    if (raw === undefined) throw new MissingTenantError('tenant is required');
    if (raw !== 'acme') throw new UnknownTenantError('unknown tenant');
    return acme;
  },
  all: () => [acme],
};

function run(headers: Record<string, string | string[] | undefined>) {
  const request: { headers: typeof headers; ops?: unknown } = { headers };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const result = new OpsGuard(registry).canActivate(context);
  return { result, request };
}
const ok = { 'x-tenant-id': 'acme', 'x-actor-id': 'op@x', 'x-actor-role': 'OPS' };
const failure = (headers: Record<string, string | string[] | undefined>): unknown => {
  try {
    run(headers);
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('OpsGuard', () => {
  it('assigns tenant and actor when actor id and OPS role are present', () => {
    const { result, request } = run(ok);
    expect(result).toBe(true);
    expect(request.ops).toEqual({ tenant: acme, actor: 'op@x' });
  });

  it.each([undefined, '', '   '])('rejects a missing or blank x-actor-id (%j) with 401', (id) => {
    const error = failure({ ...ok, 'x-actor-id': id });
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'MISSING_ACTOR' });
  });

  it.each([undefined, 'ADMIN', 'ops', ['OPS', 'ADMIN']])(
    'rejects role %j with 403 FORBIDDEN_ROLE',
    (role) => {
      expect(failure({ ...ok, 'x-actor-role': role })).toMatchObject({
        status: 403,
        code: 'FORBIDDEN_ROLE',
      });
    },
  );

  it('checks the actor before the role and the role before the tenant', () => {
    expect(failure({})).toMatchObject({ status: 401 });
    expect(failure({ 'x-actor-id': 'op@x' })).toMatchObject({ status: 403 });
    expect(failure({ 'x-actor-id': 'op@x', 'x-actor-role': 'OPS' })).toBeInstanceOf(
      MissingTenantError,
    );
    expect(failure({ ...ok, 'x-tenant-id': 'zzz' })).toBeInstanceOf(UnknownTenantError);
  });

  it('ignores customer headers as identity', () => {
    expect(
      failure({ 'x-tenant-id': 'acme', 'x-customer-id': 'c1', 'x-actor-role': 'OPS' }),
    ).toMatchObject({ status: 401, code: 'MISSING_ACTOR' });
    expect(run({ ...ok, 'x-customer-id': 'c1' }).request.ops).toEqual({
      tenant: acme,
      actor: 'op@x',
    });
  });
});
