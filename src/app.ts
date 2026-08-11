import express, { NextFunction, Request, Response } from "express";
import http from "http";
import cors from "cors";
import cookieParser from "cookie-parser";
import formidable from "formidable";
import { randomUUID } from "crypto";

import dotenv from "dotenv";
import { parityMiddleware } from "./middleware/parityMiddleware";
import { requestParityMiddleware } from "./middleware/requestParityMiddleware";

dotenv.config();

const app = express();
const router = express.Router();
// KEEP IN SYNC with ALLOWED_ORIGINS in src/chat/chat.gateway.ts. They are two
// lists of the same thing: an origin added here but not there gets working REST
// calls and a chat socket that silently refuses to connect.
const whitelist = [
  "http://localhost:4200",
  "http://localhost:4201",
  "https://provider.servana.com.ph",
  "https://admin.servana.com.ph",
  "https://www.servana.com.ph",
  "https://servana.com.ph",
  // Customer web portal. Added 2026-08-09 — without it every request from the
  // customer web origin is refused by CORS, which the browser reports as a
  // network failure rather than as a rejection, so it reads like the API is
  // down. Purely additive: no existing origin is affected.
  "https://client.servana.com.ph",
];
const corsOptionsDelegate = function (req: any, callback: any) {
    var corsOptions;
    if (whitelist.indexOf(req.header("Origin")) !== -1) {
        corsOptions = { origin: true }; // reflect (enable) the requested origin in the CORS response
    } else {
        corsOptions = { origin: false }; // disable CORS for this request
    }
    callback(null, corsOptions); // callback expects two parameters: error and options
};

const port = process.env.PORT;
app.disable("x-powered-by");
app.set("trust proxy", 1); // trust first hop (Nginx on same server) only — prevents IP spoofing
app.use(cors(corsOptionsDelegate))
app.use(cookieParser());

// Stamp every request with a stable UUID for tracing and audit correlation
app.use((req: Request, _res: Response, next: NextFunction) => {
  (req as any).id = randomUUID();
  next();
});
app.use(
  "/api/paymongo/webhook",
  express.raw({ type: "application/json" })
);

app.use((req, _res, next) => {
  if (Buffer.isBuffer((req as any).body)) {
    (req as any).rawBody = (req as any).body;
    try {
      req.body = JSON.parse((req as any).body.toString("utf8"));
    } catch {
      req.body = {};
    }
  }
  next();
});

// 10mb covers base64-encoded images up to ~7.5 MB raw; processor outputs ≤3.5 MB (≈4.7 MB base64).
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// SWEEP request parity — enriches incoming request bodies with cross-platform
// field aliases. Exempt under /api/v1 for the same reason the response half is:
// a v1 endpoint declares the body it accepts, and a middleware that invents
// additional keys means the declared shape is not the shape the handler reads.
app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api/v1')) return next();
    return requestParityMiddleware(req, res, next);
});
// SWEEP response parity — enriches every JSON response with cross-platform field aliases.
//
// The canonical Admin Catalog is exempt, and the reason is not tidiness.
// Parity maps `name` → `serviceName`, `service_name`, `level2`, `level_2`, so a
// canonical Service came back carrying `level2: "Wiring fuitures"` — its own
// name. In the legacy model `level2` is the SUBCATEGORY. Shipping a key whose
// established meaning is contradicted by its value, on the exact contract the
// Flutter clients are about to migrate onto, would plant precisely the
// ambiguity Catalog V2 exists to remove (§52).
//
// Scoped by path prefix so no existing route's response shape moves (§4).
//
// The public canonical catalog carries the same exemption and needs it more,
// not less: it is the surface the Flutter clients actually migrate onto, so a
// parity-generated `level2` there would be read by a customer app as the
// Subcategory name while holding the Service's own name. Neither prefix
// overlaps an existing route — provider catalog is `/api/provider-catalog/*`.
// `/api/v1` carries the same exemption for a stronger reason than the catalog
// prefixes do. v1 publishes an explicit DTO per endpoint and an OpenAPI
// document generated from it. A middleware that adds keys to every response
// makes that document false the moment it runs — the wire would carry fields
// the contract does not declare, and a client generated from the spec would be
// reading a shape nobody wrote down. Explicit DTOs and global field rewriting
// are two answers to the same question, and only one of them can be true.
//
// `tests/v1-parity-exemption.test.ts` pins this. It is the kind of guarantee
// that survives exactly as long as nobody edits this list by hand.
export const CANONICAL_CONTRACT_PREFIXES = ['/api/v1', '/api/admin/catalog', '/api/catalog'];
app.use((req: Request, res: Response, next: NextFunction) => {
    if (CANONICAL_CONTRACT_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    return parityMiddleware(req, res, next);
});
app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.is("multipart/form-data") == "multipart/form-data") {
        const form = formidable({ multiples: true, maxFileSize: 15 * 1024 * 1024 });
        form.parse(req, (error, fields, files) => {
            if (error) {
                next(error);
            } else {
                (req as any).fields = fields;
                (req as any).files = Object.values(files);
                next();
            }
        });
    } else {
        next();
    }
});

