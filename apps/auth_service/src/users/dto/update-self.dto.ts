import {
  ArrayNotEmpty,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateSelfDto {
  @ApiProperty({
    description: 'User full name',
    example: 'John Doe',
    maxLength: 100,
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'Full name must not exceed 100 characters' })
  fullName?: string;

  @ApiProperty({
    description: 'User phone number',
    example: '+1234567890',
    maxLength: 100,
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'Phone number must not exceed 100 characters' })
  phoneNumber?: string;

  @ApiProperty({
    description: 'URL to user avatar image',
    example: 'https://example.com/avatar.jpg',
    maxLength: 255,
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'Avatar URL must not exceed 255 characters' })
  avatar?: string;

  @ApiProperty({
    description: 'User biography or description',
    example: 'Experienced actor with a passion for dramatic roles',
    maxLength: 1000,
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: 'Bio must not exceed 1000 characters' })
  bio?: string;

  @ApiProperty({
    description: 'Years of acting experience',
    example: 5,
    minimum: 0,
    maximum: 100,
    required: false,
  })
  @IsOptional()
  @IsNumber({}, { message: 'Years of experience must be a number' })
  @Min(0, { message: 'Years of experience must be at least 0' })
  @Max(100, { message: 'Years of experience must not exceed 100' })
  yearsOfExperience?: number;

  @ApiProperty({
    description: 'Array of genre names the user is interested in',
    example: ['Drama', 'Comedy', 'Action'],
    type: [String],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty({ message: 'Genres array cannot be empty if provided' })
  @IsString({ each: true, message: 'Each genre must be a string' })
  @MaxLength(100, {
    each: true,
    message: 'Each genre name must not exceed 100 characters',
  })
  genres?: string[];

  @ApiProperty({
    description: 'User location',
    example: 'New York, NY',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'Location must not exceed 255 characters' })
  location?: string;

  @ApiProperty({
    description: 'IANA timezone string',
    example: 'America/New_York',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'Timezone must not exceed 100 characters' })
  timezone?: string;
}
