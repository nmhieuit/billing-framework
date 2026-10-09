import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok'; service: 'wallet' } {
    return { status: 'ok', service: 'wallet' };
  }
}
