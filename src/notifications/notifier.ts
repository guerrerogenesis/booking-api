import { createEmailNotifier } from "./email.js";

export interface Recipient {
  name: string;
  email: string;
}

export interface Notification {
  subject: string;
  text: string;
}

// Each channel (email, SMS, WhatsApp...) is an adapter implementing this interface,
// so the rest of the app never depends on a specific provider.
export interface Notifier {
  notify(recipient: Recipient, notification: Notification): Promise<void>;
}

export function createNotifier(channel = process.env.NOTIFIER_CHANNEL ?? "email"): Notifier {
  switch (channel) {
    case "email":
      return createEmailNotifier();
    default:
      throw new Error(`Unknown notifier channel: ${channel}`);
  }
}
