import express, { NextFunction, Request, Response } from "express";
import http from "http";
import cors from "cors";
import cookieParser from "cookie-parser";
import formidable from "formidable";

import dotenv from "dotenv";
import { parityMiddleware } from "./middleware/parityMiddleware";
import { requestParityMiddleware } from "./middleware/requestParityMiddleware";

dotenv.config();

const app = express();
const router = express.Router();
const whitelist = [
  "http://localhost:4200",
  "https://provider.servana.com.ph",
  "https://admin.servana.com.ph",
  "https://www.servana.com.ph",
  "https://servana.com.ph",
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
app.set("trust proxy", true);
app.use(cors(corsOptionsDelegate))
app.use(cookieParser());
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

// SWEEP request parity — enriches incoming request bodies with cross-platform field aliases
app.use(requestParityMiddleware);
// SWEEP response parity — enriches every JSON response with cross-platform field aliases
app.use(parityMiddleware);
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

import authRoute from "./routes/auth.route";
app.use("/api", cors(corsOptionsDelegate), authRoute);

import userRoute from "./routes/user.route";
app.use("/api", cors(corsOptionsDelegate), userRoute);

import serviceRoute from "./routes/service.route";
app.use("/api", cors(corsOptionsDelegate), serviceRoute);

import pricingRoutes from "./routes/pricing.routes";
app.use("/api", cors(corsOptionsDelegate), pricingRoutes);

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

import adminProviderRoutes from "./routes/adminProvider.routes";
app.use("/api", cors(corsOptionsDelegate), adminProviderRoutes);

import adminOnboardingRoutes from "./routes/adminOnboarding.routes";
app.use("/api", cors(corsOptionsDelegate), adminOnboardingRoutes);

import adminBookingRoutes from "./routes/adminBooking.routes";
app.use("/api", cors(corsOptionsDelegate), adminBookingRoutes);

import adminDashboardRoutes from "./routes/adminDashboard.routes";
app.use("/api", cors(corsOptionsDelegate), adminDashboardRoutes);

// Use an http.Server so Socket.IO can share the same port as Express.
import { initChatSocket } from "./chat/chat.gateway";
import { initProviderSocket } from "./provider.gateway";
const httpServer = http.createServer(app);
const io = initChatSocket(httpServer);
initProviderSocket(io);

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

httpServer.listen(port, () => {
    console.log(`Magic is running on port ${port}`);
});
