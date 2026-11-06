import { Request } from 'express';
import { User } from '@app/common';

export interface RequestWithUser extends Request {
  user: User;
}
