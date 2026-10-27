# Booking API

[English](README.md) · **Español**

<!-- portfolio:es -->
API REST para agendar citas con profesionales. La propia base de datos impide que dos citas se empalmen, y la recuperación de contraseña está diseñada contra la enumeración de cuentas y los ataques de fuerza bruta.
<!-- /portfolio:es -->

**Stack:** Node.js, TypeScript, Fastify, Prisma, PostgreSQL, Zod, Vitest.

## Decisión de diseño clave: sin citas duplicadas

Las citas que se empalman se evitan con una exclusion constraint de PostgreSQL,
no solo con código de la aplicación. Dos solicitudes simultáneas para el mismo
horario no pueden tener éxito las dos; la base de datos rechaza la segunda.

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
| PATCH  | `/professionals/me`  | Professional | Actualiza la biografía                |
| POST   | `/professionals/me/services` | Professional | Crea un servicio              |
| PATCH  | `/professionals/me/services/:serviceId` | Professional | Actualiza un servicio |
| DELETE | `/professionals/me/services/:serviceId` | Professional | Elimina un servicio (`409` si tiene citas) |
| PUT    | `/professionals/me/availability` | Professional | Reemplaza el horario semanal |
| GET    | `/professionals/me/time-off` | Professional | Próximos días fuera de servicio |
| POST   | `/professionals/me/time-off` | Professional | Agrega días fuera de servicio (`409` si ya hay citas en ellos) |
| DELETE | `/professionals/me/time-off/:timeOffId` | Professional | Elimina días fuera de servicio |

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

## Scripts

| Comando             | Descripción            |
| ------------------- | ---------------------- |
| `npm run dev`       | Inicia con recarga en caliente |
| `npm test`          | Ejecuta las pruebas (usa una base de datos `booking_test` aparte) |
| `npm run typecheck` | Verifica los tipos del proyecto |
| `npm run build`     | Compila a `dist/`      |

¿Preguntas? [Escríbeme](mailto:guerrerogenesisd@gmail.com).
