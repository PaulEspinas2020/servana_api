import axios from 'axios';
import sgMail from '@sendgrid/mail';
import { mailerKey, mailerSender } from '../config';

if (mailerKey) sgMail.setApiKey(mailerKey);

export async function sendContactChangeCode(kind: 'email' | 'mobile', target: string, code: string): Promise<void> {
  if (kind === 'email') {
    if (!mailerKey || !mailerSender) throw unavailable();
    await sgMail.send({
      to: target,
      from: mailerSender,
      subject: 'Confirm your Servana email change',
      text: `Your Servana verification code is ${code}. It expires in 10 minutes. If you did not request this change, do not share this code.`,
    });
    return;
  }

  const apiKey = String(process.env.SEMAPHORE_API_KEY ?? '').trim();
  if (!apiKey) throw unavailable();
  const body = new URLSearchParams({
    apikey: apiKey,
    number: target,
    sendername: String(process.env.SEMAPHORE_SENDER_NAME ?? 'SERVANA').slice(0, 11),
    message: `Your Servana verification code is ${code}. It expires in 10 minutes. Do not share it.`,
  });
  try {
    await axios.post('https://api.semaphore.co/api/v4/messages', body.toString(), {
      timeout: 15_000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  } catch {
    throw unavailable();
  }
}

const unavailable = () => Object.assign(new Error('Verification delivery is temporarily unavailable'), {
  statusCode: 503,
  code: 'CONTACT_VERIFICATION_DELIVERY_UNAVAILABLE',
  retryable: true,
});
