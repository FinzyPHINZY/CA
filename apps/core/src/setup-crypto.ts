import { randomUUID } from 'crypto';

// Workaround for @nestjs/typeorm crypto issue
// This must be imported first before any other modules
if (typeof (global as any).crypto === 'undefined') {
  (global as any).crypto = {
    randomUUID: randomUUID,
  };
}
