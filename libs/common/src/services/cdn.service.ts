import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';

// default signed URL expiry: 24 hours
const DEFAULT_EXPIRY_SECONDS = 86400;

@Injectable()
export class CdnService {
  private readonly logger = new Logger(CdnService.name);
  private readonly cloudfrontDomain: string;
  private readonly keyPairId: string;
  private readonly privateKey: string;
  private readonly isConfigured: boolean;

  constructor(private readonly configService: ConfigService) {
    this.cloudfrontDomain =
      this.configService.get<string>('CLOUDFRONT_DOMAIN') || '';
    this.keyPairId =
      this.configService.get<string>('CLOUDFRONT_KEY_PAIR_ID') || '';
    // private key may contain literal \n that needs to be converted to actual newlines
    const rawKey =
      this.configService.get<string>('CLOUDFRONT_PRIVATE_KEY') || '';
    this.privateKey = rawKey.replace(/\\n/g, '\n');

    this.isConfigured = !!(
      this.cloudfrontDomain &&
      this.keyPairId &&
      this.privateKey
    );

    if (!this.isConfigured) {
      this.logger.warn(
        'CloudFront CDN is not configured. Signed URLs will fall back to direct S3 URLs.',
      );
    }
  }

  // generate a signed CloudFront URL for an S3 key.
  // if CloudFront is not configured, falls back to the plain S3 URL.
  generateSignedUrl(
    s3Key: string,
    expiresInSeconds: number = DEFAULT_EXPIRY_SECONDS,
  ): string {
    if (!this.isConfigured) {
      return this.buildDirectS3Url(s3Key);
    }

    const url = `https://${this.cloudfrontDomain}/${s3Key}`;
    const dateLessThan = new Date(
      Date.now() + expiresInSeconds * 1000,
    ).toISOString();

    try {
      const signedUrl = getSignedUrl({
        url,
        keyPairId: this.keyPairId,
        privateKey: this.privateKey,
        dateLessThan,
      });

      return signedUrl;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to generate signed URL: ${message}`);
      // fall back to direct S3 URL on signing failure
      return this.buildDirectS3Url(s3Key);
    }
  }

  // generate signed URLs for multiple S3 keys at once.
  generateSignedUrls(
    s3Keys: string[],
    expiresInSeconds: number = DEFAULT_EXPIRY_SECONDS,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const key of s3Keys) {
      result[key] = this.generateSignedUrl(key, expiresInSeconds);
    }
    return result;
  }

  // check if CloudFront CDN is properly configured.
  isCdnConfigured(): boolean {
    return this.isConfigured;
  }

  private buildDirectS3Url(s3Key: string): string {
    const bucket = this.configService.get<string>('AWS_S3_BUCKET') || '';
    return `https://${bucket}.s3.amazonaws.com/${s3Key}`;
  }
}
