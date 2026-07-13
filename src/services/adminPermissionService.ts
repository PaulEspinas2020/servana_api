import dbQuery from '../db/dbQuery';
import { db } from '../config';
import { auditFire } from './adminAuditService';
import { toCamel } from '../helpers/idGenerator';

const s = db.schema;

// ── Types ─────────────────────────────────────────────────────────────────────

export type AdminAccountStatus = 'active' | 'inactive' | 'suspended' | 'archived';

export interface AdminUserRow {
  admin_uid: string;
  email: string;
  display_name: string | null;
  is_super_admin: boolean;
  account_status: AdminAccountStatus;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  deactivated_at: string | null;
  version: number;
}

export interface AdminEffectivePermissionProfile {
  adminUid: string;
  isSuperAdmin: boolean;
  accountStatus: AdminAccountStatus;
  permissions: string[];
  deniedPermissions: string[];
  generatedAt: string;
  version: number;
}

export interface AdminPermissionDefinitionRow {
  key: string;
  module: string;
  groupLabel: string;
  label: string;
  description: string;
  actionType: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  requires: string[];
  conflictsWith: string[];
  isDangerous: boolean;
  isHiddenFromNormalUi: boolean;
  displayOrder: number;
}

interface PermissionSeed {
  key: string;
  module: string;
  group_label: string;
  label: string;
  description: string;
  action_type: string;
  risk_level: string;
  requires: string[];
  conflicts_with?: string[];
  is_dangerous?: boolean;
  is_hidden_from_normal_ui?: boolean;
  display_order: number;
}

// ── Permission cache (60s TTL) ─────────────────────────────────────────────────

