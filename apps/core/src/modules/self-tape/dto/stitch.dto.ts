import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  Min,
  ValidateNested,
} from 'class-validator';

export class StitchTakeDto {
  @ApiProperty({ description: 'Take number to include', example: 1 })
  @IsInt()
  @Min(1)
  @IsNotEmpty()
  takeNumber: number;

  @ApiProperty({
    description: 'Start trim point in milliseconds',
    example: 0,
  })
  @IsInt()
  @Min(0)
  @IsNotEmpty()
  startMs: number;

  @ApiProperty({
    description: 'End trim point in milliseconds',
    example: 45000,
  })
  @IsInt()
  @Min(0)
  @IsNotEmpty()
  endMs: number;
}

export class StitchDto {
  @ApiProperty({
    description: 'Ordered list of takes to stitch together',
    type: [StitchTakeDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StitchTakeDto)
  @IsNotEmpty()
  takes: StitchTakeDto[];

  @ApiProperty({
    description: 'Whether to include the title card as the first 5 seconds',
    example: true,
  })
  @IsBoolean()
  @IsNotEmpty()
  includeTitleCard: boolean;
}
