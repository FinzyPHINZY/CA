// Crypto polyfill for Node.js environment
import { webcrypto } from 'crypto';

if (typeof globalThis.crypto === 'undefined') {
  (globalThis as any).crypto = webcrypto;
}
