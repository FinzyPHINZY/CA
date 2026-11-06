import { randomUUID, webcrypto } from 'crypto';

if (typeof (global as any).crypto === 'undefined') {
  (global as any).crypto = (webcrypto as any) ?? {};
}

if (
  !(global as any).crypto.getRandomValues &&
  (webcrypto as any)?.getRandomValues
) {
  (global as any).crypto.getRandomValues = (
    webcrypto as any
  ).getRandomValues.bind(webcrypto);
}

if (!(global as any).crypto.randomUUID) {
  (global as any).crypto.randomUUID = randomUUID;
}
