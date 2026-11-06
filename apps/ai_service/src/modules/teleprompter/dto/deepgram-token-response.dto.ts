// Swagger response schema for GET /api/teleprompter/deepgram-token. Plain
// interface — not used as a validation DTO, only as the Swagger reference
// shape for the OpenAPI annotations.

export const DEEPGRAM_TOKEN_RESPONSE_EXAMPLE = {
  success: true,
  message: 'Deepgram token issued',
  data: {
    token: 'dg_session_abc123...',
    keyId: 'aabbccdd-eeff-0011-2233-445566778899',
    expiresAt: '2026-05-22T14:35:00.000Z',
    model: 'nova-2',
    config: {
      interim_results: true,
      punctuate: true,
      smart_format: true,
      endpointing: 1000,
    },
  },
};
