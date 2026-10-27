import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance, FastifySchema } from "fastify";
import { z } from "zod";

// Request schemas come straight from the Zod schemas the handlers parse with, so the docs
// can't drift from the validation. Response schemas are defined here and checked against
// real responses by the contract test (src/docs.test.ts).

const id = z.uuid();
const dateTime = z.iso.datetime();
const date = z.iso.date();

export const errorResponse = z.object({
  error: z.string(),
  issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })).optional(),
});

export const healthResponse = z.strictObject({ status: z.literal("ok") });
export const messageResponse = z.strictObject({ message: z.string() });
export const tokenResponse = z.strictObject({ token: z.string().meta({ description: "JWT, valid for 1 hour" }) });
export const resetTokenResponse = z.strictObject({ resetToken: z.string().regex(/^[a-f0-9]{64}$/) });

export const userResponse = z.strictObject({
  id,
  email: z.email(),
  name: z.string(),
  role: z.enum(["CLIENT", "PROFESSIONAL"]),
});

export const serviceResponse = z.strictObject({
  id,
  name: z.string(),
  durationMinutes: z.int(),
  priceCents: z.int(),
});

export const availabilityResponse = z.strictObject({ weekday: z.int(), startMinute: z.int(), endMinute: z.int() });

export const profileResponse = z.strictObject({
  id,
  name: z.string(),
  bio: z.string().nullable(),
  timezone: z.string(),
  maxAppointmentsPerDay: z.int().nullable(),
  bufferMinutes: z.int(),
  services: z.array(serviceResponse),
  availability: z.array(availabilityResponse),
});

export const slotsResponse = z.strictObject({
  date,
  timezone: z.string(),
  durationMinutes: z.int(),
  slots: z.array(
    z.strictObject({
      startsAt: dateTime,
      endsAt: dateTime,
      localTime: z.string().meta({ description: "HH:MM in the professional's timezone" }),
    }),
  ),
});

export const timeOffResponse = z.strictObject({ id, startDate: date, endDate: date, reason: z.string().nullable() });

export const rescheduleRequestResponse = z.strictObject({
  id,
  appointmentId: id,
  startsAt: dateTime,
  endsAt: dateTime,
  status: z.enum(["PENDING", "ACCEPTED", "REJECTED", "WITHDRAWN", "EXPIRED", "CANCELLED"]),
  rejectionReason: z.string().nullable(),
  createdAt: dateTime,
  respondedAt: dateTime.nullable(),
});

export const appointmentResponse = z.strictObject({
  id,
  status: z.enum(["CONFIRMED", "CANCELLED"]),
  startsAt: dateTime,
  endsAt: dateTime,
  cancelledAt: dateTime.nullable(),
  cancelledBy: z.enum(["CLIENT", "PROFESSIONAL"]).nullable(),
  service: serviceResponse,
  professional: z.strictObject({ id, name: z.string(), timezone: z.string() }),
  client: z.strictObject({ id, name: z.string() }),
  pendingReschedule: rescheduleRequestResponse.nullable(),
});

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 429;

const errorDescriptions: Record<ErrorStatus, string> = {
  400: "Invalid input",
  401: "Missing or invalid token",
  403: "Not allowed for this user or role",
  404: "Not found",
  409: "Conflicts with the current state",
  429: "Too many requests (see Retry-After)",
};

function jsonSchema(schema: z.ZodType, io: "input" | "output") {
  const { $schema, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: "any" });
  return dropRedundantPatterns(rest);
}

// Zod adds long regexes next to standard formats (date-time, email...); the format says enough.
function dropRedundantPatterns(node: unknown): any {
  if (Array.isArray(node)) return node.map(dropRedundantPatterns);
  if (!node || typeof node !== "object") return node;
  const entries = Object.entries(node).filter(([key]) => !(key === "pattern" && "format" in node));
  return Object.fromEntries(entries.map(([key, value]) => [key, dropRedundantPatterns(value)]));
}

interface DocOptions {
  tag: string;
  summary: string;
  description?: string;
  auth?: boolean;
  body?: z.ZodType;
  querystring?: z.ZodType;
  params?: z.ZodType;
  response: Partial<Record<200 | 201 | 202 | 204, z.ZodType | null>>;
  errors?: readonly ErrorStatus[];
}

// Builds the route's OpenAPI schema. 400 is added for routes with input and 401 for
// authenticated ones; list any other error statuses in `errors`.
export function doc(options: DocOptions): FastifySchema {
  const response: Record<string, unknown> = {};
  for (const [status, schema] of Object.entries(options.response)) {
    response[status] = schema
      ? { description: "Success", ...jsonSchema(schema, "output") }
      : { description: "No content", type: "null" };
  }

  const errors = new Set(options.errors);
  if (options.body || options.querystring || options.params) errors.add(400);
  if (options.auth) errors.add(401);
  for (const status of [...errors].sort()) {
    response[status] = { description: errorDescriptions[status], ...jsonSchema(errorResponse, "output") };
  }

  // Keys are only set when present: Fastify warns about `body: undefined` and the like.
  const schema: FastifySchema = {
    tags: [options.tag],
    summary: options.summary,
    security: options.auth ? [{ bearerAuth: [] }] : [],
    response,
  };
  if (options.description) schema.description = options.description;
  if (options.body) schema.body = jsonSchema(options.body, "input");
  if (options.querystring) schema.querystring = jsonSchema(options.querystring, "input");
  if (options.params) schema.params = jsonSchema(options.params, "input");
  return schema;
}

// Uses each key as the route's operationId (the method name in generated API clients),
// so keys must be unique across the API.
export function withOperationIds<T extends Record<string, FastifySchema>>(docs: T): T {
  for (const [operationId, schema] of Object.entries(docs)) schema.operationId = operationId;
  return docs;
}

export function registerDocs(app: FastifyInstance) {
  // Zod in the handlers is the only validation; route schemas are documentation only.
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));

  // Every route must be documented, or the app refuses to start.
  app.addHook("onRoute", (route) => {
    if (route.schema?.hide || route.url.startsWith("/docs")) return;
    if (!route.schema?.summary) throw new Error(`Route ${route.method} ${route.url} has no OpenAPI docs`);
  });

  app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Booking API",
        version: "0.1.0",
        description:
          "Appointments with professionals. All times are ISO 8601 instants; local times are in the professional's timezone.",
      },
      servers: [{ url: "http://localhost:3000", description: "Local development" }],
      tags: [
        { name: "Health", description: "Service status" },
        { name: "Auth", description: "Accounts and JWT login" },
        { name: "Password reset", description: "Three-step reset with an emailed code" },
        { name: "Professionals", description: "Public profiles and available slots" },
        { name: "My profile", description: "The authenticated professional's settings, services and schedule" },
        { name: "Appointments", description: "Booking, listing and cancelling" },
        { name: "Reschedule", description: "Client requests to move an appointment, and direct moves by the professional" },
      ],
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
    },
  });
  app.register(swaggerUi, { routePrefix: "/docs" });
}
