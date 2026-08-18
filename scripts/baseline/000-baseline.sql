--
-- Servana schema baseline
--
-- WHAT THIS IS
--
-- The schema that predates this repository's migration chain. The chain alters
-- and reads eighteen foundational tables that no migration creates -- starting
-- with 001 -- so a fresh database cannot reach the current schema without this
-- file first.
--
-- WHAT IT CONTAINS
--
-- Structure only: tables, columns, constraints, indexes, sequences, functions
-- and triggers. Captured with --schema-only --no-owner --no-privileges, so it
-- carries no rows, no owners and no grants.
--
-- HOW IT WAS CAPTURED
--
--   pg_dump --schema-only --no-owner --no-privileges --schema=servana
--
-- streamed over SSH from the production host so that nothing was written there
-- and no credential left it. Verified before committing: 0 INSERT, 0 COPY,
-- no ownership statements, no grants, and no value matching any
-- FORBIDDEN_BASELINE_PATTERN.
--
-- OWNERSHIP
--
-- Deliberately absent. Ownership is NOT copied from production -- it is a
-- property of whoever applies this file, and the runner applies it as `admin`.
-- Copying owners is what reproduced the 2026-08-10 outage, where 29 of 116
-- tables ended up owned by `postgres` and unusable by the application.
--
-- HOW TO REGENERATE
--
--   see docs/database/DATABASE_BASELINE_CAPTURE.md
--

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: servana; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS servana;


CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: touch_payments_updated_at(); Type: FUNCTION; Schema: servana; Owner: -
--

CREATE FUNCTION servana.touch_payments_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_deletion_requests; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.account_deletion_requests (
    id bigint NOT NULL,
    uid character varying(128),
    identifier character varying(254) NOT NULL,
    identifier_type character varying(10) NOT NULL,
    source character varying(10) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    processed_by character varying(128),
    note text
);


--
-- Name: account_deletion_requests_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.account_deletion_requests_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: account_deletion_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.account_deletion_requests_id_seq OWNED BY servana.account_deletion_requests.id;


--
-- Name: admin_audit_events; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.admin_audit_events (
    id integer NOT NULL,
    event_id text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    action character varying(100) NOT NULL,
    action_category character varying(30) NOT NULL,
    outcome character varying(20) DEFAULT 'success'::character varying NOT NULL,
    actor_uid text,
    actor_type character varying(20) DEFAULT 'admin'::character varying NOT NULL,
    actor_role character varying(20),
    actor_display_name text,
    actor_email text,
    entity_type character varying(50) NOT NULL,
    entity_id text NOT NULL,
    entity_display_name text,
    related_entities jsonb,
    before_json jsonb,
    after_json jsonb,
    changed_fields text[],
    reason text,
    note text,
    request_id text,
    client_request_id text,
    ip_address text,
    user_agent text,
    source character varying(30) DEFAULT 'admin_portal'::character varying NOT NULL,
    metadata jsonb,
    schema_version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_audit_events_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.admin_audit_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_audit_events_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.admin_audit_events_id_seq OWNED BY servana.admin_audit_events.id;


--
-- Name: admin_booking_drafts; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.admin_booking_drafts (
    id integer NOT NULL,
    draft_id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_by_admin_uid character varying(256) NOT NULL,
    last_updated_by_admin_uid character varying(256),
    status character varying(30) DEFAULT 'editing'::character varying NOT NULL,
    current_step smallint DEFAULT 1 NOT NULL,
    customer_type character varying(10),
    customer_uid character varying(256),
    guest_payload jsonb,
    service_option_id integer,
    addon_option_ids integer[] DEFAULT '{}'::integer[] NOT NULL,
    schedule_at timestamp with time zone,
    address_payload jsonb,
    selected_provider_uid character varying(256),
    provider_snapshot jsonb,
    payment_method character varying(20),
    payment_status_choice character varying(20),
    payment_evidence_payload jsonb,
    internal_notes text,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_opened_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval) NOT NULL,
    converted_booking_id integer,
    converted_at timestamp with time zone,
    discarded_at timestamp with time zone,
    discarded_by_admin_uid character varying(256),
    discard_reason text,
    customer_name character varying(256),
    CONSTRAINT chk_draft_status CHECK (((status)::text = ANY ((ARRAY['editing'::character varying, 'ready_for_review'::character varying, 'converting'::character varying, 'converted'::character varying, 'discarded'::character varying, 'expired'::character varying])::text[])))
);


--
-- Name: admin_booking_drafts_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.admin_booking_drafts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_booking_drafts_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.admin_booking_drafts_id_seq OWNED BY servana.admin_booking_drafts.id;


--
-- Name: admin_communication_events; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.admin_communication_events (
    id bigint NOT NULL,
    event_key character varying(64) DEFAULT (gen_random_uuid())::character varying NOT NULL,
    channel character varying(32) NOT NULL,
    direction character varying(16) DEFAULT 'outbound'::character varying NOT NULL,
    status character varying(32) DEFAULT 'sent'::character varying NOT NULL,
    severity character varying(16) DEFAULT 'info'::character varying NOT NULL,
    category character varying(64),
    recipient_uid character varying(128),
    recipient_email character varying(255),
    recipient_name character varying(255),
    recipient_role character varying(32),
    sender_uid character varying(128),
    sender_role character varying(32) DEFAULT 'system'::character varying,
    entity_type character varying(64),
    entity_id character varying(128),
    template_name character varying(128),
    subject character varying(512),
    safe_body text,
    provider_response jsonb,
    retry_count integer DEFAULT 0 NOT NULL,
    last_retry_at timestamp with time zone,
    error_message text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_communication_events_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.admin_communication_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_communication_events_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.admin_communication_events_id_seq OWNED BY servana.admin_communication_events.id;


--
-- Name: admin_notification_templates; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.admin_notification_templates (
    id bigint NOT NULL,
    template_key character varying(128) NOT NULL,
    name character varying(255) NOT NULL,
    channel character varying(32) NOT NULL,
    category character varying(64),
    subject character varying(512),
    body_template text NOT NULL,
    variables jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone
);


--
-- Name: admin_notification_templates_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.admin_notification_templates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_notification_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.admin_notification_templates_id_seq OWNED BY servana.admin_notification_templates.id;


--
-- Name: admin_notifications; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.admin_notifications (
    id bigint NOT NULL,
    admin_uid text NOT NULL,
    notification_key character varying(160) NOT NULL,
    type character varying(80) NOT NULL,
    severity character varying(20) DEFAULT 'info'::character varying NOT NULL,
    title character varying(180) NOT NULL,
    body text NOT NULL,
    booking_id integer,
    conversation_id integer,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_notifications_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.admin_notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.admin_notifications_id_seq OWNED BY servana.admin_notifications.id;


--
-- Name: admin_permission_definitions; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.admin_permission_definitions (
    permission_key text NOT NULL,
    module text NOT NULL,
    group_label text NOT NULL,
    label text NOT NULL,
    description text,
    action_type text NOT NULL,
    risk_level text DEFAULT 'low'::text NOT NULL,
    requires jsonb DEFAULT '[]'::jsonb NOT NULL,
    conflicts_with jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_dangerous boolean DEFAULT false NOT NULL,
    is_hidden_from_normal_ui boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_permission_events; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.admin_permission_events (
    event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    target_admin_uid text NOT NULL,
    actor_admin_uid text NOT NULL,
    event_type text NOT NULL,
    added_permissions jsonb DEFAULT '[]'::jsonb NOT NULL,
    removed_permissions jsonb DEFAULT '[]'::jsonb NOT NULL,
    before_permissions jsonb,
    after_permissions jsonb,
    reason text NOT NULL,
    request_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_permission_grants; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.admin_permission_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    admin_uid text NOT NULL,
    permission_key text NOT NULL,
    granted boolean NOT NULL,
    granted_by text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_by text,
    revoked_at timestamp with time zone,
    reason text,
    version integer DEFAULT 1 NOT NULL
);


--
-- Name: admin_users; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.admin_users (
    admin_uid text NOT NULL,
    email text NOT NULL,
    display_name text,
    is_super_admin boolean DEFAULT false NOT NULL,
    account_status text DEFAULT 'active'::text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deactivated_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    invited_at timestamp with time zone,
    accepted_at timestamp with time zone
);


--
-- Name: booking_additional_items; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.booking_additional_items (
    id integer NOT NULL,
    additional_request_id integer NOT NULL,
    service_option_id integer,
    quantity integer,
    unit_price numeric(10,2),
    total_price numeric(10,2)
);


--
-- Name: booking_additional_items_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.booking_additional_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: booking_additional_items_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.booking_additional_items_id_seq OWNED BY servana.booking_additional_items.id;


--
-- Name: booking_additional_requests; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.booking_additional_requests (
    id integer NOT NULL,
    booking_id integer NOT NULL,
    requested_by character varying(50),
    status character varying(50),
    total_amount numeric(10,2),
    approved_at timestamp without time zone,
    paid_at timestamp without time zone,
    worker_decision character varying(20),
    decided_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: booking_additional_requests_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.booking_additional_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: booking_additional_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.booking_additional_requests_id_seq OWNED BY servana.booking_additional_requests.id;


--
-- Name: booking_addons; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.booking_addons (
    id integer NOT NULL,
    booking_id integer,
    addon_option_id integer,
    qty integer DEFAULT 1,
    unit_price numeric
);


--
-- Name: booking_addons_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.booking_addons_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: booking_addons_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.booking_addons_id_seq OWNED BY servana.booking_addons.id;


--
-- Name: booking_audit_events; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.booking_audit_events (
    id integer NOT NULL,
    booking_id integer,
    actor_uid text,
    actor_role character varying(20) DEFAULT 'admin'::character varying NOT NULL,
    action character varying(100) NOT NULL,
    before_json jsonb,
    after_json jsonb,
    reason text,
    request_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: booking_audit_events_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.booking_audit_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: booking_audit_events_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.booking_audit_events_id_seq OWNED BY servana.booking_audit_events.id;


--
-- Name: booking_create_idempotency; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.booking_create_idempotency (
    id integer NOT NULL,
    idempotency_key character varying(64) NOT NULL,
    actor_uid character varying(256) NOT NULL,
    booking_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: booking_create_idempotency_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.booking_create_idempotency_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: booking_create_idempotency_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.booking_create_idempotency_id_seq OWNED BY servana.booking_create_idempotency.id;


--
-- Name: booking_escalations; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.booking_escalations (
    id integer NOT NULL,
    booking_id integer NOT NULL,
    reason_code character varying(80),
    reason text NOT NULL,
    severity character varying(20) DEFAULT 'normal'::character varying NOT NULL,
    assigned_team text,
    actor_uid text,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: booking_escalations_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.booking_escalations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: booking_escalations_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.booking_escalations_id_seq OWNED BY servana.booking_escalations.id;


--
-- Name: booking_notes; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.booking_notes (
    id integer NOT NULL,
    booking_id integer NOT NULL,
    note_text text NOT NULL,
    author_uid text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: booking_notes_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.booking_notes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: booking_notes_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.booking_notes_id_seq OWNED BY servana.booking_notes.id;


--
-- Name: booking_payment_evidence; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.booking_payment_evidence (
    id integer NOT NULL,
    booking_id integer NOT NULL,
    storage_url text NOT NULL,
    original_file_name character varying(255),
    mime_type character varying(50) NOT NULL,
    file_size_bytes integer NOT NULL,
    uploaded_by_admin_uid character varying(256) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: booking_payment_evidence_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.booking_payment_evidence_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: booking_payment_evidence_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.booking_payment_evidence_id_seq OWNED BY servana.booking_payment_evidence.id;


--
-- Name: booking_workers; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.booking_workers (
    id integer NOT NULL,
    booking_id integer,
    worker_uid character varying,
    status character varying(30) DEFAULT 'ASSIGNED'::character varying,
    assigned_at timestamp without time zone DEFAULT now(),
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    confirmation_source character varying(40),
    admin_actor_uid character varying(256),
    consent_method character varying(30),
    consent_reference text,
    confirmation_reason text,
    confirmed_at timestamp with time zone,
    en_route_at timestamp with time zone,
    arrived_at timestamp with time zone,
    accepted_at timestamp with time zone,
    declined_at timestamp with time zone
);


--
-- Name: COLUMN booking_workers.en_route_at; Type: COMMENT; Schema: servana; Owner: -
--

COMMENT ON COLUMN servana.booking_workers.en_route_at IS 'When the provider set out. Written by the canonical transition executor.';


--
-- Name: COLUMN booking_workers.arrived_at; Type: COMMENT; Schema: servana; Owner: -
--

COMMENT ON COLUMN servana.booking_workers.arrived_at IS 'When the provider reached the address. Written by the canonical transition executor.';


--
-- Name: COLUMN booking_workers.accepted_at; Type: COMMENT; Schema: servana; Owner: -
--

COMMENT ON COLUMN servana.booking_workers.accepted_at IS 'When the provider accepted the assignment. Written by the canonical transition executor.';


--
-- Name: COLUMN booking_workers.declined_at; Type: COMMENT; Schema: servana; Owner: -
--

COMMENT ON COLUMN servana.booking_workers.declined_at IS 'When the provider declined the assignment. Written by the canonical transition executor.';


--
-- Name: booking_technicians_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.booking_technicians_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: booking_technicians_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.booking_technicians_id_seq OWNED BY servana.booking_workers.id;


--
-- Name: booking_timeline_events; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.booking_timeline_events (
    id integer NOT NULL,
    booking_id integer NOT NULL,
    event_type character varying(80) NOT NULL,
    title character varying(200) NOT NULL,
    description text,
    actor_type character varying(20) DEFAULT 'admin'::character varying NOT NULL,
    actor_uid text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: booking_timeline_events_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.booking_timeline_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: booking_timeline_events_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.booking_timeline_events_id_seq OWNED BY servana.booking_timeline_events.id;


--
-- Name: booking_tracking; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.booking_tracking (
    id integer NOT NULL,
    booking_id integer NOT NULL,
    status character varying(30) NOT NULL,
    note text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: booking_tracking_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.booking_tracking_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: booking_tracking_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.booking_tracking_id_seq OWNED BY servana.booking_tracking.id;


--
-- Name: bookings; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.bookings (
    id integer NOT NULL,
    user_id character varying,
    user_address_id character varying,
    service_option_id integer NOT NULL,
    schedule timestamp without time zone NOT NULL,
    payment_method character varying(20) NOT NULL,
    status character varying(30) DEFAULT 'PENDING_OTP'::character varying,
    otp_code character varying(6),
    quoted_price numeric,
    final_price numeric,
    pricing_breakdown jsonb,
    eta_minutes integer,
    eta_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    branch_id integer,
    worker_uid character varying(80),
    worker_code character varying(6),
    transpo_fee numeric(10,2) DEFAULT 0 NOT NULL,
    cancelled_at timestamp with time zone,
    guest_customer_id uuid,
    admin_created boolean DEFAULT false,
    admin_created_by character varying(256),
    service_address jsonb,
    catalog_service_id integer,
    is_synthetic boolean DEFAULT false NOT NULL
);


--
-- Name: COLUMN bookings.is_synthetic; Type: COMMENT; Schema: servana; Owner: -
--

COMMENT ON COLUMN servana.bookings.is_synthetic IS 'Release-smoke / test booking. Server-controlled, never client-settable. Excluded from business reporting by servana booking reporting policy; lifecycle semantics are unchanged.';


--
-- Name: bookings_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.bookings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bookings_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.bookings_id_seq OWNED BY servana.bookings.id;


--
-- Name: branch_slots; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.branch_slots (
    id integer NOT NULL,
    branch_id integer NOT NULL,
    slot_time time without time zone NOT NULL,
    max_capacity integer DEFAULT 1 NOT NULL
);


--
-- Name: branch_slots_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.branch_slots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: branch_slots_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.branch_slots_id_seq OWNED BY servana.branch_slots.id;


--
-- Name: branches; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.branches (
    id integer NOT NULL,
    service_id integer NOT NULL,
    name character varying(150) NOT NULL,
    address text NOT NULL,
    city character varying(100) NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: branches_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.branches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: branches_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.branches_id_seq OWNED BY servana.branches.id;


--
-- Name: catalog_categories; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.catalog_categories (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    slug character varying(200) NOT NULL,
    description text,
    icon_key character varying(100),
    image_url text,
    display_order integer DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    legacy_category_text text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT catalog_categories_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'active'::character varying, 'inactive'::character varying, 'archived'::character varying])::text[])))
);


--
-- Name: catalog_categories_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.catalog_categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: catalog_categories_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.catalog_categories_id_seq OWNED BY servana.catalog_categories.id;


--
-- Name: catalog_provider_services; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.catalog_provider_services (
    id integer NOT NULL,
    provider_uid text NOT NULL,
    service_id integer NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    legacy_service_family_id integer,
    source character varying(30) DEFAULT 'migrated_from_family'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT catalog_provider_services_source_check CHECK (((source)::text = ANY ((ARRAY['migrated_from_family'::character varying, 'admin_grant'::character varying, 'application_approved'::character varying])::text[]))),
    CONSTRAINT catalog_provider_services_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'paused'::character varying, 'archived'::character varying])::text[])))
);


--
-- Name: catalog_provider_services_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.catalog_provider_services_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: catalog_provider_services_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.catalog_provider_services_id_seq OWNED BY servana.catalog_provider_services.id;


--
-- Name: services; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.services (
    id integer NOT NULL,
    subcategory_id integer NOT NULL,
    name character varying(300) NOT NULL,
    slug character varying(300) NOT NULL,
    short_description text,
    full_description text,
    image_url text,
    base_price numeric,
    unit character varying(100),
    estimated_duration_mins integer,
    display_order integer DEFAULT 0 NOT NULL,
    bookable boolean DEFAULT true NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    legacy_service_option_id integer,
    legacy_service_family_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT catalog_services_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'active'::character varying, 'inactive'::character varying, 'archived'::character varying])::text[])))
);


--
-- Name: TABLE services; Type: COMMENT; Schema: servana; Owner: -
--

COMMENT ON TABLE servana.services IS 'Catalog V2 canonical bookable entity: the 95 Specific Services. services.id is the canonical service identity for provider capability, future booking, matching and analytics. Category is derived through subcategory_id -> catalog_subcategories -> catalog_categories.';


--
-- Name: catalog_services_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.catalog_services_id_seq
    AS integer
    START WITH 100000
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: catalog_services_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.catalog_services_id_seq OWNED BY servana.services.id;


--
-- Name: catalog_subcategories; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.catalog_subcategories (
    id integer NOT NULL,
    category_id integer NOT NULL,
    name character varying(200) NOT NULL,
    slug character varying(200) NOT NULL,
    description text,
    icon_key character varying(100),
    image_url text,
    display_order integer DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    legacy_service_family_id integer,
    legacy_level_2 character varying(100),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT catalog_subcategories_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'active'::character varying, 'inactive'::character varying, 'archived'::character varying])::text[])))
);


