/** biome-ignore-all lint/style/useImportType: <> */

import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CoreService } from './core.service';

@ApiTags('Core')
@Controller()
export class CoreController {
  constructor(private readonly coreService: CoreService) {}

  @Get()
  @ApiOperation({
    summary: 'Get service status',
    description:
      'Returns a simple hello message to verify the core service is running',
  })
  @ApiOkResponse({
    description: 'Service is running',
    schema: { type: 'string', example: 'Hello from ACR Core Service!' },
  })
  getHello(): string {
    return this.coreService.getHello();
  }
}
