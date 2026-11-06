import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateProfileBasicsDto {
  @ApiProperty({
    description: 'Reader bio / about section',
    example:
      'Professional voice actor with 10 years of experience in dramatic and comedic roles.',
    required: false,
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000, { message: 'Bio must not exceed 2000 characters' })
  bio?: string;

  @ApiProperty({
    description: 'Short headline displayed on search results',
    example: 'Versatile Reader | Drama & Comedy Specialist',
    required: false,
  })
  @IsString()
  @IsOptional()
  @MaxLength(255, { message: 'Headline must not exceed 255 characters' })
  headline?: string;

  @ApiProperty({
    description: 'Reader website URL',
    example: 'https://johndoe-acting.com',
    required: false,
  })
  @IsString()
  @IsOptional()
  @MaxLength(500, { message: 'Website URL must not exceed 500 characters' })
  websiteUrl?: string;

  @ApiProperty({
    description: 'Years of acting/reading experience',
    example: 5,
    required: false,
  })
  @IsInt()
  @IsOptional()
  @Min(0, { message: 'Years of experience must be 0 or greater' })
  yearsOfExperience?: number;
}
