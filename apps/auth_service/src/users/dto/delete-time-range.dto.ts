import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsString, Matches, IsNotEmpty } from 'class-validator';
import { DayOfWeek } from '@app/common/enums';

export class DeleteTimeRangeDto {
  @ApiProperty({
    description: 'Day of the week to delete time range from',
    enum: DayOfWeek,
    example: DayOfWeek.MONDAY,
  })
  @IsEnum(DayOfWeek, { message: 'Invalid day of week' })
  dayOfWeek: DayOfWeek;

  @ApiProperty({
    description: 'Start time of the time range to delete (HH:mm format)',
    example: '09:00',
  })
  @IsNotEmpty({ message: 'Start time is required' })
  @IsString()
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, {
    message: 'Start time must be in HH:mm format (24-hour)',
  })
  startTime: string;

  @ApiProperty({
    description: 'End time of the time range to delete (HH:mm format)',
    example: '12:00',
  })
  @IsNotEmpty({ message: 'End time is required' })
  @IsString()
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, {
    message: 'End time must be in HH:mm format (24-hour)',
  })
  endTime: string;
}
