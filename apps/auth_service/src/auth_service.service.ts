import { Injectable } from '@nestjs/common';
@Injectable()
export class Auth_Service {
  constructor() {}
  getHello(): string {
    return 'Hello World!';
  }
}
