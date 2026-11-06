import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class HazelTokenRequestDto {
  @ApiProperty({
    description:
      'Rehearsal UUID. Caller must own the rehearsal. Channel name is derived deterministically as `hazel_rec_{rehearsalId}`.',
    example: '55555555-5555-5555-5555-555555555555',
  })
  @IsUUID()
  rehearsalId: string;
}
