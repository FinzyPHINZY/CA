import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { DataSource, Repository } from 'typeorm';

// Verifies, at boot, that every TypeORM Repository in the DI graph has a
// matching entity registered with the DataSource. Catches the "@InjectRepository
// added but entity missing from DatabaseModule.forRoot({ entities: [...] })"
// class of bug at startup, not when the first query runs hours later.
//
// Strictness controlled by constructor flag set from DatabaseModule options:
//   - strict = true:  throw on missing, refusing to boot
//   - strict = false: log error and continue (default; safer rollout)
@Injectable()
export class RepositoryRegistrationVerifier implements OnApplicationBootstrap {
  private readonly logger = new Logger(RepositoryRegistrationVerifier.name);

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly dataSource: DataSource,
    private readonly strict: boolean,
  ) {}

  onApplicationBootstrap(): void {
    const missing: string[] = [];

    for (const wrapper of this.discoveryService.getProviders()) {
      const instance = wrapper.instance;
      if (!instance || !(instance instanceof Repository)) continue;

      const target = instance.target;
      if (!target) continue;

      if (!this.dataSource.hasMetadata(target)) {
        const entityName =
          typeof target === 'function'
            ? target.name
            : typeof target === 'string'
              ? target
              : String(target);
        const providerName =
          wrapper.metatype?.name ?? wrapper.name?.toString() ?? '<unknown>';
        missing.push(`${providerName} -> ${entityName}`);
      }
    }

    if (missing.length === 0) return;

    const msg =
      `Repository providers reference entities not registered in DatabaseModule.forRoot({ entities }):\n  - ` +
      missing.join('\n  - ');
    this.logger.error(msg);
    if (this.strict) throw new Error(msg);
  }
}
