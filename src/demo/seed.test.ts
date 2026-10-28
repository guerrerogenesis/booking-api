import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../test/db.js";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { DEMO_CLIENT_EMAIL, DEMO_PASSWORD, DEMO_PROFESSIONAL_EMAIL, seedDemo } from "./seed.js";

const app = buildApp({ notifier: { notify: async () => {} } });

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  expect(res.statusCode).toBe(200);
  return { authorization: `Bearer ${res.json().token}` };
}

async function demoProfessional() {
  return prisma.professional.findFirstOrThrow({
    where: { user: { email: DEMO_PROFESSIONAL_EMAIL } },
    include: { services: true, availability: true, timeOff: true },
  });
}

beforeEach(async () => {
  await resetDb();
  await seedDemo(prisma);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("seedDemo", () => {
  it("creates verified accounts that can log in and book", async () => {
    const client = await login(DEMO_CLIENT_EMAIL);
    await login(DEMO_PROFESSIONAL_EMAIL);
    const { id, services } = await demoProfessional();

    // Next Monday, so the slot is on a working day and outside the 2-hour notice.
    const monday = new Date();
    monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7 || 7));
    const date = monday.toISOString().slice(0, 10);
    const slots = await app.inject({ url: `/professionals/${id}/slots?serviceId=${services[0].id}&date=${date}` });
    const [slot] = slots.json().slots;

    const booking = await app.inject({
      method: "POST",
      url: "/appointments",
      headers: client,
      payload: { professionalId: id, serviceId: services[0].id, startsAt: slot.startsAt },
    });
    expect(booking.statusCode).toBe(201);
  });

  it("is idempotent", async () => {
    await seedDemo(prisma);

    expect(await prisma.user.count()).toBe(2);
    const { services, availability } = await demoProfessional();
    expect(services).toHaveLength(2);
    expect(availability).toHaveLength(5);
  });

  it("restores what visitors changed, keeping services that have appointments", async () => {
    const professional = await demoProfessional();
    const client = await prisma.user.findUniqueOrThrow({ where: { email: DEMO_CLIENT_EMAIL } });
    await prisma.user.update({ where: { id: client.id }, data: { passwordHash: "changed" } });
    await prisma.professional.update({ where: { id: professional.id }, data: { timezone: "Asia/Tokyo" } });
    await prisma.availability.deleteMany({ where: { professionalId: professional.id } });
    await prisma.timeOff.create({
      data: { professionalId: professional.id, startDate: new Date("2030-01-01"), endDate: new Date("2030-01-02") },
    });
    const unused = await prisma.service.create({
      data: { professionalId: professional.id, name: "Unused", durationMinutes: 15, priceCents: 100 },
    });
    const booked = await prisma.service.create({
      data: { professionalId: professional.id, name: "Booked", durationMinutes: 15, priceCents: 100 },
    });
    await prisma.appointment.create({
      data: {
        professionalId: professional.id,
        serviceId: booked.id,
        clientId: client.id,
        startsAt: new Date("2030-01-07T15:00:00Z"),
        endsAt: new Date("2030-01-07T15:15:00Z"),
      },
    });

    await seedDemo(prisma);

    await login(DEMO_CLIENT_EMAIL);
    const restored = await demoProfessional();
    expect(restored.timezone).toBe("America/Mexico_City");
    expect(restored.availability).toHaveLength(5);
    expect(restored.timeOff).toHaveLength(0);
    const names = restored.services.map((service) => service.name);
    expect(names).not.toContain(unused.name);
    expect(names.sort()).toEqual(["Beard trim", "Booked", "Haircut"]);
  });
});
