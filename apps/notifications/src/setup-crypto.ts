import { randomUUID, webcrypto } from 'crypto';

// Ensure global crypto is available for libs that expect Web Crypto API
if (typeof (global as any).crypto === 'undefined') {
  (global as any).crypto = (webcrypto as any) ?? {};
}

// Ensure getRandomValues is available
if (
  !(global as any).crypto.getRandomValues &&
  (webcrypto as any)?.getRandomValues
) {
  (global as any).crypto.getRandomValues = (
    webcrypto as any
  ).getRandomValues.bind(webcrypto);
}

// Ensure randomUUID is available
if (!(global as any).crypto.randomUUID) {
  (global as any).crypto.randomUUID = randomUUID;
}
