import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';

@ApiTags('Notifications')
@Controller()
export class NotificationsServiceController {
  constructor() {}

  @Get('hello')
  @ApiOperation({
    summary: 'Get notifications service status',
    description:
      'Returns a simple hello message to verify the notifications service is running',
  })
  @ApiOkResponse({
    description: 'Service is running',
    schema: { type: 'string', example: 'Hello World' },
  })
  async getHello(): Promise<string> {
    return 'Hello World';
  }
}
