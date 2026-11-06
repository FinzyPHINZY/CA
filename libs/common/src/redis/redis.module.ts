import { DynamicModule, Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RedisModule as NestRedisModule } from '@nestjs-modules/ioredis';
import { RedisLockService } from './redis-lock.service';

@Global()
@Module({})
export class RedisModule {
  static forRoot(): DynamicModule {
    return {
      module: RedisModule,
      global: true,
      imports: [
        NestRedisModule.forRootAsync({
          imports: [ConfigModule],
          useFactory: (configService: ConfigService) => ({
            type: 'single' as const,
            url: configService.get<string>(
              'REDIS_URL',
              'redis://localhost:6379',
            ),
          }),
          inject: [ConfigService],
        }),
      ],
      providers: [RedisLockService],
      exports: [NestRedisModule, RedisLockService],
    };
  }
}
