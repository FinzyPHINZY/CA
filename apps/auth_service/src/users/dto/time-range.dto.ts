import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, IsNotEmpty } from 'class-validator';

export class TimeRangeDto {
  @ApiProperty({
    description: 'Start time in HH:mm format (24-hour)',
    example: '09:00',
  })
  @IsNotEmpty({ message: 'Start time is required' })
  @IsString()
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, {
    message: 'Start time must be in HH:mm format (24-hour)',
  })
  startTime: string;

  @ApiProperty({
    description: 'End time in HH:mm format (24-hour)',
    example: '12:00',
  })
  @IsNotEmpty({ message: 'End time is required' })
  @IsString()
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, {
    message: 'End time must be in HH:mm format (24-hour)',
  })
  endTime: string;
}
