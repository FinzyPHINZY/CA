import { ApiProperty } from '@nestjs/swagger';

/**
 * One dialogue line in script order (sequential, not grouped by character).
 * Used in Scene.dialogues array.
 */
export class SceneDialogueEntryDto {
  @ApiProperty({
    description: 'Character UUID when mapped, or null if not resolved',
    example: '123e4567-e89b-12d3-a456-426614174002',
    nullable: true,
  })
  characterId?: string | null;

  @ApiProperty({
    description: 'Character name as in the script (e.g. CAROLINE, MAY)',
    example: 'CAROLINE',
  })
  characterName: string;

  @ApiProperty({
    description: 'Single line of dialogue as spoken in the script',
    example: 'How are you?',
  })
  text: string;
}
