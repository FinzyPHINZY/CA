import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsUUID } from 'class-validator';

export class CreateSelfTapeSessionDto {
  @ApiProperty({
    description: 'Project ID for the self-tape session',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID('4')
  @IsNotEmpty()
  projectId: string;

  @ApiProperty({
    description: 'Script ID for the self-tape session',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID('4')
  @IsNotEmpty()
  scriptId: string;

  @ApiProperty({
    description: 'Scene ID for the self-tape session',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID('4')
  @IsNotEmpty()
  sceneId: string;
}
