/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import { MediaType } from '@app/common';
import { BadRequestException, Logger } from '@nestjs/common';
import { FileServiceService } from './file_service.service';

describe('FileServiceService', () => {
  let service: FileServiceService;
  let storageService: any;
  let mediaService: any;
  let configService: any;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    storageService = {
      uploadFile: jest.fn(),
    };
    mediaService = {
      createMedia: jest.fn(),
    };
    configService = {
      get: jest.fn().mockReturnValue(''),
    };

    service = new FileServiceService(
      storageService,
      mediaService,
      configService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts a valid uploaded video work sample and stores it under the reader work-samples prefix', async () => {
    const file = {
      originalname: 'commercial-reel.mp4',
      mimetype: 'video/mp4',
      size: 10 * 1024 * 1024,
      buffer: Buffer.from('video'),
    } as Express.Multer.File;

    storageService.uploadFile.mockResolvedValue({
      url: 'https://bucket.s3.amazonaws.com/marketplace/readers/user-1/work-samples/key.mp4',
      key: 'marketplace/readers/user-1/work-samples/key.mp4',
    });
    mediaService.createMedia.mockResolvedValue({
      id: 'media-1',
      type: MediaType.VIDEO,
      url: 'https://bucket.s3.amazonaws.com/marketplace/readers/user-1/work-samples/key.mp4',
      s3Key: 'marketplace/readers/user-1/work-samples/key.mp4',
    });

    const result = await service.uploadReaderWorkSample(file, 'user-1');

    expect(storageService.uploadFile).toHaveBeenCalledWith(
      file,
      expect.objectContaining({
        keyPrefix: 'marketplace/readers/user-1/work-samples',
        metadata: expect.objectContaining({
          purpose: 'reader_work_sample',
          ownerUserId: 'user-1',
          mediaType: MediaType.VIDEO,
        }),
      }),
    );
    expect(mediaService.createMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MediaType.VIDEO,
        userId: 'user-1',
      }),
    );
    expect(result.type).toBe(MediaType.VIDEO);
  });

  it('rejects unsupported work sample file types', async () => {
    const file = {
      originalname: 'notes.pdf',
      mimetype: 'application/pdf',
      size: 1024,
      buffer: Buffer.from('pdf'),
    } as Express.Multer.File;

    await expect(
      service.uploadReaderWorkSample(file, 'user-1'),
    ).rejects.toThrow(BadRequestException);

    expect(storageService.uploadFile).not.toHaveBeenCalled();
  });

  it('rejects oversized work sample files', async () => {
    const file = {
      originalname: 'feature-reel.mp4',
      mimetype: 'video/mp4',
      size: 101 * 1024 * 1024,
      buffer: Buffer.from('video'),
    } as Express.Multer.File;

    await expect(
      service.uploadReaderWorkSample(file, 'user-1'),
    ).rejects.toThrow(BadRequestException);

    expect(storageService.uploadFile).not.toHaveBeenCalled();
  });

  it('rejects extension and mime mismatches for work sample uploads', async () => {
    const file = {
      originalname: 'voice-demo.mp3',
      mimetype: 'video/mp4',
      size: 2 * 1024 * 1024,
      buffer: Buffer.from('audio'),
    } as Express.Multer.File;

    await expect(
      service.uploadReaderWorkSample(file, 'user-1'),
    ).rejects.toThrow(BadRequestException);
  });
});
