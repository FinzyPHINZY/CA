
import type { DynamicModule, Type } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';

const REDIS_TOKEN = 'default_IORedisModuleConnectionToken';

function buildEnvDefaults(): void {
  process.env.AGORA_APP_ID ??= 'test-agora-app-id';
  process.env.AGORA_APP_CERTIFICATE ??= 'test-agora-cert';
  process.env.AGORA_CUSTOMER_KEY ??= 'test-agora-key';
  process.env.AGORA_CUSTOMER_SECRET ??= 'test-agora-secret';
}

function makeDataSourceStub(): Record<string, unknown> {
  const manager = {
    connection: undefined as unknown,
    find: async () => [],
    findOne: async () => null,
    save: async <T>(x: T) => x,
    create: <T>(x: T) => x,
    transaction: async (fn: (m: unknown) => Promise<unknown>) => fn(manager),
  };
  const stub: Record<string, unknown> = {
    isInitialized: true,
    initialize: async () => stub,
    destroy: async () => undefined,
    manager,
    hasMetadata: () => true,
    getRepository: () => ({
      find: async () => [],
      findOne: async () => null,
      save: async <T>(x: T) => x,
      create: <T>(x: T) => x,
      target: undefined,
      metadata: {},
    }),
    createEntityManager: () => manager,
    entityMetadatas: [],
    options: {},
    driver: {},
    createQueryBuilder: () => ({}),
    createQueryRunner: () => ({
      connect: async () => undefined,
      release: async () => undefined,
    }),
    query: async () => [],
  };
  manager.connection = stub;
  return stub;
}

function makeRedisStub(): Record<string, unknown> {
  return {
    on: () => undefined,
    quit: async () => 'OK',
    disconnect: () => undefined,
    get: async () => null,
    set: async () => 'OK',
    del: async () => 0,
    expire: async () => 1,
    sadd: async () => 1,
    srem: async () => 1,
    smembers: async () => [],
    hget: async () => null,
    hset: async () => 1,
    hgetall: async () => ({}),
    pipeline: () => ({ exec: async () => [] }),
    multi: () => ({ exec: async () => [] }),
  };
}

export async function compileRootModule(
  rootModule: Type<unknown> | DynamicModule,
): Promise<TestingModule> {
  buildEnvDefaults();

  const builder = Test.createTestingModule({ imports: [rootModule as any] });

  builder
    .overrideProvider(getDataSourceToken())
    .useValue(makeDataSourceStub())
    .overrideProvider(REDIS_TOKEN)
    .useValue(makeRedisStub());

  return builder.compile();
}