--
-- Name: catalog_subcategories_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.catalog_subcategories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: catalog_subcategories_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.catalog_subcategories_id_seq OWNED BY servana.catalog_subcategories.id;


--
-- Name: chat_conversations; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.chat_conversations (
    id bigint NOT NULL,
    booking_id integer NOT NULL,
    is_closed boolean DEFAULT false NOT NULL,
    last_message_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status character varying(24) DEFAULT 'ACTIVE'::character varying NOT NULL,
    read_only_at timestamp with time zone,
    archived_at timestamp with time zone,
    escalated_at timestamp with time zone
);


--
-- Name: chat_conversations_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.chat_conversations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chat_conversations_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.chat_conversations_id_seq OWNED BY servana.chat_conversations.id;


--
-- Name: chat_message_attachments; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.chat_message_attachments (
    id bigint NOT NULL,
    message_id bigint NOT NULL,
    url text NOT NULL,
    file_name text,
    mime_type text,
    size_bytes bigint,
    width integer,
    height integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: chat_message_attachments_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.chat_message_attachments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chat_message_attachments_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.chat_message_attachments_id_seq OWNED BY servana.chat_message_attachments.id;


--
-- Name: chat_message_reports; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.chat_message_reports (
    id integer NOT NULL,
    reporter_uid text NOT NULL,
    message_id integer NOT NULL,
    conversation_id integer NOT NULL,
    category text NOT NULL,
    description text,
    status text DEFAULT 'pending'::text NOT NULL,
    resolved_by text,
    resolved_at timestamp with time zone,
    resolution_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: chat_message_reports_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.chat_message_reports_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chat_message_reports_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.chat_message_reports_id_seq OWNED BY servana.chat_message_reports.id;


--
-- Name: chat_messages; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.chat_messages (
    id bigint NOT NULL,
    conversation_id bigint NOT NULL,
    sender_uid text,
    sender_role smallint,
    type text DEFAULT 'text'::text NOT NULL,
    body text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    client_msg_id text,
    edited_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: chat_messages_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.chat_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chat_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.chat_messages_id_seq OWNED BY servana.chat_messages.id;


--
-- Name: chat_participants; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.chat_participants (
    id bigint NOT NULL,
    conversation_id bigint NOT NULL,
    user_uid text NOT NULL,
    role smallint NOT NULL,
    last_read_message_id bigint,
    is_muted boolean DEFAULT false NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    left_at timestamp with time zone,
    can_read boolean DEFAULT true NOT NULL,
    can_send boolean DEFAULT true NOT NULL
);


--
-- Name: chat_participants_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.chat_participants_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chat_participants_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.chat_participants_id_seq OWNED BY servana.chat_participants.id;


--
-- Name: customer_notifications; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.customer_notifications (
    id bigint NOT NULL,
    notification_key character varying(64) DEFAULT (gen_random_uuid())::character varying NOT NULL,
    user_uid character varying(128) NOT NULL,
    type character varying(64) DEFAULT 'system'::character varying NOT NULL,
    status character varying(32) DEFAULT 'unread'::character varying NOT NULL,
    severity character varying(32) DEFAULT 'info'::character varying NOT NULL,
    title character varying(255) NOT NULL,
    safe_body text NOT NULL,
    safe_context_label character varying(255),
    route jsonb,
    can_mark_read boolean DEFAULT true NOT NULL,
    can_dismiss boolean DEFAULT true NOT NULL,
    can_open_detail boolean DEFAULT false NOT NULL,
    read_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: customer_notifications_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.customer_notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customer_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.customer_notifications_id_seq OWNED BY servana.customer_notifications.id;


--
-- Name: customer_reviews; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.customer_reviews (
    review_id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id character varying(128) NOT NULL,
    customer_uid character varying(128) NOT NULL,
    provider_uid character varying(128),
    service_id character varying(128),
    overall_rating integer NOT NULL,
    public_comment text,
    private_feedback text,
    visibility character varying(30) DEFAULT 'PUBLIC'::character varying NOT NULL,
    moderation_status character varying(30) DEFAULT 'NOT_REQUIRED'::character varying NOT NULL,
    client_request_id character varying(128),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    edited_at timestamp with time zone,
    deleted_at timestamp with time zone,
    branch_id character varying(128),
    publication_state character varying(32) DEFAULT 'PUBLISHED'::character varying NOT NULL,
    appeal_state character varying(32) DEFAULT 'NONE'::character varying NOT NULL,
    provider_response_state character varying(32) DEFAULT 'NONE'::character varying NOT NULL,
    policy_version integer DEFAULT 1 NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_reviews_moderation_status_check CHECK (((moderation_status)::text = ANY ((ARRAY['NOT_REQUIRED'::character varying, 'AUTOMATED_CHECKS_PASSED'::character varying, 'PENDING'::character varying, 'APPROVED'::character varying, 'REJECTED'::character varying, 'HIDDEN'::character varying, 'REMOVED'::character varying, 'FLAGGED'::character varying, 'REPORTED'::character varying, 'REDACTED'::character varying, 'RESTORED'::character varying])::text[]))),
    CONSTRAINT customer_reviews_overall_rating_check CHECK (((overall_rating >= 1) AND (overall_rating <= 5))),
    CONSTRAINT customer_reviews_visibility_check CHECK (((visibility)::text = ANY ((ARRAY['PUBLIC'::character varying, 'ANONYMOUS_PUBLIC'::character varying, 'PRIVATE'::character varying])::text[])))
);


--
-- Name: customer_support_ticket_replies; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.customer_support_ticket_replies (
    id bigint NOT NULL,
    ticket_key character varying(64) NOT NULL,
    sender_type character varying(32) DEFAULT 'customer'::character varying NOT NULL,
    safe_body text NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: customer_support_ticket_replies_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.customer_support_ticket_replies_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customer_support_ticket_replies_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.customer_support_ticket_replies_id_seq OWNED BY servana.customer_support_ticket_replies.id;


--
-- Name: customer_support_tickets; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.customer_support_tickets (
    id bigint NOT NULL,
    ticket_key character varying(64) DEFAULT (gen_random_uuid())::character varying NOT NULL,
    customer_uid character varying(128) NOT NULL,
    client_request_id character varying(128),
    category character varying(64) DEFAULT 'other'::character varying NOT NULL,
    status character varying(64) DEFAULT 'submitted'::character varying NOT NULL,
    title character varying(200) NOT NULL,
    description text NOT NULL,
    booking_id character varying(128),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: customer_support_tickets_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.customer_support_tickets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customer_support_tickets_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.customer_support_tickets_id_seq OWNED BY servana.customer_support_tickets.id;


--
-- Name: disbursements; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.disbursements (
    id integer NOT NULL,
    booking_id integer NOT NULL,
    worker_uid text NOT NULL,
    total_amount numeric(12,2) NOT NULL,
    servana_share numeric(12,2) NOT NULL,
    worker_share numeric(12,2) NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    paymongo_payout_id text,
    payout_error text,
    released_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    hold_reason text,
    hold_until timestamp with time zone,
    held_by text,
    retry_count integer DEFAULT 0,
    last_retry_at timestamp with time zone,
    payout_attempt integer DEFAULT 0 NOT NULL
);


--
-- Name: disbursements_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.disbursements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: disbursements_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.disbursements_id_seq OWNED BY servana.disbursements.id;


--
-- Name: email_otps; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.email_otps (
    id bigint NOT NULL,
    email character varying(255) NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    used boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    purpose text DEFAULT 'REGISTRATION_VERIFICATION'::text NOT NULL
);


--
-- Name: COLUMN email_otps.purpose; Type: COMMENT; Schema: servana; Owner: -
--

COMMENT ON COLUMN servana.email_otps.purpose IS 'What the code entitles the holder to do: REGISTRATION_VERIFICATION, PASSWORD_RESET or SENSITIVE_CHANGE. Every read is scoped to one, so a code minted for one decision can never satisfy another. Values are a contract — append, never rename. See src/services/otpService.ts.';


--
-- Name: email_otps_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.email_otps_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_otps_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.email_otps_id_seq OWNED BY servana.email_otps.id;


--
-- Name: employee_catalog_capabilities; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.employee_catalog_capabilities (
    id integer NOT NULL,
    employee_uid text NOT NULL,
    offering_id integer NOT NULL,
    service_id integer NOT NULL,
    level_2 character varying(100) NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    application_id uuid,
    approved_at timestamp with time zone,
    suspended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT employee_catalog_capabilities_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'suspended'::character varying, 'archived'::character varying])::text[])))
);


--
-- Name: employee_catalog_capabilities_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.employee_catalog_capabilities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: employee_catalog_capabilities_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.employee_catalog_capabilities_id_seq OWNED BY servana.employee_catalog_capabilities.id;


--
-- Name: employee_services; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.employee_services (
    id integer NOT NULL,
    employee_uid text NOT NULL,
    service_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    pause_reason text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT employee_services_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text])))
);


--
-- Name: employee_services_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.employee_services_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: employee_services_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.employee_services_id_seq OWNED BY servana.employee_services.id;


