import {
  ArrayNotEmpty,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export type NotificationChannel = 'email' | 'in_app';

export class SendNotificationDto {
  @IsUUID()
  recipientUserId: string;

  @IsString()
  @MaxLength(150)
  title: string;

  @IsString()
  body: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  channels: NotificationChannel[];

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  template?: string;

  @IsOptional()
  @IsObject()
  data?: Record<string, any>;
}