app.use((req: Request, res: Response, next: NextFunction) => {
    res.locals.timezone = req.get("TimeZone") !== undefined ? req.get("TimeZone") : "UTC";
    next();
});

app.get("/hello", (req: Request, res: Response) => {
    res.json({ message: "Hello, from router!" });
});

/**
 * ─── CANONICAL v1 — mounted FIRST, deliberately ─────────────────────────────
 *
 * Every path below this line belongs to the legacy tree, and that tree contains
 * `GET /api/:id` (booking.routes) — a single-segment wildcard at the API root.
 * Anything registered after it that is one segment long is unreachable, which
 * is exactly what happened to `GET /api/catalog`.
 *
 * `/api/v1/*` is two segments so it could not be shadowed by that route today,
 * but "could not be shadowed today" is the property that quietly stops being
 * true. Mounting the canonical namespace first makes it unshadowable by
 * construction, and `tests/route-shadowing.test.ts` fails the build if any
 * route in the composed app eclipses another.
 *
 * The v1 router ends in its own 404, so an unknown `/api/v1` path says so
 * rather than falling through to the legacy tree and answering 401.
 */
import v1Router from "./api/v1/register";
app.use("/api/v1", cors(corsOptionsDelegate), v1Router);

/**
 * Counts every legacy route that the v1 contract names as superseded.
 *
 * Mounted after v1 and before the legacy tree, so a v1 call is never counted as
 * legacy traffic and every legacy call is counted exactly once regardless of
 * which router eventually answers it. The watch list is derived from
 * `V1_CONTRACT.legacy`, so it cannot fall out of step with the migration matrix.
 *
 * Read it with: pm2 logs servana-prod | grep legacy-contract
 */
import { legacyContractTelemetry } from "./api/v1/legacyTelemetry";
app.use(legacyContractTelemetry);

import authRoute from "./routes/auth.route";
app.use("/api", cors(corsOptionsDelegate), authRoute);

import userRoute from "./routes/user.route";
app.use("/api", cors(corsOptionsDelegate), userRoute);

import serviceRoute from "./routes/service.route";
app.use("/api", cors(corsOptionsDelegate), serviceRoute);

import pricingRoutes from "./routes/pricing.routes";
app.use("/api", cors(corsOptionsDelegate), pricingRoutes);

/**
 * The public canonical catalog is mounted BEFORE bookings, and the order is
 * load-bearing.
 *
 * `booking.routes` registers `GET /:id`. Mounted at `/api`, that matches any
 * single-segment GET — so with the catalog router below it, `GET /api/catalog`
 * resolved to the booking getter: 401 for the unauthenticated customer app the
 * route exists for, and 400 "Invalid booking id" for everyone else. The three
 * deeper `/catalog/*` paths were unaffected, which is what made it survive a
 * green test run.
 *
 * Moving the mount is the whole fix. No path, payload or guard changes, and no
 * booking id can be the literal string "catalog", so no booking call is
 * affected. Retiring `GET /:id` instead would have been the tidier repair and
 * is not available: it is a live protected-client contract (§5).
 */
import catalogPublicRoutes from "./routes/catalogPublic.routes";
app.use("/api", cors(corsOptionsDelegate), catalogPublicRoutes);

import bookingRoutes from "./routes/booking.routes";
app.use("/api", cors(corsOptionsDelegate), bookingRoutes);

import technicianRoutes from "./routes/technician.routes";
app.use("/api", cors(corsOptionsDelegate), technicianRoutes);

import paymentRoutes from "./routes/payment.routes";
app.use("/api", cors(corsOptionsDelegate), paymentRoutes);

import additionalRoutes from "./routes/additional.routes";
app.use("/api", cors(corsOptionsDelegate), additionalRoutes);

import chatRoutes from "./chat/chat.routes";
app.use("/api", cors(corsOptionsDelegate), chatRoutes);

import disbursementRoutes from "./routes/disbursement.routes";
app.use("/api", cors(corsOptionsDelegate), disbursementRoutes);

import providerRoutes from "./routes/provider.routes";
app.use("/api", cors(corsOptionsDelegate), providerRoutes);

import locationRoutes from "./routes/location.routes";
app.use("/api", cors(corsOptionsDelegate), locationRoutes);

import providerCatalogRoutes from "./routes/providerCatalog.routes";
app.use("/api", cors(corsOptionsDelegate), providerCatalogRoutes);

