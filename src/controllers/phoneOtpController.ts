import { Request, Response } from "express";
import { db } from "../config";
import dbQuery from "../db/dbQuery";
import { generateOTP } from "../helpers/otp";
import { sendSmsOtp } from "../helpers/semaphore";
import mongoDb from "../db/mongodbQuery";
import { firebaseAdmin } from "../middleware/firebaseApp";
import { getAuth as getAuthAdmin } from "firebase-admin/auth";
import { getAuth, signInWithCustomToken } from "firebase/auth";

const dbSchema = db.schema;
const OTP_TTL_MINUTES = 10;

// ─── Normalise PH phone numbers to E.164 ──────────────────────────────────────

const toE164Ph = (phone: string): string => {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("63") && digits.length === 12) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 11) return `+63${digits.slice(1)}`;
  if (digits.length === 10) return `+63${digits}`;
  return `+${digits}`;
};

// ─── POST /api/auth/provider/request-otp ─────────────────────────────────────

export const requestOtp = async (req: Request, res: Response) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ status: "failed", message: "phone is required" });
    }

    const e164 = toE164Ph(String(phone));

    // Look up user by phone in DB
    const userRes = await dbQuery.query(
      `SELECT uid, first_name, phone_number
       FROM ${dbSchema}.user_credentials
       WHERE phone_number = $1 OR phone_number = $2
       LIMIT 1`,
      [phone, e164]
    );

    if (!userRes.rowCount) {
      // Return generic message — don't reveal whether phone is registered
      return res.status(200).json({
        status: "success",
        data: { message: "If this number is registered, an OTP has been sent." },
      });
    }

    const user = userRes.rows[0];
    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    // Store OTP in MongoDB with TTL
    const collection = (await mongoDb).collection("phone_otps");
    await collection.updateOne(
      { phone: e164 },
      {
        $set: {
          phone: e164,
          uid: user.uid,
          otp,
          expiresAt,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    // Send SMS via Twilio
    await sendSmsOtp(e164, otp);

    return res.status(200).json({
      status: "success",
      data: { message: "OTP sent to your registered number." },
    });
  } catch (error: any) {
    console.error("[requestOtp]", error?.message);
    return res.status(500).json({ status: "failed", message: "Failed to send OTP. Please try again." });
  }
};

// ─── POST /api/auth/provider/verify-otp ──────────────────────────────────────

export const verifyOtp = async (req: Request, res: Response) => {
  try {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ status: "failed", message: "phone and otp are required" });
    }

    const e164 = toE164Ph(String(phone));

    // Find OTP record in MongoDB
    const collection = (await mongoDb).collection("phone_otps");
    const record = await collection.findOne({ phone: e164 });

    if (!record) {
      return res.status(401).json({ status: "failed", message: "Invalid or expired OTP." });
    }

    if (new Date() > new Date(record.expiresAt)) {
      await collection.deleteOne({ phone: e164 });
      return res.status(401).json({ status: "failed", message: "OTP has expired. Please request a new one." });
    }

    if (record.otp !== String(otp)) {
      return res.status(401).json({ status: "failed", message: "Invalid OTP." });
    }

    // OTP is valid — delete it (one-time use)
    await collection.deleteOne({ phone: e164 });

    const uid = record.uid;

    // Get user from DB
    const userRes = await dbQuery.query(
      `SELECT uid, first_name, last_name, email, is_email_verified, role, worker_code
       FROM ${dbSchema}.user_credentials
       WHERE uid = $1`,
      [uid]
    );

    if (!userRes.rowCount) {
      return res.status(404).json({ status: "failed", message: "User not found." });
    }

    const user = userRes.rows[0];

    // Create Firebase custom token via Admin SDK
    const adminAuth = getAuthAdmin(firebaseAdmin);
    const customToken = await adminAuth.createCustomToken(uid);

    // Exchange custom token for ID token using Firebase Client SDK (server-side)
    const clientAuth = getAuth();
    const credential = await signInWithCustomToken(clientAuth, customToken);
    const idToken = await credential.user.getIdToken();

    return res.status(200).json({
      status: "success",
      data: {
        token: idToken,
        providerId: uid,
        userId: uid,
        firstName: user.first_name || "",
        lastName: user.last_name || "",
        role: "provider",
        accountStatus: user.is_email_verified ? "approved" : "pending",
        onboardingStatus: user.is_email_verified ? "approved" : "pending",
        isEmailVerified: user.is_email_verified ?? false,
        workerCode: user.worker_code || null,
      },
    });
  } catch (error: any) {
    console.error("[verifyOtp]", error?.message);
    return res.status(500).json({ status: "failed", message: "Verification failed. Please try again." });
  }
};
