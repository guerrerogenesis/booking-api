# Booking API

[![CI](https://github.com/guerrerogenesis/booking-api/actions/workflows/ci.yml/badge.svg)](https://github.com/guerrerogenesis/booking-api/actions/workflows/ci.yml)

[English](README.md) · **Español**

**Demo en vivo:** [booking-api-rg2g.onrender.com/docs](https://booking-api-rg2g.onrender.com/docs) (instancia gratuita: la primera petición tras un rato sin uso puede tardar hasta un minuto)

| Cuenta demo  | Email | Contraseña |
| ------------ | ----- | ---------- |
| Profesional  | `pro.demo@example.com` | `Demo$ecret1` |
| Cliente      | `client.demo@example.com` | `Demo$ecret1` |

Inicia sesión con `POST /auth/login`, haz clic en **Authorize** y pega el token. La demo no envía correos,
así que ahí no se pueden verificar registros nuevos; las cuentas demo se restauran en cada arranque.

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

### Postman

Importa `postman/booking-api.postman_collection.json` y `postman/local.postman_environment.json`.
Al correr la colección de principio a fin contra tu entorno local se recorre todo el flujo sin intervención:
cada request guarda los tokens e ids que necesitan los siguientes, cada corrida registra cuentas nuevas y
los códigos de verificación y de recuperación se leen de Mailpit.

## Endpoints

| Método | Ruta             | Autenticación | Descripción                         |
| ------ | ---------------- | ---- | -------------------------------------------- |
| GET    | `/health`        | —    | Verificación de estado                       |
| POST   | `/auth/register` | —    | Crea una cuenta `CLIENT` o `PROFESSIONAL` y envía un código de verificación |
| POST   | `/auth/verify-email` | — | Verifica el email con el código (necesario para iniciar sesión) |
| POST   | `/auth/verify-email/resend` | — | Envía un nuevo código de verificación (siempre `202`) |
| POST   | `/auth/login`    | —    | Devuelve un JWT (válido por 1 hora; `403` si el email no está verificado) |
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

### Verificación de email y protección contra abuso

Cada cuenta genera correos, así que la API se asegura de escribir solo a direcciones cuyo dueño lo pidió:

- Las cuentas nuevas reciben un código de 6 dígitos (con las mismas reglas que los códigos de recuperación) y no
  pueden iniciar sesión hasta verificarse, así que nunca se envía nada más (reservas, cambios, códigos de
  recuperación) a una dirección sin verificar.
- El registro tiene rate limit de 5 por hora por IP.
- Un tope global (`NOTIFICATION_DAILY_LIMIT`, 100 por día UTC por defecto) decora el notifier, así que ni el
  tráfico desde muchas IPs puede agotar la cuota del proveedor de correo. El contador es un upsert atómico en
  PostgreSQL, así que sobrevive a los reinicios y es exacto con peticiones simultáneas.
- Si alguien registra tu correo antes que tú, puedes recuperarlo: pide un nuevo código de verificación,
  verifica y después restablece la contraseña.

### Seguridad en la recuperación de contraseña

- La respuesta es la misma exista o no el correo, así que no se pueden enumerar cuentas. Los códigos solo se envían a correos verificados.
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
sin tocar la lógica de negocio. Elige el canal con `NOTIFIER_CHANNEL`:

- `email` (predeterminado): SMTP con nodemailer.
- `log`: no envía nada y registra en el log el destinatario y el asunto (nunca el cuerpo, que puede llevar
  códigos). La demo pública lo usa: con correos reales, cualquiera podría registrar direcciones temporales
  y agotar la cuota del proveedor.

Para agregar SMS o WhatsApp, implementa `Notifier` en `src/notifications/` y regístralo en `createNotifier()`.

En desarrollo, los correos los captura [Mailpit](https://mailpit.axllent.org/): abre http://localhost:8025.

## Deploy

El `Dockerfile` construye una imagen de producción (multi-stage, sin dependencias de desarrollo,
y corre con un usuario sin privilegios de root). Al arrancar aplica las migraciones pendientes, restaura las
cuentas demo si `SEED_DEMO=true` y luego inicia el servidor; con `SIGTERM` se cierra de forma ordenada para
que terminen las peticiones en curso.

Configuración gratuita: la API en [Render](https://render.com) y la base de datos en [Neon](https://neon.tech).

1. Crea un proyecto en Neon y copia su cadena de conexión **directa** (sin pooling); las migraciones la necesitan.
2. En Render: **New > Blueprint** y elige este repo. `render.yaml` define el servicio; llena
   `DATABASE_URL`. `JWT_SECRET` se genera solo.
3. El blueprint usa el canal `log` y crea las cuentas demo. Para enviar correos reales, pon
   `NOTIFIER_CHANNEL=email` junto con `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` y `MAIL_FROM`.
   El plan gratuito de Render bloquea los puertos 25, 465 y 587, así que elige un proveedor que acepte el puerto 2525.

Las instancias gratuitas de Render se suspenden tras ~15 minutos sin tráfico, así que la primera petición puede tardar hasta un minuto.

`TRUST_PROXY_HOPS` es el número de proxies delante de la app, para que el rate limit use la IP real
del cliente. En Render es `3` (Cloudflare y dos proxies de Render), medido en el servicio desplegado:
el `remoteAddress` del log coincide con el del cliente y un `X-Forwarded-For` falsificado se ignora.
Es un número de saltos y no "confiar en todo" porque Render agrega su IP a
`X-Forwarded-For` en lugar de reemplazar el encabezado: confiar en todo el encabezado permitiría que un cliente
falsificara su IP y se saltara el rate limit. Una prueba demuestra que la dirección falsificada se ignora.

## Scripts

| Comando             | Descripción            |
| ------------------- | ---------------------- |
| `npm run dev`       | Inicia con recarga en caliente |
| `npm test`          | Ejecuta las pruebas (usa una base de datos `booking_test` aparte) |
| `npm run typecheck` | Verifica los tipos del proyecto |
| `npm run build`     | Compila a `dist/`      |
| `npm run db:seed:demo` | Crea o restaura las cuentas demo |

¿Preguntas? [Escríbeme](mailto:guerrerogenesisd@gmail.com).
