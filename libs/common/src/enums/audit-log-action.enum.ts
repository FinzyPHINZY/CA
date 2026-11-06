/**
 * Audit log action codes for admin and system events.
 * Used when writing to auth_schema.audit_logs.
 */
export enum AuditLogAction {
  /** System admin created a new app admin user */
  ADMIN_CREATE_APP_ADMIN = 'admin.create_app_admin',
  /** System admin set/updated an app admin's permissions */
  ADMIN_SET_PERMISSIONS = 'admin.set_permissions',
  /** Admin listed admin users */
  ADMIN_LIST_ADMIN_USERS = 'admin.list_admin_users',
  /** Admin listed no-show bookings */
  ADMIN_LIST_NO_SHOWS = 'admin.list_no_shows',
  /** Admin resolved a no-show booking (determined who was absent) */
  ADMIN_RESOLVE_NO_SHOW = 'admin.resolve_no_show',
  /** Admin listed booking payment reconciliation issues */
  ADMIN_LIST_PAYMENT_RECONCILIATION_ISSUES = 'admin.list_payment_reconciliation_issues',
  /** Admin retried a booking refund/reconciliation flow */
  ADMIN_RETRY_BOOKING_REFUND = 'admin.retry_booking_refund',
  /** Admin manually marked a booking as completed */
  ADMIN_COMPLETE_BOOKING = 'admin.complete_booking',
  /** Admin deleted moderated content */
  ADMIN_DELETE_CONTENT = 'admin.delete_content',
  /** Admin flagged a project */
  ADMIN_FLAG_PROJECT = 'admin.flag_project',
  /** Admin listed users */
  ADMIN_LIST_USERS = 'admin.list_users',
  /** Admin viewed single user */
  ADMIN_GET_USER = 'admin.get_user',
  /** Admin listed user projects */
  ADMIN_LIST_USER_PROJECTS = 'admin.list_user_projects',
  /** Admin listed user recordings */
  ADMIN_LIST_USER_RECORDINGS = 'admin.list_user_recordings',
  /** Admin listed user rehearsals */
  ADMIN_LIST_USER_REHEARSALS = 'admin.list_user_rehearsals',
  /** Admin listed projects */
  ADMIN_LIST_PROJECTS = 'admin.list_projects',
  /** Admin listed subscriptions */
  ADMIN_LIST_SUBSCRIPTIONS = 'admin.list_subscriptions',
  /** Admin viewed payments dashboard summary */
  ADMIN_GET_PAYMENTS_SUMMARY = 'admin.get_payments_summary',
  /** Admin listed audit log entries (activity feed) */
  ADMIN_LIST_AUDIT_LOGS = 'admin.list_audit_logs',
  /** Admin viewed queue / broker health */
  ADMIN_GET_QUEUE_HEALTH = 'admin.get_queue_health',
  /** Admin listed settlement reconciliation issues */
  ADMIN_LIST_SETTLEMENT_ISSUES = 'admin.list_settlement_issues',
  /** Admin listed financial reconciliation issues (extended) */
  ADMIN_LIST_FINANCIAL_RECONCILIATION_ISSUES =
    'admin.list_financial_reconciliation_issues',
  /** Admin retried a booking settlement */
  ADMIN_RETRY_BOOKING_SETTLEMENT = 'admin.retry_booking_settlement',
  /** Admin listed marketplace bookings */
  ADMIN_LIST_BOOKINGS = 'admin.list_bookings',
  /** Admin viewed a single booking */
  ADMIN_GET_BOOKING = 'admin.get_booking',
  /** Admin listed projects with analysis enrichment */
  ADMIN_LIST_PROJECTS_ENRICHED = 'admin.list_projects_enriched',
  /** Admin inspected project analysis outbox jobs */
  ADMIN_GET_PROJECT_OUTBOX_JOBS = 'admin.get_project_outbox_jobs',
  /** Admin retried failed project script analysis */
  ADMIN_RETRY_PROJECT_SCRIPT_ANALYSIS = 'admin.retry_project_script_analysis',
}
