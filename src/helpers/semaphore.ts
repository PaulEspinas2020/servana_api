import https from "https";
import querystring from "querystring";

const SENDER_NAME = process.env.SEMAPHORE_SENDER_NAME || "SEMAPHORE";

export const sendSmsOtp = async (toPhone: string, otp: string): Promise<void> => {
  const apiKey = process.env.SEMAPHORE_API_KEY;
  if (!apiKey) throw new Error("SEMAPHORE_API_KEY is not set");

  // Normalise to 11-digit PH format (09xxxxxxxxx) — Semaphore expects local format
  const digits = toPhone.replace(/\D/g, "");
  let localPhone = digits;
  if (digits.startsWith("63") && digits.length === 12) {
    localPhone = "0" + digits.slice(2);
  } else if (digits.startsWith("+63")) {
    localPhone = "0" + digits.slice(3);
  }

  const payload = querystring.stringify({
    apikey: apiKey,
    number: localPhone,
    message: `Your Servana verification code is ${otp}. It expires in 10 minutes. Do not share this code.`,
    sendername: SENDER_NAME,
  });

  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.semaphore.co",
        path: "/api/v4/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Semaphore error ${res.statusCode}: ${body}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
};
