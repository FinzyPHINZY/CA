/** biome-ignore-all lint/suspicious/noExplicitAny: test fixtures are partial */
import { BadRequestException } from '@nestjs/common';
import { HazelSceneLoaderService } from './hazel-scene-loader.service';

describe('HazelSceneLoaderService', () => {
  let service: HazelSceneLoaderService;
  let sceneRepository: any;

  beforeEach(() => {
    sceneRepository = {
      findByIdWithCharacters: jest.fn(),
    };

    service = new HazelSceneLoaderService(sceneRepository);
  });

  it('should keep canonical dialogue character ids unchanged', async () => {
    sceneRepository.findByIdWithCharacters.mockResolvedValue({
      id: 'scene-1',
      characters: [
        { id: 'char-edward', name: 'Edward' },
        { id: 'char-will', name: 'Will' },
      ],
      dialogues: [
        {
          type: 'dialogue',
          characterId: 'char-edward',
          characterName: 'Edward',
          lines: ['First line'],
        },
      ],
    });

    await expect(service.loadScene('scene-1', 'char-will')).resolves.toEqual([
      {
        type: 'dialogue',
        characterId: 'char-edward',
        characterName: 'Edward',
        lines: ['First line'],
      },
    ]);
  });

  it('should replace stale dialogue character ids using canonical character names', async () => {
    sceneRepository.findByIdWithCharacters.mockResolvedValue({
      id: 'scene-1',
      characters: [
        { id: 'char-edward', name: 'Edward' },
        { id: 'char-will', name: 'Will' },
      ],
      dialogues: [
        {
          type: 'dialogue',
          characterId: 'stale-edward-id',
          characterName: 'Edward',
          lines: ['Edward should be Hazel'],
        },
        {
          type: 'dialogue',
          characterId: 'stale-will-id',
          characterName: 'Will',
          lines: ['Will should be actor'],
        },
      ],
    });

    await expect(service.loadScene('scene-1', 'char-will')).resolves.toEqual([
      {
        type: 'dialogue',
        characterId: 'char-edward',
        characterName: 'Edward',
        lines: ['Edward should be Hazel'],
      },
      {
        type: 'dialogue',
        characterId: 'char-will',
        characterName: 'Will',
        lines: ['Will should be actor'],
      },
    ]);
  });

  it('should backfill missing dialogue character ids using canonical character names', async () => {
    sceneRepository.findByIdWithCharacters.mockResolvedValue({
      id: 'scene-1',
      characters: [{ id: 'char-will', name: 'Will' }],
      dialogues: [
        {
          type: 'dialogue',
          characterId: null,
          characterName: 'Will',
          lines: ['Line without id'],
        },
      ],
    });

    await expect(service.loadScene('scene-1', 'char-will')).resolves.toEqual([
      {
        type: 'dialogue',
        characterId: 'char-will',
        characterName: 'Will',
        lines: ['Line without id'],
      },
    ]);
  });

  it('should reject an actor character that is not part of the scene', async () => {
    sceneRepository.findByIdWithCharacters.mockResolvedValue({
      id: 'scene-1',
      characters: [{ id: 'char-edward', name: 'Edward' }],
      dialogues: [],
    });

    await expect(service.loadScene('scene-1', 'char-will')).rejects.toThrow(
      new BadRequestException('Character char-will is not in scene scene-1'),
    );
  });
});
