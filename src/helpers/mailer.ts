import { mailerKey, mailerSender } from "../config";
import {
  isValidEmail
} from "../helpers/validation";
import sgMail from '@sendgrid/mail'
import { logCommunicationEvent } from "../services/adminCommunicationService";

if(mailerKey) sgMail.setApiKey(mailerKey);

const templates: any = {
  verify_email: "d-ee375012cb0f40778805bcf86bea255f",
  verify_email_otp: "d-aeb7e4734a83475988e2509910313c22",
  verify_booking_otp: "d-2eb4f7805752417797a1627f3717d901",
  booking_worker_assigned: "d-6baaa559c30f472f8ea0a0db8074b524",  // TODO: replace after creating in SendGrid
  booking_accepted: "d-a8698d90e9b040cca514b063564095ed",          // TODO: replace after creating in SendGrid
  booking_started: "d-986ec5fc29694a0ba02bff1d59b26a01",           // TODO: replace after creating in SendGrid
  booking_completed: "d-3abf263468f44b3d94eed9283c40a1d4",         // TODO: replace after creating in SendGrid
  payment_confirmed: "d-67ec56821df140b79263022d806ab062",         // TODO: replace after creating in SendGrid
  payment_failed: "d-51b66c564c9f41f380828e08f0d769b8",            // TODO: replace after creating in SendGrid
  additional_work_approved: "d-3a919e2ab9ba4e329eca33c00283d64d",  // TODO: replace after creating in SendGrid
  additional_work_rejected: "d-89698e254f164d0c8f0506cf0898dea5",  // TODO: replace after creating in SendGrid
  refund_processed: "d-faaf990253e64b5e974c922e696bb1a8",          // TODO: replace after creating in SendGrid
  booking_otp_reminder: "d-53a0b8df087d43b7b19e6769d05bf0d3 ",                  // TODO: create template in SendGrid
  payment_retry: "d-b2f8183438c440c9bf9016c3257e2426",                           // TODO: create template in SendGrid
  employee_invite: "d-48f357229164403a9a6ce115ca5f426c",   // TODO: create template in SendGrid
  forgot_password: "d-4abeb2443f88422f91eb2873a2f26751",
  //confirm_email: "d-b325fec0028c419c9ec48c9b5866f10c"
};

const send = (recipient:string, templateToUse:string, data: any) => {
  const email = isValidEmail(recipient.trim()) ? recipient : mailerSender;
  const msg: any = {
      to: email,
      from: mailerSender,
      templateId: templates[templateToUse],
      dynamic_template_data: {
          ...data
      }
  };

  sgMail.send(msg).then(() => {
      logCommunicationEvent({
        channel: 'email',
        status: 'sent',
        category: deriveCategoryFromTemplate(templateToUse),
        recipientEmail: email,
        templateName: templateToUse,
        subject: templateToUse.replace(/_/g, ' '),
        senderRole: 'system',
      }).catch(() => {});
      return 'Email sent!';
  }, error => {
      console.log(error);
      if (error.response?.body) console.log(error.response.body);
      logCommunicationEvent({
        channel: 'email',
        status: 'failed',
        severity: 'error',
        category: deriveCategoryFromTemplate(templateToUse),
        recipientEmail: email,
        templateName: templateToUse,
        subject: templateToUse.replace(/_/g, ' '),
        senderRole: 'system',
        errorMessage: error && error.message ? String(error.message).substring(0, 500) : 'SendGrid error',
      }).catch(() => {});
  });
}

function deriveCategoryFromTemplate(name: string): any {
  if (name.startsWith('booking') || name.startsWith('additional_work')) return 'booking';
  if (name.startsWith('payment') || name.startsWith('refund')) return 'payment';
  if (name.startsWith('verify_email') || name.startsWith('forgot_password') || name.startsWith('employee_invite')) return 'auth';
  if (name.startsWith('verify_booking')) return 'booking';
  return 'system';
}

export {
  send
};