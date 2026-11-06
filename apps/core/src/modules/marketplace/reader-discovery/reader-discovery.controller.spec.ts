/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { ReaderDiscoveryController } from './reader-discovery.controller';
import { ReaderDiscoveryService } from './reader-discovery.service';

describe('ReaderDiscoveryController', () => {
  let controller: ReaderDiscoveryController;
  let discoveryService: jest.Mocked<Partial<ReaderDiscoveryService>>;

  const mockReq = { user: { id: 'actor-1' } };
  const mockReqNoAuth = { user: undefined };

  beforeEach(() => {
    discoveryService = {
      searchReaders: jest.fn().mockResolvedValue({
        success: true,
        message: 'OK',
        data: { items: [], total: 0, page: 1 },
      }),
      listFavorites: jest.fn().mockResolvedValue({
        success: true,
        message: 'OK',
        data: { items: [], total: 0 },
      }),
      heartbeat: jest.fn().mockResolvedValue({
        success: true,
        message: 'Heartbeat recorded successfully',
      }),
      getPublicProfile: jest.fn().mockResolvedValue({
        success: true,
        message: 'OK',
        data: { id: 'profile-1', headline: 'Great reader' },
      }),
      addFavorite: jest.fn().mockResolvedValue({
        success: true,
        message: 'OK',
        data: { userId: 'actor-1', readerProfileId: 'p1' },
      }),
      removeFavorite: jest
        .fn()
        .mockResolvedValue({ success: true, message: 'OK' }),
    };

    controller = new ReaderDiscoveryController(
      discoveryService as unknown as ReaderDiscoveryService,
    );
  });

  describe('searchReaders', () => {
    it('should pass query and actor user ID', async () => {
      const query = { genre: 'Drama' } as any;
      await controller.searchReaders(query, mockReq);

      expect(discoveryService.searchReaders).toHaveBeenCalledWith(
        query,
        'actor-1',
      );
    });

    it('should pass undefined actorUserId when not authenticated', async () => {
      const query = {} as any;
      await controller.searchReaders(query, mockReqNoAuth);

      expect(discoveryService.searchReaders).toHaveBeenCalledWith(
        query,
        undefined,
      );
    });
  });

  describe('listFavorites', () => {
    it('should delegate with userId and pagination', async () => {
      await controller.listFavorites(mockReq, 2, 10);

      expect(discoveryService.listFavorites).toHaveBeenCalledWith(
        'actor-1',
        2,
        10,
      );
    });

    it('should default page=1 and limit=20', async () => {
      await controller.listFavorites(mockReq);

      expect(discoveryService.listFavorites).toHaveBeenCalledWith(
        'actor-1',
        1,
        20,
      );
    });
  });

  describe('heartbeat', () => {
    it('should delegate with userId', async () => {
      await controller.heartbeat(mockReq);

      expect(discoveryService.heartbeat).toHaveBeenCalledWith('actor-1');
    });
  });

  describe('getPublicProfile', () => {
    it('should delegate with profile ID', async () => {
      const result = await controller.getPublicProfile('profile-1');

      expect(discoveryService.getPublicProfile).toHaveBeenCalledWith(
        'profile-1',
      );
      expect(result.data.headline).toBe('Great reader');
    });
  });

  describe('addFavorite', () => {
    it('should delegate with userId and profileId', async () => {
      await controller.addFavorite(mockReq, 'profile-1');

      expect(discoveryService.addFavorite).toHaveBeenCalledWith(
        'actor-1',
        'profile-1',
      );
    });
  });

  describe('removeFavorite', () => {
    it('should delegate with userId and profileId', async () => {
      await controller.removeFavorite(mockReq, 'profile-1');

      expect(discoveryService.removeFavorite).toHaveBeenCalledWith(
        'actor-1',
        'profile-1',
      );
    });
  });
});
