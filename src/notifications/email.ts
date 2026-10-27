import nodemailer from "nodemailer";
import type { Notifier } from "./notifier.js";

// Adapts nodemailer (SMTP) to the Notifier interface.
export function createEmailNotifier(): Notifier {
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? "localhost",
    port: Number(process.env.SMTP_PORT ?? 1025),
  });
  const from = process.env.MAIL_FROM ?? "no-reply@booking.local";

  return {
    async notify(recipient, { subject, text }) {
      await transport.sendMail({ from, to: recipient.email, subject, text });
    },
  };
}
