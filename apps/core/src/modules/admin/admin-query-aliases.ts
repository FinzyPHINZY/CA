/**
 * TypeORM query-builder aliases safe for PostgreSQL raw SQL fragments.
 * Do not use reserved words (e.g. USER, ORDER, GROUP, TABLE) as aliases in
 * .select() / .addSelect() / raw join conditions.
 */
export const ADMIN_USER_ALIAS = 'u';
export const ADMIN_USER_ROLE_ALIAS = 'role';
export const ADMIN_PROJECT_ALIAS = 'p';
export const ADMIN_PROJECT_OWNER_ALIAS = 'own';
export const ADMIN_SUBSCRIPTION_ALIAS = 'sub';
export const ADMIN_SUBSCRIBER_ALIAS = 'subr';
export const ADMIN_RECORDING_ALIAS = 'rec';
export const ADMIN_REHEARSAL_ALIAS = 'rh';
export const ADMIN_PAYMENT_RECORD_ALIAS = 'pr';
export const ADMIN_BILLING_SUB_ALIAS = 'bsub';
export const ADMIN_USAGE_RECORD_ALIAS = 'ur';
export const ADMIN_USER_ROLE_ENTITY_ALIAS = 'urole';
export const ADMIN_AUDIT_LOG_ALIAS = 'alog';
export const ADMIN_BOOKING_ACTOR_ALIAS = 'bactor';
export const ADMIN_BOOKING_READER_ALIAS = 'breader';
