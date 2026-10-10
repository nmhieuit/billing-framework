import {
  Inject,
  Injectable,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { TenantRegistry } from '../../application/ports.js';
import type { TenantId } from '../../domain/tenant-id.js';
import { TENANT_REGISTRY } from './tokens.js';

type TenantRequest = FastifyRequest & { reconciliationTenant?: TenantId };

const headerValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value.join(',') : value;

/** Cho API vận hành (không gắn với khách): chỉ cần tenant, lấy từ header do gateway đặt. */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(@Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TenantRequest>();
    request.reconciliationTenant = this.registry.resolve(
      headerValue(request.headers['x-tenant-id']),
    );
    return true;
  }
}

export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantId => {
    const tenant = context.switchToHttp().getRequest<TenantRequest>().reconciliationTenant;
    if (!tenant) throw new Error('TenantGuard did not run before CurrentTenant');
    return tenant;
  },
);
