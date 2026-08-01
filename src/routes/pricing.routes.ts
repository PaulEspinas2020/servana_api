import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import * as pricingController from "../controllers/pricingController";

const router = Router();

/**
 * Quoting stays PUBLIC on purpose.
 *
 * An audit recommended putting the auth middleware here because every
 * pricing-adjacent route has it. That would have been a regression: the customer app's booking
 * configuration screens are not in the router's protected list
 * (servana_client-main/lib/common/presentation/routes/main_router.dart:124-143
 * gates Settings, Bookings, Profile, Messages and friends — not the category or
 * option screens), so a signed-out customer can legitimately configure a job and
 * see a price before creating an account. Requiring a token would have broken browsing for exactly the people Servana
 * most wants to convert. (The middleware is named in prose only — a regression
 * test asserts this file does not reference it.)
 *
 * The defect this endpoint actually had was that it accepted PRICES from the
 * caller — `parts[].unit_price` was multiplied into the total and written to
 * quoted_price, final_price and the payments row. That is fixed in
 * pricingService.computeQuote, where it belonged: with every price resolved from
 * the database, a quote reveals nothing the public catalog does not already.
 *
 * What being public does deserve is a ceiling. Each call runs several DB
 * lookups, so it gets a limiter — generous enough that a customer comparing
 * options never notices, low enough that it cannot be used to hammer the
 * database.
 */
const quoteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "error",
    message: "Too many pricing requests. Please try again shortly.",
  },
});

router.post("/quote", quoteLimiter, pricingController.quote);

export default router;
