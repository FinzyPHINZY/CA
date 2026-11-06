/** biome-ignore-all lint/style/useImportType: <> */
import { Project, Recording, Rehersal, Script } from '@app/common';
import { Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { DomainEventHandlerController } from './domain-event-handler.controller';

describe('DomainEventHandlerController', () => {
  let controller: DomainEventHandlerController;
  let mockDataSource: jest.Mocked<Partial<DataSource>>;
  let mockManager: jest.Mocked<Partial<EntityManager>>;

  beforeEach(() => {
    // suppress console output during tests
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    // mock counts for each entity type
    const mockCounts: Record<string, number> = {
      Project: 2,
      Script: 5,
      Recording: 3,
      Rehersal: 1,
    };

    mockManager = {
      count: jest.fn().mockImplementation((entity) => {
        return Promise.resolve(mockCounts[entity.name] || 0);
      }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    } as jest.Mocked<Partial<EntityManager>>;

    mockDataSource = {
      transaction: jest
        .fn()
        .mockImplementation((callback) => callback(mockManager)),
    } as jest.Mocked<Partial<DataSource>>;

    // directly instantiate controller with mocked DataSource
    controller = new DomainEventHandlerController(
      mockDataSource as unknown as DataSource,
      { generateSlotsForReader: jest.fn().mockResolvedValue(0) } as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('handleUserDeleted', () => {
    const mockEvent = {
      userId: 'test-user-id-123',
      email: 'test@example.com',
      deletedAt: new Date().toISOString(),
      isSoftDelete: true,
    };

    it('should delete all user data when event is received', async () => {
      await controller.handleUserDeleted(mockEvent);

      // verify transaction was called
      expect(mockDataSource.transaction).toHaveBeenCalled();

      // verify counts were retrieved for all entity types
      expect(mockManager.count).toHaveBeenCalledWith(Rehersal, {
        where: { userId: mockEvent.userId },
      });
      expect(mockManager.count).toHaveBeenCalledWith(Recording, {
        where: { userId: mockEvent.userId },
      });
      expect(mockManager.count).toHaveBeenCalledWith(Script, {
        where: { userId: mockEvent.userId },
      });
      expect(mockManager.count).toHaveBeenCalledWith(Project, {
        where: { userId: mockEvent.userId },
      });

      // verify delete was called 4 times (rehearsals, recordings, scripts, projects)
      expect(mockManager.delete).toHaveBeenCalledTimes(4);
    });

    it('should skip delete for entities with zero count', async () => {
      // override counts to have zero for some entities
      (mockManager.count as jest.Mock).mockImplementation((entity) => {
        if (entity === Rehersal || entity === Recording) {
          return Promise.resolve(0);
        }
        return Promise.resolve(1);
      });

      await controller.handleUserDeleted(mockEvent);

      // only script and project should be deleted (2 calls)
      expect(mockManager.delete).toHaveBeenCalledTimes(2);
    });

    it('should handle errors gracefully and re-throw', async () => {
      const error = new Error('Database error');
      (mockDataSource.transaction as jest.Mock).mockRejectedValue(error);

      await expect(controller.handleUserDeleted(mockEvent)).rejects.toThrow(
        'Database error',
      );
    });
  });
});
