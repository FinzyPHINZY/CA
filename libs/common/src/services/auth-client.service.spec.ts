/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { AUTH_SERVICE, AuthClientService, type UserDto } from '@app/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { of, throwError } from 'rxjs';

describe('AuthClientService', () => {
  let service: AuthClientService;
  let mockAuthClient: {
    connect: jest.Mock;
    send: jest.Mock;
  };

  const mockUser: UserDto = {
    id: 'user-123',
    email: 'test@example.com',
    fullName: 'Test User',
    avatar: 'https://example.com/avatar.jpg',
    roles: ['actor'],
    timezone: 'UTC',
  };

  beforeEach(async () => {
    mockAuthClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      send: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthClientService,
        {
          provide: AUTH_SERVICE,
          useValue: mockAuthClient,
        },
      ],
    }).compile();

    service = module.get<AuthClientService>(AuthClientService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should connect to auth service', async () => {
      await service.onModuleInit();
      expect(mockAuthClient.connect).toHaveBeenCalled();
    });
  });

  describe('getUserById', () => {
    it('should return user when found', async () => {
      mockAuthClient.send.mockReturnValue(of(mockUser));

      const result = await service.getUserById('user-123');

      expect(result).toEqual(mockUser);
      expect(mockAuthClient.send).toHaveBeenCalledWith(
        'getUserById',
        'user-123',
      );
    });

    it('should return null for empty userId', async () => {
      const result = await service.getUserById('');
      expect(result).toBeNull();
      expect(mockAuthClient.send).not.toHaveBeenCalled();
    });

    it('should return null when user not found', async () => {
      mockAuthClient.send.mockReturnValue(of(null));

      const result = await service.getUserById('nonexistent');
      expect(result).toBeNull();
    });

    it('should return null on error', async () => {
      mockAuthClient.send.mockReturnValue(
        throwError(() => new Error('Connection error')),
      );

      const result = await service.getUserById('user-123');
      expect(result).toBeNull();
    });
  });

  describe('getUsersByIds', () => {
    it('should return map of users', async () => {
      const users: UserDto[] = [
        mockUser,
        { ...mockUser, id: 'user-456', email: 'user2@example.com' },
      ];
      mockAuthClient.send.mockReturnValue(of(users));

      const result = await service.getUsersByIds(['user-123', 'user-456']);

      expect(result.size).toBe(2);
      expect(result.get('user-123')).toEqual(mockUser);
      expect(result.get('user-456')).toBeDefined();
    });

    it('should return empty map for empty array', async () => {
      const result = await service.getUsersByIds([]);
      expect(result.size).toBe(0);
      expect(mockAuthClient.send).not.toHaveBeenCalled();
    });

    it('should deduplicate user IDs', async () => {
      mockAuthClient.send.mockReturnValue(of([mockUser]));

      await service.getUsersByIds(['user-123', 'user-123', 'user-123']);

      // Should only send unique IDs
      expect(mockAuthClient.send).toHaveBeenCalledWith('getUsersByIds', [
        'user-123',
      ]);
    });

    it('should filter out empty IDs', async () => {
      mockAuthClient.send.mockReturnValue(of([mockUser]));

      await service.getUsersByIds([
        'user-123',
        '',
        null as any,
        undefined as any,
      ]);

      expect(mockAuthClient.send).toHaveBeenCalledWith('getUsersByIds', [
        'user-123',
      ]);
    });

    it('should return empty map on error', async () => {
      mockAuthClient.send.mockReturnValue(
        throwError(() => new Error('Connection error')),
      );

      const result = await service.getUsersByIds(['user-123']);
      expect(result.size).toBe(0);
    });
  });

  describe('userExists', () => {
    it('should return true when user exists', async () => {
      mockAuthClient.send.mockReturnValue(of(true));

      const result = await service.userExists('user-123');
      expect(result).toBe(true);
    });

    it('should return false when user does not exist', async () => {
      mockAuthClient.send.mockReturnValue(of(false));

      const result = await service.userExists('nonexistent');
      expect(result).toBe(false);
    });

    it('should return false for empty userId', async () => {
      const result = await service.userExists('');
      expect(result).toBe(false);
    });

    it('should return false on error', async () => {
      mockAuthClient.send.mockReturnValue(throwError(() => new Error('Error')));

      const result = await service.userExists('user-123');
      expect(result).toBe(false);
    });
  });

  describe('enrichWithUsers', () => {
    interface TestItem {
      id: string;
      userId: string;
      name: string;
    }

    const testItems: TestItem[] = [
      { id: '1', userId: 'user-123', name: 'Item 1' },
      { id: '2', userId: 'user-456', name: 'Item 2' },
      { id: '3', userId: 'user-123', name: 'Item 3' },
    ];

    it('should enrich items with user data', async () => {
      const users: UserDto[] = [
        mockUser,
        { ...mockUser, id: 'user-456', fullName: 'User 456' },
      ];
      mockAuthClient.send.mockReturnValue(of(users));

      const result = await service.enrichWithUsers(
        testItems,
        (item) => item.userId,
        (item, user) => ({ ...item, user }),
      );

      expect(result.length).toBe(3);
      expect(result[0].user?.fullName).toBe('Test User');
      expect(result[1].user?.fullName).toBe('User 456');
      expect(result[2].user?.fullName).toBe('Test User');
    });

    it('should return empty array for empty items', async () => {
      const result = await service.enrichWithUsers(
        [],
        (item: TestItem) => item.userId,
        (item, user) => ({ ...item, user }),
      );

      expect(result).toEqual([]);
    });

    it('should handle items with missing user', async () => {
      mockAuthClient.send.mockReturnValue(of([mockUser]));

      const result = await service.enrichWithUsers(
        testItems,
        (item) => item.userId,
        (item, user) => ({ ...item, user }),
      );

      // user-456 won't be found, so user should be null
      expect(result[1].user).toBeNull();
    });
  });
});
