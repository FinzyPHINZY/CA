/** biome-ignore-all lint/suspicious/noExplicitAny: test fixtures are partial */
// Locks down the deterministic + distinct contract of buildDefaultVoiceMap:
//   T1 distinctness, T2 determinism, T3 order-independence,
//   T4 exhaustion, T5 concurrency safety.
// (T6 "keyed by character.id" lives in voice-assignment.spec.ts.)

import type { Character, VoiceMetadata } from '@app/common';
import { VoiceMapperService } from './voice-mapper.service';

const ACTOR = 'actor-uuid';

// female/young voices — characters below all route to the female_young pool.
function fyVoices(...ids: string[]): VoiceMetadata[] {
  return ids.map((voiceId) => ({
    voiceId,
    name: voiceId,
    description: '',
    previewAudioUrl: '',
    labels: { gender: 'female', age: 'young' },
  })) as VoiceMetadata[];
}

function femaleYoungChar(id: string): Character {
  return {
    id,
    name: `char-${id}`,
    voiceProfile: { gender: 'female', ageCategory: 'young' },
  } as unknown as Character;
}

async function makeService(
  voices: VoiceMetadata[],
): Promise<VoiceMapperService> {
  const redis = { get: jest.fn().mockResolvedValue(null) };
  const elevenLabs = { listVoices: jest.fn().mockResolvedValue(voices) };
  const service = new VoiceMapperService(redis as any, elevenLabs as any);
  await (service as any).loadVoices();
  return service;
}

describe('VoiceMapperService — deterministic + distinct assignment', () => {
  it('T1: N characters in one category get N distinct voices', async () => {
    const service = await makeService(fyVoices('fy1', 'fy2', 'fy3'));
    const chars = ['c1', 'c2', 'c3'].map(femaleYoungChar);

    const map = await service.buildDefaultVoiceMap(chars, ACTOR);

    const assigned = Object.values(map);
    expect(assigned).toHaveLength(3);
    expect(new Set(assigned).size).toBe(3); // all distinct
  });

  it('T2: identical inputs produce identical maps', async () => {
    const service = await makeService(fyVoices('fy1', 'fy2', 'fy3'));
    const chars = ['c1', 'c2', 'c3'].map(femaleYoungChar);

    const first = await service.buildDefaultVoiceMap(chars, ACTOR);
    const second = await service.buildDefaultVoiceMap(chars, ACTOR);

    expect(second).toEqual(first);
  });

  it('T3: assignment is independent of input character order', async () => {
    const service = await makeService(fyVoices('fy1', 'fy2', 'fy3'));
    const inOrder = ['c1', 'c2', 'c3'].map(femaleYoungChar);
    const shuffled = ['c3', 'c1', 'c2'].map(femaleYoungChar);

    const a = await service.buildDefaultVoiceMap(inOrder, ACTOR);
    const b = await service.buildDefaultVoiceMap(shuffled, ACTOR);

    expect(b).toEqual(a);
  });

  it('T4: pool smaller than character count still assigns everyone (reuse allowed)', async () => {
    const service = await makeService(fyVoices('fy1', 'fy2'));
    const chars = ['c1', 'c2', 'c3'].map(femaleYoungChar);

    const map = await service.buildDefaultVoiceMap(chars, ACTOR);

    expect(Object.keys(map)).toHaveLength(3); // no character dropped
    expect(new Set(Object.values(map)).size).toBe(2); // both voices used; one reused
    // deterministic on repeat
    expect(await service.buildDefaultVoiceMap(chars, ACTOR)).toEqual(map);
  });

  it('T5: concurrent builds do not corrupt each other (no shared mutable state)', async () => {
    const service = await makeService(fyVoices('fy1', 'fy2', 'fy3', 'fy4'));
    const setA = ['a1', 'a2', 'a3'].map(femaleYoungChar);
    const setB = ['b1', 'b2', 'b3'].map(femaleYoungChar);

    // sequential baselines
    const baseA = await service.buildDefaultVoiceMap(setA, ACTOR);
    const baseB = await service.buildDefaultVoiceMap(setB, ACTOR);

    // run them interleaved
    const [concA, concB] = await Promise.all([
      service.buildDefaultVoiceMap(setA, ACTOR),
      service.buildDefaultVoiceMap(setB, ACTOR),
    ]);

    expect(concA).toEqual(baseA);
    expect(concB).toEqual(baseB);
    // each map internally distinct
    expect(new Set(Object.values(concA)).size).toBe(3);
    expect(new Set(Object.values(concB)).size).toBe(3);
  });
});
