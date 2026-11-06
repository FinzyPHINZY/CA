import { Module, DynamicModule } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EntityClassOrSchema } from '@nestjs/typeorm/dist/interfaces/entity-class-or-schema.type';
import { DataSource } from 'typeorm';
import { RepositoryRegistrationVerifier } from './repository-registration.verifier';

export interface DatabaseModuleOptions {
  entities?: EntityClassOrSchema[];
  // false: skip verifier entirely. true (default): run verifier.
  verifyRepositoryRegistration?: boolean;
  // true: verifier throws and refuses to boot. false (default): log only.
  // Flip on per service after that service's repository graph is clean.
  strictRepositoryVerification?: boolean;
}

const toBoolean = (value?: string | boolean): boolean => {
  if (typeof value === 'boolean') return value;
  if (!value) return false;
  return value === 'true';
};

@Module({})
export class DatabaseModule {
  static forRoot(options?: DatabaseModuleOptions): DynamicModule {
    const verify = options?.verifyRepositoryRegistration ?? true;
    const strict = options?.strictRepositoryVerification ?? false;
    return {
      module: DatabaseModule,
      imports: [
        DiscoveryModule,
        TypeOrmModule.forRootAsync({
          imports: [ConfigModule],
          useFactory: (configService: ConfigService): TypeOrmModuleOptions => {
            const useSsl = toBoolean(configService.get('DB_SSL', 'false'));
            const sslOption = useSsl
              ? { rejectUnauthorized: false }
              : undefined;
            const baseConfig: TypeOrmModuleOptions = {
              type: 'postgres',
              host: configService.get<string>('DB_HOST', 'postgres'),
              port: configService.get<number>('DB_PORT', 5432),
              username: configService.get<string>('DB_USERNAME', 'postgres'),
              password: configService.get<string>('DB_PASSWORD', 'postgres'),
              database: configService.get<string>('DB_NAME', 'acr_db'),
              synchronize: toBoolean(
                configService.get('DB_SYNCHRONIZE', false),
              ),
              logging: toBoolean(configService.get('DB_LOGGING', false)),
              ssl: sslOption,
            };

            if (options?.entities && options.entities.length > 0) {
              return {
                ...baseConfig,
                entities: options.entities,
              };
            }

            return {
              ...baseConfig,
              autoLoadEntities: true,
            };
          },
          inject: [ConfigService],
        }),
      ],
      providers: verify
        ? [
            {
              provide: RepositoryRegistrationVerifier,
              useFactory: (
                discoveryService: DiscoveryService,
                dataSource: DataSource,
              ) =>
                new RepositoryRegistrationVerifier(
                  discoveryService,
                  dataSource,
                  strict,
                ),
              inject: [DiscoveryService, DataSource],
            },
          ]
        : [],
      exports: [TypeOrmModule],
    };
  }
}
