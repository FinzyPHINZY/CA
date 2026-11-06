import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * Encrypts and decrypts OAuth tokens for calendar provider connections.
 *
 * Stored format (all hex, colon-delimited): iv:authTag:ciphertext
 *
 * Key: CALENDAR_ENCRYPTION_KEY env var — 32-byte hex string (64 hex chars).
 * Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
@Injectable()
export class CalendarEncryptionService {
  private readonly key: Buffer;

  constructor(private readonly configService: ConfigService) {
    const hexKey = this.configService.get<string>('CALENDAR_ENCRYPTION_KEY');
    if (!hexKey) {
      throw new InternalServerErrorException(
        'CALENDAR_ENCRYPTION_KEY is not configured',
      );
    }
    this.key = Buffer.from(hexKey, 'hex');
    if (this.key.length !== 32) {
      throw new InternalServerErrorException(
        'CALENDAR_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)',
      );
    }
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return [
      iv.toString('hex'),
      authTag.toString('hex'),
      encrypted.toString('hex'),
    ].join(':');
  }

  decrypt(stored: string): string {
    const parts = stored.split(':');
    if (parts.length !== 3) {
      throw new InternalServerErrorException('Invalid encrypted token format');
    }
    const [ivHex, authTagHex, ciphertextHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const ciphertext = Buffer.from(ciphertextHex, 'hex');

    if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
      throw new InternalServerErrorException('Malformed encrypted token');
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }
}
