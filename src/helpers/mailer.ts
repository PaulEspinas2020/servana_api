import { mailerKey, mailerSender } from "../config";
import {
  isValidEmail
} from "../helpers/validation";
import sgMail from '@sendgrid/mail'

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
  //pw_reset: "d-7bfcedb6768a4f43a8b1655599d4faf6"
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
      return 'Email sent!';
  }, error => {
      console.log(error);
      console.log(error.response.body.error)
  });
}

export {
  send
};