const permCache = new Map<string, { perms: string[]; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

export function invalidatePermissionCache(adminUid: string): void {
  permCache.delete(adminUid);
}

// ── Permission seed list ───────────────────────────────────────────────────────

const PERMISSION_SEEDS: PermissionSeed[] = [
  // Dashboard
  { key: 'dashboard.view', module: 'dashboard', group_label: 'Dashboard', label: 'View Admin Dashboard', description: 'Access the admin dashboard', action_type: 'view', risk_level: 'low', requires: [], display_order: 100 },
  { key: 'dashboard.operations_metrics.view', module: 'dashboard', group_label: 'Dashboard', label: 'View Operations Metrics', description: '', action_type: 'view', risk_level: 'low', requires: ['dashboard.view'], display_order: 110 },
  { key: 'dashboard.revenue_metrics.view', module: 'dashboard', group_label: 'Dashboard', label: 'View Revenue Metrics', description: '', action_type: 'view', risk_level: 'low', requires: ['dashboard.view'], display_order: 120 },
  { key: 'dashboard.provider_supply_metrics.view', module: 'dashboard', group_label: 'Dashboard', label: 'View Provider Supply Metrics', description: '', action_type: 'view', risk_level: 'low', requires: ['dashboard.view'], display_order: 130 },
  { key: 'dashboard.booking_pipeline_metrics.view', module: 'dashboard', group_label: 'Dashboard', label: 'View Booking Pipeline Metrics', description: '', action_type: 'view', risk_level: 'low', requires: ['dashboard.view'], display_order: 140 },
  { key: 'dashboard.system_health.view', module: 'dashboard', group_label: 'Dashboard', label: 'View System Health', description: '', action_type: 'view', risk_level: 'low', requires: ['dashboard.view'], display_order: 150 },

  // Bookings
  { key: 'bookings.view', module: 'bookings', group_label: 'Booking / Job Operations', label: 'View Bookings', description: '', action_type: 'view', risk_level: 'low', requires: [], display_order: 200 },
  { key: 'bookings.details.view', module: 'bookings', group_label: 'Booking / Job Operations', label: 'View Booking Details', description: '', action_type: 'view', risk_level: 'low', requires: ['bookings.view'], display_order: 210 },
  { key: 'bookings.timeline.view', module: 'bookings', group_label: 'Booking / Job Operations', label: 'View Booking Timeline', description: '', action_type: 'view', risk_level: 'low', requires: ['bookings.details.view'], display_order: 220 },
  { key: 'bookings.search', module: 'bookings', group_label: 'Booking / Job Operations', label: 'Search and Filter Bookings', description: '', action_type: 'view', risk_level: 'low', requires: ['bookings.view'], display_order: 230 },
  { key: 'bookings.assign_provider', module: 'bookings', group_label: 'Booking / Job Operations', label: 'Assign Provider to Booking', description: '', action_type: 'edit', risk_level: 'medium', requires: ['bookings.view', 'providers.view'], display_order: 240 },
  { key: 'bookings.reassign_provider', module: 'bookings', group_label: 'Booking / Job Operations', label: 'Reassign Provider', description: '', action_type: 'edit', risk_level: 'medium', requires: ['bookings.assign_provider'], display_order: 250 },
  { key: 'bookings.confirm_on_behalf', module: 'bookings', group_label: 'Booking / Job Operations', label: 'Confirm Provider Acceptance on Behalf of Provider', description: '', action_type: 'override', risk_level: 'high', requires: ['bookings.assign_provider'], display_order: 255 },
  { key: 'bookings.reschedule', module: 'bookings', group_label: 'Booking / Job Operations', label: 'Reschedule Booking', description: '', action_type: 'edit', risk_level: 'medium', requires: ['bookings.details.view'], display_order: 260 },
  { key: 'bookings.cancel', module: 'bookings', group_label: 'Booking / Job Operations', label: 'Cancel Booking', description: '', action_type: 'delete', risk_level: 'high', requires: ['bookings.details.view'], display_order: 270 },
  { key: 'bookings.approve_completion', module: 'bookings', group_label: 'Booking / Job Operations', label: 'Approve Booking Completion', description: '', action_type: 'approve', risk_level: 'high', requires: ['bookings.details.view'], display_order: 280 },
  { key: 'bookings.escalate', module: 'bookings', group_label: 'Booking / Job Operations', label: 'Escalate Booking', description: '', action_type: 'override', risk_level: 'medium', requires: ['bookings.details.view'], display_order: 290 },
  { key: 'bookings.disputes.manage', module: 'bookings', group_label: 'Booking / Job Operations', label: 'Open / Manage Booking Dispute', description: '', action_type: 'edit', risk_level: 'high', requires: ['bookings.details.view'], display_order: 300 },
  { key: 'bookings.notes.add', module: 'bookings', group_label: 'Booking / Job Operations', label: 'Add Internal Booking Notes', description: '', action_type: 'create', risk_level: 'low', requires: ['bookings.details.view'], display_order: 310 },
  { key: 'bookings.customer_details.view', module: 'bookings', group_label: 'Booking / Job Operations', label: 'View Customer Details Inside Booking', description: '', action_type: 'sensitive', risk_level: 'medium', requires: ['bookings.details.view'], display_order: 320 },
  { key: 'bookings.create', module: 'bookings', group_label: 'Booking / Job Operations', label: 'Create Booking (Admin)', description: 'Create a new booking on behalf of a guest or client', action_type: 'create', risk_level: 'high', requires: ['bookings.view'], display_order: 325 },
  { key: 'bookings.create_guest', module: 'bookings', group_label: 'Booking / Job Operations', label: 'Create Booking for Guest', description: 'Create a booking for a guest customer (no Servana account required)', action_type: 'create', risk_level: 'high', requires: ['bookings.create'], display_order: 326 },
  { key: 'bookings.create_for_client', module: 'bookings', group_label: 'Booking / Job Operations', label: 'Create Booking for Existing Client', description: 'Search existing clients and create a booking on their behalf', action_type: 'create', risk_level: 'high', requires: ['bookings.create'], display_order: 327 },
  { key: 'bookings.payment_record', module: 'bookings', group_label: 'Booking / Job Operations', label: 'Record Payment Status on Booking', description: 'Mark a new booking as Paid or Pay Later during admin creation', action_type: 'edit', risk_level: 'high', requires: ['bookings.create'], display_order: 328 },
  { key: 'bookings.payment_evidence_upload', module: 'bookings', group_label: 'Booking / Job Operations', label: 'Upload Payment Receipt Evidence', description: 'Attach a payment receipt image to a booking', action_type: 'create', risk_level: 'medium', requires: ['bookings.payment_record'], display_order: 329 },
  { key: 'bookings.provider_details.view', module: 'bookings', group_label: 'Booking / Job Operations', label: 'View Provider Details Inside Booking', description: '', action_type: 'sensitive', risk_level: 'medium', requires: ['bookings.details.view'], display_order: 330 },
  { key: 'bookings.payment_details.view', module: 'bookings', group_label: 'Booking / Job Operations', label: 'View Booking Payment Details', description: '', action_type: 'sensitive', risk_level: 'medium', requires: ['bookings.details.view', 'payments.view'], display_order: 340 },
  { key: 'bookings.export', module: 'bookings', group_label: 'Booking / Job Operations', label: 'Export Bookings', description: '', action_type: 'export', risk_level: 'medium', requires: ['bookings.view'], display_order: 350 },

  // Providers
  { key: 'providers.view', module: 'providers', group_label: 'Provider Registry', label: 'View Provider Registry', description: '', action_type: 'view', risk_level: 'low', requires: [], display_order: 400 },
  { key: 'providers.profile_360.view', module: 'providers', group_label: 'Provider Registry', label: 'View Provider 360', description: '', action_type: 'view', risk_level: 'low', requires: ['providers.view'], display_order: 410 },
  { key: 'providers.search', module: 'providers', group_label: 'Provider Registry', label: 'Search and Filter Providers', description: '', action_type: 'view', risk_level: 'low', requires: ['providers.view'], display_order: 420 },
  { key: 'providers.profile.view', module: 'providers', group_label: 'Provider Registry', label: 'View Provider Profile', description: '', action_type: 'view', risk_level: 'low', requires: ['providers.view'], display_order: 430 },
  { key: 'providers.profile.edit', module: 'providers', group_label: 'Provider Registry', label: 'Edit Provider Profile', description: '', action_type: 'edit', risk_level: 'medium', requires: ['providers.profile.view'], display_order: 440 },
  { key: 'providers.status.change', module: 'providers', group_label: 'Provider Registry', label: 'Change Provider Account Status', description: '', action_type: 'edit', risk_level: 'high', requires: ['providers.profile.view'], display_order: 450 },
  { key: 'providers.suspend', module: 'providers', group_label: 'Provider Registry', label: 'Suspend Provider', description: '', action_type: 'override', risk_level: 'critical', requires: ['providers.status.change'], is_dangerous: true, display_order: 460 },
  { key: 'providers.unsuspend', module: 'providers', group_label: 'Provider Registry', label: 'Unsuspend Provider', description: '', action_type: 'restore', risk_level: 'high', requires: ['providers.status.change'], display_order: 470 },
  { key: 'providers.archive', module: 'providers', group_label: 'Provider Registry', label: 'Archive Provider', description: '', action_type: 'archive', risk_level: 'critical', requires: ['providers.status.change'], is_dangerous: true, display_order: 480 },
  { key: 'providers.restore', module: 'providers', group_label: 'Provider Registry', label: 'Restore Provider', description: '', action_type: 'restore', risk_level: 'high', requires: ['providers.profile.view'], display_order: 490 },
  { key: 'providers.documents.view', module: 'providers', group_label: 'Provider Registry', label: 'View Provider Documents', description: '', action_type: 'view', risk_level: 'low', requires: ['providers.profile.view'], display_order: 500 },
  { key: 'providers.documents.upload', module: 'providers', group_label: 'Provider Registry', label: 'Upload Provider Documents', description: '', action_type: 'create', risk_level: 'medium', requires: ['providers.documents.view'], display_order: 510 },
  { key: 'providers.documents.delete', module: 'providers', group_label: 'Provider Registry', label: 'Delete Provider Documents', description: '', action_type: 'delete', risk_level: 'high', requires: ['providers.documents.view'], display_order: 520 },
  { key: 'providers.documents.verify', module: 'providers', group_label: 'Provider Registry', label: 'Verify Provider Documents', description: 'Mark a provider document as verified', action_type: 'review', risk_level: 'high', requires: ['providers.documents.view'], display_order: 525 },
  { key: 'providers.documents.reject', module: 'providers', group_label: 'Provider Registry', label: 'Reject Provider Documents', description: 'Reject a provider document with a required reason', action_type: 'review', risk_level: 'high', requires: ['providers.documents.view'], display_order: 527 },
  { key: 'providers.documents.request_resubmission', module: 'providers', group_label: 'Provider Registry', label: 'Request Provider Document Resubmission', description: 'Request that a provider resubmit a document with a required message', action_type: 'review', risk_level: 'medium', requires: ['providers.documents.view'], display_order: 529 },
  { key: 'providers.active_services.view', module: 'providers', group_label: 'Provider Registry', label: 'View Provider Active Services', description: '', action_type: 'view', risk_level: 'low', requires: ['providers.profile.view'], display_order: 530 },
  { key: 'providers.active_services.edit', module: 'providers', group_label: 'Provider Registry', label: 'Edit Provider Active Services', description: '', action_type: 'edit', risk_level: 'medium', requires: ['providers.active_services.view'], display_order: 540 },
  { key: 'providers.jobs.view', module: 'providers', group_label: 'Provider Registry', label: 'View Provider Jobs', description: '', action_type: 'view', risk_level: 'low', requires: ['providers.profile.view'], display_order: 550 },
  { key: 'providers.performance.view', module: 'providers', group_label: 'Provider Registry', label: 'View Provider Performance', description: '', action_type: 'view', risk_level: 'low', requires: ['providers.profile.view'], display_order: 560 },
  { key: 'providers.earnings.view', module: 'providers', group_label: 'Provider Registry', label: 'View Provider Earnings Summary', description: '', action_type: 'sensitive', risk_level: 'medium', requires: ['providers.profile.view'], display_order: 570 },
  { key: 'providers.export', module: 'providers', group_label: 'Provider Registry', label: 'Export Provider List', description: '', action_type: 'export', risk_level: 'medium', requires: ['providers.view'], display_order: 580 },

  // Onboarding
  { key: 'onboarding.view', module: 'onboarding', group_label: 'Provider Onboarding', label: 'View Onboarding Queue', description: '', action_type: 'view', risk_level: 'low', requires: [], display_order: 600 },
  { key: 'onboarding.case.view', module: 'onboarding', group_label: 'Provider Onboarding', label: 'View Onboarding Case Details', description: '', action_type: 'view', risk_level: 'low', requires: ['onboarding.view'], display_order: 610 },
  { key: 'onboarding.case.assign', module: 'onboarding', group_label: 'Provider Onboarding', label: 'Assign Onboarding Case', description: '', action_type: 'edit', risk_level: 'low', requires: ['onboarding.case.view'], display_order: 620 },
  { key: 'onboarding.priority.change', module: 'onboarding', group_label: 'Provider Onboarding', label: 'Change Onboarding Priority', description: '', action_type: 'edit', risk_level: 'low', requires: ['onboarding.case.view'], display_order: 630 },
  { key: 'onboarding.status.move', module: 'onboarding', group_label: 'Provider Onboarding', label: 'Move Onboarding Case Status', description: '', action_type: 'edit', risk_level: 'medium', requires: ['onboarding.case.view'], display_order: 640 },
  { key: 'onboarding.requirement.approve', module: 'onboarding', group_label: 'Provider Onboarding', label: 'Approve Requirement', description: '', action_type: 'approve', risk_level: 'medium', requires: ['onboarding.case.view'], display_order: 650 },
  { key: 'onboarding.requirement.reject', module: 'onboarding', group_label: 'Provider Onboarding', label: 'Reject Requirement', description: '', action_type: 'reject', risk_level: 'medium', requires: ['onboarding.case.view'], display_order: 660 },
  { key: 'onboarding.requirement.request_resubmission', module: 'onboarding', group_label: 'Provider Onboarding', label: 'Request Requirement Resubmission', description: '', action_type: 'edit', risk_level: 'low', requires: ['onboarding.case.view'], display_order: 670 },
  { key: 'onboarding.notes.add', module: 'onboarding', group_label: 'Provider Onboarding', label: 'Add Onboarding Notes', description: '', action_type: 'create', risk_level: 'low', requires: ['onboarding.case.view'], display_order: 680 },
  { key: 'onboarding.timeline.view', module: 'onboarding', group_label: 'Provider Onboarding', label: 'View Onboarding Timeline', description: '', action_type: 'view', risk_level: 'low', requires: ['onboarding.case.view'], display_order: 690 },
  { key: 'onboarding.readiness.run', module: 'onboarding', group_label: 'Provider Onboarding', label: 'Run Readiness Check', description: '', action_type: 'view', risk_level: 'low', requires: ['onboarding.case.view'], display_order: 700 },
  { key: 'onboarding.final_approve', module: 'onboarding', group_label: 'Provider Onboarding', label: 'Final Approve Provider', description: 'Approve provider to active status', action_type: 'approve', risk_level: 'critical', requires: ['onboarding.case.view'], display_order: 710 },
  { key: 'onboarding.final_reject', module: 'onboarding', group_label: 'Provider Onboarding', label: 'Final Reject Provider', description: '', action_type: 'reject', risk_level: 'critical', requires: ['onboarding.case.view'], display_order: 720 },
  { key: 'onboarding.export', module: 'onboarding', group_label: 'Provider Onboarding', label: 'Export Onboarding Cases', description: '', action_type: 'export', risk_level: 'medium', requires: ['onboarding.view'], display_order: 730 },

  // Provider availability & service area
  { key: 'provider_availability.view', module: 'provider_availability', group_label: 'Provider Availability and Service Area', label: 'View Provider Availability', description: '', action_type: 'view', risk_level: 'low', requires: ['providers.view'], display_order: 800 },
  { key: 'provider_availability.weekly_schedule.edit', module: 'provider_availability', group_label: 'Provider Availability and Service Area', label: 'Edit Provider Weekly Schedule', description: '', action_type: 'edit', risk_level: 'medium', requires: ['provider_availability.view'], display_order: 810 },
  { key: 'provider_availability.time_off.add', module: 'provider_availability', group_label: 'Provider Availability and Service Area', label: 'Add Provider Time-Off', description: '', action_type: 'create', risk_level: 'medium', requires: ['provider_availability.view'], display_order: 820 },
  { key: 'provider_availability.time_off.cancel', module: 'provider_availability', group_label: 'Provider Availability and Service Area', label: 'Cancel Provider Time-Off', description: '', action_type: 'delete', risk_level: 'medium', requires: ['provider_availability.view'], display_order: 830 },
  { key: 'provider_service_area.view', module: 'provider_availability', group_label: 'Provider Availability and Service Area', label: 'View Provider Service Area', description: '', action_type: 'view', risk_level: 'low', requires: ['providers.view'], display_order: 840 },
  { key: 'provider_service_area.edit', module: 'provider_availability', group_label: 'Provider Availability and Service Area', label: 'Edit Provider Service Area', description: '', action_type: 'edit', risk_level: 'medium', requires: ['provider_service_area.view'], display_order: 850 },
  { key: 'provider_eligibility.preview', module: 'provider_availability', group_label: 'Provider Availability and Service Area', label: 'Run Provider Eligibility Preview', description: '', action_type: 'view', risk_level: 'low', requires: ['providers.view'], display_order: 860 },
  { key: 'provider_assignment.reasons.view', module: 'provider_availability', group_label: 'Provider Availability and Service Area', label: 'View Assignment Candidate Reasons', description: '', action_type: 'view', risk_level: 'low', requires: ['bookings.assign_provider'], display_order: 870 },
  { key: 'provider_assignment.warning_override', module: 'provider_availability', group_label: 'Provider Availability and Service Area', label: 'Override Assignment Warning', description: '', action_type: 'override', risk_level: 'high', requires: ['bookings.assign_provider'], display_order: 880 },
  { key: 'provider_supply_gaps.view', module: 'provider_availability', group_label: 'Provider Availability and Service Area', label: 'View Supply Gap Reports', description: '', action_type: 'view', risk_level: 'low', requires: ['providers.view'], display_order: 890 },

  // Auto-online
  { key: 'auto_online.view', module: 'auto_online', group_label: 'Auto-Online / Auto-Bookable Providers', label: 'View Auto-Online Status', description: '', action_type: 'view', risk_level: 'low', requires: ['providers.view'], display_order: 950 },
  { key: 'auto_online.readiness.view', module: 'auto_online', group_label: 'Auto-Online / Auto-Bookable Providers', label: 'View Auto-Online Readiness Checklist', description: '', action_type: 'view', risk_level: 'low', requires: ['auto_online.view'], display_order: 960 },
  { key: 'auto_online.reevaluate', module: 'auto_online', group_label: 'Auto-Online / Auto-Bookable Providers', label: 'Re-evaluate Provider Auto-Online Status', description: '', action_type: 'edit', risk_level: 'medium', requires: ['auto_online.view'], display_order: 970 },
  { key: 'auto_online.disable', module: 'auto_online', group_label: 'Auto-Online / Auto-Bookable Providers', label: 'Disable Auto-Online for Provider', description: '', action_type: 'override', risk_level: 'high', requires: ['auto_online.view'], display_order: 980 },
  { key: 'auto_online.enable_override', module: 'auto_online', group_label: 'Auto-Online / Auto-Bookable Providers', label: 'Enable Auto-Online Override', description: '', action_type: 'override', risk_level: 'high', requires: ['auto_online.view'], display_order: 990 },
  { key: 'auto_online.backfill_preview', module: 'auto_online', group_label: 'Auto-Online / Auto-Bookable Providers', label: 'Run Auto-Online Backfill Preview', description: '', action_type: 'view', risk_level: 'medium', requires: ['auto_online.view'], display_order: 1000 },
  { key: 'auto_online.backfill_apply', module: 'auto_online', group_label: 'Auto-Online / Auto-Bookable Providers', label: 'Run Auto-Online Backfill Apply', description: '', action_type: 'system', risk_level: 'critical', requires: ['auto_online.backfill_preview'], is_dangerous: true, display_order: 1010 },
  { key: 'auto_online.blockers.export', module: 'auto_online', group_label: 'Auto-Online / Auto-Bookable Providers', label: 'Export Auto-Online Blockers', description: '', action_type: 'export', risk_level: 'low', requires: ['auto_online.view'], display_order: 1020 },

  // Services/catalog
  { key: 'services.view', module: 'services', group_label: 'Services / Catalog', label: 'View Services Catalog', description: '', action_type: 'view', risk_level: 'low', requires: [], display_order: 1100 },
  { key: 'services.details.view', module: 'services', group_label: 'Services / Catalog', label: 'View Service Details', description: '', action_type: 'view', risk_level: 'low', requires: ['services.view'], display_order: 1110 },
  { key: 'services.draft.create', module: 'services', group_label: 'Services / Catalog', label: 'Create Service Draft', description: '', action_type: 'create', risk_level: 'medium', requires: ['services.view'], display_order: 1120 },
  { key: 'services.draft.edit', module: 'services', group_label: 'Services / Catalog', label: 'Edit Service Draft', description: '', action_type: 'edit', risk_level: 'medium', requires: ['services.details.view'], display_order: 1130 },
  { key: 'services.offering.create', module: 'services', group_label: 'Services / Catalog', label: 'Create Catalog Offering', description: '', action_type: 'create', risk_level: 'medium', requires: ['services.view'], display_order: 1140 },
  { key: 'services.offering.edit', module: 'services', group_label: 'Services / Catalog', label: 'Edit Catalog Offering', description: '', action_type: 'edit', risk_level: 'medium', requires: ['services.details.view'], display_order: 1150 },
  { key: 'services.offering.archive', module: 'services', group_label: 'Services / Catalog', label: 'Archive Catalog Offering', description: '', action_type: 'archive', risk_level: 'high', requires: ['services.details.view'], display_order: 1160 },
  { key: 'services.mapping.create', module: 'services', group_label: 'Services / Catalog', label: 'Create Service Mapping', description: '', action_type: 'create', risk_level: 'medium', requires: ['services.view'], display_order: 1170 },
  { key: 'services.mapping.edit', module: 'services', group_label: 'Services / Catalog', label: 'Edit Service Mapping', description: '', action_type: 'edit', risk_level: 'medium', requires: ['services.details.view'], display_order: 1180 },
  { key: 'services.mapping.archive', module: 'services', group_label: 'Services / Catalog', label: 'Archive Service Mapping', description: '', action_type: 'archive', risk_level: 'high', requires: ['services.details.view'], display_order: 1190 },
  { key: 'services.specific.create', module: 'services', group_label: 'Services / Catalog', label: 'Create Specific Service', description: '', action_type: 'create', risk_level: 'medium', requires: ['services.view'], display_order: 1200 },
  { key: 'services.specific.edit', module: 'services', group_label: 'Services / Catalog', label: 'Edit Specific Service', description: '', action_type: 'edit', risk_level: 'medium', requires: ['services.details.view'], display_order: 1210 },
  { key: 'services.specific.archive', module: 'services', group_label: 'Services / Catalog', label: 'Archive Specific Service', description: '', action_type: 'archive', risk_level: 'high', requires: ['services.details.view'], display_order: 1220 },
  { key: 'services.addon.create', module: 'services', group_label: 'Services / Catalog', label: 'Create Add-on', description: '', action_type: 'create', risk_level: 'medium', requires: ['services.view'], display_order: 1230 },
  { key: 'services.addon.edit', module: 'services', group_label: 'Services / Catalog', label: 'Edit Add-on', description: '', action_type: 'edit', risk_level: 'medium', requires: ['services.details.view'], display_order: 1240 },
  { key: 'services.addon.archive', module: 'services', group_label: 'Services / Catalog', label: 'Archive Add-on', description: '', action_type: 'archive', risk_level: 'high', requires: ['services.details.view'], display_order: 1250 },
  { key: 'services.pricing.edit', module: 'services', group_label: 'Services / Catalog', label: 'Edit Service Pricing', description: '', action_type: 'edit', risk_level: 'high', requires: ['services.details.view'], display_order: 1260 },
  { key: 'services.details.edit', module: 'services', group_label: 'Services / Catalog', label: 'Edit Service Inclusions / Exclusions', description: '', action_type: 'edit', risk_level: 'medium', requires: ['services.details.view'], display_order: 1270 },
  { key: 'services.customer_visibility.edit', module: 'services', group_label: 'Services / Catalog', label: 'Edit Customer Visibility', description: '', action_type: 'edit', risk_level: 'medium', requires: ['services.details.view'], display_order: 1280 },
  { key: 'services.provider_visibility.edit', module: 'services', group_label: 'Services / Catalog', label: 'Edit Provider Visibility', description: '', action_type: 'edit', risk_level: 'medium', requires: ['services.details.view'], display_order: 1290 },
  { key: 'services.compatibility_preview.run', module: 'services', group_label: 'Services / Catalog', label: 'Run Compatibility Preview', description: '', action_type: 'view', risk_level: 'low', requires: ['services.details.view'], display_order: 1300 },
  { key: 'services.publish', module: 'services', group_label: 'Services / Catalog', label: 'Publish Service', description: 'Make service visible to customers', action_type: 'system', risk_level: 'critical', requires: ['services.details.view', 'services.compatibility_preview.run'], display_order: 1310 },
  { key: 'services.archive', module: 'services', group_label: 'Services / Catalog', label: 'Archive Service', description: '', action_type: 'archive', risk_level: 'high', requires: ['services.details.view'], display_order: 1320 },
  { key: 'services.reactivate', module: 'services', group_label: 'Services / Catalog', label: 'Reactivate Service', description: '', action_type: 'restore', risk_level: 'high', requires: ['services.details.view'], display_order: 1330 },
  { key: 'services.export', module: 'services', group_label: 'Services / Catalog', label: 'Export Services Catalog', description: '', action_type: 'export', risk_level: 'low', requires: ['services.view'], display_order: 1340 },

  // Customers
  { key: 'customers.view', module: 'customers', group_label: 'Customers', label: 'View Customers', description: '', action_type: 'view', risk_level: 'low', requires: [], display_order: 1400 },
  { key: 'customers.details.view', module: 'customers', group_label: 'Customers', label: 'View Customer Details', description: '', action_type: 'view', risk_level: 'low', requires: ['customers.view'], display_order: 1410 },
  { key: 'customers.search', module: 'customers', group_label: 'Customers', label: 'Search and Filter Customers', description: '', action_type: 'view', risk_level: 'low', requires: ['customers.view'], display_order: 1420 },
  { key: 'customers.bookings.view', module: 'customers', group_label: 'Customers', label: 'View Customer Bookings', description: '', action_type: 'view', risk_level: 'low', requires: ['customers.details.view'], display_order: 1430 },
  { key: 'customers.payments.view', module: 'customers', group_label: 'Customers', label: 'View Customer Payment History', description: '', action_type: 'sensitive', risk_level: 'medium', requires: ['customers.details.view'], display_order: 1440 },
  { key: 'customers.addresses.view', module: 'customers', group_label: 'Customers', label: 'View Customer Addresses', description: '', action_type: 'sensitive', risk_level: 'medium', requires: ['customers.details.view'], display_order: 1450 },
  { key: 'customers.profile.edit', module: 'customers', group_label: 'Customers', label: 'Edit Customer Profile', description: '', action_type: 'edit', risk_level: 'high', requires: ['customers.details.view'], display_order: 1460 },
  { key: 'customers.archive', module: 'customers', group_label: 'Customers', label: 'Archive Customer', description: '', action_type: 'archive', risk_level: 'critical', requires: ['customers.details.view'], is_dangerous: true, display_order: 1470 },
  { key: 'customers.restore', module: 'customers', group_label: 'Customers', label: 'Restore Customer', description: '', action_type: 'restore', risk_level: 'high', requires: ['customers.details.view'], display_order: 1480 },
  { key: 'customers.notes.add', module: 'customers', group_label: 'Customers', label: 'Add Internal Customer Notes', description: '', action_type: 'create', risk_level: 'low', requires: ['customers.details.view'], display_order: 1490 },
  { key: 'customers.export', module: 'customers', group_label: 'Customers', label: 'Export Customers', description: '', action_type: 'export', risk_level: 'medium', requires: ['customers.view'], display_order: 1500 },

  // Guest Customer Management (C10)
  { key: 'customers.read', module: 'customers', group_label: 'Customers', label: 'Read All Customers (Clients + Guests)', description: 'Access the unified customer list and metrics', action_type: 'view', risk_level: 'low', requires: [], display_order: 1505 },
  { key: 'customers.read_clients', module: 'customers', group_label: 'Customers', label: 'Read Client Customers', description: 'View registered client accounts (role 3)', action_type: 'view', risk_level: 'low', requires: ['customers.read'], display_order: 1506 },
  { key: 'customers.read_guests', module: 'customers', group_label: 'Customers', label: 'Read Guest Customers', description: 'View guest customer profiles and their bookings', action_type: 'view', risk_level: 'low', requires: ['customers.read'], display_order: 1507 },
  { key: 'customers.edit_guest', module: 'customers', group_label: 'Customers', label: 'Edit Guest Customer Profile', description: 'Update guest name, email, source channel, notes', action_type: 'edit', risk_level: 'medium', requires: ['customers.read_guests'], display_order: 1508 },
  { key: 'customers.link_guest_client', module: 'customers', group_label: 'Customers', label: 'Link Guest to Client Account', description: 'Permanently link a guest identity to a registered client', action_type: 'override', risk_level: 'high', requires: ['customers.read_guests', 'customers.read_clients'], display_order: 1509 },

  // Users
  { key: 'users.view', module: 'users', group_label: 'All Users / User Accounts', label: 'View All Users', description: '', action_type: 'view', risk_level: 'low', requires: [], display_order: 1550 },
  { key: 'users.details.view', module: 'users', group_label: 'All Users / User Accounts', label: 'View User Details', description: '', action_type: 'view', risk_level: 'low', requires: ['users.view'], display_order: 1560 },
  { key: 'users.create', module: 'users', group_label: 'All Users / User Accounts', label: 'Create User', description: '', action_type: 'create', risk_level: 'high', requires: ['users.view'], display_order: 1570 },
  { key: 'users.edit', module: 'users', group_label: 'All Users / User Accounts', label: 'Edit User', description: '', action_type: 'edit', risk_level: 'high', requires: ['users.details.view'], display_order: 1580 },
  { key: 'users.status.change', module: 'users', group_label: 'All Users / User Accounts', label: 'Change User Account Status', description: '', action_type: 'edit', risk_level: 'high', requires: ['users.details.view'], display_order: 1590 },
  { key: 'users.archive', module: 'users', group_label: 'All Users / User Accounts', label: 'Archive User', description: '', action_type: 'archive', risk_level: 'critical', requires: ['users.details.view'], is_dangerous: true, display_order: 1600 },
  { key: 'users.restore', module: 'users', group_label: 'All Users / User Accounts', label: 'Restore User', description: '', action_type: 'restore', risk_level: 'high', requires: ['users.details.view'], display_order: 1610 },
  { key: 'users.activity.view', module: 'users', group_label: 'All Users / User Accounts', label: 'View User Activity', description: '', action_type: 'sensitive', risk_level: 'medium', requires: ['users.details.view'], display_order: 1620 },
  { key: 'users.export', module: 'users', group_label: 'All Users / User Accounts', label: 'Export Users', description: '', action_type: 'export', risk_level: 'medium', requires: ['users.view'], display_order: 1630 },

  // Finance / Payments
  { key: 'finance.dashboard.view', module: 'finance', group_label: 'Payments / Finance', label: 'View Finance Dashboard', description: '', action_type: 'view', risk_level: 'low', requires: [], display_order: 1700 },
  { key: 'payments.view', module: 'finance', group_label: 'Payments / Finance', label: 'View Payments', description: '', action_type: 'view', risk_level: 'low', requires: ['finance.dashboard.view'], display_order: 1710 },
  { key: 'payments.details.view', module: 'finance', group_label: 'Payments / Finance', label: 'View Payment Details', description: '', action_type: 'sensitive', risk_level: 'medium', requires: ['payments.view'], display_order: 1720 },
  { key: 'payments.gcash_review.view', module: 'finance', group_label: 'Payments / Finance', label: 'View GCash Review Queue', description: '', action_type: 'view', risk_level: 'low', requires: ['payments.view'], display_order: 1730 },
  { key: 'payments.gcash.approve', module: 'finance', group_label: 'Payments / Finance', label: 'Approve GCash Payment', description: '', action_type: 'approve', risk_level: 'critical', requires: ['payments.view', 'payments.gcash_review.view'], display_order: 1740 },
  { key: 'payments.gcash.reject', module: 'finance', group_label: 'Payments / Finance', label: 'Reject GCash Payment', description: '', action_type: 'reject', risk_level: 'critical', requires: ['payments.view', 'payments.gcash_review.view'], display_order: 1750 },
  { key: 'payments.cash.mark_paid', module: 'finance', group_label: 'Payments / Finance', label: 'Mark Cash Payment as Paid', description: '', action_type: 'approve', risk_level: 'high', requires: ['payments.view'], display_order: 1760 },
  { key: 'payments.paymongo.retry', module: 'finance', group_label: 'Payments / Finance', label: 'Retry Failed PayMongo Payment', description: '', action_type: 'override', risk_level: 'high', requires: ['payments.view'], display_order: 1770 },
  { key: 'payments.paymongo.details.view', module: 'finance', group_label: 'Payments / Finance', label: 'View PayMongo Payment Details', description: '', action_type: 'sensitive', risk_level: 'medium', requires: ['payments.details.view'], display_order: 1780 },
  { key: 'refunds.review.open', module: 'finance', group_label: 'Payments / Finance', label: 'Open Refund Review', description: '', action_type: 'create', risk_level: 'high', requires: ['payments.view'], display_order: 1790 },
  { key: 'refunds.approve', module: 'finance', group_label: 'Payments / Finance', label: 'Approve Refund', description: '', action_type: 'approve', risk_level: 'critical', requires: ['refunds.review.open'], display_order: 1800 },
  { key: 'refunds.reject', module: 'finance', group_label: 'Payments / Finance', label: 'Reject Refund', description: '', action_type: 'reject', risk_level: 'high', requires: ['refunds.review.open'], display_order: 1810 },
  { key: 'refunds.mark_processed', module: 'finance', group_label: 'Payments / Finance', label: 'Mark Refund Processed', description: '', action_type: 'edit', risk_level: 'high', requires: ['refunds.approve'], display_order: 1820 },
  { key: 'revenue_ledger.view', module: 'finance', group_label: 'Payments / Finance', label: 'View Revenue Ledger', description: '', action_type: 'sensitive', risk_level: 'medium', requires: ['finance.dashboard.view'], display_order: 1830 },
  { key: 'internal_fixer_revenue.view', module: 'finance', group_label: 'Payments / Finance', label: 'View Internal Fixer Revenue', description: '', action_type: 'sensitive', risk_level: 'medium', requires: ['revenue_ledger.view'], display_order: 1840 },
  { key: 'payment_exceptions.view', module: 'finance', group_label: 'Payments / Finance', label: 'View Payment Exceptions', description: '', action_type: 'view', risk_level: 'low', requires: ['payments.view'], display_order: 1850 },
  { key: 'payment_exceptions.resolve', module: 'finance', group_label: 'Payments / Finance', label: 'Resolve Payment Exception', description: '', action_type: 'override', risk_level: 'high', requires: ['payment_exceptions.view'], display_order: 1860 },
  { key: 'payments.export', module: 'finance', group_label: 'Payments / Finance', label: 'Export Payments', description: '', action_type: 'export', risk_level: 'medium', requires: ['payments.view'], display_order: 1870 },
  { key: 'revenue_ledger.export', module: 'finance', group_label: 'Payments / Finance', label: 'Export Revenue Ledger', description: '', action_type: 'export', risk_level: 'medium', requires: ['revenue_ledger.view'], display_order: 1880 },

  // Payouts
  { key: 'payouts.view', module: 'payouts', group_label: 'Payouts / Disbursements', label: 'View Payouts', description: '', action_type: 'view', risk_level: 'low', requires: ['finance.dashboard.view'], display_order: 1950 },
  { key: 'payouts.details.view', module: 'payouts', group_label: 'Payouts / Disbursements', label: 'View Payout Details', description: '', action_type: 'sensitive', risk_level: 'medium', requires: ['payouts.view'], display_order: 1960 },
  { key: 'payouts.provider_history.view', module: 'payouts', group_label: 'Payouts / Disbursements', label: 'View Provider Payout History', description: '', action_type: 'sensitive', risk_level: 'medium', requires: ['payouts.details.view'], display_order: 1970 },
  { key: 'payouts.retry_failed', module: 'payouts', group_label: 'Payouts / Disbursements', label: 'Retry Failed Payout', description: '', action_type: 'override', risk_level: 'critical', requires: ['payouts.view', 'payouts.details.view'], display_order: 1980 },
  { key: 'payouts.hold', module: 'payouts', group_label: 'Payouts / Disbursements', label: 'Put Payout on Hold', description: '', action_type: 'override', risk_level: 'high', requires: ['payouts.details.view'], display_order: 1990 },
  { key: 'payouts.release_hold', module: 'payouts', group_label: 'Payouts / Disbursements', label: 'Release Payout Hold', description: '', action_type: 'override', risk_level: 'high', requires: ['payouts.details.view'], display_order: 2000 },
  { key: 'payouts.trigger_due_run', module: 'payouts', group_label: 'Payouts / Disbursements', label: 'Trigger Due Payout Run', description: '', action_type: 'system', risk_level: 'critical', requires: ['payouts.view'], is_dangerous: true, display_order: 2010 },
  { key: 'payouts.missing_method_queue.view', module: 'payouts', group_label: 'Payouts / Disbursements', label: 'View Missing Payout Method Queue', description: '', action_type: 'view', risk_level: 'low', requires: ['payouts.view'], display_order: 2020 },
  { key: 'payouts.failed_queue.view', module: 'payouts', group_label: 'Payouts / Disbursements', label: 'View Failed Payout Queue', description: '', action_type: 'view', risk_level: 'low', requires: ['payouts.view'], display_order: 2030 },
  { key: 'payouts.exceptions.resolve', module: 'payouts', group_label: 'Payouts / Disbursements', label: 'Resolve Payout Exception', description: '', action_type: 'override', risk_level: 'high', requires: ['payouts.view'], display_order: 2040 },
  { key: 'payouts.export', module: 'payouts', group_label: 'Payouts / Disbursements', label: 'Export Payouts', description: '', action_type: 'export', risk_level: 'medium', requires: ['payouts.view'], display_order: 2050 },

  // Reconciliation
  { key: 'reconciliation.view', module: 'reconciliation', group_label: 'Reconciliation', label: 'View Reconciliation Center', description: '', action_type: 'view', risk_level: 'low', requires: ['finance.dashboard.view'], display_order: 2100 },
  { key: 'reconciliation.run', module: 'reconciliation', group_label: 'Reconciliation', label: 'Run Reconciliation Check', description: '', action_type: 'system', risk_level: 'high', requires: ['reconciliation.view'], display_order: 2110 },
  { key: 'reconciliation.exception_details.view', module: 'reconciliation', group_label: 'Reconciliation', label: 'View Reconciliation Exception Details', description: '', action_type: 'view', risk_level: 'low', requires: ['reconciliation.view'], display_order: 2120 },
  { key: 'reconciliation.exception.resolve', module: 'reconciliation', group_label: 'Reconciliation', label: 'Resolve Reconciliation Exception', description: '', action_type: 'override', risk_level: 'high', requires: ['reconciliation.exception_details.view'], display_order: 2130 },
  { key: 'reconciliation.exception.ignore', module: 'reconciliation', group_label: 'Reconciliation', label: 'Ignore Reconciliation Exception', description: '', action_type: 'override', risk_level: 'high', requires: ['reconciliation.exception_details.view'], display_order: 2140 },
  { key: 'reconciliation.related_booking.open', module: 'reconciliation', group_label: 'Reconciliation', label: 'Open Related Booking from Exception', description: '', action_type: 'view', risk_level: 'low', requires: ['reconciliation.view', 'bookings.details.view'], display_order: 2150 },
  { key: 'reconciliation.related_payment.open', module: 'reconciliation', group_label: 'Reconciliation', label: 'Open Related Payment from Exception', description: '', action_type: 'view', risk_level: 'low', requires: ['reconciliation.view', 'payments.details.view'], display_order: 2160 },
  { key: 'reconciliation.related_payout.open', module: 'reconciliation', group_label: 'Reconciliation', label: 'Open Related Payout from Exception', description: '', action_type: 'view', risk_level: 'low', requires: ['reconciliation.view', 'payouts.details.view'], display_order: 2170 },
  { key: 'reconciliation.export', module: 'reconciliation', group_label: 'Reconciliation', label: 'Export Reconciliation Report', description: '', action_type: 'export', risk_level: 'medium', requires: ['reconciliation.view'], display_order: 2180 },

  // Communications
  { key: 'communications.view', module: 'communications', group_label: 'Communications / Notifications', label: 'View Communications Center', description: '', action_type: 'view', risk_level: 'low', requires: [], display_order: 2200 },
  { key: 'communications.notification_logs.view', module: 'communications', group_label: 'Communications / Notifications', label: 'View Notification Logs', description: '', action_type: 'view', risk_level: 'low', requires: ['communications.view'], display_order: 2210 },
  { key: 'communications.details.view', module: 'communications', group_label: 'Communications / Notifications', label: 'View Communication Details', description: '', action_type: 'view', risk_level: 'low', requires: ['communications.view'], display_order: 2220 },
  { key: 'communications.failed_queue.view', module: 'communications', group_label: 'Communications / Notifications', label: 'View Failed Notification Queue', description: '', action_type: 'view', risk_level: 'low', requires: ['communications.view'], display_order: 2230 },
  { key: 'communications.retry_failed', module: 'communications', group_label: 'Communications / Notifications', label: 'Retry Failed Notification', description: '', action_type: 'override', risk_level: 'medium', requires: ['communications.details.view'], display_order: 2240 },
  { key: 'communications.bulk_retry_failed', module: 'communications', group_label: 'Communications / Notifications', label: 'Bulk Retry Failed Notifications', description: '', action_type: 'override', risk_level: 'high', requires: ['communications.retry_failed'], display_order: 2250 },
  { key: 'communications.templates.view', module: 'communications', group_label: 'Communications / Notifications', label: 'View Notification Templates', description: '', action_type: 'view', risk_level: 'low', requires: ['communications.view'], display_order: 2260 },
  { key: 'communications.templates.create', module: 'communications', group_label: 'Communications / Notifications', label: 'Create Notification Template', description: '', action_type: 'create', risk_level: 'medium', requires: ['communications.templates.view'], display_order: 2270 },
  { key: 'communications.templates.edit', module: 'communications', group_label: 'Communications / Notifications', label: 'Edit Notification Template', description: '', action_type: 'edit', risk_level: 'medium', requires: ['communications.templates.view'], display_order: 2280 },
  { key: 'communications.templates.archive', module: 'communications', group_label: 'Communications / Notifications', label: 'Archive Notification Template', description: '', action_type: 'archive', risk_level: 'high', requires: ['communications.templates.view'], display_order: 2290 },
  { key: 'communications.templates.activate', module: 'communications', group_label: 'Communications / Notifications', label: 'Activate Notification Template', description: '', action_type: 'edit', risk_level: 'medium', requires: ['communications.templates.view'], display_order: 2300 },
  { key: 'communications.templates.preview', module: 'communications', group_label: 'Communications / Notifications', label: 'Preview Notification Template', description: '', action_type: 'view', risk_level: 'low', requires: ['communications.templates.view'], display_order: 2310 },
  { key: 'communications.manual_send', module: 'communications', group_label: 'Communications / Notifications', label: 'Send Manual Communication', description: 'Send a notification manually to users', action_type: 'system', risk_level: 'critical', requires: ['communications.view'], is_dangerous: true, display_order: 2320 },
  { key: 'communications.support_conversations.view', module: 'communications', group_label: 'Communications / Notifications', label: 'View Support Conversations', description: '', action_type: 'view', risk_level: 'low', requires: ['communications.view'], display_order: 2330 },
  { key: 'communications.support_conversations.escalate', module: 'communications', group_label: 'Communications / Notifications', label: 'Escalate Support Conversation', description: '', action_type: 'edit', risk_level: 'medium', requires: ['communications.support_conversations.view'], display_order: 2340 },
  { key: 'communications.export', module: 'communications', group_label: 'Communications / Notifications', label: 'Export Communication Logs', description: '', action_type: 'export', risk_level: 'medium', requires: ['communications.view'], display_order: 2350 },

  // Audit logs
  { key: 'audit_logs.view', module: 'audit_logs', group_label: 'Audit Logs', label: 'View Audit Logs', description: '', action_type: 'view', risk_level: 'low', requires: [], display_order: 2400 },
  { key: 'audit_logs.details.view', module: 'audit_logs', group_label: 'Audit Logs', label: 'View Audit Event Details', description: '', action_type: 'view', risk_level: 'low', requires: ['audit_logs.view'], display_order: 2410 },
  { key: 'audit_logs.search', module: 'audit_logs', group_label: 'Audit Logs', label: 'Search and Filter Audit Logs', description: '', action_type: 'view', risk_level: 'low', requires: ['audit_logs.view'], display_order: 2420 },
  { key: 'audit_logs.entity_timeline.view', module: 'audit_logs', group_label: 'Audit Logs', label: 'View Entity Audit Timeline', description: '', action_type: 'view', risk_level: 'low', requires: ['audit_logs.view'], display_order: 2430 },
  { key: 'audit_logs.actor_history.view', module: 'audit_logs', group_label: 'Audit Logs', label: 'View Actor History', description: '', action_type: 'view', risk_level: 'low', requires: ['audit_logs.view'], display_order: 2440 },
  { key: 'audit_logs.sensitive_fields.view', module: 'audit_logs', group_label: 'Audit Logs', label: 'View Sensitive Audit Fields', description: '', action_type: 'sensitive', risk_level: 'high', requires: ['audit_logs.details.view'], display_order: 2450 },
  { key: 'audit_logs.export', module: 'audit_logs', group_label: 'Audit Logs', label: 'Export Audit Logs', description: '', action_type: 'export', risk_level: 'high', requires: ['audit_logs.view'], display_order: 2460 },

  // Reports
  { key: 'reports.view', module: 'reports', group_label: 'Reports and Exports', label: 'View Reports', description: '', action_type: 'view', risk_level: 'low', requires: [], display_order: 2500 },
  { key: 'reports.bookings.export', module: 'reports', group_label: 'Reports and Exports', label: 'Export Booking Reports', description: '', action_type: 'export', risk_level: 'medium', requires: ['reports.view', 'bookings.view'], display_order: 2510 },
  { key: 'reports.providers.export', module: 'reports', group_label: 'Reports and Exports', label: 'Export Provider Reports', description: '', action_type: 'export', risk_level: 'medium', requires: ['reports.view', 'providers.view'], display_order: 2520 },
  { key: 'reports.customers.export', module: 'reports', group_label: 'Reports and Exports', label: 'Export Customer Reports', description: '', action_type: 'export', risk_level: 'medium', requires: ['reports.view', 'customers.view'], display_order: 2530 },
  { key: 'reports.finance.export', module: 'reports', group_label: 'Reports and Exports', label: 'Export Finance Reports', description: '', action_type: 'export', risk_level: 'medium', requires: ['reports.view', 'finance.dashboard.view'], display_order: 2540 },
  { key: 'reports.audit.export', module: 'reports', group_label: 'Reports and Exports', label: 'Export Audit Reports', description: '', action_type: 'export', risk_level: 'high', requires: ['reports.view', 'audit_logs.view'], display_order: 2550 },
  { key: 'reports.service_catalog.export', module: 'reports', group_label: 'Reports and Exports', label: 'Export Service Catalog Reports', description: '', action_type: 'export', risk_level: 'low', requires: ['reports.view', 'services.view'], display_order: 2560 },
  { key: 'reports.reconciliation.export', module: 'reports', group_label: 'Reports and Exports', label: 'Export Reconciliation Reports', description: '', action_type: 'export', risk_level: 'medium', requires: ['reports.view', 'reconciliation.view'], display_order: 2570 },

  // Admin users and permissions
  { key: 'admin_users.view', module: 'admin_users', group_label: 'Admin Users and Permissions', label: 'View Admin Users', description: '', action_type: 'view', risk_level: 'low', requires: [], display_order: 2600 },
  { key: 'admin_users.create', module: 'admin_users', group_label: 'Admin Users and Permissions', label: 'Create Admin User', description: '', action_type: 'create', risk_level: 'critical', requires: ['admin_users.view'], display_order: 2610 },
  { key: 'admin_users.edit', module: 'admin_users', group_label: 'Admin Users and Permissions', label: 'Edit Admin User', description: '', action_type: 'edit', risk_level: 'high', requires: ['admin_users.view'], display_order: 2620 },
  { key: 'admin_users.deactivate', module: 'admin_users', group_label: 'Admin Users and Permissions', label: 'Deactivate Admin User', description: '', action_type: 'override', risk_level: 'critical', requires: ['admin_users.view'], display_order: 2630 },
  { key: 'admin_users.reactivate', module: 'admin_users', group_label: 'Admin Users and Permissions', label: 'Reactivate Admin User', description: '', action_type: 'restore', risk_level: 'high', requires: ['admin_users.view'], display_order: 2640 },
  { key: 'admin_permissions.view', module: 'admin_users', group_label: 'Admin Users and Permissions', label: 'View Admin Permissions', description: '', action_type: 'view', risk_level: 'low', requires: ['admin_users.view'], display_order: 2650 },
  { key: 'admin_permissions.edit', module: 'admin_users', group_label: 'Admin Users and Permissions', label: 'Edit Admin Permissions', description: 'Grant or revoke permissions for admin users', action_type: 'system', risk_level: 'critical', requires: ['admin_permissions.view', 'admin_users.view'], display_order: 2660 },
  { key: 'admin_permissions.grant_super_admin', module: 'admin_users', group_label: 'Admin Users and Permissions', label: 'Grant Super Admin Access', description: '', action_type: 'system', risk_level: 'critical', requires: ['admin_permissions.edit'], is_dangerous: true, display_order: 2670 },
  { key: 'admin_permissions.revoke_super_admin', module: 'admin_users', group_label: 'Admin Users and Permissions', label: 'Revoke Super Admin Access', description: '', action_type: 'system', risk_level: 'critical', requires: ['admin_permissions.edit'], is_dangerous: true, display_order: 2680 },
  { key: 'admin_login_history.view', module: 'admin_users', group_label: 'Admin Users and Permissions', label: 'View Admin Login History', description: '', action_type: 'view', risk_level: 'medium', requires: ['admin_users.view'], display_order: 2690 },
  { key: 'admin_access.reset', module: 'admin_users', group_label: 'Admin Users and Permissions', label: 'Reset Admin Password / Access', description: '', action_type: 'override', risk_level: 'critical', requires: ['admin_users.edit'], is_dangerous: true, display_order: 2700 },

  // System settings
  { key: 'settings.view', module: 'settings', group_label: 'System Settings', label: 'View Settings', description: '', action_type: 'view', risk_level: 'low', requires: [], display_order: 2750 },
  { key: 'settings.general.edit', module: 'settings', group_label: 'System Settings', label: 'Edit General Settings', description: '', action_type: 'edit', risk_level: 'high', requires: ['settings.view'], display_order: 2760 },
  { key: 'settings.branding.edit', module: 'settings', group_label: 'System Settings', label: 'Edit Appearance / Branding Settings', description: '', action_type: 'edit', risk_level: 'medium', requires: ['settings.view'], display_order: 2770 },
  { key: 'settings.notifications.edit', module: 'settings', group_label: 'System Settings', label: 'Edit Notification Settings', description: '', action_type: 'edit', risk_level: 'medium', requires: ['settings.view'], display_order: 2780 },
  { key: 'settings.payments.edit', module: 'settings', group_label: 'System Settings', label: 'Edit Payment Settings', description: '', action_type: 'edit', risk_level: 'critical', requires: ['settings.view'], display_order: 2790 },
  { key: 'settings.payouts.edit', module: 'settings', group_label: 'System Settings', label: 'Edit Payout Settings', description: '', action_type: 'edit', risk_level: 'critical', requires: ['settings.view'], display_order: 2800 },
  { key: 'settings.service_catalog.edit', module: 'settings', group_label: 'System Settings', label: 'Edit Service Catalog Settings', description: '', action_type: 'edit', risk_level: 'high', requires: ['settings.view'], display_order: 2810 },
  { key: 'settings.branch_slots.edit', module: 'settings', group_label: 'System Settings', label: 'Edit Branch / Slot Settings', description: '', action_type: 'edit', risk_level: 'high', requires: ['settings.view'], display_order: 2820 },
  { key: 'system_health.view', module: 'settings', group_label: 'System Settings', label: 'View System Health', description: '', action_type: 'view', risk_level: 'low', requires: [], display_order: 2830 },
  { key: 'integration_health.view', module: 'settings', group_label: 'System Settings', label: 'View Integration Health', description: '', action_type: 'view', risk_level: 'low', requires: [], display_order: 2840 },

  // Developer / emergency (hidden from normal UI)
  { key: 'developer_diagnostics.view', module: 'developer', group_label: 'Developer / Emergency Controls', label: 'View Developer Diagnostics', description: '', action_type: 'view', risk_level: 'medium', requires: [], is_hidden_from_normal_ui: true, display_order: 2900 },
  { key: 'health_checks.run', module: 'developer', group_label: 'Developer / Emergency Controls', label: 'Run Safe Health Checks', description: '', action_type: 'view', risk_level: 'medium', requires: [], is_hidden_from_normal_ui: true, display_order: 2910 },
  { key: 'data_quality_checks.run', module: 'developer', group_label: 'Developer / Emergency Controls', label: 'Run Data Quality Checks', description: '', action_type: 'view', risk_level: 'high', requires: [], is_hidden_from_normal_ui: true, display_order: 2920 },
  { key: 'backfills.preview', module: 'developer', group_label: 'Developer / Emergency Controls', label: 'Run Backfill Preview', description: '', action_type: 'view', risk_level: 'high', requires: [], is_hidden_from_normal_ui: true, display_order: 2930 },
  { key: 'backfills.apply', module: 'developer', group_label: 'Developer / Emergency Controls', label: 'Run Backfill Apply', description: '', action_type: 'system', risk_level: 'critical', requires: ['backfills.preview'], is_hidden_from_normal_ui: true, is_dangerous: true, display_order: 2940 },
  { key: 'background_jobs.retry_failed', module: 'developer', group_label: 'Developer / Emergency Controls', label: 'Retry Failed Background Jobs', description: '', action_type: 'system', risk_level: 'high', requires: [], is_hidden_from_normal_ui: true, display_order: 2950 },
  { key: 'integration_error_logs.view', module: 'developer', group_label: 'Developer / Emergency Controls', label: 'View Integration Error Logs', description: '', action_type: 'view', risk_level: 'medium', requires: [], is_hidden_from_normal_ui: true, display_order: 2960 },
];

// ── Schema bootstrap ───────────────────────────────────────────────────────────

export async function ensurePermissionSchema(): Promise<void> {
  const s = db.schema;

  // admin_users
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${s}.admin_users (
      admin_uid       TEXT PRIMARY KEY,
      email           TEXT NOT NULL,
      display_name    TEXT,
      is_super_admin  BOOLEAN NOT NULL DEFAULT FALSE,
      account_status  TEXT NOT NULL DEFAULT 'active',
      created_by      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by      TEXT,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deactivated_at  TIMESTAMPTZ,
      version         INTEGER NOT NULL DEFAULT 1
    )
  `);

  // admin_permission_definitions
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${s}.admin_permission_definitions (
      permission_key        TEXT PRIMARY KEY,
      module                TEXT NOT NULL,
      group_label           TEXT NOT NULL,
      label                 TEXT NOT NULL,
      description           TEXT,
      action_type           TEXT NOT NULL,
      risk_level            TEXT NOT NULL DEFAULT 'low',
      requires              JSONB NOT NULL DEFAULT '[]',
      conflicts_with        JSONB NOT NULL DEFAULT '[]',
      is_dangerous          BOOLEAN NOT NULL DEFAULT FALSE,
      is_hidden_from_normal_ui BOOLEAN NOT NULL DEFAULT FALSE,
      is_active             BOOLEAN NOT NULL DEFAULT TRUE,
      display_order         INTEGER NOT NULL DEFAULT 0,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // admin_permission_grants
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${s}.admin_permission_grants (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_uid      TEXT NOT NULL,
      permission_key TEXT NOT NULL,
      granted        BOOLEAN NOT NULL,
      granted_by     TEXT NOT NULL,
      granted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_by     TEXT,
      revoked_at     TIMESTAMPTZ,
      reason         TEXT,
      version        INTEGER NOT NULL DEFAULT 1
    )
  `);
  await dbQuery.query(`CREATE INDEX IF NOT EXISTS idx_perm_grants_uid ON ${s}.admin_permission_grants(admin_uid)`);
  await dbQuery.query(`CREATE INDEX IF NOT EXISTS idx_perm_grants_key ON ${s}.admin_permission_grants(permission_key)`);
  await dbQuery.query(`CREATE INDEX IF NOT EXISTS idx_perm_grants_uid_granted ON ${s}.admin_permission_grants(admin_uid) WHERE revoked_at IS NULL`);

  // admin_permission_events (append-only)
  await dbQuery.query(`
    CREATE TABLE IF NOT EXISTS ${s}.admin_permission_events (
      event_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      target_admin_uid    TEXT NOT NULL,
      actor_admin_uid     TEXT NOT NULL,
      event_type          TEXT NOT NULL,
      added_permissions   JSONB NOT NULL DEFAULT '[]',
      removed_permissions JSONB NOT NULL DEFAULT '[]',
      before_permissions  JSONB,
      after_permissions   JSONB,
      reason              TEXT NOT NULL,
      request_id          TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await dbQuery.query(`CREATE INDEX IF NOT EXISTS idx_perm_events_target ON ${s}.admin_permission_events(target_admin_uid)`);

  // Bootstrap: promote existing role=1 users to Super Admin if no super admins exist
  await dbQuery.query(`
    INSERT INTO ${s}.admin_users (admin_uid, email, display_name, is_super_admin, account_status, created_by)
    SELECT uc.uid,
           COALESCE(uc.email, uc.uid),
           NULLIF(TRIM(COALESCE(uc.first_name,'') || ' ' || COALESCE(uc.last_name,'')), ''),
           TRUE,
           'active',
           'system'
    FROM ${s}.user_credentials uc
    WHERE uc.role = 1
    ON CONFLICT (admin_uid) DO NOTHING
  `);

  // Seed permission definitions (idempotent via ON CONFLICT)
  for (const seed of PERMISSION_SEEDS) {
    await dbQuery.query(
      `INSERT INTO ${s}.admin_permission_definitions
         (permission_key, module, group_label, label, description, action_type, risk_level,
          requires, conflicts_with, is_dangerous, is_hidden_from_normal_ui, display_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (permission_key) DO UPDATE SET
         label       = EXCLUDED.label,
         description = EXCLUDED.description,
         risk_level  = EXCLUDED.risk_level,
         requires    = EXCLUDED.requires,
         display_order = EXCLUDED.display_order,
         updated_at  = NOW()`,
      [
        seed.key, seed.module, seed.group_label, seed.label,
        seed.description ?? '', seed.action_type, seed.risk_level,
        JSON.stringify(seed.requires ?? []),
        JSON.stringify(seed.conflicts_with ?? []),
        seed.is_dangerous ?? false,
        seed.is_hidden_from_normal_ui ?? false,
        seed.display_order,
      ]
    );
  }
}

// ── Core lookup helpers ────────────────────────────────────────────────────────

export async function getAdminUser(adminUid: string): Promise<AdminUserRow | null> {
  const res = await dbQuery.query(
    `SELECT * FROM ${s}.admin_users WHERE admin_uid = $1 LIMIT 1`,
    [adminUid]
  );
  return res.rows[0] ?? null;
}

export async function ensureAdminUserRow(adminUid: string): Promise<void> {
  // Look up email from users table; fall back to uid if not found
  const userRes = await dbQuery.query(
    `SELECT email, first_name, last_name FROM ${s}.user_credentials WHERE uid = $1 LIMIT 1`,
    [adminUid]
  );
  const email = userRes.rows[0]?.email ?? adminUid;
  const fn = userRes.rows[0]?.first_name ?? '';
  const ln = userRes.rows[0]?.last_name ?? '';
  const displayName = (fn + ' ' + ln).trim() || null;
  await dbQuery.query(
    `INSERT INTO ${s}.admin_users (admin_uid, email, display_name, is_super_admin, account_status, created_by)
     VALUES ($1, $2, $3, FALSE, 'active', 'system')
     ON CONFLICT (admin_uid) DO NOTHING`,
    [adminUid, email, displayName]
  );
}

export async function isSuperAdmin(adminUid: string): Promise<boolean> {
  const cached = permCache.get(`sa:${adminUid}`);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.perms.includes('__super_admin__');
  }
  const res = await dbQuery.query(
    `SELECT is_super_admin FROM ${s}.admin_users WHERE admin_uid = $1 LIMIT 1`,
    [adminUid]
  );
  const val = res.rows[0]?.is_super_admin === true;
  permCache.set(`sa:${adminUid}`, {
    perms: val ? ['__super_admin__'] : [],
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return val;
}

export async function hasPermission(adminUid: string, key: string): Promise<boolean> {
  // Super Admins always pass
  if (await isSuperAdmin(adminUid)) return true;

  // Check cache
  const cached = permCache.get(adminUid);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.perms.includes(key);
  }

  // Load grants from DB
  const res = await dbQuery.query(
    `SELECT permission_key FROM ${s}.admin_permission_grants
     WHERE admin_uid = $1 AND granted = TRUE AND revoked_at IS NULL`,
    [adminUid]
  );
  const perms = res.rows.map((r: any) => r.permission_key as string);
  permCache.set(adminUid, { perms, expiresAt: Date.now() + CACHE_TTL_MS });
  return perms.includes(key);
}

export async function getEffectivePermissions(adminUid: string): Promise<AdminEffectivePermissionProfile> {
  const admin = await getAdminUser(adminUid);
  if (!admin) {
    return {
      adminUid, isSuperAdmin: false,
      accountStatus: 'inactive' as AdminAccountStatus,
      permissions: [], deniedPermissions: [],
      generatedAt: new Date().toISOString(), version: 0,
    };
  }
  let permissions: string[] = [];
  if (admin.is_super_admin) {
    // Super Admin effectively holds all permissions
    const defsRes = await dbQuery.query(
      `SELECT permission_key FROM ${s}.admin_permission_definitions WHERE is_active = TRUE`
    );
    permissions = defsRes.rows.map((r: any) => r.permission_key as string);
  } else {
    const res = await dbQuery.query(
      `SELECT permission_key FROM ${s}.admin_permission_grants
       WHERE admin_uid = $1 AND granted = TRUE AND revoked_at IS NULL`,
      [adminUid]
    );
    permissions = res.rows.map((r: any) => r.permission_key as string);
  }
  return {
    adminUid,
    isSuperAdmin: admin.is_super_admin,
    accountStatus: admin.account_status as AdminAccountStatus,
    permissions,
    deniedPermissions: [],
    generatedAt: new Date().toISOString(),
    version: admin.version,
  };
}

// ── Admin user management ──────────────────────────────────────────────────────

export async function listAdminUsers(filter: {
  page?: number; limit?: number; status?: string; search?: string;
} = {}): Promise<{ data: any[]; total: number; page: number; limit: number }> {
  const page  = Math.max(1, filter.page  ?? 1);
  const limit = Math.min(100, Math.max(1, filter.limit ?? 25));
  const offset = (page - 1) * limit;

  const wheres: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  if (filter.status) { wheres.push(`au.account_status = $${p++}`); params.push(filter.status); }
  if (filter.search) {
    wheres.push(`(au.email ILIKE $${p} OR au.display_name ILIKE $${p})`);
    params.push(`%${filter.search}%`); p++;
  }

  const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';

  const countRes = await dbQuery.query(
    `SELECT COUNT(*) FROM ${s}.admin_users au ${where}`, params
  );
  const total = Number(countRes.rows[0]?.count ?? 0);

  const dataRes = await dbQuery.query(
    `SELECT au.*,
       (SELECT COUNT(*) FROM ${s}.admin_permission_grants g
        WHERE g.admin_uid = au.admin_uid AND g.granted = TRUE AND g.revoked_at IS NULL)
         AS permission_count
     FROM ${s}.admin_users au
     ${where}
     ORDER BY au.created_at DESC
     LIMIT $${p} OFFSET $${p + 1}`,
    [...params, limit, offset]
  );

  return { data: dataRes.rows.map(toCamel), total, page, limit };
}

export async function getAdminUserDetail(adminUid: string): Promise<any | null> {
  const res = await dbQuery.query(
    `SELECT au.*,
       (SELECT COUNT(*) FROM ${s}.admin_permission_grants g
        WHERE g.admin_uid = au.admin_uid AND g.granted = TRUE AND g.revoked_at IS NULL)
         AS permission_count
     FROM ${s}.admin_users au
     WHERE au.admin_uid = $1 LIMIT 1`,
    [adminUid]
  );
  return res.rows[0] ? toCamel(res.rows[0]) : null;
}

export async function createAdminUser(
  data: { adminUid: string; email: string; displayName?: string | null; isSuperAdmin?: boolean },
  actorUid: string,
  actorName: string | null,
  requestId: string | null
): Promise<any> {
  const existing = await getAdminUser(data.adminUid);
  if (existing) {
    throw Object.assign(new Error('Admin user already exists'), { code: 'CONFLICT' });
  }

  // Ensure user has role=1 in user_credentials (upsert)
  await dbQuery.query(
    `INSERT INTO ${s}.user_credentials (uid, role) VALUES ($1, 1)
     ON CONFLICT (uid) DO UPDATE SET role = 1`,
    [data.adminUid]
  );

  const res = await dbQuery.query(
    `INSERT INTO ${s}.admin_users (admin_uid, email, display_name, is_super_admin, account_status, created_by)
     VALUES ($1, $2, $3, $4, 'active', $5)
     RETURNING *`,
    [data.adminUid, data.email, data.displayName ?? null, data.isSuperAdmin ?? false, actorUid]
  );

  auditFire({
    actionCategory: 'admin', action: 'admin_user_created',
    entityType: 'admin_user' as any, entityId: data.adminUid,
    actorUid, actorDisplayName: actorName, outcome: 'success',
    metadata: { email: data.email, isSuperAdmin: data.isSuperAdmin ?? false },
    requestId,
  });

  invalidatePermissionCache(data.adminUid);
  invalidatePermissionCache(`sa:${data.adminUid}`);
  return toCamel(res.rows[0]);
}

export async function updateAdminUser(
  adminUid: string,
  data: { displayName?: string | null; email?: string },
  actorUid: string,
  actorName: string | null,
  requestId: string | null
): Promise<any> {
  const existing = await getAdminUser(adminUid);
  if (!existing) throw Object.assign(new Error('Admin user not found'), { code: 'NOT_FOUND' });

  const sets: string[] = ['updated_by = $2', 'updated_at = NOW()', 'version = version + 1'];
  const params: unknown[] = [adminUid, actorUid];
  let p = 3;
  if (data.displayName !== undefined) { sets.push(`display_name = $${p++}`); params.push(data.displayName); }
  if (data.email !== undefined) { sets.push(`email = $${p++}`); params.push(data.email); }

  const res = await dbQuery.query(
    `UPDATE ${s}.admin_users SET ${sets.join(', ')} WHERE admin_uid = $1 RETURNING *`,
    params
  );

  auditFire({
    actionCategory: 'admin', action: 'admin_user_updated',
    entityType: 'admin_user' as any, entityId: adminUid,
    actorUid, actorDisplayName: actorName, outcome: 'success', metadata: data, requestId,
  });

  return toCamel(res.rows[0]);
}

export async function updateAdminUserStatus(
  adminUid: string,
  status: AdminAccountStatus,
  actorUid: string,
  actorName: string | null,
  requestId: string | null
): Promise<void> {
  const existing = await getAdminUser(adminUid);
  if (!existing) throw Object.assign(new Error('Admin user not found'), { code: 'NOT_FOUND' });

  // Guard: cannot deactivate last Super Admin
  if ((status === 'inactive' || status === 'archived') && existing.is_super_admin) {
    await assertAtLeastOneSuperAdmin(adminUid);
  }

  const deactivatedAt = (status === 'inactive' || status === 'archived') ? 'NOW()' : 'NULL';
  await dbQuery.query(
    `UPDATE ${s}.admin_users SET account_status=$2, deactivated_at=${deactivatedAt},
     updated_by=$3, updated_at=NOW(), version=version+1
     WHERE admin_uid=$1`,
    [adminUid, status, actorUid]
  );

  const action = status === 'active' ? 'admin_user_reactivated' : 'admin_user_deactivated';
  auditFire({
    actionCategory: 'admin', action,
    entityType: 'admin_user' as any, entityId: adminUid,
    actorUid, actorDisplayName: actorName, outcome: 'success', metadata: { status }, requestId,
  });

  invalidatePermissionCache(adminUid);
  invalidatePermissionCache(`sa:${adminUid}`);
}

// ── Permission definitions ─────────────────────────────────────────────────────

export async function getPermissionDefinitions(): Promise<{
  groups: Array<{ module: string; groupLabel: string; permissions: AdminPermissionDefinitionRow[] }>;
  total: number;
}> {
  const res = await dbQuery.query(
    `SELECT permission_key AS key, module, group_label AS "groupLabel", label, description,
            action_type AS "actionType", risk_level AS "riskLevel",
            requires, conflicts_with AS "conflictsWith",
            is_dangerous AS "isDangerous",
            is_hidden_from_normal_ui AS "isHiddenFromNormalUi",
            display_order AS "displayOrder"
     FROM ${s}.admin_permission_definitions
     WHERE is_active = TRUE
     ORDER BY display_order ASC`
  );

  const allPerms: AdminPermissionDefinitionRow[] = res.rows.map((r: any) => ({
    ...r,
    requires: Array.isArray(r.requires) ? r.requires : [],
    conflictsWith: Array.isArray(r.conflictsWith) ? r.conflictsWith : [],
  }));

  // Group by groupLabel in order
  const groupMap = new Map<string, { module: string; groupLabel: string; permissions: AdminPermissionDefinitionRow[] }>();
  for (const perm of allPerms) {
    if (!groupMap.has(perm.groupLabel)) {
      groupMap.set(perm.groupLabel, { module: perm.module, groupLabel: perm.groupLabel, permissions: [] });
    }
    groupMap.get(perm.groupLabel)!.permissions.push(perm);
  }

  return { groups: Array.from(groupMap.values()), total: allPerms.length };
}

// ── Admin user permission management ──────────────────────────────────────────

export async function getAdminUserPermissions(adminUid: string): Promise<{
  adminUid: string; isSuperAdmin: boolean; accountStatus: string; permissions: string[]; generatedAt: string;
}> {
  const admin = await getAdminUser(adminUid);
  if (!admin) throw Object.assign(new Error('Admin user not found'), { code: 'NOT_FOUND' });

  if (admin.is_super_admin) {
    const defsRes = await dbQuery.query(
      `SELECT permission_key FROM ${s}.admin_permission_definitions WHERE is_active = TRUE`
    );
    return {
      adminUid, isSuperAdmin: true,
      accountStatus: admin.account_status,
      permissions: defsRes.rows.map((r: any) => r.permission_key as string),
      generatedAt: new Date().toISOString(),
    };
  }

  const res = await dbQuery.query(
    `SELECT permission_key FROM ${s}.admin_permission_grants
     WHERE admin_uid = $1 AND granted = TRUE AND revoked_at IS NULL`,
    [adminUid]
  );
  return {
    adminUid, isSuperAdmin: false,
    accountStatus: admin.account_status,
    permissions: res.rows.map((r: any) => r.permission_key as string),
    generatedAt: new Date().toISOString(),
  };
}

// Resolve permission dependencies: auto-add required parent keys
export function resolvePermissionDependencies(
  keys: string[],
  allDefs: AdminPermissionDefinitionRow[]
): { resolved: string[]; added: string[] } {
  const defMap = new Map(allDefs.map(d => [d.key, d]));
  const resolved = new Set(keys);
  const added: string[] = [];

  // BFS to resolve all required parents
  const queue = [...keys];
  while (queue.length > 0) {
    const key = queue.shift()!;
    const def = defMap.get(key);
    if (!def) continue;
    for (const req of def.requires) {
      if (!resolved.has(req)) {
        resolved.add(req);
        added.push(req);
        queue.push(req);
      }
    }
  }

  return { resolved: Array.from(resolved), added };
}

export async function previewPermissionChange(
  adminUid: string,
  proposedKeys: string[]
): Promise<{
  adminUid: string; current: string[]; proposed: string[];
  toAdd: string[]; toRemove: string[];
  dependenciesAdded: string[];
  highRiskPermissions: string[]; criticalPermissions: string[];
  warnings: string[];
  isValid: boolean; validationErrors: string[];
}> {
  const admin = await getAdminUser(adminUid);
  if (!admin) throw Object.assign(new Error('Admin user not found'), { code: 'NOT_FOUND' });

  const currentRes = await dbQuery.query(
    `SELECT permission_key FROM ${s}.admin_permission_grants
     WHERE admin_uid = $1 AND granted = TRUE AND revoked_at IS NULL`,
    [adminUid]
  );
  const current = currentRes.rows.map((r: any) => r.permission_key as string);
  const defsRes = await dbQuery.query(
    `SELECT permission_key AS key, group_label AS "groupLabel", label, risk_level AS "riskLevel",
            requires, is_dangerous AS "isDangerous", action_type AS "actionType",
            conflicts_with AS "conflictsWith", module, description,
            is_hidden_from_normal_ui AS "isHiddenFromNormalUi", display_order AS "displayOrder"
     FROM ${s}.admin_permission_definitions WHERE is_active = TRUE`
  );
  const allDefs: AdminPermissionDefinitionRow[] = defsRes.rows.map((r: any) => ({
    ...r,
    requires: Array.isArray(r.requires) ? r.requires : [],
    conflictsWith: Array.isArray(r.conflictsWith) ? r.conflictsWith : [],
  }));

  const { resolved: proposedResolved, added: dependenciesAdded } = resolvePermissionDependencies(proposedKeys, allDefs);
  const defMap = new Map(allDefs.map(d => [d.key, d]));

  const currentSet = new Set(current);
  const proposedSet = new Set(proposedResolved);
  const toAdd    = proposedResolved.filter((k: string) => !currentSet.has(k));
  const toRemove = current.filter((k: string) => !proposedSet.has(k));

  const highRiskPermissions = proposedResolved.filter(k => {
    const d = defMap.get(k);
    return d?.riskLevel === 'high' || d?.riskLevel === 'critical';
  });
  const criticalPermissions = proposedResolved.filter(k => defMap.get(k)?.riskLevel === 'critical');

  const warnings: string[] = [];
  if (criticalPermissions.length > 0) {
    warnings.push(`${criticalPermissions.length} critical permission(s) selected`);
  }
  if (proposedResolved.some(k => defMap.get(k)?.isDangerous)) {
    warnings.push('One or more dangerous permissions selected');
  }
  if (admin.is_super_admin && proposedKeys.length === 0) {
    warnings.push('Cannot remove all permissions from a Super Admin');
  }

  return {
    adminUid, current, proposed: proposedResolved,
    toAdd, toRemove, dependenciesAdded,
    highRiskPermissions, criticalPermissions,
    warnings, isValid: true, validationErrors: [],
  };
}

export async function updateAdminUserPermissions(
  adminUid: string,
  permissions: string[],
  reason: string,
  actorUid: string,
  actorName: string | null,
  requestId: string | null
): Promise<{ adminUid: string; savedPermissions: string[]; changesApplied: number }> {
  if (!reason?.trim()) {
    throw Object.assign(new Error('Reason is required for permission changes'), { code: 'BUSINESS_RULE' });
  }

  const admin = await getAdminUser(adminUid);
  if (!admin) throw Object.assign(new Error('Admin user not found'), { code: 'NOT_FOUND' });

  // Only Super Admins can edit permissions
  const actorIsSuperAdmin = await isSuperAdmin(actorUid);
  if (!actorIsSuperAdmin) {
    throw Object.assign(new Error('Only Super Admins can edit permissions'), { code: 'FORBIDDEN' });
  }

  // Resolve dependencies
  const defsRes = await dbQuery.query(
    `SELECT permission_key AS key, group_label AS "groupLabel", label, risk_level AS "riskLevel",
            requires, is_dangerous AS "isDangerous", action_type AS "actionType",
            conflicts_with AS "conflictsWith", module, description,
            is_hidden_from_normal_ui AS "isHiddenFromNormalUi", display_order AS "displayOrder"
     FROM ${s}.admin_permission_definitions WHERE is_active = TRUE`
  );
  const allDefs: AdminPermissionDefinitionRow[] = defsRes.rows.map((r: any) => ({
    ...r,
    requires: Array.isArray(r.requires) ? r.requires : [],
    conflictsWith: Array.isArray(r.conflictsWith) ? r.conflictsWith : [],
  }));
  const { resolved } = resolvePermissionDependencies(permissions, allDefs);

  // Get current permissions before change (for audit)
  const beforeRes = await dbQuery.query(
    `SELECT permission_key FROM ${s}.admin_permission_grants
     WHERE admin_uid = $1 AND granted = TRUE AND revoked_at IS NULL`,
    [adminUid]
  );
  const before = beforeRes.rows.map((r: any) => r.permission_key as string);
  const beforeSet = new Set(before);
  const resolvedSet = new Set(resolved);

  const toAdd    = resolved.filter((k: string) => !beforeSet.has(k));
  const toRemove = before.filter((k: string) => !resolvedSet.has(k));

  // Revoke removed permissions
  if (toRemove.length > 0) {
    await dbQuery.query(
      `UPDATE ${s}.admin_permission_grants
       SET revoked_by=$2, revoked_at=NOW()
       WHERE admin_uid=$1 AND revoked_at IS NULL
         AND permission_key = ANY($3::text[])`,
      [adminUid, actorUid, toRemove]
    );
  }

  // Insert new grants
  for (const key of toAdd) {
    await dbQuery.query(
      `INSERT INTO ${s}.admin_permission_grants (admin_uid, permission_key, granted, granted_by, reason)
       VALUES ($1, $2, TRUE, $3, $4)`,
      [adminUid, key, actorUid, reason]
    );
  }

  // Append to permission events
  await dbQuery.query(
    `INSERT INTO ${s}.admin_permission_events
       (target_admin_uid, actor_admin_uid, event_type, added_permissions, removed_permissions,
        before_permissions, after_permissions, reason, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      adminUid, actorUid, 'permissions_updated',
      JSON.stringify(toAdd), JSON.stringify(toRemove),
      JSON.stringify(before), JSON.stringify(resolved),
      reason, requestId ?? null,
    ]
  );

  invalidatePermissionCache(adminUid);
  invalidatePermissionCache(`sa:${adminUid}`);

  auditFire({
    actionCategory: 'admin', action: 'admin_permissions_updated',
    entityType: 'admin_user' as any, entityId: adminUid,
    actorUid, actorDisplayName: actorName, outcome: 'success',
    metadata: { added: toAdd, removed: toRemove, reason },
    requestId,
  });

  return { adminUid, savedPermissions: resolved, changesApplied: toAdd.length + toRemove.length };
}

export async function getPermissionHistory(
  adminUid: string,
  limit = 50
): Promise<any[]> {
  const res = await dbQuery.query(
    `SELECT event_id AS "eventId", target_admin_uid AS "targetAdminUid",
            actor_admin_uid AS "actorAdminUid", event_type AS "eventType",
            added_permissions AS "addedPermissions", removed_permissions AS "removedPermissions",
            before_permissions AS "beforePermissions", after_permissions AS "afterPermissions",
            reason, request_id AS "requestId", created_at AS "createdAt"
     FROM ${s}.admin_permission_events
     WHERE target_admin_uid = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [adminUid, limit]
  );
  return res.rows;
}

// ── Safety guards ──────────────────────────────────────────────────────────────

// Throws if removing the given admin would leave zero active Super Admins
export async function assertAtLeastOneSuperAdmin(excludeUid?: string): Promise<void> {
  const res = await dbQuery.query(
    `SELECT COUNT(*) FROM ${s}.admin_users
     WHERE is_super_admin = TRUE AND account_status = 'active'
       AND admin_uid != $1`,
    [excludeUid ?? '']
  );
  const remaining = Number(res.rows[0]?.count ?? 0);
  if (remaining < 1) {
    throw Object.assign(
      new Error('Cannot remove the last active Super Admin'),
      { code: 'BUSINESS_RULE' }
    );
  }
}

// One-time bootstrap: promote caller to Super Admin when no Super Admins exist
export async function bootstrapSuperAdmin(
  adminUid: string,
  email: string,
  displayName: string | null,
  requestId: string | null
): Promise<{ adminUid: string; isSuperAdmin: boolean }> {
  const superAdminCount = await dbQuery.query(
    `SELECT COUNT(*) FROM ${s}.admin_users WHERE is_super_admin = TRUE AND account_status = 'active'`
  );
  if (Number(superAdminCount.rows[0]?.count ?? 0) > 0) {
    throw Object.assign(
      new Error('Super Admin already exists — bootstrap not allowed'),
      { code: 'CONFLICT' }
    );
  }

  await dbQuery.query(
    `INSERT INTO ${s}.admin_users (admin_uid, email, display_name, is_super_admin, account_status, created_by)
     VALUES ($1, $2, $3, TRUE, 'active', 'bootstrap')
     ON CONFLICT (admin_uid) DO UPDATE SET is_super_admin=TRUE, updated_at=NOW()`,
    [adminUid, email, displayName]
  );

  await dbQuery.query(
    `INSERT INTO ${s}.user_credentials (uid, role) VALUES ($1, 1)
     ON CONFLICT (uid) DO UPDATE SET role = 1`,
    [adminUid]
  );

  auditFire({
    actionCategory: 'admin', action: 'super_admin_granted',
    entityType: 'admin_user' as any, entityId: adminUid,
    actorUid: adminUid, actorDisplayName: displayName, outcome: 'success',
    metadata: { bootstrapped: true }, requestId,
  });

  invalidatePermissionCache(adminUid);
  invalidatePermissionCache(`sa:${adminUid}`);
  return { adminUid, isSuperAdmin: true };
}