--
-- Name: finance_ledger_entries; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.finance_ledger_entries (
    id integer NOT NULL,
    booking_id integer NOT NULL,
    payment_id integer,
    provider_uid text,
    is_internal_fixer boolean DEFAULT false NOT NULL,
    gross_amount numeric(12,2) NOT NULL,
    servana_revenue numeric(12,2) DEFAULT 0 NOT NULL,
    provider_payable numeric(12,2) DEFAULT 0 NOT NULL,
    commission_rate numeric(5,4),
    recognition_status text DEFAULT 'recognized'::text NOT NULL,
    source text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: finance_ledger_entries_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.finance_ledger_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: finance_ledger_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.finance_ledger_entries_id_seq OWNED BY servana.finance_ledger_entries.id;


--
-- Name: finance_reconciliation_exceptions; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.finance_reconciliation_exceptions (
    id integer NOT NULL,
    run_date date DEFAULT CURRENT_DATE NOT NULL,
    exception_code text NOT NULL,
    severity text DEFAULT 'warning'::text NOT NULL,
    booking_id integer,
    payment_id integer,
    disbursement_id integer,
    amount numeric(12,2),
    description text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    resolved_by text,
    resolved_at timestamp with time zone,
    resolution_reason text,
    ignored_by text,
    ignored_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: finance_reconciliation_exceptions_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.finance_reconciliation_exceptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: finance_reconciliation_exceptions_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.finance_reconciliation_exceptions_id_seq OWNED BY servana.finance_reconciliation_exceptions.id;


--
-- Name: finance_refund_reviews; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.finance_refund_reviews (
    id integer NOT NULL,
    booking_id integer NOT NULL,
    payment_id integer,
    disbursement_id integer,
    amount numeric(12,2) NOT NULL,
    currency text DEFAULT 'PHP'::text NOT NULL,
    status text DEFAULT 'requested'::text NOT NULL,
    reason text,
    customer_uid text,
    customer_name text,
    requested_by text,
    reviewed_by text,
    reviewed_at timestamp with time zone,
    refund_method text,
    refund_reference text,
    processed_at timestamp with time zone,
    payout_reversal_needed boolean DEFAULT false NOT NULL,
    rejection_reason text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: finance_refund_reviews_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.finance_refund_reviews_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: finance_refund_reviews_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.finance_refund_reviews_id_seq OWNED BY servana.finance_refund_reviews.id;


--
-- Name: guest_customers; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.guest_customers (
    id integer NOT NULL,
    guest_customer_id uuid DEFAULT gen_random_uuid() NOT NULL,
    first_name character varying(100) NOT NULL,
    last_name character varying(100) NOT NULL,
    phone_normalized character varying(20) NOT NULL,
    email character varying(255),
    created_by_admin_uid character varying(256) NOT NULL,
    linked_customer_uid character varying(256),
    linked_at timestamp with time zone,
    linked_by_admin_uid character varying(256),
    link_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_channel character varying(50),
    source_details text,
    internal_notes text,
    updated_at timestamp with time zone
);


--
-- Name: guest_customers_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.guest_customers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: guest_customers_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.guest_customers_id_seq OWNED BY servana.guest_customers.id;


--
-- Name: logs; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.logs (
    log_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    activity text NOT NULL,
    log_by character varying NOT NULL,
    reference_id character varying,
    module_reference character varying(100),
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: payments; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.payments (
    id integer NOT NULL,
    booking_id integer,
    method character varying(20),
    status character varying(20) DEFAULT 'PENDING'::character varying,
    amount numeric,
    reference_no character varying(100),
    proof_url text,
    paid_at timestamp without time zone,
    provider character varying(50),
    provider_payment_id character varying(100),
    provider_reference_id character varying(100),
    checkout_url text,
    webhook_event_id character varying(100),
    raw_response jsonb,
    additional_request_id integer,
    submitted_at timestamp with time zone,
    reviewed_by text,
    reviewed_at timestamp with time zone,
    rejection_reason text,
    rejected_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now(),
    refunded_amount numeric(12,2) DEFAULT 0 NOT NULL,
    checkout_attempt integer DEFAULT 0 NOT NULL,
    refund_attempt integer DEFAULT 0 NOT NULL,
    return_origin text,
    superseded_session_ids text[]
);


--
-- Name: COLUMN payments.return_origin; Type: COMMENT; Schema: servana; Owner: -
--

COMMENT ON COLUMN servana.payments.return_origin IS 'Allowlisted return origin this checkout session was created for. NULL = the configured PAYMONGO_RETURN_URL default. Never a caller-supplied string; only an entry from paymentReturnOrigin.ts.';


--
-- Name: COLUMN payments.superseded_session_ids; Type: COMMENT; Schema: servana; Owner: -
--

COMMENT ON COLUMN servana.payments.superseded_session_ids IS 'PayMongo checkout session ids (cs_...) this payment previously used, appended when a session is superseded. The webhook matches against these as well as provider_payment_id, so a payment made against an older session is still recorded. Never contains pay_ ids.';


--
-- Name: payments_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payments_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.payments_id_seq OWNED BY servana.payments.id;


--
-- Name: pricing_modifiers; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.pricing_modifiers (
    id integer NOT NULL,
    service_option_id integer,
    modifier_type character varying(30),
    key character varying(50),
    amount numeric DEFAULT 0
);


--
-- Name: pricing_modifiers_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.pricing_modifiers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pricing_modifiers_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.pricing_modifiers_id_seq OWNED BY servana.pricing_modifiers.id;


--
-- Name: provider_activation; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_activation (
    provider_uid character varying(128) NOT NULL,
    activation_status character varying(32) DEFAULT 'NOT_ELIGIBLE'::character varying NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    policy_acknowledged_at timestamp with time zone,
    activated_at timestamp with time zone,
    activated_by character varying(128),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_activation_events; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_activation_events (
    id bigint NOT NULL,
    provider_uid character varying(128) NOT NULL,
    prev_state character varying(32),
    next_state character varying(32) NOT NULL,
    actor_type character varying(16) NOT NULL,
    actor_uid character varying(128),
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_activation_events_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.provider_activation_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: provider_activation_events_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.provider_activation_events_id_seq OWNED BY servana.provider_activation_events.id;


--
-- Name: provider_alerts; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_alerts (
    id bigint NOT NULL,
    alert_key character varying(64) DEFAULT (gen_random_uuid())::character varying NOT NULL,
    worker_uid character varying(128) NOT NULL,
    type character varying(64) DEFAULT 'unknown'::character varying NOT NULL,
    severity character varying(32) DEFAULT 'high'::character varying NOT NULL,
    title character varying(255) NOT NULL,
    safe_body text NOT NULL,
    is_dismissable boolean DEFAULT true NOT NULL,
    route jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_alerts_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.provider_alerts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: provider_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.provider_alerts_id_seq OWNED BY servana.provider_alerts.id;


--
-- Name: provider_auto_online_events; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_auto_online_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_uid text NOT NULL,
    event_type text NOT NULL,
    before jsonb,
    after jsonb,
    reason text,
    actor_type text DEFAULT 'system'::text NOT NULL,
    actor_uid text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_auto_online_state; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_auto_online_state (
    provider_uid text NOT NULL,
    is_auto_online boolean DEFAULT false NOT NULL,
    is_bookable boolean DEFAULT false NOT NULL,
    activation_mode text DEFAULT 'none'::text NOT NULL,
    activation_reason text,
    eligibility_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    activated_at timestamp with time zone,
    deactivated_at timestamp with time zone,
    last_evaluated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL
);


--
-- Name: provider_catalog_offering_mappings; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_catalog_offering_mappings (
    id integer NOT NULL,
    offering_id integer NOT NULL,
    service_id integer NOT NULL,
    level_2 character varying(100) NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_catalog_offering_mappings_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.provider_catalog_offering_mappings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: provider_catalog_offering_mappings_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.provider_catalog_offering_mappings_id_seq OWNED BY servana.provider_catalog_offering_mappings.id;


--
-- Name: provider_catalog_offering_policies; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_catalog_offering_policies (
    offering_id integer NOT NULL,
    enforcement_state text DEFAULT 'draft'::text NOT NULL,
    allowed_provider_types jsonb DEFAULT '[]'::jsonb NOT NULL,
    allowed_branch_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    allowed_city_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_catalog_offering_policies_allowed_branch_ids_check CHECK ((jsonb_typeof(allowed_branch_ids) = 'array'::text)),
    CONSTRAINT provider_catalog_offering_policies_allowed_city_ids_check CHECK ((jsonb_typeof(allowed_city_ids) = 'array'::text)),
    CONSTRAINT provider_catalog_offering_policies_allowed_provider_types_check CHECK ((jsonb_typeof(allowed_provider_types) = 'array'::text)),
    CONSTRAINT provider_catalog_offering_policies_enforcement_state_check CHECK ((enforcement_state = ANY (ARRAY['draft'::text, 'enforced'::text])))
);


--
-- Name: provider_catalog_offering_requirements; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_catalog_offering_requirements (
    id bigint NOT NULL,
    offering_id integer NOT NULL,
    requirement_key text NOT NULL,
    document_type_id text NOT NULL,
    provider_label text NOT NULL,
    provider_description text NOT NULL,
    is_required boolean DEFAULT true NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_catalog_offering_requirements_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.provider_catalog_offering_requirements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: provider_catalog_offering_requirements_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.provider_catalog_offering_requirements_id_seq OWNED BY servana.provider_catalog_offering_requirements.id;


--
-- Name: provider_catalog_offerings; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_catalog_offerings (
    id integer NOT NULL,
    catalog_key character varying(100) NOT NULL,
    name character varying(200) NOT NULL,
    short_description text,
    provider_description text,
    icon_key character varying(100),
    banner_path text,
    display_order integer DEFAULT 0 NOT NULL,
    is_builtin boolean DEFAULT false NOT NULL,
    status character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    provider_web_visible boolean DEFAULT true NOT NULL,
    customer_web_visible boolean DEFAULT false NOT NULL,
    legacy_provider_mobile_visible boolean DEFAULT false NOT NULL,
    legacy_customer_mobile_visible boolean DEFAULT false NOT NULL,
    created_by text,
    updated_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT provider_catalog_offerings_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'active'::character varying, 'archived'::character varying])::text[])))
);


--
-- Name: provider_catalog_offerings_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.provider_catalog_offerings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: provider_catalog_offerings_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.provider_catalog_offerings_id_seq OWNED BY servana.provider_catalog_offerings.id;


--
-- Name: provider_certifications; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_certifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_uid text NOT NULL,
    certification_type text NOT NULL,
    issuing_authority text NOT NULL,
    credential_mask text,
    issue_date date,
    expires_at timestamp with time zone,
    related_document_id integer,
    state text DEFAULT 'under_review'::text NOT NULL,
    renewal_of_id uuid,
    client_request_id text NOT NULL,
    provider_reason_code text,
    provider_reason_detail text,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_client_activity; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_client_activity (
    id bigint NOT NULL,
    provider_uid text NOT NULL,
    activity_type text NOT NULL,
    client text DEFAULT 'mobile'::text NOT NULL,
    confidence text DEFAULT 'high'::text NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_client_activity_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.provider_client_activity_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: provider_client_activity_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.provider_client_activity_id_seq OWNED BY servana.provider_client_activity.id;


--
-- Name: provider_contact_change_requests; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_contact_change_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_uid text NOT NULL,
    contact_kind text NOT NULL,
    normalized_target text NOT NULL,
    target_hash text NOT NULL,
    verification_secret_hash text,
    state text DEFAULT 'pending_verification'::text NOT NULL,
    client_request_id text NOT NULL,
    recent_auth_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    verified_at timestamp with time zone,
    committed_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_contact_change_requests_contact_kind_check CHECK ((contact_kind = ANY (ARRAY['email'::text, 'mobile'::text]))),
    CONSTRAINT provider_contact_change_requests_state_check CHECK ((state = ANY (ARRAY['pending_verification'::text, 'verified'::text, 'committed'::text, 'expired'::text, 'cancelled'::text])))
);


--
-- Name: provider_document_types; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_document_types (
    document_type_id text NOT NULL,
    provider_label text NOT NULL,
    category text NOT NULL,
    expiry_policy text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_document_types_expiry_policy_check CHECK ((expiry_policy = ANY (ARRAY['none'::text, 'optional'::text, 'required'::text])))
);


--
-- Name: provider_notification_device_tokens; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_notification_device_tokens (
    token text NOT NULL,
    worker_uid character varying(128) NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_notification_preferences; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_notification_preferences (
    worker_uid character varying(128) NOT NULL,
    job_assigned boolean DEFAULT true NOT NULL,
    job_reminder boolean DEFAULT false NOT NULL,
    payment_received boolean DEFAULT true NOT NULL,
    new_message boolean DEFAULT true NOT NULL,
    promotions boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    requirement_review boolean DEFAULT true NOT NULL,
    support boolean DEFAULT true NOT NULL,
    account_security boolean DEFAULT true NOT NULL,
    system boolean DEFAULT true NOT NULL
);


--
-- Name: provider_notifications; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_notifications (
    id bigint NOT NULL,
    notification_key character varying(64) DEFAULT (gen_random_uuid())::character varying NOT NULL,
    worker_uid character varying(128) NOT NULL,
    type character varying(64) DEFAULT 'system'::character varying NOT NULL,
    status character varying(32) DEFAULT 'unread'::character varying NOT NULL,
    severity character varying(32) DEFAULT 'info'::character varying NOT NULL,
    title character varying(255) NOT NULL,
    safe_body text NOT NULL,
    safe_context_label character varying(255),
    route jsonb,
    can_mark_read boolean DEFAULT true NOT NULL,
    can_dismiss boolean DEFAULT true NOT NULL,
    can_open_detail boolean DEFAULT false NOT NULL,
    read_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_notifications_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.provider_notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: provider_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.provider_notifications_id_seq OWNED BY servana.provider_notifications.id;


--
-- Name: provider_onboarding_cases; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_onboarding_cases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_uid text NOT NULL,
    onboarding_status text DEFAULT 'not_started'::text NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    assigned_reviewer text,
    assigned_team text,
    waiting_party text,
    submitted_at timestamp with time zone,
    first_review_due_at timestamp with time zone,
    decision_due_at timestamp with time zone,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    reopened_at timestamp with time zone,
    internal_note text,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_onboarding_cases_onboarding_status_check CHECK ((onboarding_status = ANY (ARRAY['not_started'::text, 'in_progress'::text, 'submitted'::text, 'queued'::text, 'in_review'::text, 'waiting_for_provider'::text, 'waiting_for_internal_review'::text, 'escalated'::text, 'ready_for_final_review'::text, 'approved'::text, 'rejected'::text, 'withdrawn'::text, 'expired'::text, 'suspended'::text, 'reopened'::text]))),
    CONSTRAINT provider_onboarding_cases_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT provider_onboarding_cases_waiting_party_check CHECK ((waiting_party = ANY (ARRAY['provider'::text, 'servana'::text, 'external'::text, NULL::text])))
);


--
-- Name: provider_onboarding_drafts; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_onboarding_drafts (
    uid text NOT NULL,
    current_step text DEFAULT 'welcome'::text NOT NULL,
    personal_info jsonb,
    service_ids jsonb,
    service_area jsonb,
    availability jsonb,
    payout jsonb,
    guidelines jsonb,
    submitted boolean DEFAULT false NOT NULL,
    submitted_at timestamp with time zone,
    source_client text DEFAULT 'provider_web'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_onboarding_notes; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_onboarding_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    case_id uuid NOT NULL,
    author_uid text NOT NULL,
    note_type text DEFAULT 'internal'::text NOT NULL,
    body text NOT NULL,
    is_provider_visible boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_onboarding_notes_note_type_check CHECK ((note_type = ANY (ARRAY['internal'::text, 'provider_message'::text, 'escalation'::text])))
);


--
-- Name: provider_onboarding_timeline; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_onboarding_timeline (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    case_id uuid,
    provider_uid text NOT NULL,
    actor_uid text,
    actor_role integer,
    action text NOT NULL,
    domain text DEFAULT 'case'::text NOT NULL,
    target_id text,
    prev_state text,
    next_state text,
    reason_code text,
    internal_reason text,
    provider_message text,
    result_version integer,
    source_client text DEFAULT 'admin'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_operational_availability; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_operational_availability (
    provider_uid text NOT NULL,
    availability_status text DEFAULT 'offline'::text NOT NULL,
    availability_source text DEFAULT 'provider_explicit'::text NOT NULL,
    changed_by_uid text,
    changed_by_role text,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    reason text,
    version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_profile_media_submissions; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_profile_media_submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_uid text NOT NULL,
    media_kind text DEFAULT 'profile_photo'::text NOT NULL,
    private_storage_path text NOT NULL,
    published_storage_path text,
    published_url text,
    mime_type text NOT NULL,
    byte_size integer NOT NULL,
    content_sha256 text NOT NULL,
    scan_status text NOT NULL,
    scanner_engine text,
    state text DEFAULT 'under_review'::text NOT NULL,
    client_request_id text NOT NULL,
    provider_reason_code text,
    provider_reason_detail text,
    internal_note text,
    reviewed_by text,
    reviewed_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_profile_media_submissions_media_kind_check CHECK ((media_kind = 'profile_photo'::text)),
    CONSTRAINT provider_profile_media_submissions_state_check CHECK ((state = ANY (ARRAY['processing'::text, 'under_review'::text, 'approved'::text, 'rejected'::text, 'replaced'::text, 'revoked'::text])))
);


--
-- Name: provider_profile_revisions; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_profile_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_uid text NOT NULL,
    client_request_id text NOT NULL,
    submitted_fields jsonb NOT NULL,
    state text DEFAULT 'pending_review'::text NOT NULL,
    provider_reason_code text,
    provider_reason_detail text,
    internal_note text,
    version integer DEFAULT 1 NOT NULL,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    reviewed_by text
);


--
-- Name: provider_provisional_bookable_services; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_provisional_bookable_services (
    provider_uid text NOT NULL,
    service_id integer NOT NULL,
    source text NOT NULL,
    source_id text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_quality_actions; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_quality_actions (
    action_id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_uid character varying(128) NOT NULL,
    service_id character varying(128),
    action_type character varying(40) NOT NULL,
    state character varying(32) DEFAULT 'OPEN'::character varying NOT NULL,
    provider_reason_code character varying(64) NOT NULL,
    provider_reason_detail text NOT NULL,
    is_mandatory boolean DEFAULT false NOT NULL,
    due_at timestamp with time zone,
    effective_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    policy_version integer DEFAULT 1 NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_rating_aggregates; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_rating_aggregates (
    provider_uid character varying(128) NOT NULL,
    average_rating numeric(3,2) DEFAULT 0 NOT NULL,
    review_count integer DEFAULT 0 NOT NULL,
    rating_1_count integer DEFAULT 0 NOT NULL,
    rating_2_count integer DEFAULT 0 NOT NULL,
    rating_3_count integer DEFAULT 0 NOT NULL,
    rating_4_count integer DEFAULT 0 NOT NULL,
    rating_5_count integer DEFAULT 0 NOT NULL,
    last_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    aggregation_policy_version integer DEFAULT 1 NOT NULL,
    aggregate_version bigint DEFAULT 1 NOT NULL,
    calculated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_requirement_decisions; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_requirement_decisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    worker_requirement_id bigint NOT NULL,
    provider_uid text NOT NULL,
    requirement_definition_code text,
    decision text NOT NULL,
    reason_code text,
    provider_message text,
    internal_rationale text,
    reviewer_uid text NOT NULL,
    decided_at timestamp with time zone DEFAULT now() NOT NULL,
    expected_req_version integer,
    is_superseded boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_requirement_decisions_decision_check CHECK ((decision = ANY (ARRAY['approved'::text, 'rejected'::text, 'needs_resubmission'::text, 'escalated'::text])))
);


--
-- Name: provider_requirement_definitions; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_requirement_definitions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    def_version integer DEFAULT 1 NOT NULL,
    title text NOT NULL,
    provider_facing_title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    category text DEFAULT 'other'::text NOT NULL,
    is_required boolean DEFAULT true NOT NULL,
    applicable_provider_types jsonb DEFAULT '["2", "4"]'::jsonb NOT NULL,
    accepted_mime_types jsonb DEFAULT '["image/jpeg", "image/png", "application/pdf"]'::jsonb NOT NULL,
    max_file_size_bytes bigint DEFAULT 5242880 NOT NULL,
    min_files integer DEFAULT 1 NOT NULL,
    max_files integer DEFAULT 3 NOT NULL,
    provider_instructions text DEFAULT ''::text NOT NULL,
    reviewer_instructions text DEFAULT ''::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    effective_from timestamp with time zone DEFAULT now() NOT NULL,
    effective_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_requirement_definitions_category_check CHECK ((category = ANY (ARRAY['identity'::text, 'background'::text, 'qualification'::text, 'profile'::text, 'financial'::text, 'service_specific'::text, 'other'::text])))
);


--
-- Name: provider_review_reason_codes; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_review_reason_codes (
    code text NOT NULL,
    domain text NOT NULL,
    applicable_decisions jsonb DEFAULT '[]'::jsonb NOT NULL,
    internal_label text NOT NULL,
    provider_facing_title text NOT NULL,
    provider_facing_body text NOT NULL,
    suggested_correction text DEFAULT ''::text NOT NULL,
    requires_free_text boolean DEFAULT false NOT NULL,
    requires_escalation boolean DEFAULT false NOT NULL,
    provider_may_resubmit boolean DEFAULT true NOT NULL,
    is_sensitive boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    restricts_scope text,
    may_auto_lift boolean DEFAULT false NOT NULL,
    reapplication_wait_days integer
);


--
-- Name: provider_service_area_catalog; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_service_area_catalog (
    area_id text NOT NULL,
    provider_label text NOT NULL,
    province text NOT NULL,
    is_supported boolean DEFAULT false NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_service_rating_aggregates; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_service_rating_aggregates (
    provider_uid character varying(128) NOT NULL,
    service_id character varying(128) NOT NULL,
    average_rating numeric(4,3),
    review_count integer DEFAULT 0 NOT NULL,
    aggregation_policy_version integer DEFAULT 1 NOT NULL,
    aggregate_version bigint DEFAULT 1 NOT NULL,
    calculated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_source_attribution; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_source_attribution (
    uid text NOT NULL,
    registration_source text DEFAULT 'unknown'::text NOT NULL,
    first_seen_source text DEFAULT 'unknown'::text NOT NULL,
    last_seen_source text DEFAULT 'unknown'::text NOT NULL,
    first_provider_web_seen_at timestamp with time zone,
    last_provider_web_seen_at timestamp with time zone,
    first_provider_mobile_seen_at timestamp with time zone,
    last_provider_mobile_seen_at timestamp with time zone,
    registration_context text,
    confidence text DEFAULT 'unknown'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_support_cases; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_support_cases (
    case_id uuid DEFAULT gen_random_uuid() NOT NULL,
    public_reference character varying(32) NOT NULL,
    provider_uid character varying(128) NOT NULL,
    account_uid character varying(128) NOT NULL,
    organization_id character varying(128),
    branch_id character varying(128),
    domain character varying(32) NOT NULL,
    category_id character varying(64) NOT NULL,
    subcategory character varying(64),
    title character varying(160) NOT NULL,
    provider_narrative text NOT NULL,
    desired_outcome text,
    provider_state character varying(40) DEFAULT 'SUBMITTED'::character varying NOT NULL,
    internal_state character varying(48) DEFAULT 'NEW'::character varying NOT NULL,
    severity character varying(16) DEFAULT 'STANDARD'::character varying NOT NULL,
    priority character varying(16) DEFAULT 'NORMAL'::character varying NOT NULL,
    safety_classification character varying(32) DEFAULT 'NONE'::character varying NOT NULL,
    immediate_danger boolean DEFAULT false NOT NULL,
    current_queue character varying(64) NOT NULL,
    assigned_role character varying(64),
    assigned_admin_uid character varying(128),
    provider_action_required boolean DEFAULT false NOT NULL,
    servana_action_required boolean DEFAULT true NOT NULL,
    sla_policy_code character varying(64) NOT NULL,
    first_response_target_at timestamp with time zone,
    resolution_target_at timestamp with time zone,
    escalation_due_at timestamp with time zone,
    last_provider_visible_update_at timestamp with time zone DEFAULT now() NOT NULL,
    escalation_state character varying(32) DEFAULT 'NONE'::character varying NOT NULL,
    resolution_code character varying(64),
    appeal_eligible boolean DEFAULT false NOT NULL,
    appeal_deadline_at timestamp with time zone,
    client_request_id character varying(128) NOT NULL,
    policy_version integer DEFAULT 1 NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    closed_at timestamp with time zone
);


--
-- Name: provider_support_ticket_replies; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_support_ticket_replies (
    id bigint NOT NULL,
    ticket_key character varying(64) NOT NULL,
    sender_type character varying(32) DEFAULT 'provider'::character varying NOT NULL,
    safe_body text NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_support_ticket_replies_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.provider_support_ticket_replies_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: provider_support_ticket_replies_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.provider_support_ticket_replies_id_seq OWNED BY servana.provider_support_ticket_replies.id;


--
-- Name: provider_support_tickets; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_support_tickets (
    id bigint NOT NULL,
    ticket_key character varying(64) DEFAULT (gen_random_uuid())::character varying NOT NULL,
    worker_uid character varying(128) NOT NULL,
    category character varying(64) DEFAULT 'other'::character varying NOT NULL,
    status character varying(64) DEFAULT 'submitted'::character varying NOT NULL,
    title character varying(100) NOT NULL,
    description text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_support_tickets_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.provider_support_tickets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: provider_support_tickets_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.provider_support_tickets_id_seq OWNED BY servana.provider_support_tickets.id;


--
-- Name: provider_verification_events; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.provider_verification_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_uid text NOT NULL,
    domain text NOT NULL,
    source_type text NOT NULL,
    source_id text,
    event_type text NOT NULL,
    provider_reason_code text,
    provider_reason_detail text,
    internal_metadata jsonb,
    event_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: review_appeals; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.review_appeals (
    appeal_id uuid DEFAULT gen_random_uuid() NOT NULL,
    case_id uuid NOT NULL,
    review_id uuid NOT NULL,
    provider_uid character varying(128) NOT NULL,
    ground character varying(64) NOT NULL,
    explanation text NOT NULL,
    state character varying(32) DEFAULT 'SUBMITTED'::character varying NOT NULL,
    provider_reason_code character varying(64),
    provider_reason_detail text,
    internal_notes text,
    client_request_id character varying(128) NOT NULL,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL
);


--
-- Name: review_dimension_definitions; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.review_dimension_definitions (
    dimension_key character varying(50) NOT NULL,
    provider_label character varying(100) NOT NULL,
    description text NOT NULL,
    is_public boolean DEFAULT true NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL
);


--
-- Name: review_dimension_scores; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.review_dimension_scores (
    id bigint NOT NULL,
    review_id uuid NOT NULL,
    dimension_key character varying(50) NOT NULL,
    score integer NOT NULL,
    CONSTRAINT review_dimension_scores_score_check CHECK (((score >= 1) AND (score <= 5)))
);


--
-- Name: review_dimension_scores_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.review_dimension_scores_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: review_dimension_scores_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.review_dimension_scores_id_seq OWNED BY servana.review_dimension_scores.id;


--
-- Name: review_moderation_cases; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.review_moderation_cases (
    case_id uuid DEFAULT gen_random_uuid() NOT NULL,
    review_id uuid NOT NULL,
    report_id uuid,
    state character varying(32) DEFAULT 'PENDING_REVIEW'::character varying NOT NULL,
    public_effect character varying(32) DEFAULT 'UNCHANGED'::character varying NOT NULL,
    provider_reason_code character varying(64),
    provider_reason_detail text,
    internal_notes text,
    assigned_admin_uid character varying(128),
    decision_admin_uid character varying(128),
    decision_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL
);


--
-- Name: review_policy_versions; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.review_policy_versions (
    policy_version integer NOT NULL,
    rating_min integer NOT NULL,
    rating_max integer NOT NULL,
    review_window_days integer NOT NULL,
    edit_window_hours integer NOT NULL,
    response_window_days integer NOT NULL,
    appeal_window_days integer NOT NULL,
    minimum_dimension_sample integer NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    retired_at timestamp with time zone,
    CONSTRAINT review_policy_versions_appeal_window_days_check CHECK ((appeal_window_days > 0)),
    CONSTRAINT review_policy_versions_edit_window_hours_check CHECK ((edit_window_hours > 0)),
    CONSTRAINT review_policy_versions_minimum_dimension_sample_check CHECK ((minimum_dimension_sample > 0)),
    CONSTRAINT review_policy_versions_rating_max_check CHECK ((rating_max = 5)),
    CONSTRAINT review_policy_versions_rating_min_check CHECK ((rating_min = 1)),
    CONSTRAINT review_policy_versions_response_window_days_check CHECK ((response_window_days > 0)),
    CONSTRAINT review_policy_versions_review_window_days_check CHECK ((review_window_days > 0))
);


--
-- Name: review_provider_responses; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.review_provider_responses (
    response_id uuid DEFAULT gen_random_uuid() NOT NULL,
    review_id uuid NOT NULL,
    provider_uid character varying(128) NOT NULL,
    body text NOT NULL,
    moderation_status character varying(30) DEFAULT 'NOT_REQUIRED'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    client_request_id character varying(128),
    publication_state character varying(32) DEFAULT 'PENDING_MODERATION'::character varying NOT NULL,
    version integer DEFAULT 1 NOT NULL
);


--
-- Name: review_reports; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.review_reports (
    report_id uuid DEFAULT gen_random_uuid() NOT NULL,
    review_id uuid,
    response_id uuid,
    reporter_uid character varying(128) NOT NULL,
    reason character varying(50) NOT NULL,
    details text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    client_request_id character varying(128),
    state character varying(32) DEFAULT 'SUBMITTED'::character varying NOT NULL,
    provider_reason_detail text,
    version integer DEFAULT 1 NOT NULL
);


--
-- Name: review_reputation_events; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.review_reputation_events (
    event_id bigint NOT NULL,
    review_id uuid NOT NULL,
    provider_uid character varying(128) NOT NULL,
    event_type character varying(64) NOT NULL,
    actor_type character varying(32) NOT NULL,
    actor_uid character varying(128),
    public_detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    restricted_detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    idempotency_key character varying(160),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: review_reputation_events_event_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.review_reputation_events_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: review_reputation_events_event_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.review_reputation_events_event_id_seq OWNED BY servana.review_reputation_events.event_id;


--
-- Name: review_response_moderation_cases; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.review_response_moderation_cases (
    case_id uuid DEFAULT gen_random_uuid() NOT NULL,
    response_id uuid NOT NULL,
    review_id uuid NOT NULL,
    provider_uid character varying(128) NOT NULL,
    state character varying(32) DEFAULT 'PENDING_REVIEW'::character varying NOT NULL,
    provider_reason_code character varying(64),
    provider_reason_detail text,
    internal_notes text,
    assigned_admin_uid character varying(128),
    decision_admin_uid character varying(128),
    decision_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL
);


--
-- Name: roles; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.roles (
    role_id integer NOT NULL,
    role_name character varying NOT NULL,
    description character varying
);


--
-- Name: service_coverage; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.service_coverage (
    id integer NOT NULL,
    service_id integer,
    city character varying(100),
    area character varying(100),
    is_active boolean DEFAULT true,
    center_lat numeric,
    center_lon numeric,
    radius_km numeric
);


--
-- Name: service_coverage_geo; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.service_coverage_geo (
    id integer NOT NULL,
    service_id integer NOT NULL,
    center_lat numeric NOT NULL,
    center_lon numeric NOT NULL,
    radius_km numeric NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: service_coverage_geo_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.service_coverage_geo_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: service_coverage_geo_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.service_coverage_geo_id_seq OWNED BY servana.service_coverage_geo.id;


--
-- Name: service_coverage_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.service_coverage_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: service_coverage_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.service_coverage_id_seq OWNED BY servana.service_coverage.id;


--
-- Name: service_families; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.service_families (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    category character varying(100),
    created_at timestamp without time zone DEFAULT now(),
    service_type character varying(20) DEFAULT 'HOME'::character varying NOT NULL,
    worker_title character varying(50),
    worker_role integer,
    deleted_at timestamp without time zone
);


--
-- Name: TABLE service_families; Type: COMMENT; Schema: servana; Owner: -
--

COMMENT ON TABLE servana.service_families IS 'LEGACY coarse service families. Retained for provenance: employee_services, worker_service_applications, service_options, branches and coverage still key on these ids. Not the canonical catalog hierarchy and not for everyday management.';


--
-- Name: service_option_meta; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.service_option_meta (
    id integer NOT NULL,
    service_option_id integer,
    inclusions jsonb DEFAULT '[]'::jsonb,
    exclusions jsonb DEFAULT '[]'::jsonb,
    description text
);


--
-- Name: service_option_meta_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.service_option_meta_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: service_option_meta_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.service_option_meta_id_seq OWNED BY servana.service_option_meta.id;


--
-- Name: service_options; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.service_options (
    id integer NOT NULL,
    service_id integer NOT NULL,
    level_2 character varying(100),
    level_3 character varying(150),
    unit character varying(50),
    base_price numeric DEFAULT 0,
    option_type character varying(20) DEFAULT 'MAIN'::character varying,
    parent_option_id integer,
    created_at timestamp without time zone DEFAULT now(),
    is_active boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    duration_mins integer DEFAULT 120 NOT NULL,
    banner_url text
);


--
-- Name: service_options_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.service_options_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: service_options_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.service_options_id_seq OWNED BY servana.service_options.id;


--
-- Name: service_review_dimensions; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.service_review_dimensions (
    service_id bigint NOT NULL,
    dimension_key character varying(50) NOT NULL,
    is_required boolean DEFAULT false NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    policy_version integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: services_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.services_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: services_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.services_id_seq OWNED BY servana.service_families.id;


--
-- Name: support_case_appeals; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.support_case_appeals (
    appeal_id uuid DEFAULT gen_random_uuid() NOT NULL,
    case_id uuid NOT NULL,
    provider_uid character varying(128) NOT NULL,
    resolution_id uuid NOT NULL,
    ground character varying(64) NOT NULL,
    explanation text NOT NULL,
    state character varying(32) DEFAULT 'SUBMITTED'::character varying NOT NULL,
    client_request_id character varying(128) NOT NULL,
    provider_reason_code character varying(64),
    provider_reason_detail text,
    internal_notes text,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL
);


--
-- Name: support_case_attachments; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.support_case_attachments (
    attachment_id uuid DEFAULT gen_random_uuid() NOT NULL,
    case_id uuid NOT NULL,
    provider_uid character varying(128) NOT NULL,
    private_storage_path text NOT NULL,
    safe_file_name character varying(180) NOT NULL,
    mime_type character varying(100) NOT NULL,
    byte_size bigint NOT NULL,
    content_sha256 character(64) NOT NULL,
    scan_status character varying(24) NOT NULL,
    scanner_engine character varying(80),
    evidence_class character varying(32) DEFAULT 'STANDARD'::character varying NOT NULL,
    state character varying(24) DEFAULT 'AVAILABLE'::character varying NOT NULL,
    client_request_id character varying(128) NOT NULL,
    retention_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: support_case_categories; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.support_case_categories (
    category_id character varying(64) NOT NULL,
    domain character varying(32) NOT NULL,
    provider_title character varying(120) NOT NULL,
    provider_description text NOT NULL,
    eligible_source_types jsonb DEFAULT '[]'::jsonb NOT NULL,
    required_fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    evidence_policy character varying(32) DEFAULT 'OPTIONAL'::character varying NOT NULL,
    default_severity character varying(16) DEFAULT 'STANDARD'::character varying NOT NULL,
    routing_queue character varying(64) NOT NULL,
    sla_policy_code character varying(64) NOT NULL,
    reopen_window_days integer DEFAULT 14 NOT NULL,
    appeal_window_days integer DEFAULT 14 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    policy_version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: support_case_escalations; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.support_case_escalations (
    escalation_id uuid DEFAULT gen_random_uuid() NOT NULL,
    case_id uuid NOT NULL,
    escalation_type character varying(32) NOT NULL,
    source_queue character varying(64) NOT NULL,
    destination_queue character varying(64) NOT NULL,
    trigger_code character varying(64) NOT NULL,
    state character varying(24) DEFAULT 'ACTIVE'::character varying NOT NULL,
    created_by_uid character varying(128),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone
);


--
-- Name: support_case_events; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.support_case_events (
    event_id bigint NOT NULL,
    case_id uuid NOT NULL,
    event_type character varying(64) NOT NULL,
    actor_type character varying(24) NOT NULL,
    actor_uid character varying(128),
    provider_visible boolean DEFAULT true NOT NULL,
    provider_label character varying(160),
    public_detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    restricted_detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    idempotency_key character varying(160),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: support_case_events_event_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.support_case_events_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: support_case_events_event_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.support_case_events_event_id_seq OWNED BY servana.support_case_events.event_id;


--
-- Name: support_case_internal_notes; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.support_case_internal_notes (
    note_id uuid DEFAULT gen_random_uuid() NOT NULL,
    case_id uuid NOT NULL,
    admin_uid character varying(128) NOT NULL,
    note_body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: support_case_messages; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.support_case_messages (
    message_id uuid DEFAULT gen_random_uuid() NOT NULL,
    case_id uuid NOT NULL,
    sender_type character varying(24) NOT NULL,
    sender_uid character varying(128),
    provider_visible_body text NOT NULL,
    client_request_id character varying(128),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: support_case_resolutions; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.support_case_resolutions (
    resolution_id uuid DEFAULT gen_random_uuid() NOT NULL,
    case_id uuid NOT NULL,
    resolution_code character varying(64) NOT NULL,
    provider_explanation text NOT NULL,
    internal_explanation text,
    source_actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    approval_state character varying(24) DEFAULT 'APPROVED'::character varying NOT NULL,
    applied_by_uid character varying(128) NOT NULL,
    applied_by_role character varying(64) NOT NULL,
    appeal_eligible boolean DEFAULT false NOT NULL,
    client_request_id character varying(128) NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: support_case_sources; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.support_case_sources (
    source_link_id uuid DEFAULT gen_random_uuid() NOT NULL,
    case_id uuid NOT NULL,
    provider_uid character varying(128) NOT NULL,
    source_type character varying(32) NOT NULL,
    source_id character varying(128) NOT NULL,
    safe_label character varying(160) NOT NULL,
    source_version character varying(64),
    linked_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_address; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.user_address (
    address_id character varying NOT NULL,
    uid character varying NOT NULL,
    location_id character varying,
    address_one character varying(255) NOT NULL,
    address_two character varying(255),
    zip_code character varying(20),
    post_town character varying(100),
    country character varying(100) NOT NULL,
    label character varying(50),
    is_primary boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    created_by character varying,
    updated_at timestamp without time zone DEFAULT now(),
    updated_by character varying
);


--
-- Name: user_credentials; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.user_credentials (
    uid character varying NOT NULL,
    email character varying(255),
    first_name character varying(100) NOT NULL,
    last_name character varying(100) NOT NULL,
    role character varying(50) NOT NULL,
    created_date timestamp without time zone DEFAULT now() NOT NULL,
    password text,
    phone_number character varying,
    is_archive boolean DEFAULT false,
    is_email_verified boolean DEFAULT false NOT NULL,
    is_phone_verified boolean DEFAULT false NOT NULL,
    fcm_token character varying,
    worker_code character varying,
    account_status text DEFAULT 'pending'::text NOT NULL,
    is_internal_fixer boolean DEFAULT false,
    last_activity_at timestamp with time zone,
    email_normalized character varying(254),
    phone_normalized character varying(20),
    is_mobile_verified boolean DEFAULT false NOT NULL
);


--
-- Name: user_profile; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.user_profile (
    uid character varying NOT NULL,
    birthdate date,
    gender character varying(30),
    photo_url text,
    updated_at timestamp with time zone DEFAULT now(),
    service_preference character varying(100),
    public_display_name text,
    public_bio text,
    public_skills jsonb DEFAULT '[]'::jsonb NOT NULL,
    public_languages jsonb DEFAULT '[]'::jsonb NOT NULL,
    public_experience_summary text,
    legal_address jsonb,
    profile_version integer DEFAULT 1 NOT NULL,
    public_profile_version integer DEFAULT 1 NOT NULL
);


--
-- Name: worker_availability; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.worker_availability (
    worker_uid text NOT NULL,
    schedule jsonb DEFAULT '{}'::jsonb NOT NULL,
    timezone text DEFAULT 'Asia/Manila'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    version integer DEFAULT 1 NOT NULL
);


--
-- Name: worker_bank_accounts; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.worker_bank_accounts (
    worker_uid text NOT NULL,
    bank_code text NOT NULL,
    account_number text NOT NULL,
    account_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: worker_notification_prefs; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.worker_notification_prefs (
    worker_uid text NOT NULL,
    job_assigned boolean DEFAULT true NOT NULL,
    job_reminder boolean DEFAULT true NOT NULL,
    payment_received boolean DEFAULT true NOT NULL,
    new_message boolean DEFAULT true NOT NULL,
    promotions boolean DEFAULT false NOT NULL,
    quiet_hours jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: worker_requirements; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.worker_requirements (
    id integer NOT NULL,
    worker_uid text NOT NULL,
    file_url text NOT NULL,
    file_name text NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    requirement_type character varying(100),
    storage_path text,
    mime_type text,
    byte_size integer,
    content_sha256 text,
    client_request_id text,
    lifecycle_state text DEFAULT 'legacy_review_required'::text NOT NULL,
    scan_status text DEFAULT 'legacy_review_required'::text NOT NULL,
    issue_date date,
    expires_at timestamp with time zone,
    identifier_mask text,
    replacement_for_id integer,
    replaced_by_id integer,
    version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    scanner_engine text
);


--
-- Name: worker_requirements_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.worker_requirements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: worker_requirements_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.worker_requirements_id_seq OWNED BY servana.worker_requirements.id;


--
-- Name: worker_service_application_timeline; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.worker_service_application_timeline (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id uuid NOT NULL,
    event_key text NOT NULL,
    event_code text NOT NULL,
    provider_label text NOT NULL,
    provider_explanation text,
    actor_category text DEFAULT 'system'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: worker_service_applications; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.worker_service_applications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    worker_uid text NOT NULL,
    service_id integer NOT NULL,
    status text DEFAULT 'pending_review'::text NOT NULL,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    cancelled_at timestamp with time zone,
    approved_at timestamp with time zone,
    reviewed_at timestamp with time zone,
    reviewed_by text,
    review_reason text,
    version integer DEFAULT 1 NOT NULL,
    provider_reason_code text,
    provider_reason_detail text,
    client_request_id character varying(128),
    requirements_version integer DEFAULT 1 NOT NULL,
    service_snapshot jsonb,
    CONSTRAINT worker_service_applications_status_check CHECK ((status = ANY (ARRAY['pending_review'::text, 'action_required'::text, 'rejected'::text, 'cancelled'::text, 'approved'::text])))
);


--
-- Name: worker_service_areas; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.worker_service_areas (
    worker_uid text NOT NULL,
    city_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    label text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    coverage_mode text DEFAULT 'city'::text NOT NULL,
    branch_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    radius_km numeric(6,2),
    updated_by text,
    version integer DEFAULT 1 NOT NULL
);


--
-- Name: worker_time_off; Type: TABLE; Schema: servana; Owner: -
--

CREATE TABLE servana.worker_time_off (
    id integer NOT NULL,
    worker_uid text NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text,
    status text DEFAULT 'active'::text NOT NULL,
    cancelled_at timestamp with time zone,
    cancelled_by text,
    all_day boolean DEFAULT true NOT NULL,
    start_time time without time zone,
    end_time time without time zone,
    note text
);


--
-- Name: worker_time_off_id_seq; Type: SEQUENCE; Schema: servana; Owner: -
--

CREATE SEQUENCE servana.worker_time_off_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: worker_time_off_id_seq; Type: SEQUENCE OWNED BY; Schema: servana; Owner: -
--

ALTER SEQUENCE servana.worker_time_off_id_seq OWNED BY servana.worker_time_off.id;


--
-- Name: account_deletion_requests id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.account_deletion_requests ALTER COLUMN id SET DEFAULT nextval('servana.account_deletion_requests_id_seq'::regclass);


--
-- Name: admin_audit_events id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.admin_audit_events ALTER COLUMN id SET DEFAULT nextval('servana.admin_audit_events_id_seq'::regclass);


--
-- Name: admin_booking_drafts id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.admin_booking_drafts ALTER COLUMN id SET DEFAULT nextval('servana.admin_booking_drafts_id_seq'::regclass);


--
-- Name: admin_communication_events id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.admin_communication_events ALTER COLUMN id SET DEFAULT nextval('servana.admin_communication_events_id_seq'::regclass);


--
-- Name: admin_notification_templates id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.admin_notification_templates ALTER COLUMN id SET DEFAULT nextval('servana.admin_notification_templates_id_seq'::regclass);


--
-- Name: admin_notifications id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.admin_notifications ALTER COLUMN id SET DEFAULT nextval('servana.admin_notifications_id_seq'::regclass);


--
-- Name: booking_additional_items id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_additional_items ALTER COLUMN id SET DEFAULT nextval('servana.booking_additional_items_id_seq'::regclass);


--
-- Name: booking_additional_requests id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_additional_requests ALTER COLUMN id SET DEFAULT nextval('servana.booking_additional_requests_id_seq'::regclass);


--
-- Name: booking_addons id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_addons ALTER COLUMN id SET DEFAULT nextval('servana.booking_addons_id_seq'::regclass);


--
-- Name: booking_audit_events id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_audit_events ALTER COLUMN id SET DEFAULT nextval('servana.booking_audit_events_id_seq'::regclass);


--
-- Name: booking_create_idempotency id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_create_idempotency ALTER COLUMN id SET DEFAULT nextval('servana.booking_create_idempotency_id_seq'::regclass);


--
-- Name: booking_escalations id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_escalations ALTER COLUMN id SET DEFAULT nextval('servana.booking_escalations_id_seq'::regclass);


--
-- Name: booking_notes id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_notes ALTER COLUMN id SET DEFAULT nextval('servana.booking_notes_id_seq'::regclass);


--
-- Name: booking_payment_evidence id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_payment_evidence ALTER COLUMN id SET DEFAULT nextval('servana.booking_payment_evidence_id_seq'::regclass);


--
-- Name: booking_timeline_events id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_timeline_events ALTER COLUMN id SET DEFAULT nextval('servana.booking_timeline_events_id_seq'::regclass);


--
-- Name: booking_tracking id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_tracking ALTER COLUMN id SET DEFAULT nextval('servana.booking_tracking_id_seq'::regclass);


--
-- Name: booking_workers id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_workers ALTER COLUMN id SET DEFAULT nextval('servana.booking_technicians_id_seq'::regclass);


--
-- Name: bookings id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.bookings ALTER COLUMN id SET DEFAULT nextval('servana.bookings_id_seq'::regclass);


--
-- Name: branch_slots id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.branch_slots ALTER COLUMN id SET DEFAULT nextval('servana.branch_slots_id_seq'::regclass);


--
-- Name: branches id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.branches ALTER COLUMN id SET DEFAULT nextval('servana.branches_id_seq'::regclass);


--
-- Name: catalog_categories id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.catalog_categories ALTER COLUMN id SET DEFAULT nextval('servana.catalog_categories_id_seq'::regclass);


--
-- Name: catalog_provider_services id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.catalog_provider_services ALTER COLUMN id SET DEFAULT nextval('servana.catalog_provider_services_id_seq'::regclass);


--
-- Name: catalog_subcategories id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.catalog_subcategories ALTER COLUMN id SET DEFAULT nextval('servana.catalog_subcategories_id_seq'::regclass);


--
-- Name: chat_conversations id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.chat_conversations ALTER COLUMN id SET DEFAULT nextval('servana.chat_conversations_id_seq'::regclass);


--
-- Name: chat_message_attachments id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.chat_message_attachments ALTER COLUMN id SET DEFAULT nextval('servana.chat_message_attachments_id_seq'::regclass);


--
-- Name: chat_message_reports id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.chat_message_reports ALTER COLUMN id SET DEFAULT nextval('servana.chat_message_reports_id_seq'::regclass);


--
-- Name: chat_messages id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.chat_messages ALTER COLUMN id SET DEFAULT nextval('servana.chat_messages_id_seq'::regclass);


--
-- Name: chat_participants id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.chat_participants ALTER COLUMN id SET DEFAULT nextval('servana.chat_participants_id_seq'::regclass);


--
-- Name: customer_notifications id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.customer_notifications ALTER COLUMN id SET DEFAULT nextval('servana.customer_notifications_id_seq'::regclass);


--
-- Name: customer_support_ticket_replies id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.customer_support_ticket_replies ALTER COLUMN id SET DEFAULT nextval('servana.customer_support_ticket_replies_id_seq'::regclass);


--
-- Name: customer_support_tickets id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.customer_support_tickets ALTER COLUMN id SET DEFAULT nextval('servana.customer_support_tickets_id_seq'::regclass);


--
-- Name: disbursements id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.disbursements ALTER COLUMN id SET DEFAULT nextval('servana.disbursements_id_seq'::regclass);


--
-- Name: email_otps id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.email_otps ALTER COLUMN id SET DEFAULT nextval('servana.email_otps_id_seq'::regclass);


--
-- Name: employee_catalog_capabilities id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.employee_catalog_capabilities ALTER COLUMN id SET DEFAULT nextval('servana.employee_catalog_capabilities_id_seq'::regclass);


--
-- Name: employee_services id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.employee_services ALTER COLUMN id SET DEFAULT nextval('servana.employee_services_id_seq'::regclass);


--
-- Name: finance_ledger_entries id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.finance_ledger_entries ALTER COLUMN id SET DEFAULT nextval('servana.finance_ledger_entries_id_seq'::regclass);


--
-- Name: finance_reconciliation_exceptions id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.finance_reconciliation_exceptions ALTER COLUMN id SET DEFAULT nextval('servana.finance_reconciliation_exceptions_id_seq'::regclass);


--
-- Name: finance_refund_reviews id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.finance_refund_reviews ALTER COLUMN id SET DEFAULT nextval('servana.finance_refund_reviews_id_seq'::regclass);


--
-- Name: guest_customers id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.guest_customers ALTER COLUMN id SET DEFAULT nextval('servana.guest_customers_id_seq'::regclass);


--
-- Name: payments id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.payments ALTER COLUMN id SET DEFAULT nextval('servana.payments_id_seq'::regclass);


--
-- Name: pricing_modifiers id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.pricing_modifiers ALTER COLUMN id SET DEFAULT nextval('servana.pricing_modifiers_id_seq'::regclass);


--
-- Name: provider_activation_events id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_activation_events ALTER COLUMN id SET DEFAULT nextval('servana.provider_activation_events_id_seq'::regclass);


--
-- Name: provider_alerts id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_alerts ALTER COLUMN id SET DEFAULT nextval('servana.provider_alerts_id_seq'::regclass);


--
-- Name: provider_catalog_offering_mappings id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_catalog_offering_mappings ALTER COLUMN id SET DEFAULT nextval('servana.provider_catalog_offering_mappings_id_seq'::regclass);


--
-- Name: provider_catalog_offering_requirements id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_catalog_offering_requirements ALTER COLUMN id SET DEFAULT nextval('servana.provider_catalog_offering_requirements_id_seq'::regclass);


--
-- Name: provider_catalog_offerings id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_catalog_offerings ALTER COLUMN id SET DEFAULT nextval('servana.provider_catalog_offerings_id_seq'::regclass);


--
-- Name: provider_client_activity id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_client_activity ALTER COLUMN id SET DEFAULT nextval('servana.provider_client_activity_id_seq'::regclass);


--
-- Name: provider_notifications id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications ALTER COLUMN id SET DEFAULT nextval('servana.provider_notifications_id_seq'::regclass);


--
-- Name: provider_support_ticket_replies id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_support_ticket_replies ALTER COLUMN id SET DEFAULT nextval('servana.provider_support_ticket_replies_id_seq'::regclass);


--
-- Name: provider_support_tickets id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_support_tickets ALTER COLUMN id SET DEFAULT nextval('servana.provider_support_tickets_id_seq'::regclass);


--
-- Name: review_dimension_scores id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_dimension_scores ALTER COLUMN id SET DEFAULT nextval('servana.review_dimension_scores_id_seq'::regclass);


--
-- Name: review_reputation_events event_id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_reputation_events ALTER COLUMN event_id SET DEFAULT nextval('servana.review_reputation_events_event_id_seq'::regclass);


--
-- Name: service_coverage id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.service_coverage ALTER COLUMN id SET DEFAULT nextval('servana.service_coverage_id_seq'::regclass);


--
-- Name: service_coverage_geo id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.service_coverage_geo ALTER COLUMN id SET DEFAULT nextval('servana.service_coverage_geo_id_seq'::regclass);


--
-- Name: service_families id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.service_families ALTER COLUMN id SET DEFAULT nextval('servana.services_id_seq'::regclass);


--
-- Name: service_option_meta id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.service_option_meta ALTER COLUMN id SET DEFAULT nextval('servana.service_option_meta_id_seq'::regclass);


--
-- Name: service_options id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.service_options ALTER COLUMN id SET DEFAULT nextval('servana.service_options_id_seq'::regclass);


--
-- Name: services id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.services ALTER COLUMN id SET DEFAULT nextval('servana.catalog_services_id_seq'::regclass);


--
-- Name: support_case_events event_id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_events ALTER COLUMN event_id SET DEFAULT nextval('servana.support_case_events_event_id_seq'::regclass);


--
-- Name: worker_requirements id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.worker_requirements ALTER COLUMN id SET DEFAULT nextval('servana.worker_requirements_id_seq'::regclass);


--
-- Name: worker_time_off id; Type: DEFAULT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.worker_time_off ALTER COLUMN id SET DEFAULT nextval('servana.worker_time_off_id_seq'::regclass);


--
-- Name: account_deletion_requests account_deletion_requests_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.account_deletion_requests
    ADD CONSTRAINT account_deletion_requests_pkey PRIMARY KEY (id);


--
-- Name: admin_audit_events admin_audit_events_event_id_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.admin_audit_events
    ADD CONSTRAINT admin_audit_events_event_id_key UNIQUE (event_id);


--
-- Name: admin_audit_events admin_audit_events_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.admin_audit_events
    ADD CONSTRAINT admin_audit_events_pkey PRIMARY KEY (id);


--
-- Name: admin_booking_drafts admin_booking_drafts_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.admin_booking_drafts
    ADD CONSTRAINT admin_booking_drafts_pkey PRIMARY KEY (id);


--
-- Name: admin_communication_events admin_communication_events_event_key_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.admin_communication_events
    ADD CONSTRAINT admin_communication_events_event_key_key UNIQUE (event_key);


--
-- Name: admin_communication_events admin_communication_events_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.admin_communication_events
    ADD CONSTRAINT admin_communication_events_pkey PRIMARY KEY (id);


--
-- Name: admin_notification_templates admin_notification_templates_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.admin_notification_templates
    ADD CONSTRAINT admin_notification_templates_pkey PRIMARY KEY (id);


--
-- Name: admin_notification_templates admin_notification_templates_template_key_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.admin_notification_templates
    ADD CONSTRAINT admin_notification_templates_template_key_key UNIQUE (template_key);


--
-- Name: admin_notifications admin_notifications_admin_uid_notification_key_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.admin_notifications
    ADD CONSTRAINT admin_notifications_admin_uid_notification_key_key UNIQUE (admin_uid, notification_key);


--
-- Name: admin_notifications admin_notifications_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.admin_notifications
    ADD CONSTRAINT admin_notifications_pkey PRIMARY KEY (id);


--
-- Name: admin_permission_definitions admin_permission_definitions_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.admin_permission_definitions
    ADD CONSTRAINT admin_permission_definitions_pkey PRIMARY KEY (permission_key);


--
-- Name: admin_permission_events admin_permission_events_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.admin_permission_events
    ADD CONSTRAINT admin_permission_events_pkey PRIMARY KEY (event_id);


--
-- Name: admin_permission_grants admin_permission_grants_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.admin_permission_grants
    ADD CONSTRAINT admin_permission_grants_pkey PRIMARY KEY (id);


--
-- Name: admin_users admin_users_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.admin_users
    ADD CONSTRAINT admin_users_pkey PRIMARY KEY (admin_uid);


--
-- Name: booking_additional_items booking_additional_items_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_additional_items
    ADD CONSTRAINT booking_additional_items_pkey PRIMARY KEY (id);


--
-- Name: booking_additional_requests booking_additional_requests_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_additional_requests
    ADD CONSTRAINT booking_additional_requests_pkey PRIMARY KEY (id);


--
-- Name: booking_addons booking_addons_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_addons
    ADD CONSTRAINT booking_addons_pkey PRIMARY KEY (id);


--
-- Name: booking_audit_events booking_audit_events_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_audit_events
    ADD CONSTRAINT booking_audit_events_pkey PRIMARY KEY (id);


--
-- Name: booking_create_idempotency booking_create_idempotency_idempotency_key_admin_actor_uid_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_create_idempotency
    ADD CONSTRAINT booking_create_idempotency_idempotency_key_admin_actor_uid_key UNIQUE (idempotency_key, actor_uid);


--
-- Name: booking_create_idempotency booking_create_idempotency_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_create_idempotency
    ADD CONSTRAINT booking_create_idempotency_pkey PRIMARY KEY (id);


--
-- Name: booking_escalations booking_escalations_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_escalations
    ADD CONSTRAINT booking_escalations_pkey PRIMARY KEY (id);


--
-- Name: booking_notes booking_notes_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_notes
    ADD CONSTRAINT booking_notes_pkey PRIMARY KEY (id);


--
-- Name: booking_payment_evidence booking_payment_evidence_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_payment_evidence
    ADD CONSTRAINT booking_payment_evidence_pkey PRIMARY KEY (id);


--
-- Name: booking_workers booking_technicians_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_workers
    ADD CONSTRAINT booking_technicians_pkey PRIMARY KEY (id);


--
-- Name: booking_timeline_events booking_timeline_events_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_timeline_events
    ADD CONSTRAINT booking_timeline_events_pkey PRIMARY KEY (id);


--
-- Name: booking_tracking booking_tracking_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_tracking
    ADD CONSTRAINT booking_tracking_pkey PRIMARY KEY (id);


--
-- Name: bookings bookings_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.bookings
    ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);


--
-- Name: branch_slots branch_slots_branch_id_slot_time_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.branch_slots
    ADD CONSTRAINT branch_slots_branch_id_slot_time_key UNIQUE (branch_id, slot_time);


--
-- Name: branch_slots branch_slots_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.branch_slots
    ADD CONSTRAINT branch_slots_pkey PRIMARY KEY (id);


--
-- Name: branches branches_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.branches
    ADD CONSTRAINT branches_pkey PRIMARY KEY (id);


--
-- Name: catalog_categories catalog_categories_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.catalog_categories
    ADD CONSTRAINT catalog_categories_pkey PRIMARY KEY (id);


--
-- Name: catalog_categories catalog_categories_slug_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.catalog_categories
    ADD CONSTRAINT catalog_categories_slug_key UNIQUE (slug);


--
-- Name: catalog_provider_services catalog_provider_services_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.catalog_provider_services
    ADD CONSTRAINT catalog_provider_services_pkey PRIMARY KEY (id);


--
-- Name: catalog_provider_services catalog_provider_services_provider_uid_service_id_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.catalog_provider_services
    ADD CONSTRAINT catalog_provider_services_provider_uid_service_id_key UNIQUE (provider_uid, service_id);


--
-- Name: services catalog_services_legacy_service_option_id_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.services
    ADD CONSTRAINT catalog_services_legacy_service_option_id_key UNIQUE (legacy_service_option_id);


--
-- Name: services catalog_services_slug_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.services
    ADD CONSTRAINT catalog_services_slug_key UNIQUE (slug);


--
-- Name: catalog_subcategories catalog_subcategories_category_id_slug_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.catalog_subcategories
    ADD CONSTRAINT catalog_subcategories_category_id_slug_key UNIQUE (category_id, slug);


--
-- Name: catalog_subcategories catalog_subcategories_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.catalog_subcategories
    ADD CONSTRAINT catalog_subcategories_pkey PRIMARY KEY (id);


--
-- Name: chat_conversations chat_conversations_booking_id_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.chat_conversations
    ADD CONSTRAINT chat_conversations_booking_id_key UNIQUE (booking_id);


--
-- Name: chat_conversations chat_conversations_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.chat_conversations
    ADD CONSTRAINT chat_conversations_pkey PRIMARY KEY (id);


--
-- Name: chat_message_attachments chat_message_attachments_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.chat_message_attachments
    ADD CONSTRAINT chat_message_attachments_pkey PRIMARY KEY (id);


--
-- Name: chat_message_reports chat_message_reports_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.chat_message_reports
    ADD CONSTRAINT chat_message_reports_pkey PRIMARY KEY (id);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: chat_participants chat_participants_conversation_id_user_uid_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.chat_participants
    ADD CONSTRAINT chat_participants_conversation_id_user_uid_key UNIQUE (conversation_id, user_uid);


--
-- Name: chat_participants chat_participants_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.chat_participants
    ADD CONSTRAINT chat_participants_pkey PRIMARY KEY (id);


--
-- Name: customer_notifications customer_notifications_notification_key_key1; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.customer_notifications
    ADD CONSTRAINT customer_notifications_notification_key_key1 UNIQUE (notification_key);


--
-- Name: customer_notifications customer_notifications_notification_key_key2; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.customer_notifications
    ADD CONSTRAINT customer_notifications_notification_key_key2 UNIQUE (notification_key);


--
-- Name: customer_notifications customer_notifications_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.customer_notifications
    ADD CONSTRAINT customer_notifications_pkey PRIMARY KEY (id);


--
-- Name: customer_reviews customer_reviews_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.customer_reviews
    ADD CONSTRAINT customer_reviews_pkey PRIMARY KEY (review_id);


--
-- Name: customer_support_ticket_replies customer_support_ticket_replies_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.customer_support_ticket_replies
    ADD CONSTRAINT customer_support_ticket_replies_pkey PRIMARY KEY (id);


--
-- Name: customer_support_tickets customer_support_tickets_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.customer_support_tickets
    ADD CONSTRAINT customer_support_tickets_pkey PRIMARY KEY (id);


--
-- Name: customer_support_tickets customer_support_tickets_ticket_key_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.customer_support_tickets
    ADD CONSTRAINT customer_support_tickets_ticket_key_key UNIQUE (ticket_key);


--
-- Name: disbursements disbursements_booking_id_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.disbursements
    ADD CONSTRAINT disbursements_booking_id_key UNIQUE (booking_id);


--
-- Name: disbursements disbursements_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.disbursements
    ADD CONSTRAINT disbursements_pkey PRIMARY KEY (id);


--
-- Name: email_otps email_otps_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.email_otps
    ADD CONSTRAINT email_otps_pkey PRIMARY KEY (id);


--
-- Name: employee_catalog_capabilities employee_catalog_capabilities_employee_uid_offering_id_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.employee_catalog_capabilities
    ADD CONSTRAINT employee_catalog_capabilities_employee_uid_offering_id_key UNIQUE (employee_uid, offering_id);


--
-- Name: employee_catalog_capabilities employee_catalog_capabilities_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.employee_catalog_capabilities
    ADD CONSTRAINT employee_catalog_capabilities_pkey PRIMARY KEY (id);


--
-- Name: employee_services employee_services_employee_uid_service_id_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.employee_services
    ADD CONSTRAINT employee_services_employee_uid_service_id_key UNIQUE (employee_uid, service_id);


--
-- Name: employee_services employee_services_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.employee_services
    ADD CONSTRAINT employee_services_pkey PRIMARY KEY (id);


--
-- Name: finance_ledger_entries finance_ledger_entries_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.finance_ledger_entries
    ADD CONSTRAINT finance_ledger_entries_pkey PRIMARY KEY (id);


--
-- Name: finance_reconciliation_exceptions finance_reconciliation_exceptions_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.finance_reconciliation_exceptions
    ADD CONSTRAINT finance_reconciliation_exceptions_pkey PRIMARY KEY (id);


--
-- Name: finance_refund_reviews finance_refund_reviews_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.finance_refund_reviews
    ADD CONSTRAINT finance_refund_reviews_pkey PRIMARY KEY (id);


--
-- Name: guest_customers guest_customers_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.guest_customers
    ADD CONSTRAINT guest_customers_pkey PRIMARY KEY (id);


--
-- Name: logs logs_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.logs
    ADD CONSTRAINT logs_pkey PRIMARY KEY (log_id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: pricing_modifiers pricing_modifiers_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.pricing_modifiers
    ADD CONSTRAINT pricing_modifiers_pkey PRIMARY KEY (id);


--
-- Name: provider_activation_events provider_activation_events_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_activation_events
    ADD CONSTRAINT provider_activation_events_pkey PRIMARY KEY (id);


--
-- Name: provider_activation provider_activation_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_activation
    ADD CONSTRAINT provider_activation_pkey PRIMARY KEY (provider_uid);


--
-- Name: provider_alerts provider_alerts_alert_key_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_alerts
    ADD CONSTRAINT provider_alerts_alert_key_key UNIQUE (alert_key);


--
-- Name: provider_alerts provider_alerts_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_alerts
    ADD CONSTRAINT provider_alerts_pkey PRIMARY KEY (id);


--
-- Name: provider_auto_online_events provider_auto_online_events_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_auto_online_events
    ADD CONSTRAINT provider_auto_online_events_pkey PRIMARY KEY (id);


--
-- Name: provider_auto_online_state provider_auto_online_state_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_auto_online_state
    ADD CONSTRAINT provider_auto_online_state_pkey PRIMARY KEY (provider_uid);


--
-- Name: provider_catalog_offering_mappings provider_catalog_offering_map_offering_id_service_id_level__key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_catalog_offering_mappings
    ADD CONSTRAINT provider_catalog_offering_map_offering_id_service_id_level__key UNIQUE (offering_id, service_id, level_2);


--
-- Name: provider_catalog_offering_mappings provider_catalog_offering_mappings_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_catalog_offering_mappings
    ADD CONSTRAINT provider_catalog_offering_mappings_pkey PRIMARY KEY (id);


--
-- Name: provider_catalog_offering_policies provider_catalog_offering_policies_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_catalog_offering_policies
    ADD CONSTRAINT provider_catalog_offering_policies_pkey PRIMARY KEY (offering_id);


--
-- Name: provider_catalog_offering_requirements provider_catalog_offering_requi_offering_id_requirement_key_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_catalog_offering_requirements
    ADD CONSTRAINT provider_catalog_offering_requi_offering_id_requirement_key_key UNIQUE (offering_id, requirement_key);


--
-- Name: provider_catalog_offering_requirements provider_catalog_offering_requirements_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_catalog_offering_requirements
    ADD CONSTRAINT provider_catalog_offering_requirements_pkey PRIMARY KEY (id);


--
-- Name: provider_catalog_offerings provider_catalog_offerings_catalog_key_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_catalog_offerings
    ADD CONSTRAINT provider_catalog_offerings_catalog_key_key UNIQUE (catalog_key);


--
-- Name: provider_catalog_offerings provider_catalog_offerings_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_catalog_offerings
    ADD CONSTRAINT provider_catalog_offerings_pkey PRIMARY KEY (id);


--
-- Name: provider_certifications provider_certifications_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_certifications
    ADD CONSTRAINT provider_certifications_pkey PRIMARY KEY (id);


--
-- Name: provider_certifications provider_certifications_provider_uid_client_request_id_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_certifications
    ADD CONSTRAINT provider_certifications_provider_uid_client_request_id_key UNIQUE (provider_uid, client_request_id);


--
-- Name: provider_client_activity provider_client_activity_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_client_activity
    ADD CONSTRAINT provider_client_activity_pkey PRIMARY KEY (id);


--
-- Name: provider_contact_change_requests provider_contact_change_reque_provider_uid_client_request_i_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_contact_change_requests
    ADD CONSTRAINT provider_contact_change_reque_provider_uid_client_request_i_key UNIQUE (provider_uid, client_request_id);


--
-- Name: provider_contact_change_requests provider_contact_change_requests_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_contact_change_requests
    ADD CONSTRAINT provider_contact_change_requests_pkey PRIMARY KEY (id);


--
-- Name: provider_document_types provider_document_types_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_document_types
    ADD CONSTRAINT provider_document_types_pkey PRIMARY KEY (document_type_id);


--
-- Name: provider_notification_device_tokens provider_notification_device_tokens_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notification_device_tokens
    ADD CONSTRAINT provider_notification_device_tokens_pkey PRIMARY KEY (token);


--
-- Name: provider_notification_preferences provider_notification_preferences_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notification_preferences
    ADD CONSTRAINT provider_notification_preferences_pkey PRIMARY KEY (worker_uid);


--
-- Name: provider_notifications provider_notifications_notification_key_key1; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key1 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key10; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key10 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key11; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key11 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key12; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key12 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key13; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key13 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key14; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key14 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key15; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key15 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key16; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key16 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key17; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key17 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key18; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key18 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key19; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key19 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key2; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key2 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key20; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key20 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key21; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key21 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key22; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key22 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key23; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key23 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key24; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key24 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key25; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key25 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key26; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key26 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key27; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key27 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key28; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key28 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key29; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key29 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key3; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key3 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key30; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key30 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key31; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key31 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key32; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key32 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key33; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key33 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key34; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key34 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key35; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key35 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key36; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key36 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key37; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key37 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key4; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key4 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key5; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key5 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key6; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key6 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key7; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key7 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key8; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key8 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_notification_key_key9; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_notification_key_key9 UNIQUE (notification_key);


--
-- Name: provider_notifications provider_notifications_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_notifications
    ADD CONSTRAINT provider_notifications_pkey PRIMARY KEY (id);


--
-- Name: provider_onboarding_cases provider_onboarding_cases_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_onboarding_cases
    ADD CONSTRAINT provider_onboarding_cases_pkey PRIMARY KEY (id);


--
-- Name: provider_onboarding_drafts provider_onboarding_drafts_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_onboarding_drafts
    ADD CONSTRAINT provider_onboarding_drafts_pkey PRIMARY KEY (uid);


--
-- Name: provider_onboarding_notes provider_onboarding_notes_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_onboarding_notes
    ADD CONSTRAINT provider_onboarding_notes_pkey PRIMARY KEY (id);


--
-- Name: provider_onboarding_timeline provider_onboarding_timeline_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_onboarding_timeline
    ADD CONSTRAINT provider_onboarding_timeline_pkey PRIMARY KEY (id);


--
-- Name: provider_operational_availability provider_operational_availability_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_operational_availability
    ADD CONSTRAINT provider_operational_availability_pkey PRIMARY KEY (provider_uid);


--
-- Name: provider_profile_media_submissions provider_profile_media_submis_provider_uid_client_request_i_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_profile_media_submissions
    ADD CONSTRAINT provider_profile_media_submis_provider_uid_client_request_i_key UNIQUE (provider_uid, client_request_id);


--
-- Name: provider_profile_media_submissions provider_profile_media_submissions_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_profile_media_submissions
    ADD CONSTRAINT provider_profile_media_submissions_pkey PRIMARY KEY (id);


--
-- Name: provider_profile_revisions provider_profile_revisions_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_profile_revisions
    ADD CONSTRAINT provider_profile_revisions_pkey PRIMARY KEY (id);


--
-- Name: provider_profile_revisions provider_profile_revisions_provider_uid_client_request_id_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_profile_revisions
    ADD CONSTRAINT provider_profile_revisions_provider_uid_client_request_id_key UNIQUE (provider_uid, client_request_id);


--
-- Name: provider_provisional_bookable_services provider_provisional_bookable_services_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_provisional_bookable_services
    ADD CONSTRAINT provider_provisional_bookable_services_pkey PRIMARY KEY (provider_uid, service_id);


--
-- Name: provider_quality_actions provider_quality_actions_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_quality_actions
    ADD CONSTRAINT provider_quality_actions_pkey PRIMARY KEY (action_id);


--
-- Name: provider_rating_aggregates provider_rating_aggregates_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_rating_aggregates
    ADD CONSTRAINT provider_rating_aggregates_pkey PRIMARY KEY (provider_uid);


--
-- Name: provider_requirement_decisions provider_requirement_decisions_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_requirement_decisions
    ADD CONSTRAINT provider_requirement_decisions_pkey PRIMARY KEY (id);


--
-- Name: provider_requirement_definitions provider_requirement_definitions_code_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_requirement_definitions
    ADD CONSTRAINT provider_requirement_definitions_code_key UNIQUE (code);


--
-- Name: provider_requirement_definitions provider_requirement_definitions_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_requirement_definitions
    ADD CONSTRAINT provider_requirement_definitions_pkey PRIMARY KEY (id);


--
-- Name: provider_review_reason_codes provider_review_reason_codes_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_review_reason_codes
    ADD CONSTRAINT provider_review_reason_codes_pkey PRIMARY KEY (code);


--
-- Name: provider_service_area_catalog provider_service_area_catalog_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_service_area_catalog
    ADD CONSTRAINT provider_service_area_catalog_pkey PRIMARY KEY (area_id);


--
-- Name: provider_service_rating_aggregates provider_service_rating_aggregates_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_service_rating_aggregates
    ADD CONSTRAINT provider_service_rating_aggregates_pkey PRIMARY KEY (provider_uid, service_id);


--
-- Name: provider_source_attribution provider_source_attribution_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_source_attribution
    ADD CONSTRAINT provider_source_attribution_pkey PRIMARY KEY (uid);


--
-- Name: provider_support_cases provider_support_cases_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_support_cases
    ADD CONSTRAINT provider_support_cases_pkey PRIMARY KEY (case_id);


--
-- Name: provider_support_cases provider_support_cases_public_reference_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_support_cases
    ADD CONSTRAINT provider_support_cases_public_reference_key UNIQUE (public_reference);


--
-- Name: provider_support_ticket_replies provider_support_ticket_replies_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_support_ticket_replies
    ADD CONSTRAINT provider_support_ticket_replies_pkey PRIMARY KEY (id);


--
-- Name: provider_support_tickets provider_support_tickets_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_support_tickets
    ADD CONSTRAINT provider_support_tickets_pkey PRIMARY KEY (id);


--
-- Name: provider_support_tickets provider_support_tickets_ticket_key_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_support_tickets
    ADD CONSTRAINT provider_support_tickets_ticket_key_key UNIQUE (ticket_key);


--
-- Name: provider_verification_events provider_verification_events_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_verification_events
    ADD CONSTRAINT provider_verification_events_pkey PRIMARY KEY (id);


--
-- Name: provider_verification_events provider_verification_events_provider_uid_event_key_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_verification_events
    ADD CONSTRAINT provider_verification_events_provider_uid_event_key_key UNIQUE (provider_uid, event_key);


--
-- Name: review_appeals review_appeals_case_id_provider_uid_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_appeals
    ADD CONSTRAINT review_appeals_case_id_provider_uid_key UNIQUE (case_id, provider_uid);


--
-- Name: review_appeals review_appeals_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_appeals
    ADD CONSTRAINT review_appeals_pkey PRIMARY KEY (appeal_id);


--
-- Name: review_appeals review_appeals_provider_uid_client_request_id_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_appeals
    ADD CONSTRAINT review_appeals_provider_uid_client_request_id_key UNIQUE (provider_uid, client_request_id);


--
-- Name: review_dimension_definitions review_dimension_definitions_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_dimension_definitions
    ADD CONSTRAINT review_dimension_definitions_pkey PRIMARY KEY (dimension_key);


--
-- Name: review_dimension_scores review_dimension_scores_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_dimension_scores
    ADD CONSTRAINT review_dimension_scores_pkey PRIMARY KEY (id);


--
-- Name: review_dimension_scores review_dimension_scores_review_id_dimension_key_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_dimension_scores
    ADD CONSTRAINT review_dimension_scores_review_id_dimension_key_key UNIQUE (review_id, dimension_key);


--
-- Name: review_moderation_cases review_moderation_cases_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_moderation_cases
    ADD CONSTRAINT review_moderation_cases_pkey PRIMARY KEY (case_id);


--
-- Name: review_policy_versions review_policy_versions_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_policy_versions
    ADD CONSTRAINT review_policy_versions_pkey PRIMARY KEY (policy_version);


--
-- Name: review_provider_responses review_provider_responses_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_provider_responses
    ADD CONSTRAINT review_provider_responses_pkey PRIMARY KEY (response_id);


--
-- Name: review_reports review_reports_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_reports
    ADD CONSTRAINT review_reports_pkey PRIMARY KEY (report_id);


--
-- Name: review_reputation_events review_reputation_events_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_reputation_events
    ADD CONSTRAINT review_reputation_events_pkey PRIMARY KEY (event_id);


--
-- Name: review_response_moderation_cases review_response_moderation_cases_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_response_moderation_cases
    ADD CONSTRAINT review_response_moderation_cases_pkey PRIMARY KEY (case_id);


--
-- Name: review_response_moderation_cases review_response_moderation_cases_response_id_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_response_moderation_cases
    ADD CONSTRAINT review_response_moderation_cases_response_id_key UNIQUE (response_id);


--
-- Name: roles roles_pk; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.roles
    ADD CONSTRAINT roles_pk PRIMARY KEY (role_id);


--
-- Name: service_coverage_geo service_coverage_geo_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.service_coverage_geo
    ADD CONSTRAINT service_coverage_geo_pkey PRIMARY KEY (id);


--
-- Name: service_coverage service_coverage_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.service_coverage
    ADD CONSTRAINT service_coverage_pkey PRIMARY KEY (id);


--
-- Name: service_families service_families_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.service_families
    ADD CONSTRAINT service_families_pkey PRIMARY KEY (id);


--
-- Name: service_option_meta service_option_meta_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.service_option_meta
    ADD CONSTRAINT service_option_meta_pkey PRIMARY KEY (id);


--
-- Name: service_option_meta service_option_meta_service_option_id_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.service_option_meta
    ADD CONSTRAINT service_option_meta_service_option_id_key UNIQUE (service_option_id);


--
-- Name: service_options service_options_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.service_options
    ADD CONSTRAINT service_options_pkey PRIMARY KEY (id);


--
-- Name: service_review_dimensions service_review_dimensions_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.service_review_dimensions
    ADD CONSTRAINT service_review_dimensions_pkey PRIMARY KEY (service_id, dimension_key);


--
-- Name: service_families services_name_unique; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.service_families
    ADD CONSTRAINT services_name_unique UNIQUE (name);


--
-- Name: services services_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.services
    ADD CONSTRAINT services_pkey PRIMARY KEY (id);


--
-- Name: support_case_appeals support_case_appeals_case_id_resolution_id_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_appeals
    ADD CONSTRAINT support_case_appeals_case_id_resolution_id_key UNIQUE (case_id, resolution_id);


--
-- Name: support_case_appeals support_case_appeals_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_appeals
    ADD CONSTRAINT support_case_appeals_pkey PRIMARY KEY (appeal_id);


--
-- Name: support_case_appeals support_case_appeals_provider_uid_client_request_id_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_appeals
    ADD CONSTRAINT support_case_appeals_provider_uid_client_request_id_key UNIQUE (provider_uid, client_request_id);


--
-- Name: support_case_attachments support_case_attachments_case_id_content_sha256_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_attachments
    ADD CONSTRAINT support_case_attachments_case_id_content_sha256_key UNIQUE (case_id, content_sha256);


--
-- Name: support_case_attachments support_case_attachments_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_attachments
    ADD CONSTRAINT support_case_attachments_pkey PRIMARY KEY (attachment_id);


--
-- Name: support_case_attachments support_case_attachments_provider_uid_client_request_id_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_attachments
    ADD CONSTRAINT support_case_attachments_provider_uid_client_request_id_key UNIQUE (provider_uid, client_request_id);


--
-- Name: support_case_categories support_case_categories_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_categories
    ADD CONSTRAINT support_case_categories_pkey PRIMARY KEY (category_id);


--
-- Name: support_case_escalations support_case_escalations_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_escalations
    ADD CONSTRAINT support_case_escalations_pkey PRIMARY KEY (escalation_id);


--
-- Name: support_case_events support_case_events_case_id_idempotency_key_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_events
    ADD CONSTRAINT support_case_events_case_id_idempotency_key_key UNIQUE (case_id, idempotency_key);


--
-- Name: support_case_events support_case_events_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_events
    ADD CONSTRAINT support_case_events_pkey PRIMARY KEY (event_id);


--
-- Name: support_case_internal_notes support_case_internal_notes_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_internal_notes
    ADD CONSTRAINT support_case_internal_notes_pkey PRIMARY KEY (note_id);


--
-- Name: support_case_messages support_case_messages_case_id_sender_type_client_request_id_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_messages
    ADD CONSTRAINT support_case_messages_case_id_sender_type_client_request_id_key UNIQUE (case_id, sender_type, client_request_id);


--
-- Name: support_case_messages support_case_messages_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_messages
    ADD CONSTRAINT support_case_messages_pkey PRIMARY KEY (message_id);


--
-- Name: provider_support_cases support_case_provider_request_unique; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_support_cases
    ADD CONSTRAINT support_case_provider_request_unique UNIQUE (provider_uid, client_request_id);


--
-- Name: support_case_resolutions support_case_resolutions_case_id_client_request_id_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_resolutions
    ADD CONSTRAINT support_case_resolutions_case_id_client_request_id_key UNIQUE (case_id, client_request_id);


--
-- Name: support_case_resolutions support_case_resolutions_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_resolutions
    ADD CONSTRAINT support_case_resolutions_pkey PRIMARY KEY (resolution_id);


--
-- Name: support_case_sources support_case_sources_case_id_source_type_source_id_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_sources
    ADD CONSTRAINT support_case_sources_case_id_source_type_source_id_key UNIQUE (case_id, source_type, source_id);


--
-- Name: support_case_sources support_case_sources_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_sources
    ADD CONSTRAINT support_case_sources_pkey PRIMARY KEY (source_link_id);


--
-- Name: admin_booking_drafts uq_draft_id; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.admin_booking_drafts
    ADD CONSTRAINT uq_draft_id UNIQUE (draft_id);


--
-- Name: user_address user_address_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.user_address
    ADD CONSTRAINT user_address_pkey PRIMARY KEY (address_id);


--
-- Name: user_credentials user_credentials_email_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.user_credentials
    ADD CONSTRAINT user_credentials_email_key UNIQUE (email);


--
-- Name: user_credentials user_credentials_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.user_credentials
    ADD CONSTRAINT user_credentials_pkey PRIMARY KEY (uid);


--
-- Name: user_profile user_profile_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.user_profile
    ADD CONSTRAINT user_profile_pkey PRIMARY KEY (uid);


--
-- Name: worker_availability worker_availability_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.worker_availability
    ADD CONSTRAINT worker_availability_pkey PRIMARY KEY (worker_uid);


--
-- Name: worker_bank_accounts worker_bank_accounts_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.worker_bank_accounts
    ADD CONSTRAINT worker_bank_accounts_pkey PRIMARY KEY (worker_uid);


--
-- Name: worker_notification_prefs worker_notification_prefs_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.worker_notification_prefs
    ADD CONSTRAINT worker_notification_prefs_pkey PRIMARY KEY (worker_uid);


--
-- Name: worker_requirements worker_requirements_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.worker_requirements
    ADD CONSTRAINT worker_requirements_pkey PRIMARY KEY (id);


--
-- Name: worker_service_application_timeline worker_service_application_timelin_application_id_event_key_key; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.worker_service_application_timeline
    ADD CONSTRAINT worker_service_application_timelin_application_id_event_key_key UNIQUE (application_id, event_key);


--
-- Name: worker_service_application_timeline worker_service_application_timeline_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.worker_service_application_timeline
    ADD CONSTRAINT worker_service_application_timeline_pkey PRIMARY KEY (id);


--
-- Name: worker_service_applications worker_service_applications_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.worker_service_applications
    ADD CONSTRAINT worker_service_applications_pkey PRIMARY KEY (id);


--
-- Name: worker_service_areas worker_service_areas_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.worker_service_areas
    ADD CONSTRAINT worker_service_areas_pkey PRIMARY KEY (worker_uid);


--
-- Name: worker_time_off worker_time_off_pkey; Type: CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.worker_time_off
    ADD CONSTRAINT worker_time_off_pkey PRIMARY KEY (id);


--
-- Name: admin_audit_events_action_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX admin_audit_events_action_idx ON servana.admin_audit_events USING btree (action);


--
-- Name: admin_audit_events_actor_uid_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX admin_audit_events_actor_uid_idx ON servana.admin_audit_events USING btree (actor_uid);


--
-- Name: admin_audit_events_category_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX admin_audit_events_category_idx ON servana.admin_audit_events USING btree (action_category);


--
-- Name: admin_audit_events_entity_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX admin_audit_events_entity_idx ON servana.admin_audit_events USING btree (entity_type, entity_id);


--
-- Name: admin_audit_events_occurred_at_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX admin_audit_events_occurred_at_idx ON servana.admin_audit_events USING btree (occurred_at DESC);


--
-- Name: admin_audit_events_outcome_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX admin_audit_events_outcome_idx ON servana.admin_audit_events USING btree (outcome);


--
-- Name: admin_audit_events_request_id_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX admin_audit_events_request_id_idx ON servana.admin_audit_events USING btree (request_id);


--
-- Name: catalog_provider_services_provider_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX catalog_provider_services_provider_idx ON servana.catalog_provider_services USING btree (provider_uid);


--
-- Name: catalog_provider_services_service_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX catalog_provider_services_service_idx ON servana.catalog_provider_services USING btree (service_id);


--
-- Name: catalog_services_subcategory_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX catalog_services_subcategory_idx ON servana.services USING btree (subcategory_id);


--
-- Name: catalog_subcategories_category_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX catalog_subcategories_category_idx ON servana.catalog_subcategories USING btree (category_id);


--
-- Name: fin_exc_booking_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX fin_exc_booking_idx ON servana.finance_reconciliation_exceptions USING btree (booking_id);


--
-- Name: fin_exc_code_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX fin_exc_code_idx ON servana.finance_reconciliation_exceptions USING btree (exception_code);


--
-- Name: fin_exc_run_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX fin_exc_run_idx ON servana.finance_reconciliation_exceptions USING btree (run_date DESC);


--
-- Name: fin_exc_status_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX fin_exc_status_idx ON servana.finance_reconciliation_exceptions USING btree (status);


--
-- Name: fin_ledger_booking_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX fin_ledger_booking_idx ON servana.finance_ledger_entries USING btree (booking_id);


--
-- Name: fin_ledger_created_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX fin_ledger_created_idx ON servana.finance_ledger_entries USING btree (created_at DESC);


--
-- Name: fin_ledger_payment_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX fin_ledger_payment_idx ON servana.finance_ledger_entries USING btree (payment_id);


--
-- Name: fin_refund_booking_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX fin_refund_booking_idx ON servana.finance_refund_reviews USING btree (booking_id);


--
-- Name: fin_refund_created_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX fin_refund_created_idx ON servana.finance_refund_reviews USING btree (created_at DESC);


--
-- Name: fin_refund_status_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX fin_refund_status_idx ON servana.finance_refund_reviews USING btree (status);


--
-- Name: idx_abd_admin_status; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_abd_admin_status ON servana.admin_booking_drafts USING btree (created_by_admin_uid, status, updated_at DESC);


--
-- Name: idx_abd_expires; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_abd_expires ON servana.admin_booking_drafts USING btree (expires_at) WHERE ((status)::text = ANY ((ARRAY['editing'::character varying, 'ready_for_review'::character varying])::text[]));


--
-- Name: idx_ace_created; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_ace_created ON servana.admin_communication_events USING btree (created_at DESC);


--
-- Name: idx_ace_entity; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_ace_entity ON servana.admin_communication_events USING btree (entity_type, entity_id, created_at DESC);


--
-- Name: idx_ace_recipient; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_ace_recipient ON servana.admin_communication_events USING btree (recipient_uid, created_at DESC);


--
-- Name: idx_ace_status; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_ace_status ON servana.admin_communication_events USING btree (status, channel, created_at DESC);


--
-- Name: idx_activation_events_provider; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_activation_events_provider ON servana.provider_activation_events USING btree (provider_uid, created_at DESC);


--
-- Name: idx_admin_notifications_inbox; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_admin_notifications_inbox ON servana.admin_notifications USING btree (admin_uid, created_at DESC);


--
-- Name: idx_adr_open_identifier; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX idx_adr_open_identifier ON servana.account_deletion_requests USING btree (identifier) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_adr_pending; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_adr_pending ON servana.account_deletion_requests USING btree (requested_at) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_ant_channel; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_ant_channel ON servana.admin_notification_templates USING btree (channel, is_active);


--
-- Name: idx_booking_workers_current_assignment; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_booking_workers_current_assignment ON servana.booking_workers USING btree (booking_id, assigned_at DESC, id DESC);


--
-- Name: idx_bookings_admin_created; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_bookings_admin_created ON servana.bookings USING btree (admin_created) WHERE (admin_created = true);


--
-- Name: idx_bookings_synthetic; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_bookings_synthetic ON servana.bookings USING btree (id) WHERE (is_synthetic = true);


--
-- Name: idx_bpe_booking_id; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_bpe_booking_id ON servana.booking_payment_evidence USING btree (booking_id);


--
-- Name: idx_bte_booking_id; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_bte_booking_id ON servana.booking_timeline_events USING btree (booking_id, created_at DESC);


--
-- Name: idx_bw_confirmation_source; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_bw_confirmation_source ON servana.booking_workers USING btree (confirmation_source) WHERE (confirmation_source IS NOT NULL);


--
-- Name: idx_bw_consent_method; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_bw_consent_method ON servana.booking_workers USING btree (consent_method) WHERE (consent_method IS NOT NULL);


--
-- Name: idx_chat_attachments_message; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_chat_attachments_message ON servana.chat_message_attachments USING btree (message_id);


--
-- Name: idx_chat_message_client_idempotency; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX idx_chat_message_client_idempotency ON servana.chat_messages USING btree (conversation_id, sender_uid, client_msg_id) WHERE (client_msg_id IS NOT NULL);


--
-- Name: idx_chat_messages_conversation_created; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_chat_messages_conversation_created ON servana.chat_messages USING btree (conversation_id, created_at DESC);


--
-- Name: idx_chat_participants_user; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_chat_participants_user ON servana.chat_participants USING btree (user_uid);


--
-- Name: idx_cn_user_uid; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_cn_user_uid ON servana.customer_notifications USING btree (user_uid, created_at DESC);


--
-- Name: idx_cr_client_req; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX idx_cr_client_req ON servana.customer_reviews USING btree (customer_uid, client_request_id) WHERE ((client_request_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: idx_cr_customer_uid; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_cr_customer_uid ON servana.customer_reviews USING btree (customer_uid, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_cr_provider_uid; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_cr_provider_uid ON servana.customer_reviews USING btree (provider_uid, created_at DESC) WHERE ((deleted_at IS NULL) AND ((moderation_status)::text = ANY ((ARRAY['NOT_REQUIRED'::character varying, 'APPROVED'::character varying])::text[])));


--
-- Name: idx_cst_client_req; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX idx_cst_client_req ON servana.customer_support_tickets USING btree (customer_uid, client_request_id) WHERE (client_request_id IS NOT NULL);


--
-- Name: idx_cst_customer_uid; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_cst_customer_uid ON servana.customer_support_tickets USING btree (customer_uid, created_at DESC);


--
-- Name: idx_cstr_ticket_key; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_cstr_ticket_key ON servana.customer_support_ticket_replies USING btree (ticket_key, created_at);


--
-- Name: idx_email_otps_email_purpose; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_email_otps_email_purpose ON servana.email_otps USING btree (email, purpose, used, expires_at);


--
-- Name: idx_employee_services_service; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_employee_services_service ON servana.employee_services USING btree (service_id);


--
-- Name: idx_employee_services_uid; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_employee_services_uid ON servana.employee_services USING btree (employee_uid);


--
-- Name: idx_gc_phone; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_gc_phone ON servana.guest_customers USING btree (phone_normalized);


--
-- Name: idx_gc_phone_unique; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX idx_gc_phone_unique ON servana.guest_customers USING btree (phone_normalized);


--
-- Name: idx_gc_uuid; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX idx_gc_uuid ON servana.guest_customers USING btree (guest_customer_id);


--
-- Name: idx_pa_worker_uid; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_pa_worker_uid ON servana.provider_alerts USING btree (worker_uid, created_at DESC);


--
-- Name: idx_paoe_provider_uid; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_paoe_provider_uid ON servana.provider_auto_online_events USING btree (provider_uid);


--
-- Name: idx_payments_paymongo_checkout_retry; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_payments_paymongo_checkout_retry ON servana.payments USING btree (status, updated_at) WHERE ((provider)::text = 'PAYMONGO'::text);


--
-- Name: idx_payments_paymongo_payment_resource; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_payments_paymongo_payment_resource ON servana.payments USING btree (provider_payment_id) WHERE ((provider)::text = 'PAYMONGO'::text);


--
-- Name: idx_payments_superseded_session_ids; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_payments_superseded_session_ids ON servana.payments USING gin (superseded_session_ids) WHERE (superseded_session_ids IS NOT NULL);


--
-- Name: idx_payments_webhook_event_id; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX idx_payments_webhook_event_id ON servana.payments USING btree (webhook_event_id) WHERE (webhook_event_id IS NOT NULL);


--
-- Name: idx_pca_client_type; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_pca_client_type ON servana.provider_client_activity USING btree (client, activity_type, created_at DESC);


--
-- Name: idx_pca_provider_uid; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_pca_provider_uid ON servana.provider_client_activity USING btree (provider_uid, created_at DESC);


--
-- Name: idx_perm_events_target; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_perm_events_target ON servana.admin_permission_events USING btree (target_admin_uid);


--
-- Name: idx_perm_grants_key; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_perm_grants_key ON servana.admin_permission_grants USING btree (permission_key);


--
-- Name: idx_perm_grants_uid; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_perm_grants_uid ON servana.admin_permission_grants USING btree (admin_uid);


--
-- Name: idx_perm_grants_uid_granted; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_perm_grants_uid_granted ON servana.admin_permission_grants USING btree (admin_uid) WHERE (revoked_at IS NULL);


--
-- Name: idx_pn_worker_uid; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_pn_worker_uid ON servana.provider_notifications USING btree (worker_uid, created_at DESC);


--
-- Name: idx_pndt_worker_uid; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_pndt_worker_uid ON servana.provider_notification_device_tokens USING btree (worker_uid);


--
-- Name: idx_ppbs_provider_uid; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_ppbs_provider_uid ON servana.provider_provisional_bookable_services USING btree (provider_uid) WHERE (status = 'active'::text);


--
-- Name: idx_provider_quality_actions_owner; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_provider_quality_actions_owner ON servana.provider_quality_actions USING btree (provider_uid, state, effective_at DESC);


--
-- Name: idx_pst_worker_uid; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_pst_worker_uid ON servana.provider_support_tickets USING btree (worker_uid, created_at DESC);


--
-- Name: idx_pstr_ticket_key; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_pstr_ticket_key ON servana.provider_support_ticket_replies USING btree (ticket_key, created_at);


--
-- Name: idx_review_response_moderation_provider; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_review_response_moderation_provider ON servana.review_response_moderation_cases USING btree (provider_uid, created_at DESC);


--
-- Name: idx_review_response_moderation_queue; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_review_response_moderation_queue ON servana.review_response_moderation_cases USING btree (state, created_at DESC);


--
-- Name: idx_service_coverage_geo_service; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_service_coverage_geo_service ON servana.service_coverage_geo USING btree (service_id);


--
-- Name: idx_support_case_provider_action; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_support_case_provider_action ON servana.provider_support_cases USING btree (provider_uid, provider_action_required, updated_at DESC);


--
-- Name: idx_support_case_provider_page; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_support_case_provider_page ON servana.provider_support_cases USING btree (provider_uid, updated_at DESC, case_id DESC);


--
-- Name: idx_support_case_queue; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_support_case_queue ON servana.provider_support_cases USING btree (current_queue, internal_state, priority, created_at);


--
-- Name: idx_support_case_sla; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_support_case_sla ON servana.provider_support_cases USING btree (escalation_due_at) WHERE ((internal_state)::text <> ALL ((ARRAY['RESOLVED'::character varying, 'CLOSED'::character varying])::text[]));


--
-- Name: idx_support_events_case; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_support_events_case ON servana.support_case_events USING btree (case_id, created_at, event_id);


--
-- Name: idx_support_messages_case; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_support_messages_case ON servana.support_case_messages USING btree (case_id, created_at, message_id);


--
-- Name: idx_support_source_duplicate; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_support_source_duplicate ON servana.support_case_sources USING btree (provider_uid, source_type, source_id);


--
-- Name: idx_uc_email_normalized; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_uc_email_normalized ON servana.user_credentials USING btree (email_normalized) WHERE (email_normalized IS NOT NULL);


--
-- Name: idx_uc_email_normalized_unique; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX idx_uc_email_normalized_unique ON servana.user_credentials USING btree (email_normalized) WHERE (email_normalized IS NOT NULL);


--
-- Name: idx_uc_phone_normalized; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX idx_uc_phone_normalized ON servana.user_credentials USING btree (phone_normalized) WHERE (phone_normalized IS NOT NULL);


--
-- Name: idx_uc_phone_normalized_unique; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX idx_uc_phone_normalized_unique ON servana.user_credentials USING btree (phone_normalized) WHERE (phone_normalized IS NOT NULL);


--
-- Name: poc_priority_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX poc_priority_idx ON servana.provider_onboarding_cases USING btree (priority, submitted_at);


--
-- Name: poc_provider_uid_active_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX poc_provider_uid_active_idx ON servana.provider_onboarding_cases USING btree (provider_uid) WHERE (onboarding_status <> ALL (ARRAY['approved'::text, 'rejected'::text, 'withdrawn'::text, 'expired'::text]));


--
-- Name: poc_status_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX poc_status_idx ON servana.provider_onboarding_cases USING btree (onboarding_status, last_activity_at DESC);


--
-- Name: pon_case_id_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX pon_case_id_idx ON servana.provider_onboarding_notes USING btree (case_id, created_at DESC);


--
-- Name: pot_case_id_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX pot_case_id_idx ON servana.provider_onboarding_timeline USING btree (case_id, created_at DESC);


--
-- Name: pot_provider_uid_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX pot_provider_uid_idx ON servana.provider_onboarding_timeline USING btree (provider_uid, created_at DESC);


--
-- Name: prd_provider_uid_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX prd_provider_uid_idx ON servana.provider_requirement_decisions USING btree (provider_uid, decided_at DESC);


--
-- Name: prd_req_id_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX prd_req_id_idx ON servana.provider_requirement_decisions USING btree (worker_requirement_id);


--
-- Name: provider_catalog_policy_enforcement_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX provider_catalog_policy_enforcement_idx ON servana.provider_catalog_offering_policies USING btree (enforcement_state);


--
-- Name: provider_catalog_requirement_offering_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX provider_catalog_requirement_offering_idx ON servana.provider_catalog_offering_requirements USING btree (offering_id, is_active, display_order);


--
-- Name: provider_certifications_provider_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX provider_certifications_provider_idx ON servana.provider_certifications USING btree (provider_uid, created_at DESC);


--
-- Name: provider_contact_change_active_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX provider_contact_change_active_idx ON servana.provider_contact_change_requests USING btree (provider_uid, contact_kind, created_at DESC);


--
-- Name: provider_profile_media_one_approved_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX provider_profile_media_one_approved_idx ON servana.provider_profile_media_submissions USING btree (provider_uid, media_kind) WHERE (state = 'approved'::text);


--
-- Name: provider_profile_media_provider_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX provider_profile_media_provider_idx ON servana.provider_profile_media_submissions USING btree (provider_uid, created_at DESC);


--
-- Name: provider_profile_revisions_provider_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX provider_profile_revisions_provider_idx ON servana.provider_profile_revisions USING btree (provider_uid, submitted_at DESC);


--
-- Name: provider_verification_events_provider_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX provider_verification_events_provider_idx ON servana.provider_verification_events USING btree (provider_uid, created_at DESC);


--
-- Name: uniq_primary_address_per_user; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX uniq_primary_address_per_user ON servana.user_address USING btree (uid) WHERE (is_primary = true);


--
-- Name: uq_customer_notifications_owner_key; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX uq_customer_notifications_owner_key ON servana.customer_notifications USING btree (user_uid, notification_key);


--
-- Name: uq_provider_notifications_owner_key; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX uq_provider_notifications_owner_key ON servana.provider_notifications USING btree (worker_uid, notification_key);


--
-- Name: ux_customer_reviews_active_booking; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX ux_customer_reviews_active_booking ON servana.customer_reviews USING btree (booking_id, customer_uid) WHERE ((deleted_at IS NULL) AND ((publication_state)::text <> ALL ((ARRAY['WITHDRAWN'::character varying, 'ARCHIVED'::character varying])::text[])));


--
-- Name: ux_customer_reviews_request; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX ux_customer_reviews_request ON servana.customer_reviews USING btree (customer_uid, client_request_id) WHERE ((client_request_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: ux_review_open_moderation_case; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX ux_review_open_moderation_case ON servana.review_moderation_cases USING btree (review_id) WHERE ((state)::text = ANY ((ARRAY['PENDING_REVIEW'::character varying, 'UNDER_REVIEW'::character varying, 'ADDITIONAL_INFORMATION_REQUIRED'::character varying, 'ESCALATED'::character varying])::text[]));


--
-- Name: ux_review_provider_response_active; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX ux_review_provider_response_active ON servana.review_provider_responses USING btree (review_id, provider_uid) WHERE (deleted_at IS NULL);


--
-- Name: ux_review_provider_response_request; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX ux_review_provider_response_request ON servana.review_provider_responses USING btree (provider_uid, client_request_id) WHERE (client_request_id IS NOT NULL);


--
-- Name: ux_review_report_provider_review; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX ux_review_report_provider_review ON servana.review_reports USING btree (review_id, reporter_uid) WHERE (review_id IS NOT NULL);


--
-- Name: ux_review_report_request; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX ux_review_report_request ON servana.review_reports USING btree (reporter_uid, client_request_id) WHERE (client_request_id IS NOT NULL);


--
-- Name: ux_review_reputation_event_idempotency; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX ux_review_reputation_event_idempotency ON servana.review_reputation_events USING btree (provider_uid, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: ux_support_active_escalation; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX ux_support_active_escalation ON servana.support_case_escalations USING btree (case_id, escalation_type, destination_queue) WHERE ((state)::text = 'ACTIVE'::text);


--
-- Name: worker_requirements_provider_request_uidx; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX worker_requirements_provider_request_uidx ON servana.worker_requirements USING btree (worker_uid, client_request_id) WHERE (client_request_id IS NOT NULL);


--
-- Name: worker_requirements_provider_type_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX worker_requirements_provider_type_idx ON servana.worker_requirements USING btree (worker_uid, requirement_type, uploaded_at DESC);


--
-- Name: wsa_provider_request_idempotency; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX wsa_provider_request_idempotency ON servana.worker_service_applications USING btree (worker_uid, client_request_id) WHERE (client_request_id IS NOT NULL);


--
-- Name: wsa_service_id_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX wsa_service_id_idx ON servana.worker_service_applications USING btree (service_id);


--
-- Name: wsa_status_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX wsa_status_idx ON servana.worker_service_applications USING btree (status);


--
-- Name: wsa_unique_open_application; Type: INDEX; Schema: servana; Owner: -
--

CREATE UNIQUE INDEX wsa_unique_open_application ON servana.worker_service_applications USING btree (worker_uid, service_id) WHERE (status = ANY (ARRAY['pending_review'::text, 'action_required'::text]));


--
-- Name: wsa_worker_uid_idx; Type: INDEX; Schema: servana; Owner: -
--

CREATE INDEX wsa_worker_uid_idx ON servana.worker_service_applications USING btree (worker_uid);


--
-- Name: payments trg_payments_updated_at; Type: TRIGGER; Schema: servana; Owner: -
--

CREATE TRIGGER trg_payments_updated_at BEFORE UPDATE ON servana.payments FOR EACH ROW EXECUTE FUNCTION servana.touch_payments_updated_at();


--
-- Name: booking_addons booking_addons_addon_option_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_addons
    ADD CONSTRAINT booking_addons_addon_option_id_fkey FOREIGN KEY (addon_option_id) REFERENCES servana.service_options(id);


--
-- Name: booking_addons booking_addons_booking_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_addons
    ADD CONSTRAINT booking_addons_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES servana.bookings(id);


--
-- Name: booking_workers booking_technicians_booking_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_workers
    ADD CONSTRAINT booking_technicians_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES servana.bookings(id);


--
-- Name: booking_tracking booking_tracking_booking_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.booking_tracking
    ADD CONSTRAINT booking_tracking_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES servana.bookings(id);


--
-- Name: bookings bookings_branch_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.bookings
    ADD CONSTRAINT bookings_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES servana.branches(id);


--
-- Name: bookings bookings_service_option_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.bookings
    ADD CONSTRAINT bookings_service_option_id_fkey FOREIGN KEY (service_option_id) REFERENCES servana.service_options(id);


--
-- Name: bookings bookings_user_address_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.bookings
    ADD CONSTRAINT bookings_user_address_id_fkey FOREIGN KEY (user_address_id) REFERENCES servana.user_address(address_id);


--
-- Name: bookings bookings_user_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.bookings
    ADD CONSTRAINT bookings_user_id_fkey FOREIGN KEY (user_id) REFERENCES servana.user_credentials(uid);


--
-- Name: branch_slots branch_slots_branch_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.branch_slots
    ADD CONSTRAINT branch_slots_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES servana.branches(id);


--
-- Name: branches branches_service_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.branches
    ADD CONSTRAINT branches_service_id_fkey FOREIGN KEY (service_id) REFERENCES servana.service_families(id);


--
-- Name: catalog_provider_services catalog_provider_services_service_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.catalog_provider_services
    ADD CONSTRAINT catalog_provider_services_service_id_fkey FOREIGN KEY (service_id) REFERENCES servana.services(id);


--
-- Name: services catalog_services_subcategory_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.services
    ADD CONSTRAINT catalog_services_subcategory_id_fkey FOREIGN KEY (subcategory_id) REFERENCES servana.catalog_subcategories(id);


--
-- Name: catalog_subcategories catalog_subcategories_category_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.catalog_subcategories
    ADD CONSTRAINT catalog_subcategories_category_id_fkey FOREIGN KEY (category_id) REFERENCES servana.catalog_categories(id);


--
-- Name: chat_conversations chat_conversations_booking_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.chat_conversations
    ADD CONSTRAINT chat_conversations_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES servana.bookings(id) ON DELETE CASCADE;


--
-- Name: chat_message_attachments chat_message_attachments_message_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.chat_message_attachments
    ADD CONSTRAINT chat_message_attachments_message_id_fkey FOREIGN KEY (message_id) REFERENCES servana.chat_messages(id) ON DELETE CASCADE;


--
-- Name: chat_messages chat_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.chat_messages
    ADD CONSTRAINT chat_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES servana.chat_conversations(id) ON DELETE CASCADE;


--
-- Name: chat_participants chat_participants_conversation_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.chat_participants
    ADD CONSTRAINT chat_participants_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES servana.chat_conversations(id) ON DELETE CASCADE;


--
-- Name: disbursements disbursements_booking_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.disbursements
    ADD CONSTRAINT disbursements_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES servana.bookings(id);


--
-- Name: employee_catalog_capabilities employee_catalog_capabilities_offering_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.employee_catalog_capabilities
    ADD CONSTRAINT employee_catalog_capabilities_offering_id_fkey FOREIGN KEY (offering_id) REFERENCES servana.provider_catalog_offerings(id);


--
-- Name: employee_services employee_services_employee_uid_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.employee_services
    ADD CONSTRAINT employee_services_employee_uid_fkey FOREIGN KEY (employee_uid) REFERENCES servana.user_credentials(uid) ON DELETE CASCADE;


--
-- Name: employee_services employee_services_service_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.employee_services
    ADD CONSTRAINT employee_services_service_id_fkey FOREIGN KEY (service_id) REFERENCES servana.service_families(id) ON DELETE CASCADE;


--
-- Name: finance_ledger_entries finance_ledger_entries_booking_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.finance_ledger_entries
    ADD CONSTRAINT finance_ledger_entries_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES servana.bookings(id) ON DELETE CASCADE;


--
-- Name: finance_ledger_entries finance_ledger_entries_payment_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.finance_ledger_entries
    ADD CONSTRAINT finance_ledger_entries_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES servana.payments(id) ON DELETE SET NULL;


--
-- Name: finance_reconciliation_exceptions finance_reconciliation_exceptions_booking_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.finance_reconciliation_exceptions
    ADD CONSTRAINT finance_reconciliation_exceptions_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES servana.bookings(id) ON DELETE SET NULL;


--
-- Name: finance_reconciliation_exceptions finance_reconciliation_exceptions_disbursement_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.finance_reconciliation_exceptions
    ADD CONSTRAINT finance_reconciliation_exceptions_disbursement_id_fkey FOREIGN KEY (disbursement_id) REFERENCES servana.disbursements(id) ON DELETE SET NULL;


--
-- Name: finance_reconciliation_exceptions finance_reconciliation_exceptions_payment_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.finance_reconciliation_exceptions
    ADD CONSTRAINT finance_reconciliation_exceptions_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES servana.payments(id) ON DELETE SET NULL;


--
-- Name: finance_refund_reviews finance_refund_reviews_booking_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.finance_refund_reviews
    ADD CONSTRAINT finance_refund_reviews_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES servana.bookings(id) ON DELETE CASCADE;


--
-- Name: finance_refund_reviews finance_refund_reviews_disbursement_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.finance_refund_reviews
    ADD CONSTRAINT finance_refund_reviews_disbursement_id_fkey FOREIGN KEY (disbursement_id) REFERENCES servana.disbursements(id) ON DELETE SET NULL;


--
-- Name: finance_refund_reviews finance_refund_reviews_payment_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.finance_refund_reviews
    ADD CONSTRAINT finance_refund_reviews_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES servana.payments(id) ON DELETE SET NULL;


--
-- Name: logs fk_logs_user; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.logs
    ADD CONSTRAINT fk_logs_user FOREIGN KEY (log_by) REFERENCES servana.user_credentials(uid);


--
-- Name: user_address fk_user_address_uid; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.user_address
    ADD CONSTRAINT fk_user_address_uid FOREIGN KEY (uid) REFERENCES servana.user_credentials(uid) ON DELETE CASCADE;


--
-- Name: payments payments_booking_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.payments
    ADD CONSTRAINT payments_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES servana.bookings(id);


--
-- Name: pricing_modifiers pricing_modifiers_service_option_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.pricing_modifiers
    ADD CONSTRAINT pricing_modifiers_service_option_id_fkey FOREIGN KEY (service_option_id) REFERENCES servana.service_options(id);


--
-- Name: provider_catalog_offering_mappings provider_catalog_offering_mappings_offering_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_catalog_offering_mappings
    ADD CONSTRAINT provider_catalog_offering_mappings_offering_id_fkey FOREIGN KEY (offering_id) REFERENCES servana.provider_catalog_offerings(id);


--
-- Name: provider_catalog_offering_policies provider_catalog_offering_policies_offering_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_catalog_offering_policies
    ADD CONSTRAINT provider_catalog_offering_policies_offering_id_fkey FOREIGN KEY (offering_id) REFERENCES servana.provider_catalog_offerings(id) ON DELETE CASCADE;


--
-- Name: provider_catalog_offering_requirements provider_catalog_offering_requirements_document_type_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_catalog_offering_requirements
    ADD CONSTRAINT provider_catalog_offering_requirements_document_type_id_fkey FOREIGN KEY (document_type_id) REFERENCES servana.provider_document_types(document_type_id);


--
-- Name: provider_catalog_offering_requirements provider_catalog_offering_requirements_offering_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_catalog_offering_requirements
    ADD CONSTRAINT provider_catalog_offering_requirements_offering_id_fkey FOREIGN KEY (offering_id) REFERENCES servana.provider_catalog_offerings(id) ON DELETE CASCADE;


--
-- Name: provider_certifications provider_certifications_related_document_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_certifications
    ADD CONSTRAINT provider_certifications_related_document_id_fkey FOREIGN KEY (related_document_id) REFERENCES servana.worker_requirements(id);


--
-- Name: provider_certifications provider_certifications_renewal_of_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_certifications
    ADD CONSTRAINT provider_certifications_renewal_of_id_fkey FOREIGN KEY (renewal_of_id) REFERENCES servana.provider_certifications(id);


--
-- Name: provider_support_cases provider_support_cases_category_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.provider_support_cases
    ADD CONSTRAINT provider_support_cases_category_id_fkey FOREIGN KEY (category_id) REFERENCES servana.support_case_categories(category_id);


--
-- Name: review_appeals review_appeals_case_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_appeals
    ADD CONSTRAINT review_appeals_case_id_fkey FOREIGN KEY (case_id) REFERENCES servana.review_moderation_cases(case_id);


--
-- Name: review_appeals review_appeals_review_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_appeals
    ADD CONSTRAINT review_appeals_review_id_fkey FOREIGN KEY (review_id) REFERENCES servana.customer_reviews(review_id);


--
-- Name: review_dimension_scores review_dimension_scores_review_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_dimension_scores
    ADD CONSTRAINT review_dimension_scores_review_id_fkey FOREIGN KEY (review_id) REFERENCES servana.customer_reviews(review_id) ON DELETE CASCADE;


--
-- Name: review_moderation_cases review_moderation_cases_report_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_moderation_cases
    ADD CONSTRAINT review_moderation_cases_report_id_fkey FOREIGN KEY (report_id) REFERENCES servana.review_reports(report_id);


--
-- Name: review_moderation_cases review_moderation_cases_review_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_moderation_cases
    ADD CONSTRAINT review_moderation_cases_review_id_fkey FOREIGN KEY (review_id) REFERENCES servana.customer_reviews(review_id);


--
-- Name: review_provider_responses review_provider_responses_review_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_provider_responses
    ADD CONSTRAINT review_provider_responses_review_id_fkey FOREIGN KEY (review_id) REFERENCES servana.customer_reviews(review_id) ON DELETE CASCADE;


--
-- Name: review_reports review_reports_response_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_reports
    ADD CONSTRAINT review_reports_response_id_fkey FOREIGN KEY (response_id) REFERENCES servana.review_provider_responses(response_id);


--
-- Name: review_reports review_reports_review_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_reports
    ADD CONSTRAINT review_reports_review_id_fkey FOREIGN KEY (review_id) REFERENCES servana.customer_reviews(review_id);


--
-- Name: review_reputation_events review_reputation_events_review_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_reputation_events
    ADD CONSTRAINT review_reputation_events_review_id_fkey FOREIGN KEY (review_id) REFERENCES servana.customer_reviews(review_id);


--
-- Name: review_response_moderation_cases review_response_moderation_cases_response_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_response_moderation_cases
    ADD CONSTRAINT review_response_moderation_cases_response_id_fkey FOREIGN KEY (response_id) REFERENCES servana.review_provider_responses(response_id);


--
-- Name: review_response_moderation_cases review_response_moderation_cases_review_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.review_response_moderation_cases
    ADD CONSTRAINT review_response_moderation_cases_review_id_fkey FOREIGN KEY (review_id) REFERENCES servana.customer_reviews(review_id);


--
-- Name: service_coverage_geo service_coverage_geo_service_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.service_coverage_geo
    ADD CONSTRAINT service_coverage_geo_service_id_fkey FOREIGN KEY (service_id) REFERENCES servana.service_families(id);


--
-- Name: service_coverage service_coverage_service_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.service_coverage
    ADD CONSTRAINT service_coverage_service_id_fkey FOREIGN KEY (service_id) REFERENCES servana.service_families(id);


--
-- Name: service_option_meta service_option_meta_service_option_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.service_option_meta
    ADD CONSTRAINT service_option_meta_service_option_id_fkey FOREIGN KEY (service_option_id) REFERENCES servana.service_options(id);


--
-- Name: service_options service_options_parent_option_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.service_options
    ADD CONSTRAINT service_options_parent_option_id_fkey FOREIGN KEY (parent_option_id) REFERENCES servana.service_options(id);


--
-- Name: service_options service_options_service_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.service_options
    ADD CONSTRAINT service_options_service_id_fkey FOREIGN KEY (service_id) REFERENCES servana.service_families(id);


--
-- Name: service_review_dimensions service_review_dimensions_dimension_key_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.service_review_dimensions
    ADD CONSTRAINT service_review_dimensions_dimension_key_fkey FOREIGN KEY (dimension_key) REFERENCES servana.review_dimension_definitions(dimension_key);


--
-- Name: service_review_dimensions service_review_dimensions_service_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.service_review_dimensions
    ADD CONSTRAINT service_review_dimensions_service_id_fkey FOREIGN KEY (service_id) REFERENCES servana.service_families(id);


--
-- Name: support_case_appeals support_case_appeals_case_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_appeals
    ADD CONSTRAINT support_case_appeals_case_id_fkey FOREIGN KEY (case_id) REFERENCES servana.provider_support_cases(case_id) ON DELETE CASCADE;


--
-- Name: support_case_appeals support_case_appeals_resolution_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_appeals
    ADD CONSTRAINT support_case_appeals_resolution_id_fkey FOREIGN KEY (resolution_id) REFERENCES servana.support_case_resolutions(resolution_id);


--
-- Name: support_case_attachments support_case_attachments_case_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_attachments
    ADD CONSTRAINT support_case_attachments_case_id_fkey FOREIGN KEY (case_id) REFERENCES servana.provider_support_cases(case_id) ON DELETE CASCADE;


--
-- Name: support_case_escalations support_case_escalations_case_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_escalations
    ADD CONSTRAINT support_case_escalations_case_id_fkey FOREIGN KEY (case_id) REFERENCES servana.provider_support_cases(case_id) ON DELETE CASCADE;


--
-- Name: support_case_events support_case_events_case_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_events
    ADD CONSTRAINT support_case_events_case_id_fkey FOREIGN KEY (case_id) REFERENCES servana.provider_support_cases(case_id) ON DELETE CASCADE;


--
-- Name: support_case_internal_notes support_case_internal_notes_case_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_internal_notes
    ADD CONSTRAINT support_case_internal_notes_case_id_fkey FOREIGN KEY (case_id) REFERENCES servana.provider_support_cases(case_id) ON DELETE CASCADE;


--
-- Name: support_case_messages support_case_messages_case_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_messages
    ADD CONSTRAINT support_case_messages_case_id_fkey FOREIGN KEY (case_id) REFERENCES servana.provider_support_cases(case_id) ON DELETE CASCADE;


--
-- Name: support_case_resolutions support_case_resolutions_case_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_resolutions
    ADD CONSTRAINT support_case_resolutions_case_id_fkey FOREIGN KEY (case_id) REFERENCES servana.provider_support_cases(case_id) ON DELETE CASCADE;


--
-- Name: support_case_sources support_case_sources_case_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.support_case_sources
    ADD CONSTRAINT support_case_sources_case_id_fkey FOREIGN KEY (case_id) REFERENCES servana.provider_support_cases(case_id) ON DELETE CASCADE;


--
-- Name: user_profile user_profile_fk; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.user_profile
    ADD CONSTRAINT user_profile_fk FOREIGN KEY (uid) REFERENCES servana.user_profile(uid) ON DELETE CASCADE;


--
-- Name: worker_requirements worker_requirements_replaced_by_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.worker_requirements
    ADD CONSTRAINT worker_requirements_replaced_by_id_fkey FOREIGN KEY (replaced_by_id) REFERENCES servana.worker_requirements(id);


--
-- Name: worker_requirements worker_requirements_replacement_for_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.worker_requirements
    ADD CONSTRAINT worker_requirements_replacement_for_id_fkey FOREIGN KEY (replacement_for_id) REFERENCES servana.worker_requirements(id);


--
-- Name: worker_requirements worker_requirements_worker_uid_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.worker_requirements
    ADD CONSTRAINT worker_requirements_worker_uid_fkey FOREIGN KEY (worker_uid) REFERENCES servana.user_credentials(uid) ON DELETE CASCADE;


--
-- Name: worker_service_application_timeline worker_service_application_timeline_application_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.worker_service_application_timeline
    ADD CONSTRAINT worker_service_application_timeline_application_id_fkey FOREIGN KEY (application_id) REFERENCES servana.worker_service_applications(id);


--
-- Name: worker_service_applications worker_service_applications_service_id_fkey; Type: FK CONSTRAINT; Schema: servana; Owner: -
--

ALTER TABLE ONLY servana.worker_service_applications
    ADD CONSTRAINT worker_service_applications_service_id_fkey FOREIGN KEY (service_id) REFERENCES servana.service_families(id);


--
-- PostgreSQL database dump complete
--