// Canonical Admin Catalog — Category → Subcategory → Service, keyed on
// services.id. Additive: it introduces new paths only and leaves every existing
// route, including the /api/services* provider-compatibility projections,
// untouched (§4).
import catalogAdminRoutes from "./routes/catalogAdmin.routes";
app.use("/api", cors(corsOptionsDelegate), catalogAdminRoutes);

// Canonical PUBLIC Catalog — the customer-facing read half of the same model.
// Catalog V2 shipped Admin-only, which left the Client App with no canonical
// hierarchy it could legally read: `/api/admin/catalog/*` requires role 1, and
// a customer app must never hold that. Without this router the only way to give
// the app a Category → Subcategory → Service tree was to rebuild it in Dart
// from the legacy option shape — manufacturing the catalog on the frontend,
// which §3 and §30 forbid. Read-only and additive (§4).
//
// MOUNTED ABOVE `booking.routes`, not here — see the comment there. Leaving the
// registration at this position is what made `GET /api/catalog` unreachable.

import adminProviderRoutes from "./routes/adminProvider.routes";
app.use("/api", cors(corsOptionsDelegate), adminProviderRoutes);

import adminProviderAvailabilityRoutes from "./routes/adminProviderAvailability.routes";
app.use("/api", cors(corsOptionsDelegate), adminProviderAvailabilityRoutes);

import adminOnboardingRoutes from "./routes/adminOnboarding.routes";
app.use("/api", cors(corsOptionsDelegate), adminOnboardingRoutes);

import adminBookingRoutes from "./routes/adminBooking.routes";
app.use("/api", cors(corsOptionsDelegate), adminBookingRoutes);

import { ensureAdminCreateBookingSchema } from "./services/adminCreateBookingService";
(async () => {
  try {
    await ensureAdminCreateBookingSchema();
  } catch (err) {
    console.error("[admin-create-booking] schema error:", err);
  }
})();

import adminBookingDraftRoutes from "./routes/adminBookingDraft.routes";
app.use("/api", cors(corsOptionsDelegate), adminBookingDraftRoutes);

import { ensureAdminBookingDraftSchema } from "./services/adminBookingDraftService";
(async () => {
  try {
    await ensureAdminBookingDraftSchema();
  } catch (err) {
    console.error("[admin-booking-draft] schema error:", err);
  }
})();

import adminDashboardRoutes from "./routes/adminDashboard.routes";
app.use("/api", cors(corsOptionsDelegate), adminDashboardRoutes);

import adminAuditRoutes from "./routes/adminAudit.routes";
app.use("/api", cors(corsOptionsDelegate), adminAuditRoutes);

import adminCommunicationRoutes from "./routes/adminCommunication.routes";
app.use("/api", cors(corsOptionsDelegate), adminCommunicationRoutes);
import adminSupportCaseRoutes from "./routes/adminSupportCase.routes";
app.use("/api", cors(corsOptionsDelegate), adminSupportCaseRoutes);
import adminNotificationRoutes from "./routes/adminNotification.routes";
app.use("/api", cors(corsOptionsDelegate), adminNotificationRoutes);

import adminAutoOnlineRoutes from "./routes/adminAutoOnline.routes";
app.use("/api", cors(corsOptionsDelegate), adminAutoOnlineRoutes);

import adminFinanceRoutes from "./routes/adminFinance.routes";
app.use("/api", cors(corsOptionsDelegate), adminFinanceRoutes);

import adminPermissionRoutes from "./routes/adminPermission.routes";
app.use("/api", cors(corsOptionsDelegate), adminPermissionRoutes);

import adminCustomerRoutes from "./routes/adminCustomer.routes";
app.use("/api", cors(corsOptionsDelegate), adminCustomerRoutes);

import adminUserAccountRoutes from "./routes/adminUserAccount.routes";
app.use("/api", cors(corsOptionsDelegate), adminUserAccountRoutes);

import customerSupportRoutes from "./routes/customerSupport.routes";
app.use("/api", cors(corsOptionsDelegate), customerSupportRoutes);

import customerReviewRoutes from "./routes/customerReview.routes";
app.use("/api", cors(corsOptionsDelegate), customerReviewRoutes);

/**
 * Account deletion (Google Play "Data deletion" policy).
 *
 * The page router is mounted WITHOUT the /api prefix and without the CORS
 * delegate: it is a plain HTML page a Play reviewer opens directly in a
 * browser, not an XHR target, and putting it behind the API origin allowlist
 * would 403 exactly the person it exists for.
 */
import accountDeletionRoutes, { accountDeletionPageRouter } from "./routes/accountDeletion.routes";
app.use("/api", cors(corsOptionsDelegate), accountDeletionRoutes);
app.use(accountDeletionPageRouter);

// Use an http.Server so Socket.IO can share the same port as Express.
import { initChatSocket } from "./chat/chat.gateway";
import { initProviderSocket } from "./provider.gateway";
const httpServer = http.createServer(app);
const io = initChatSocket(httpServer);
initProviderSocket(io);

