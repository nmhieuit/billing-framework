import {
  Inject,
  Injectable,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { MissingCustomerError } from '../../application/errors.js';
import type { TenantRegistry } from '../../application/ports.js';
import { CustomerId } from '../../domain/customer-id.js';
import type { TenantId } from '../../domain/tenant-id.js';
import { TENANT_REGISTRY } from './tokens.js';

export interface Caller {
  tenant: TenantId;
  customerId: CustomerId;
}

type CallerRequest = FastifyRequest & { caller?: Caller };

const headerValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value.join(',') : value;

/** Lấy tenant và khách từ header do gateway đặt; không bao giờ đọc từ body hay query. */
@Injectable()
export class CallerGuard implements CanActivate {
  constructor(@Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<CallerRequest>();
    const tenant = this.registry.resolve(headerValue(request.headers['x-tenant-id']));
    const rawCustomer = headerValue(request.headers['x-customer-id']);
    if (rawCustomer === undefined || rawCustomer.trim() === '') {
      throw new MissingCustomerError('customer is required');
    }
    request.caller = { tenant, customerId: CustomerId.parse(rawCustomer) };
    return true;
  }
}

export const CurrentCaller = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Caller => {
    const caller = context.switchToHttp().getRequest<CallerRequest>().caller;
    if (!caller) throw new Error('CallerGuard did not run before CurrentCaller');
    return caller;
  },
);
