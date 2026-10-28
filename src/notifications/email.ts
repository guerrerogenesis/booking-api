import nodemailer from "nodemailer";
import type { Notifier } from "./notifier.js";

// Adapts nodemailer (SMTP) to the Notifier interface.
export function createEmailNotifier(): Notifier {
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? "localhost",
    port: Number(process.env.SMTP_PORT ?? 1025),
    // Mailpit needs no credentials; real providers (Brevo, Resend...) do.
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  const from = process.env.MAIL_FROM ?? "no-reply@booking.local";

  return {
    async notify(recipient, { subject, text }) {
      await transport.sendMail({ from, to: recipient.email, subject, text });
    },
  };
}
