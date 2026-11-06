import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty } from 'class-validator';

export class ResolveNoShowDto {
  @ApiProperty({
    description: 'Who was absent from the session',
    enum: ['actor', 'reader'],
    example: 'reader',
  })
  @IsNotEmpty()
  @IsIn(['actor', 'reader'])
  noShowBy: 'actor' | 'reader';
}
