import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, Min } from 'class-validator';

export class MarkTakeDto {
  @ApiProperty({
    description: 'Take number (sequential, starting from 1)',
    example: 1,
  })
  @IsInt()
  @Min(1)
  @IsNotEmpty()
  takeNumber: number;

  @ApiProperty({
    description: 'Start timestamp in milliseconds relative to recording start',
    example: 5000,
  })
  @IsInt()
  @Min(0)
  @IsNotEmpty()
  startMs: number;

  @ApiProperty({
    description: 'End timestamp in milliseconds relative to recording start',
    example: 45000,
  })
  @IsInt()
  @Min(0)
  @IsNotEmpty()
  endMs: number;
}
