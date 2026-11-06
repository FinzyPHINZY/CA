import { ApiProperty } from '@nestjs/swagger';
import { IsArray, ValidateNested, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { DayAvailabilityDto } from './day-availability.dto';

export class UpdateAvailabilityDto {
  @ApiProperty({
    description: 'Array of day availabilities with time ranges',
    type: [DayAvailabilityDto],
    example: [
      {
        dayOfWeek: 'MONDAY',
        timeRanges: [
          { startTime: '09:00', endTime: '12:00' },
          { startTime: '14:00', endTime: '17:00' },
        ],
      },
    ],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DayAvailabilityDto)
  @IsOptional()
  days?: DayAvailabilityDto[];
}