// Additive chat lifecycle columns (status / can_read / can_send). Every
// statement is IF NOT EXISTS, so this is a no-op after the first boot. It is
// not awaited — a DDL hiccup must not stop the server coming up, and every
// read path COALESCEs the new columns.
import { ensureChatLifecycleSchema } from "./chat/chat.repository";
ensureChatLifecycleSchema().catch((e) =>
  console.error("[chat] lifecycle schema init failed:", e)
);

import { startScheduler } from "./scheduler";
startScheduler();

import { initProviderCatalogSchema, seedBuiltInOfferings } from "./services/providerCatalogService";
(async () => {
  try {
    await initProviderCatalogSchema();
    await seedBuiltInOfferings();
  } catch (err) {
    console.error("[provider-catalog] schema/seed error:", err);
  }
})();

import { ensureOnboardingSchema, seedReasonCodes, seedRequirementDefinitions } from "./services/adminOnboardingService";
(async () => {
  try {
    await ensureOnboardingSchema();
    await seedReasonCodes();
    await seedRequirementDefinitions();
  } catch (err) {
    console.error("[admin-onboarding] schema/seed error:", err);
  }
})();

import { ensureAttributionSchema } from "./services/adminMobileAttributionService";
(async () => {
  try {
    await ensureAttributionSchema();
  } catch (err) {
    console.error("[mobile-attribution] schema error:", err);
  }
})();

import { ensureProviderWebSchema } from "./services/providerOnboardingService";
(async () => {
  try {
    await ensureProviderWebSchema();
  } catch (err) {
    console.error("[provider-web-onboarding] schema error:", err);
  }
})();

import { ensureBookingOpsSchema } from "./services/adminBookingService";
(async () => {
  try {
    await ensureBookingOpsSchema();
  } catch (err) {
    console.error("[booking-ops] schema error:", err);
  }
})();

import { ensureAuditSchema } from "./services/adminAuditService";
(async () => {
  try {
    await ensureAuditSchema();
  } catch (err) {
    console.error("[admin-audit] schema error:", err);
  }
})();

import { ensureCommunicationSchema } from "./services/adminCommunicationService";
(async () => {
  try {
    await ensureCommunicationSchema();
  } catch (err) {
    console.error("[admin-communication] schema error:", err);
  }
})();

import { bootstrap as bootstrapAutoOnline } from "./services/providerAutoOnlineEngine";
(async () => {
  try {
    await bootstrapAutoOnline();
  } catch (err) {
    console.error("[auto-online] schema error:", err);
  }
})();

import { ensureFinanceSchema } from "./services/adminFinanceService";
(async () => {
  try {
    await ensureFinanceSchema();
  } catch (err) {
    console.error("[admin-finance] schema error:", err);
  }
})();

/**
 * Identity columns MUST be ensured at boot.
 *
 * upsertFirebaseUser has written email_normalized / phone_normalized since
 * f97fc0d, but this bootstrap was written and never called — so the columns did
 * not exist in production and EVERY Firebase sign-in failed with
 * `42703 column "email_normalized" does not exist`.
 *
 * It went unnoticed because email/password sign-in uses a different endpoint
 * that never touches this table's normalized columns. Only phone auth, which
 * goes through firebase-login, was broken — so it read as a mobile-specific bug
 * rather than as a missing migration.
 */
import { ensureIdentityColumns } from "./services/identityColumns";
(async () => {
  try {
    await ensureIdentityColumns();
  } catch (err) {
    console.error("[identity] column bootstrap failed:", err);
  }
})();

import { ensurePermissionSchema } from "./services/adminPermissionService";
(async () => {
  try {
    await ensurePermissionSchema();
  } catch (err) {
    console.error("[admin-permission] schema error:", err);
  }
})();

import { assertContinueUrlsAreUsable } from "./constants/platformContinueUrls";
import { ensureDashboardSchema } from "./services/adminDashboardService";
(async () => {
  try {
    await ensureDashboardSchema();
  } catch (err) {
    console.error("[admin-dashboard] schema error:", err);
  }
})();

/**
 * Refuse to start on a Firebase continue URL that could never work.
 *
 * These URLs are only ever exercised by an email somebody receives, so a typo
 * in `CUSTOMER_RESET_URL` is the kind of defect that surfaces as a locked-out
 * customer that support cannot explain. Checking at boot is the last cheap
 * moment; the alternative is finding out from the person it happened to.
 *
 * Deliberately before `listen`, and deliberately fatal. A process that starts
 * and silently emails broken password-reset links is worse than one that
 * refuses to start and names the variable that is wrong.
 */
assertContinueUrlsAreUsable();

httpServer.listen(port, () => {
    console.log(`Magic is running on port ${port}`);
});
