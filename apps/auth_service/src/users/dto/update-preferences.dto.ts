import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, ValidateNested } from 'class-validator';
import { UpdateDefaultSessionSettingsDto } from './update-default-session-settings.dto';
import { UpdateDisplayPreferencesDto } from './update-display-preferences.dto';

export class UpdatePreferencesDto {
  @ApiProperty({ required: false, type: UpdateDisplayPreferencesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateDisplayPreferencesDto)
  display?: UpdateDisplayPreferencesDto;

  @ApiProperty({ required: false, type: UpdateDefaultSessionSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateDefaultSessionSettingsDto)
  sessionDefaults?: UpdateDefaultSessionSettingsDto;
}
