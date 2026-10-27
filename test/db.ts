import { prisma } from "../src/db.js";

export async function resetDb() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "Appointment", "Availability", "Service", "Professional", "PasswordReset", "TimeOff", "User" CASCADE',
  );
}
