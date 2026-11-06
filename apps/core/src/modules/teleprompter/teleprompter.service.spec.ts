/** biome-ignore-all lint/suspicious/noExplicitAny: test fixtures are partial */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TeleprompterService } from './teleprompter.service';

describe('TeleprompterService', () => {
  let service: TeleprompterService;
  let preferenceRepository: any;
  let sceneRepository: any;
  let scriptRepository: any;

  beforeEach(() => {
    preferenceRepository = {
      findByUserId: jest.fn(),
      upsertByUserId: jest.fn(),
    };
    sceneRepository = {
      findByIdWithCharacters: jest.fn(),
      findByScriptIdWithCharacters: jest.fn(),
    };
    scriptRepository = {
      findById: jest.fn(),
    };

    service = new TeleprompterService(
      preferenceRepository,
      sceneRepository,
      scriptRepository,
    );
  });

  it('returns scene teleprompter content for the script owner', async () => {
    sceneRepository.findByIdWithCharacters.mockResolvedValue({
      id: 'scene-1',
      scriptId: 'script-1',
      number: 1,
      heading: 'INT. ROOM - DAY',
      pages: [1],
      dialogues: [
        {
          type: 'dialogue',
          characterId: 'char-1',
          characterName: 'MAYA',
          lines: ['Line one'],
        },
      ],
    });
    scriptRepository.findById.mockResolvedValue({
      id: 'script-1',
      userId: 'owner-1',
      parserMetadata: {},
    });

    const result = await service.getSceneTeleprompter(
      'scene-1',
      'char-1',
      'owner-1',
    );

    expect(result.success).toBe(true);
    expect(result.data.sceneId).toBe('scene-1');
    expect(result.data.elements[0]).toMatchObject({
      characterId: 'char-1',
      isActor: true,
    });
  });

  it('rejects scene teleprompter access for non-owners', async () => {
    sceneRepository.findByIdWithCharacters.mockResolvedValue({
      id: 'scene-1',
      scriptId: 'script-1',
      dialogues: [],
    });
    scriptRepository.findById.mockResolvedValue({
      id: 'script-1',
      userId: 'owner-1',
    });

    await expect(
      service.getSceneTeleprompter('scene-1', 'char-1', 'other-user'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects script teleprompter access for non-owners', async () => {
    scriptRepository.findById.mockResolvedValue({
      id: 'script-1',
      userId: 'owner-1',
    });

    await expect(
      service.getScriptTeleprompterScenes('script-1', 'char-1', 'other-user'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sceneRepository.findByScriptIdWithCharacters).not.toHaveBeenCalled();
  });

  it('throws not found when the scene script does not exist', async () => {
    sceneRepository.findByIdWithCharacters.mockResolvedValue({
      id: 'scene-1',
      scriptId: 'missing-script',
      dialogues: [],
    });
    scriptRepository.findById.mockResolvedValue(null);

    await expect(
      service.getSceneTeleprompter('scene-1', 'char-1', 'owner-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
