import { mailerKey, mailerSender } from "../config";
import {
  isValidEmail
} from "../helpers/validation";
import sgMail from '@sendgrid/mail'

if(mailerKey) sgMail.setApiKey(mailerKey);

const templates: any = {
  // to add template here once created
  //verify_email: "d-11bed1fea8dc49aaa735cbb5d11dee62",
  //pw_reset: "d-7bfcedb6768a4f43a8b1655599d4faf6"
  // confirm_email: "d-b325fec0028c419c9ec48c9b5866f10c"
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