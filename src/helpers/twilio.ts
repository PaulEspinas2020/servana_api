import twilio from "twilio";

const getSid = () => process.env.TWILIO_ACCOUNT_SID as string;
const getToken = () => process.env.TWILIO_AUTH_TOKEN as string;
const getFrom = () => process.env.TWILIO_PHONE_NUMBER as string;

export const sendSmsOtp = async (toPhone: string, otp: string): Promise<void> => {
  const client = twilio(getSid(), getToken());

  await client.messages.create({
    body: `Your Servana verification code is ${otp}. It expires in 10 minutes. Do not share this code with anyone.`,
    from: getFrom(),
    to: toPhone,
  });
};
