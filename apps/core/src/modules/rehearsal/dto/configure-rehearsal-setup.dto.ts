import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsUUID } from 'class-validator';

export class ConfigureRehearsalSetupDto {
  @ApiProperty({
    description:
      'Character the actor will play in this rehearsal. Must belong to the linked scene.',
    example: '423e4567-e89b-12d3-a456-426614174003',
  })
  @IsUUID('4', { message: 'Character ID must be a valid UUID' })
  @IsNotEmpty({ message: 'Character ID is required' })
  characterId: string;
}
