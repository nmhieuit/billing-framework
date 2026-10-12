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
import { ApiError } from './errors.js';
import { TENANT_REGISTRY } from './tokens.js';

export interface OpsContext {
  tenant: TenantId;
  actor: string;
}

type OpsRequest = FastifyRequest & { ops?: OpsContext };

const headerValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value.join(',') : value;

/**
 * Cho API vận hành: danh tính CHỈ lấy từ header do gateway đặt (`x-actor-id`, `x-actor-role`), không bao giờ từ body.
 * Thứ tự: actor (401) -> vai trò (403) -> tenant. Header có nhiều giá trị bị nối lại nên không thể lách kiểm tra
 * (ví dụ `OPS, ADMIN` không bằng `OPS`). Header của khách (`x-customer-id`) không được dùng làm danh tính.
 */
@Injectable()
export class OpsGuard implements CanActivate {
  constructor(@Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<OpsRequest>();
    const actor = headerValue(request.headers['x-actor-id'])?.trim();
    if (actor === undefined || actor === '') {
      throw new ApiError(401, 'MISSING_ACTOR', 'x-actor-id header is required');
    }
    if (headerValue(request.headers['x-actor-role'])?.trim() !== 'OPS') {
      throw new ApiError(403, 'FORBIDDEN_ROLE', 'ops role is required');
    }
    const tenant = this.registry.resolve(headerValue(request.headers['x-tenant-id']));
    request.ops = { tenant, actor };
    return true;
  }
}

export const CurrentOps = createParamDecorator(
  (_data: unknown, context: ExecutionContext): OpsContext => {
    const ops = context.switchToHttp().getRequest<OpsRequest>().ops;
    if (!ops) throw new Error('OpsGuard did not run before CurrentOps');
    return ops;
  },
);
