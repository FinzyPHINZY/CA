import { ApiProperty } from '@nestjs/swagger';

export class BaseResponseDto {
  @ApiProperty({
    description: 'Whether the request was successful',
    example: true,
  })
  success: boolean;

  @ApiProperty({
    description: 'Human-readable message describing the result',
    example: 'Operation completed successfully',
  })
  message: string;
}
