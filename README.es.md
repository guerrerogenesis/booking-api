# Booking API

[![CI](https://github.com/guerrerogenesis/booking-api/actions/workflows/ci.yml/badge.svg)](https://github.com/guerrerogenesis/booking-api/actions/workflows/ci.yml)

[English](README.md) · **Español**

<!-- portfolio:es -->
API REST para agendar citas con profesionales. La propia base de datos impide que dos citas se empalmen, y la recuperación de contraseña está diseñada contra la enumeración de cuentas y los ataques de fuerza bruta.
<!-- /portfolio:es -->

**Stack:** Node.js, TypeScript, Fastify, Prisma, PostgreSQL, Zod, Vitest.

## Decisión de diseño clave: sin citas duplicadas

Dos capas garantizan que dos solicitudes simultáneas para el mismo horario no puedan tener éxito las dos:

1. **Bloqueo de fila.** Una reserva bloquea la fila del profesional (`SELECT ... FOR UPDATE`),
   vuelve a calcular los horarios libres y solo acepta una hora de inicio que esté entre ellos.
2. **Exclusion constraint.** Aunque el código de la aplicación tuviera un bug, PostgreSQL rechaza
   por sí mismo las citas confirmadas que se empalman, y la API responde `409`, no `500`.

Una prueba lanza dos reservas simultáneas y verifica que solo una gana.

```sql
EXCLUDE USING gist (
  "professionalId" WITH =,
  tstzrange("startsAt", "endsAt", '[)') WITH &&
) WHERE ("status" = 'CONFIRMED')
```

## Primeros pasos

Requiere Node 20+ y Docker.

```bash
cp .env.example .env
docker compose up -d
npm install
npx prisma migrate dev
npm run dev        # http://localhost:3000/health
```

## Documentación de la API

Documentación interactiva OpenAPI 3.1 en http://localhost:3000/docs (la especificación en `/docs/json`).

- **Generada desde el código.** Los esquemas de las peticiones son los mismos esquemas Zod con los que
  validan los handlers, convertidos con `z.toJSONSchema`, así que la documentación no puede desfasarse de la validación.
- **Toda ruta debe estar documentada**, o la app no arranca.
- **Prueba de contrato.** `src/docs.test.ts` recorre el flujo completo de reservas y verifica que el código de
  estado de cada respuesta esté documentado y que su cuerpo cumpla el esquema estricto, así que un campo no
  documentado o filtrado (como un email) hace fallar la build.

## Endpoints

| Método | Ruta             | Autenticación | Descripción                         |
| ------ | ---------------- | ---- | -------------------------------------------- |
| GET    | `/health`        | —    | Verificación de estado                       |
| POST   | `/auth/register` | —    | Crea una cuenta `CLIENT` o `PROFESSIONAL`    |
| POST   | `/auth/login`    | —    | Devuelve un JWT (válido por 1 hora)          |
| GET    | `/auth/me`       | JWT  | Usuario actual                               |
| POST   | `/auth/password-reset/request` | — | Envía por correo un código de 6 dígitos (siempre `202`) |
| POST   | `/auth/password-reset/verify`  | — | Cambia el código por un token de restablecimiento |
| POST   | `/auth/password-reset/confirm` | — | Establece una nueva contraseña con el token |
| GET    | `/professionals/:id` | — | Perfil público con servicios y disponibilidad semanal |
| GET    | `/professionals/:id/slots?serviceId&date` | — | Horarios de inicio libres para un servicio en una fecha |
| GET    | `/professionals/me`  | Professional | Perfil propio                         |
| PATCH  | `/professionals/me`  | Professional | Actualiza la biografía, la zona horaria y la configuración de reservas |
| POST   | `/professionals/me/services` | Professional | Crea un servicio              |
| PATCH  | `/professionals/me/services/:serviceId` | Professional | Actualiza un servicio |
| DELETE | `/professionals/me/services/:serviceId` | Professional | Elimina un servicio (`409` si tiene citas) |
| PUT    | `/professionals/me/availability` | Professional | Reemplaza el horario semanal |
| GET    | `/professionals/me/time-off` | Professional | Próximos días fuera de servicio |
| POST   | `/professionals/me/time-off` | Professional | Agrega días fuera de servicio (`409` si ya hay citas en ellos) |
| DELETE | `/professionals/me/time-off/:timeOffId` | Professional | Elimina días fuera de servicio |
| POST   | `/appointments`              | Client | Reserva un horario libre (`409` si no está disponible) |
| GET    | `/appointments/me?scope&limit&offset` | JWT | Citas propias (`upcoming` o `past`) |
| POST   | `/appointments/:id/cancel`   | JWT    | Cancela: el cliente necesita 48 h de anticipación; el profesional, en cualquier momento antes del inicio |
| POST   | `/appointments/:id/reschedule-requests` | Client | Propone un nuevo horario (48 h de anticipación, una solicitud pendiente a la vez) |
| GET    | `/appointments/:id/reschedule-requests` | JWT    | Historial de solicitudes de la cita |
| POST   | `/appointments/:id/reschedule-requests/:requestId/accept` | Professional | Mueve la cita al horario propuesto |
| POST   | `/appointments/:id/reschedule-requests/:requestId/reject` | Professional | Rechaza, con un `reason` opcional |
| POST   | `/appointments/:id/reschedule-requests/:requestId/withdraw` | Client | Retira una solicitud pendiente |
| POST   | `/appointments/:id/reschedule` | Professional | Mueve una cita directamente, en cualquier momento antes de que empiece |

Ambas partes reciben una notificación cuando se reserva, se mueve o se cancela una cita.

Las solicitudes de cambio no apartan el horario propuesto: al aceptarla se vuelve a verificar con el mismo
bloqueo que usan las reservas. Un índice único parcial permite solo una solicitud `PENDING` por cita, y las
solicitudes pendientes vencen solas cuando faltan menos de 48 horas (se revisa al momento, sin procesos en segundo plano).

Cada profesional tiene una `timezone` IANA (p. ej. `America/Mexico_City`); la disponibilidad semanal y
los días fuera de servicio se interpretan en esa zona horaria. Configuración de reservas opcional:
`maxAppointmentsPerDay` y `bufferMinutes` entre citas.

Las rutas bajo `/professionals/me` solo consultan los datos del profesional autenticado,
así que las propias consultas garantizan que cada quien acceda solo a lo suyo. Un servicio de otro
profesional devuelve `404`, no `403`, para no revelar que existe.

Las contraseñas se guardan como hash con `scrypt`, incluido en Node (con un salt aleatorio por usuario), y deben
tener entre 8 y 128 caracteres, con una mayúscula, una minúscula, un número y un símbolo, y sin espacios.

### Seguridad en la recuperación de contraseña

- La respuesta es la misma exista o no el correo, así que no se pueden enumerar cuentas.
- Los códigos expiran a los 15 minutos, permiten 5 intentos y se guardan como HMAC, nunca en texto plano.
- No se puede solicitar un código nuevo antes de 60 segundos desde el anterior.
- El token de restablecimiento es de un solo uso, incluso con solicitudes simultáneas.
- Rate limiting por IP en el inicio de sesión y en cada paso de la recuperación (`429` con `Retry-After`).

## Horarios disponibles

`computeSlots` (`src/professionals/slots.ts`) es una función pura, con pruebas unitarias que no requieren base de datos:

1. La fecha se interpreta en la zona horaria del profesional (considerando el horario de verano). Si es un día fuera de servicio o ya está lleno (`maxAppointmentsPerDay`), no hay horarios.
2. Los bloques de disponibilidad contiguos se unen, así que un servicio puede abarcar 09–12 y 12–15.
3. Se generan horarios de inicio cada 15 minutos en los que cabe el servicio completo.
4. Se descartan los horarios que chocan con citas confirmadas, incluidos los `bufferMinutes` antes y después.
5. Ventana de reserva: con al menos 2 horas de anticipación y a no más de 60 días.

## Notificaciones

Las notificaciones pasan por una interfaz `Notifier` (patrón adapter), así que el canal puede cambiar
sin tocar la lógica de negocio. El correo (SMTP con nodemailer) es el canal predeterminado; elige el canal
con `NOTIFIER_CHANNEL`. Para agregar SMS o WhatsApp, implementa `Notifier` en `src/notifications/`
y regístralo en `createNotifier()`.

En desarrollo, los correos los captura [Mailpit](https://mailpit.axllent.org/): abre http://localhost:8025.

## Deploy

El `Dockerfile` construye una imagen de producción (multi-stage, sin dependencias de desarrollo,
y corre con un usuario sin privilegios de root). Al arrancar aplica las migraciones pendientes y
luego inicia el servidor; con `SIGTERM` se cierra de forma ordenada para que terminen las peticiones en curso.

Configuración gratuita: la API en [Render](https://render.com) y la base de datos en [Neon](https://neon.tech).

1. Crea un proyecto en Neon y copia su cadena de conexión **directa** (sin pooling); las migraciones la necesitan.
2. En Render: **New > Blueprint** y elige este repo. `render.yaml` define el servicio; llena
   `DATABASE_URL` y los valores de SMTP. `JWT_SECRET` se genera solo.
3. Para los correos, usa un proveedor SMTP (p. ej. Mailtrap) con `SMTP_USER` y `SMTP_PASS`. El plan gratuito
   de Render bloquea los puertos 25, 465 y 587, así que elige un proveedor que acepte el puerto 2525.

Las instancias gratuitas de Render se suspenden tras ~15 minutos sin tráfico, así que la primera petición puede tardar hasta un minuto.

`TRUST_PROXY_HOPS` es el número de proxies delante de la app (`1` en Render), para que el rate limit
use la IP real del cliente. Es un número de saltos y no "confiar en todo" porque Render agrega su IP a
`X-Forwarded-For` en lugar de reemplazar el encabezado: confiar en todo el encabezado permitiría que un cliente
falsificara su IP y se saltara el rate limit. Una prueba demuestra que la dirección falsificada se ignora.

## Scripts

| Comando             | Descripción            |
| ------------------- | ---------------------- |
| `npm run dev`       | Inicia con recarga en caliente |
| `npm test`          | Ejecuta las pruebas (usa una base de datos `booking_test` aparte) |
| `npm run typecheck` | Verifica los tipos del proyecto |
| `npm run build`     | Compila a `dist/`      |

¿Preguntas? [Escríbeme](mailto:guerrerogenesisd@gmail.com).
