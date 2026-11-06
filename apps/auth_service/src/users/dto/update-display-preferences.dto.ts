import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { StartDelaySec, ThemeMode, ThemePreset } from '@app/common';

const HEX_OR_PRESET =
  /^#[0-9a-fA-F]{6}$|^(green|blue|pink|orange|purple|teal)$/;
const HEX_ONLY = /^#[0-9a-fA-F]{6}$/;

export class UpdateDisplayPreferencesDto {
  @ApiProperty({ enum: ['preset', 'custom'], required: false })
  @IsOptional()
  @IsIn(['preset', 'custom'])
  theme?: ThemeMode;

  @ApiProperty({
    description: 'Preset name or hex color',
    example: 'green',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Matches(HEX_OR_PRESET, {
    message:
      'themeColor must be a preset (green|blue|pink|orange|purple|teal) or hex (#rrggbb)',
  })
  themeColor?: ThemePreset | string;

  @ApiProperty({
    description: 'Hex color for current-line highlight (custom theme only)',
    example: '#ffeb3b',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Matches(HEX_ONLY, {
    message: 'highlightColor must be hex (#rrggbb)',
  })
  highlightColor?: string;

  @ApiProperty({ minimum: 10, maximum: 32, required: false })
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(32)
  fontSize?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  hideStageDirections?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  hideStartMarker?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  hideEntireScript?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  hideYourLines?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  firstLetterMnemonics?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  autoShowAnalytics?: boolean;

  @ApiProperty({ enum: [0, 3, 5, 10], required: false })
  @IsOptional()
  @IsIn([0, 3, 5, 10])
  startDelaySec?: StartDelaySec;
}
