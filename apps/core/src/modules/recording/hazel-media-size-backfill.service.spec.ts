/** biome-ignore-all lint/style/useImportType: <> */
import { MediaRepository, StorageService } from '@app/common';
import { Logger } from '@nestjs/common';
import { HazelMediaSizeBackfillService } from './hazel-media-size-backfill.service';

const makeMedia = (overrides: Record<string, any> = {}) => ({
  id: 'media-1',
  s3Key: 'recordings/hazel/x/file.mp4',
  size: 0,
  ...overrides,
});

const makeBuilder = (rows: any[]) => {
  const builder: any = {};
  for (const method of ['innerJoin', 'where', 'andWhere', 'orderBy', 'limit']) {
    builder[method] = jest.fn().mockReturnValue(builder);
  }
  builder.getMany = jest.fn().mockResolvedValue(rows);
  return builder;
};

describe('HazelMediaSizeBackfillService', () => {
  let service: HazelMediaSizeBackfillService;
  let mediaRepository: jest.Mocked<Partial<MediaRepository>>;
  let storageService: jest.Mocked<Partial<StorageService>>;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();

    mediaRepository = {
      createQueryBuilder: jest.fn(),
      updateMedia: jest.fn().mockResolvedValue({}),
    };
    storageService = {
      getObjectSize: jest.fn(),
    };

    service = new HazelMediaSizeBackfillService(
      mediaRepository as any,
      storageService as any,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('no-op when no candidates', async () => {
    (mediaRepository.createQueryBuilder as jest.Mock).mockReturnValue(
      makeBuilder([]),
    );

    await service.backfillSizes();

    expect(storageService.getObjectSize).not.toHaveBeenCalled();
    expect(mediaRepository.updateMedia).not.toHaveBeenCalled();
  });

  it('skips media without s3Key (no S3 call, no update)', async () => {
    (mediaRepository.createQueryBuilder as jest.Mock).mockReturnValue(
      makeBuilder([makeMedia({ s3Key: null })]),
    );

    await service.backfillSizes();

    expect(storageService.getObjectSize).not.toHaveBeenCalled();
    expect(mediaRepository.updateMedia).not.toHaveBeenCalled();
  });

  it('leaves row when getObjectSize returns null (still uploading)', async () => {
    (mediaRepository.createQueryBuilder as jest.Mock).mockReturnValue(
      makeBuilder([makeMedia()]),
    );
    (storageService.getObjectSize as jest.Mock).mockResolvedValue(null);

    await service.backfillSizes();

    expect(mediaRepository.updateMedia).not.toHaveBeenCalled();
  });

  it('leaves row when getObjectSize returns 0 (treat as missing)', async () => {
    (mediaRepository.createQueryBuilder as jest.Mock).mockReturnValue(
      makeBuilder([makeMedia()]),
    );
    (storageService.getObjectSize as jest.Mock).mockResolvedValue(0);

    await service.backfillSizes();

    expect(mediaRepository.updateMedia).not.toHaveBeenCalled();
  });

  it('updates size when getObjectSize returns positive bytes', async () => {
    const media = makeMedia();
    (mediaRepository.createQueryBuilder as jest.Mock).mockReturnValue(
      makeBuilder([media]),
    );
    (storageService.getObjectSize as jest.Mock).mockResolvedValue(123456);

    await service.backfillSizes();

    expect(mediaRepository.updateMedia).toHaveBeenCalledWith('media-1', {
      size: 123456,
    });
  });

  it('processes multiple rows in a single tick', async () => {
    const rows = [
      makeMedia({ id: 'media-1', s3Key: 'a.mp4' }),
      makeMedia({ id: 'media-2', s3Key: 'b.mp4' }),
      makeMedia({ id: 'media-3', s3Key: null }),
    ];
    (mediaRepository.createQueryBuilder as jest.Mock).mockReturnValue(
      makeBuilder(rows),
    );
    (storageService.getObjectSize as jest.Mock).mockImplementation(
      (key: string) =>
        Promise.resolve(key === 'a.mp4' ? 1000 : key === 'b.mp4' ? 2000 : null),
    );

    await service.backfillSizes();

    expect(mediaRepository.updateMedia).toHaveBeenCalledTimes(2);
    expect(mediaRepository.updateMedia).toHaveBeenCalledWith('media-1', {
      size: 1000,
    });
    expect(mediaRepository.updateMedia).toHaveBeenCalledWith('media-2', {
      size: 2000,
    });
  });

  it('continues processing after updateMedia error on one row', async () => {
    const rows = [
      makeMedia({ id: 'media-1', s3Key: 'a.mp4' }),
      makeMedia({ id: 'media-2', s3Key: 'b.mp4' }),
    ];
    (mediaRepository.createQueryBuilder as jest.Mock).mockReturnValue(
      makeBuilder(rows),
    );
    (storageService.getObjectSize as jest.Mock).mockResolvedValue(1000);
    (mediaRepository.updateMedia as jest.Mock)
      .mockRejectedValueOnce(new Error('db error'))
      .mockResolvedValueOnce({});

    await service.backfillSizes();

    expect(mediaRepository.updateMedia).toHaveBeenCalledTimes(2);
  });
});
