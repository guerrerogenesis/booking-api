import type { PrismaClient, Role } from "@prisma/client";
import { hashPassword } from "../auth/password.js";

// Public demo credentials, published in the README. The demo sends no emails, so these
// accounts come pre-verified. Restored on every boot, so visitors can change anything
// without breaking the demo for the next one.
export const DEMO_PASSWORD = "Demo$ecret1";
export const DEMO_PROFESSIONAL_EMAIL = "pro.demo@example.com";
export const DEMO_CLIENT_EMAIL = "client.demo@example.com";

const profile = {
  bio: "Barber with 10 years of experience.",
  timezone: "America/Mexico_City",
  maxAppointmentsPerDay: null,
  bufferMinutes: 0,
};
const services = [
  { name: "Haircut", durationMinutes: 60, priceCents: 25000 },
  { name: "Beard trim", durationMinutes: 30, priceCents: 15000 },
];
// Monday to Friday, 09:00–17:00 in the professional's timezone.
const availability = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 }));

export async function seedDemo(db: PrismaClient) {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const account = (email: string, name: string, role: Role) => {
    const data = { name, role, passwordHash, emailVerifiedAt: new Date() };
    return db.user.upsert({ where: { email }, create: { email, ...data }, update: data });
  };

  await account(DEMO_CLIENT_EMAIL, "Luis Pérez", "CLIENT");
  const user = await account(DEMO_PROFESSIONAL_EMAIL, "Ana López", "PROFESSIONAL");
  const { id: professionalId } = await db.professional.upsert({
    where: { userId: user.id },
    create: { userId: user.id, ...profile },
    update: profile,
  });

  await db.$transaction(async (tx) => {
    await tx.availability.deleteMany({ where: { professionalId } });
    await tx.availability.createMany({ data: availability.map((slot) => ({ professionalId, ...slot })) });
    await tx.timeOff.deleteMany({ where: { professionalId } });

    // Services visitors added go away, unless appointments reference them.
    const names = services.map((service) => service.name);
    await tx.service.deleteMany({ where: { professionalId, name: { notIn: names }, appointments: { none: {} } } });
    for (const service of services) {
      const existing = await tx.service.findFirst({ where: { professionalId, name: service.name } });
      if (existing) await tx.service.update({ where: { id: existing.id }, data: service });
      else await tx.service.create({ data: { professionalId, ...service } });
    }
  });
}
