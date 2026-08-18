#!/usr/bin/env node
/**
 * Guard: verify that mobile-authoritative and provider-web API route
 * patterns still exist in the backend source. Detects accidental removal.
 *
 * Protected contracts (mobile-authoritative — NEVER remove or rename):
 *   Worker (mobile): /worker/* routes
 *   Customer (mobile): /customer/* routes
 *   Location: /location/address-suggestions, /location/address-details
 *   Booking: /booking/*, /bookings/*
 *   Auth: /auth/worker, /auth/customer
 *
 * Read-only scan of src/. Never mutates anything.
 * Exit 1 if any protected route pattern is missing.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

let failures = 0;

function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ MISSING: ${msg}`); failures++; }
function section(name) { console.log(`\n[guard-contracts] ${name}`); }

function walkSrc(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkSrc(full));
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
      results.push(full);
    }
  }
  return results;
}

const allFiles = walkSrc(SRC);

function srcContains(pattern) {
  return allFiles.some(f => pattern.test(fs.readFileSync(f, 'utf8')));
}

// ── Worker (mobile) routes ────────────────────────────────────────────────────
section('Worker mobile routes');

const WORKER_ROUTES = [
  { label: '/worker/ route prefix exists', pattern: /['"`]\/worker\// },
  { label: '/workers/ route prefix exists', pattern: /['"`]\/workers\// },
];

for (const { label, pattern } of WORKER_ROUTES) {
  if (srcContains(pattern)) ok(label);
  else fail(label);
}

// ── Booking routes (used by customer mobile app) ─────────────────────────────
section('Booking routes (customer mobile app uses these)');

// Two prefixes, two checks, each anchored.
//
// This was ONE check, `/['"`]\/booking/`, with no boundary after the word. It
// matched `'/bookings'` just as happily as `'/booking/'`, so deleting every
// `/booking/:bookingId/...` route left it green on the strength of the plural —
// a path passing by matching inside a longer one, which is the exact failure
// this repository has recorded an endpoint-matrix guard committing before.
//
// Both prefixes are real and distinct: `/booking/:bookingId/provider-location`
// and `/booking/:bookingId/provider` are mounted in provider.routes.ts, and
// `/bookings` is its own tree. Splitting them loses no coverage and makes each
// check answer the question its label asks.
const BOOKING_ROUTES = [
  { label: '/booking/ route prefix exists', pattern: /['"`]\/booking\// },
  { label: '/bookings route prefix exists', pattern: /['"`]\/bookings['"`\/]/ },
];

for (const { label, pattern } of BOOKING_ROUTES) {
  if (srcContains(pattern)) ok(label);
  else fail(label);
}

// ── Location routes ───────────────────────────────────────────────────────────
section('Location routes (address autocomplete)');

const LOCATION_ROUTES = [
  { label: '/location/address-suggestions endpoint exists', pattern: /address-suggestions/ },
  { label: '/location/address-details endpoint exists', pattern: /address-details/ },
];

for (const { label, pattern } of LOCATION_ROUTES) {
  if (srcContains(pattern)) ok(label);
  else fail(label);
}

// ── Auth routes ───────────────────────────────────────────────────────────────
section('Auth routes');

const AUTH_ROUTES = [
  { label: '/auth/ route prefix exists', pattern: /['"`]\/auth\// },
];

for (const { label, pattern } of AUTH_ROUTES) {
  if (srcContains(pattern)) ok(label);
  else fail(label);
}

// ── Admin routes ──────────────────────────────────────────────────────────────
section('Admin routes');

const ADMIN_ROUTES = [
  { label: '/admin/ route prefix exists', pattern: /['"`]\/admin\// },
  { label: '/admin/bookings route exists', pattern: /admin\/booking/ },
  { label: '/admin/providers route exists', pattern: /admin\/provider/ },
];

for (const { label, pattern } of ADMIN_ROUTES) {
  if (srcContains(pattern)) ok(label);
  else fail(label);
}

// ── Summary ────────────────────────────────────────────────────────────────────
console.log('');
if (failures === 0) {
  console.log('[guard-contracts] All protected route contracts verified.');
  process.exit(0);
} else {
  console.error(`[guard-contracts] ${failures} protected route(s) missing. DO NOT deploy.`);
  process.exit(1);
}
