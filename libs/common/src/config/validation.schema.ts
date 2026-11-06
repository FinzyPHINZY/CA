import * as Joi from 'joi';

export const validationSchema = Joi.object({
  // Application
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),

  // Service Ports
  AUTH_PORT: Joi.number().default(3001),
  CORE_PORT: Joi.number().default(3000),
  AI_SERVICE_PORT: Joi.number().default(3002),
  NOTIFICATIONS_SERVICE_PORT: Joi.number().default(3003),
  NOTIFICATIONS_TCP_PORT: Joi.number().default(4004),
  FILE_SERVICE_PORT: Joi.number().default(3004),
  RABBITMQ_URL: Joi.string().default('amqp://rabbitmq:5672'),
  NOTIFICATIONS_QUEUE: Joi.string().default('notifications.queue'),
  AI_SERVICE_QUEUE: Joi.string().default('ai_service.queue'),

  AUTH_SERVICE_TCP_PORT: Joi.number().default(4001),
  CORE_SERVICE_TCP_PORT: Joi.number().default(4002),
  AI_SERVICE_TCP_PORT: Joi.number().default(4003),

  // Database
  DB_HOST: Joi.string().allow('').default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().allow('').default('postgres'),
  DB_PASSWORD: Joi.string().allow('').default('postgres'),
  DB_NAME: Joi.string().allow('').default('acr_db'),
  DB_SYNCHRONIZE: Joi.boolean().default(false),
  DB_LOGGING: Joi.boolean().default(false),
  DB_SSL: Joi.boolean().default(false),

  // JWT
  JWT_SECRET: Joi.string().default('your-secret-key'),
  JWT_REFRESH_SECRET: Joi.string().default('refresh-secret'),
  JWT_ACCESS_TOKEN_EXPIRES_IN: Joi.string().default('15m'),
  JWT_REFRESH_TOKEN_EXPIRES_IN: Joi.string().default('7d'),

  // WebAuthn
  RP_NAME: Joi.string().default('ACR App'),
  RP_ID: Joi.string().default('localhost'),
  ORIGIN: Joi.string().default('http://localhost:3000'),
  CHALLENGE_TTL_SECONDS: Joi.number().default(120),

  // Google OAuth
  GOOGLE_CLIENT_ID: Joi.string().optional(),

  // Apple OAuth
  APPLE_CLIENT_ID: Joi.string().optional(),
  APPLE_TEAM_ID: Joi.string().optional(),
  APPLE_KEY_ID: Joi.string().optional(),
  APPLE_PRIVATE_KEY: Joi.string().optional(),

  // Email Configuration (Nodemailer)
  EMAIL_ENABLED: Joi.boolean().default(false),
  SMTP_HOST: Joi.string().optional(),
  SMTP_PORT: Joi.number().default(587),
  SMTP_SECURE: Joi.boolean().default(false),
  SMTP_USER: Joi.string().optional(),
  SMTP_PASSWORD: Joi.string().optional(),
  SMTP_SERVICE: Joi.string().optional(), // e.g., 'gmail', 'outlook', 'mailtrap'
  EMAIL_FROM: Joi.string().optional(), // Default sender email address
  APP_NAME: Joi.string().default('ACR App'),

  // Payment Model: 'destination' (legacy) or 'separate' (new — money stays on platform)
  PAYMENT_MODEL: Joi.string()
    .valid('destination', 'separate')
    .default('destination'),

  // AWS S3 Configuration
  AWS_REGION: Joi.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: Joi.string().allow('').optional(),
  AWS_SECRET_ACCESS_KEY: Joi.string().allow('').optional(),
  AWS_S3_BUCKET: Joi.string().allow('').optional(),
});
