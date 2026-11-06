/** biome-ignore-all lint/suspicious/noExplicitAny: test fixtures are partial */
import {
  CharacterRepository,
  RehearsalMode,
  RehearsalStatus,
  RehersalRepository,
  SceneRepository,
} from '@app/common';
import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RehearsalReadModelService } from './rehearsal-read-model.service';
import { RehearsalService } from './rehearsal.service';
import { RehearsalLifecycleEventService } from './rehearsal-lifecycle-event.service';

describe('RehearsalService', () => {
  let service: RehearsalService;
  let rehearsalRepository: Partial<RehersalRepository>;
  let sceneRepository: Partial<SceneRepository>;
  let characterRepository: Partial<CharacterRepository>;
  let rehearsalReadModelService: Partial<RehearsalReadModelService>;

  beforeEach(() => {
    rehearsalRepository = {
      findOne: jest.fn(),
      updateById: jest.fn(),
    };
    sceneRepository = {
      findByIdWithCharacters: jest.fn(),
    };
    characterRepository = {
      findById: jest.fn(),
      findByScriptIdAndName: jest.fn(),
    };
    rehearsalReadModelService = {
      buildDetail: jest.fn(),
    };

    service = new RehearsalService(
      rehearsalRepository as unknown as RehersalRepository,
      {} as any,
      {} as any,
      sceneRepository as unknown as SceneRepository,
      characterRepository as unknown as CharacterRepository,
      {} as any,
      {} as unknown as DataSource,
      rehearsalReadModelService as unknown as RehearsalReadModelService,
      {} as unknown as RehearsalLifecycleEventService,
    );
  });

  it('should reject AI role setup when rehearsal content is not ready', async () => {
    (rehearsalRepository.findOne as jest.Mock).mockResolvedValue({
      id: 'reh-1',
      userId: 'actor-1',
      mode: RehearsalMode.AI,
      status: RehearsalStatus.CREATED,
      sceneId: 'scene-1',
      metaData: null,
    });
    (sceneRepository.findByIdWithCharacters as jest.Mock).mockResolvedValue({
      id: 'scene-1',
      scriptId: 'script-1',
      characters: [{ id: 'char-1', name: 'MAYA' }],
      dialogues: [],
    });
    (rehearsalReadModelService.buildDetail as jest.Mock).mockResolvedValue({
      setupState: {
        contentReady: false,
      },
    });

    await expect(
      service.configureSetup('reh-1', 'actor-1', { characterId: 'char-1' }),
    ).rejects.toThrow(
      'Rehearsal content is not ready yet. Complete script analysis before selecting a role.',
    );
    expect(rehearsalRepository.updateById).not.toHaveBeenCalled();
  });

  it('should reject AI role setup when the character is not in the scene', async () => {
    (rehearsalRepository.findOne as jest.Mock).mockResolvedValue({
      id: 'reh-1',
      userId: 'actor-1',
      mode: RehearsalMode.AI,
      status: RehearsalStatus.CREATED,
      sceneId: 'scene-1',
      metaData: null,
    });
    (sceneRepository.findByIdWithCharacters as jest.Mock).mockResolvedValue({
      id: 'scene-1',
      scriptId: 'script-1',
      characters: [{ id: 'char-2', name: 'JONAH' }],
      dialogues: [{ id: 'dialogue-1' }],
    });
    (rehearsalReadModelService.buildDetail as jest.Mock).mockResolvedValue({
      setupState: {
        contentReady: true,
      },
    });

    await expect(
      service.configureSetup('reh-1', 'actor-1', { characterId: 'char-1' }),
    ).rejects.toThrow(
      'Character char-1 is not available in this rehearsal scene',
    );
  });

  it('should persist selected AI character and setup metadata when role selection is valid', async () => {
    const updatedRehearsal = {
      id: 'reh-1',
      userId: 'actor-1',
      mode: RehearsalMode.AI,
      status: RehearsalStatus.CREATED,
      sceneId: 'scene-1',
      project: null,
      script: null,
      scene: null,
      recordings: [],
      character: null,
      metaData: {
        setup: {
          characterSelectionRequired: true,
          characterSelected: true,
        },
      },
    };

    (rehearsalRepository.findOne as jest.Mock)
      .mockResolvedValueOnce({
        id: 'reh-1',
        userId: 'actor-1',
        mode: RehearsalMode.AI,
        status: RehearsalStatus.CREATED,
        sceneId: 'scene-1',
        scriptId: 'script-1',
        metaData: null,
      })
      .mockResolvedValueOnce(updatedRehearsal);
    (sceneRepository.findByIdWithCharacters as jest.Mock).mockResolvedValue({
      id: 'scene-1',
      scriptId: 'script-1',
      characters: [{ id: 'char-1', name: 'MAYA' }],
      dialogues: [{ id: 'dialogue-1' }],
    });
    (characterRepository.findById as jest.Mock).mockResolvedValue({
      id: 'char-1',
      name: 'MAYA',
      scriptId: 'script-1',
    });
    (rehearsalReadModelService.buildDetail as jest.Mock)
      .mockResolvedValueOnce({
        setupState: {
          contentReady: true,
        },
      })
      .mockResolvedValueOnce({
        id: 'reh-1',
        selectedCharacter: { id: 'char-1', name: 'MAYA' },
        setupState: {
          contentReady: true,
          roleSelectionRequired: true,
          roleSelected: true,
        },
      });

    const result = await service.configureSetup('reh-1', 'actor-1', {
      characterId: 'char-1',
    });

    expect(rehearsalRepository.updateById).toHaveBeenCalledWith(
      'reh-1',
      expect.objectContaining({
        characterId: 'char-1',
        metaData: expect.objectContaining({
          setup: expect.objectContaining({
            characterSelectionRequired: true,
            characterSelected: true,
            configuredAt: expect.any(String),
          }),
        }),
      }),
    );
    expect(result).toEqual({
      success: true,
      message: 'Rehearsal setup updated successfully',
      data: {
        id: 'reh-1',
        selectedCharacter: { id: 'char-1', name: 'MAYA' },
        setupState: {
          contentReady: true,
          roleSelectionRequired: true,
          roleSelected: true,
        },
      },
    });
  });

  it('should resolve a stale scene character id to the canonical script character before persisting', async () => {
    (rehearsalRepository.findOne as jest.Mock)
      .mockResolvedValueOnce({
        id: 'reh-1',
        userId: 'actor-1',
        mode: RehearsalMode.AI,
        status: RehearsalStatus.CREATED,
        sceneId: 'scene-1',
        scriptId: 'script-1',
        metaData: null,
      })
      .mockResolvedValueOnce({
        id: 'reh-1',
        userId: 'actor-1',
        mode: RehearsalMode.AI,
        status: RehearsalStatus.CREATED,
        sceneId: 'scene-1',
        scriptId: 'script-1',
        project: null,
        script: null,
        scene: null,
        recordings: [],
        character: null,
        metaData: null,
      });
    (sceneRepository.findByIdWithCharacters as jest.Mock).mockResolvedValue({
      id: 'scene-1',
      scriptId: 'script-1',
      characters: [{ id: 'char-stale', name: 'MAYA' }],
      dialogues: [{ id: 'dialogue-1' }],
    });
    (characterRepository.findById as jest.Mock).mockResolvedValue(null);
    (characterRepository.findByScriptIdAndName as jest.Mock).mockResolvedValue({
      id: 'char-canonical',
      name: 'MAYA',
    });
    (rehearsalReadModelService.buildDetail as jest.Mock)
      .mockResolvedValueOnce({
        setupState: {
          contentReady: true,
        },
      })
      .mockResolvedValueOnce({
        id: 'reh-1',
        selectedCharacter: { id: 'char-canonical', name: 'MAYA' },
        setupState: {
          contentReady: true,
          roleSelectionRequired: true,
          roleSelected: true,
        },
      });

    await service.configureSetup('reh-1', 'actor-1', {
      characterId: 'char-stale',
    });

    expect(characterRepository.findByScriptIdAndName).toHaveBeenCalledWith(
      'script-1',
      'MAYA',
    );
    expect(rehearsalRepository.updateById).toHaveBeenCalledWith(
      'reh-1',
      expect.objectContaining({
        characterId: 'char-canonical',
      }),
    );
  });

  it('should ignore a stale stored rehearsal character while checking setup readiness', async () => {
    (rehearsalRepository.findOne as jest.Mock)
      .mockResolvedValueOnce({
        id: 'reh-1',
        userId: 'actor-1',
        mode: RehearsalMode.AI,
        status: RehearsalStatus.CREATED,
        sceneId: 'scene-1',
        scriptId: 'script-1',
        characterId: 'legacy-character-id',
        metaData: null,
      })
      .mockResolvedValueOnce({
        id: 'reh-1',
        userId: 'actor-1',
        mode: RehearsalMode.AI,
        status: RehearsalStatus.CREATED,
        sceneId: 'scene-1',
        scriptId: 'script-1',
        characterId: 'char-1',
        project: null,
        script: null,
        scene: null,
        recordings: [],
        character: null,
        metaData: null,
      });
    (sceneRepository.findByIdWithCharacters as jest.Mock).mockResolvedValue({
      id: 'scene-1',
      scriptId: 'script-1',
      characters: [{ id: 'char-1', name: 'MAYA' }],
      dialogues: [{ id: 'dialogue-1' }],
    });
    (characterRepository.findById as jest.Mock).mockResolvedValue({
      id: 'char-1',
      name: 'MAYA',
      scriptId: 'script-1',
    });
    (rehearsalReadModelService.buildDetail as jest.Mock)
      .mockResolvedValueOnce({
        setupState: {
          contentReady: true,
        },
      })
      .mockResolvedValueOnce({
        id: 'reh-1',
        selectedCharacter: { id: 'char-1', name: 'MAYA' },
        setupState: {
          contentReady: true,
          roleSelectionRequired: true,
          roleSelected: true,
        },
      });

    await service.configureSetup('reh-1', 'actor-1', {
      characterId: 'char-1',
    });

    expect(rehearsalRepository.findOne).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        relations: ['project', 'script', 'scene', 'recordings'],
      }),
    );
    expect(rehearsalReadModelService.buildDetail).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        characterId: null,
        character: null,
      }),
    );
  });

  it('should resolve the requested character from scene dialogue metadata when scene characters are stale', async () => {
    (rehearsalRepository.findOne as jest.Mock)
      .mockResolvedValueOnce({
        id: 'reh-1',
        userId: 'actor-1',
        mode: RehearsalMode.AI,
        status: RehearsalStatus.CREATED,
        sceneId: 'scene-1',
        scriptId: 'script-1',
        metaData: null,
      })
      .mockResolvedValueOnce({
        id: 'reh-1',
        userId: 'actor-1',
        mode: RehearsalMode.AI,
        status: RehearsalStatus.CREATED,
        sceneId: 'scene-1',
        scriptId: 'script-1',
        characterId: 'char-canonical',
        project: null,
        script: null,
        scene: null,
        recordings: [],
        character: null,
        metaData: null,
      });
    (sceneRepository.findByIdWithCharacters as jest.Mock).mockResolvedValue({
      id: 'scene-1',
      scriptId: 'script-1',
      characters: [],
      dialogues: [
        {
          characterId: 'char-stale',
          characterName: 'MAYA',
          lines: ['Hello there'],
        },
      ],
    });
    (characterRepository.findById as jest.Mock).mockResolvedValue(null);
    (characterRepository.findByScriptIdAndName as jest.Mock).mockResolvedValue({
      id: 'char-canonical',
      name: 'MAYA',
      scriptId: 'script-1',
    });
    (rehearsalReadModelService.buildDetail as jest.Mock)
      .mockResolvedValueOnce({
        setupState: {
          contentReady: true,
        },
      })
      .mockResolvedValueOnce({
        id: 'reh-1',
        selectedCharacter: { id: 'char-canonical', name: 'MAYA' },
        setupState: {
          contentReady: true,
          roleSelectionRequired: true,
          roleSelected: true,
        },
      });

    await service.configureSetup('reh-1', 'actor-1', {
      characterId: 'char-stale',
    });

    expect(characterRepository.findByScriptIdAndName).toHaveBeenCalledWith(
      'script-1',
      'MAYA',
    );
    expect(rehearsalRepository.updateById).toHaveBeenCalledWith(
      'reh-1',
      expect.objectContaining({
        characterId: 'char-canonical',
      }),
    );
  });

  it('should convert character foreign key failures into a refreshable bad request', async () => {
    (rehearsalRepository.findOne as jest.Mock).mockResolvedValue({
      id: 'reh-1',
      userId: 'actor-1',
      mode: RehearsalMode.AI,
      status: RehearsalStatus.CREATED,
      sceneId: 'scene-1',
      scriptId: 'script-1',
      metaData: null,
    });
    (sceneRepository.findByIdWithCharacters as jest.Mock).mockResolvedValue({
      id: 'scene-1',
      scriptId: 'script-1',
      characters: [{ id: 'char-1', name: 'MAYA' }],
      dialogues: [{ id: 'dialogue-1' }],
    });
    (characterRepository.findById as jest.Mock).mockResolvedValue({
      id: 'char-1',
      name: 'MAYA',
      scriptId: 'script-1',
    });
    (rehearsalReadModelService.buildDetail as jest.Mock).mockResolvedValue({
      setupState: {
        contentReady: true,
      },
    });
    (rehearsalRepository.updateById as jest.Mock).mockRejectedValue({
      code: '23503',
      message:
        'insert or update on table "rehersals" violates foreign key constraint "FK_rehersals_characterId"',
    });

    await expect(
      service.configureSetup('reh-1', 'actor-1', { characterId: 'char-1' }),
    ).rejects.toThrow(
      'Character char-1 is no longer available for this rehearsal script. Refresh scene data and try again.',
    );
  });
});
