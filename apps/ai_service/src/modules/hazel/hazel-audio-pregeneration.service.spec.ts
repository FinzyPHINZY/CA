/** biome-ignore-all lint/suspicious/noExplicitAny: test mocks */
import { HazelAudioPreGenerationService } from './hazel-audio-pregeneration.service';
import type { Turn } from './types/hazel.types';

describe('HazelAudioPreGenerationService.pregenerateFirstHazelLine', () => {
  const makeService = () => {
    const redis = {
      exists: jest.fn().mockResolvedValue(0),
      set: jest.fn().mockResolvedValue('OK'),
    } as any;
    const elevenLabs = {
      generateAudio: jest.fn().mockResolvedValue(Buffer.from('mp3')),
      defaultModelId: 'eleven_flash_v2_5',
    } as any;
    const config = { get: jest.fn().mockReturnValue(5) } as any;
    const sessionService = {} as any;
    const service = new HazelAudioPreGenerationService(
      redis,
      elevenLabs,
      config,
      sessionService,
    );
    return { service, elevenLabs };
  };

  const turns: Turn[] = [
    { index: 0, type: 'actor', text: 'hi', lines: ['hi'] },
    {
      index: 1,
      type: 'hazel',
      characterId: 'c1',
      text: 'hello there',
      lines: ['hello there'],
    },
    {
      index: 2,
      type: 'hazel',
      characterId: 'c1',
      text: 'and more',
      lines: ['and more'],
    },
  ];

  it('generates only the first hazel line', async () => {
    const { service, elevenLabs } = makeService();
    const idx = await service.pregenerateFirstHazelLine('r1', turns, {
      c1: 'v1',
    });
    expect(idx).toBe(1);
    expect(elevenLabs.generateAudio).toHaveBeenCalledTimes(1);
  });

  it('returns null when there is no hazel turn', async () => {
    const { service, elevenLabs } = makeService();
    const idx = await service.pregenerateFirstHazelLine(
      'r1',
      [{ index: 0, type: 'actor', text: 'hi', lines: ['hi'] }],
      {},
    );
    expect(idx).toBeNull();
    expect(elevenLabs.generateAudio).not.toHaveBeenCalled();
  });
});
