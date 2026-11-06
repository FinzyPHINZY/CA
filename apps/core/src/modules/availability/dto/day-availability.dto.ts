import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsArray, ValidateNested, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { TimeRangeDto } from './time-range.dto';
import { DayOfWeek } from '@app/common';

export class DayAvailabilityDto {
  @ApiProperty({
    description: 'Day of the week',
    enum: DayOfWeek,
    example: DayOfWeek.MONDAY,
  })
  @IsEnum(DayOfWeek, { message: 'Invalid day of week' })
  dayOfWeek: DayOfWeek;

  @ApiProperty({
    description: 'Array of time ranges for this day',
    type: [TimeRangeDto],
    example: [{ startTime: '09:00', endTime: '12:00' }],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TimeRangeDto)
  @IsOptional()
  timeRanges?: TimeRangeDto[];
}
