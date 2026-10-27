import nodemailer from "nodemailer";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export function createSmtpMailer(): Mailer {
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? "localhost",
    port: Number(process.env.SMTP_PORT ?? 1025),
  });
  const from = process.env.MAIL_FROM ?? "no-reply@booking.local";

  return {
    async send(mail) {
      await transport.sendMail({ from, ...mail });
    },
  };
}
