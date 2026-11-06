import { SocialPlatform } from '@app/common';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class SocialLinkItemDto {
  @ApiProperty({
    description: 'Social platform',
    enum: SocialPlatform,
    example: SocialPlatform.INSTAGRAM,
  })
  @IsIn(Object.values(SocialPlatform))
  platform: string;

  @ApiProperty({
    description: 'URL to the social profile',
    example: 'https://instagram.com/johndoe',
  })
  @IsString()
  @MaxLength(500)
  url: string;
}

export class UpdateSocialLinksDto {
  @ApiProperty({
    description: 'List of social media links',
    type: [SocialLinkItemDto],
    required: false,
  })
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => SocialLinkItemDto)
  links: SocialLinkItemDto[];
}
