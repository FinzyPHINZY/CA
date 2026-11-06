/** biome-ignore-all lint/suspicious/noExplicitAny: test mocks */
import { BadRequestException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RehearsalListService } from '../rehearsal/rehearsal-list.service';
import { AdminUsersService } from './admin-users.service';

describe('AdminUsersService', () => {
  let service: AdminUsersService;
  let dataSource: jest.Mocked<Pick<DataSource, 'query' | 'getRepository'>>;
  let qb: ReturnType<typeof makeQb>;

  function makeQb() {
    return {
      withDeleted: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      clone: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(0),
      offset: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
  }

  beforeEach(() => {
    qb = makeQb();
    dataSource = {
      query: jest.fn().mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('to_regclass')) {
          return [{ exists: true }];
        }
        if (typeof sql === 'string' && sql.includes('pg_attribute')) {
          return [{ cnt: '2' }];
        }
        return [];
      }),
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue(qb),
      } as any),
    };
    service = new AdminUsersService(
      dataSource as unknown as DataSource,
      {} as RehearsalListService,
    );
  });

  it('throws BadRequestException when createdFrom is later than createdTo', async () => {
    await expect(
      service.listUsers({
        createdFrom: '2026-05-10T00:00:00.000Z',
        createdTo: '2026-05-01T00:00:00.000Z',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('falls back gracefully when subscriptions table lookup fails', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      dataSource.query.mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('to_regclass')) {
          throw new Error('db unavailable');
        }
        if (typeof sql === 'string' && sql.includes('pg_attribute')) {
          return [{ cnt: '2' }];
        }
        return [];
      });

      const result = await service.listUsers({
        subscriptionStatus: 'active',
        page: 1,
        limit: 20,
      } as any);

      expect(result).toMatchObject({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        hasNext: false,
        hasPrev: false,
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('omits ban columns when schema probe reports they are missing', async () => {
    dataSource.query.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('to_regclass')) {
        return [{ exists: true }];
      }
      if (typeof sql === 'string' && sql.includes('pg_attribute')) {
        return [{ cnt: '0' }];
      }
      return [];
    });

    await service.listUsers({ page: 1, limit: 20 } as any);

    const selectArg = qb.select.mock.calls[0]?.[0] as string[];
    expect(selectArg.some((s) => s.includes('banReason'))).toBe(false);
    expect(selectArg.some((s) => s.includes('bannedAt'))).toBe(false);
  });

  it('selects avatar field for user list payload', async () => {
    await service.listUsers({ page: 1, limit: 20 } as any);

    const selectArg = qb.select.mock.calls[0]?.[0] as string[];
    expect(selectArg.some((s) => s.includes('avatar'))).toBe(true);
  });
});
