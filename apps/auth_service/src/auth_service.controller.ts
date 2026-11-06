import { Controller, Get } from '@nestjs/common';
import { Auth_Service } from './auth_service.service';
@Controller('auth')
export class AuthServiceController {
  constructor(private readonly auth_service: Auth_Service) {}

  @Get()
  getHello(): string {
    return this.auth_service.getHello();
  }
}
