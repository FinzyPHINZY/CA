/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsObject, IsOptional, IsString } from 'class-validator';

export class NcsEventDto {
  @ApiProperty({
    description: 'Agora NCS event type code',
    example: 103,
  })
  @IsNumber({}, { message: 'Event type must be a number' })
  eventType: number;

  @ApiProperty({
    description:
      'Event payload from Agora NCS. RTC events use `channelName`; cloud-recording events (productId=3) use `cname`.',
    example: { channelName: 'session_abc', uid: 12345 },
  })
  @IsObject({ message: 'Payload must be an object' })
  @IsOptional()
  payload: any;

  @ApiPropertyOptional({
    description:
      'Agora product line. 1=RTC, 3=cloud recording. Used to disambiguate event semantics.',
    example: 1,
  })
  @IsOptional()
  @IsNumber()
  productId?: number;

  @ApiPropertyOptional({ description: 'Agora notice id (idempotency key)' })
  @IsOptional()
  @IsString()
  noticeId?: string;

  @ApiPropertyOptional({
    description: 'Notification timestamp (ms since epoch) from Agora.',
  })
  @IsOptional()
  @IsNumber()
  notifyMs?: number;

  @ApiPropertyOptional({
    description:
      'Cloud-recording session id, present only on productId=3 events.',
  })
  @IsOptional()
  @IsString()
  sid?: string;
}
