# Gestor editorial y de redes de afterstage

Backend Node.js desacoplado para gestionar el ciclo completo de una pieza editorial: idea, nota, material visual, copys, aprobación, programación y publicación. La interfaz React/Vite vive en `../frontend` y consume esta API.

## Norte del producto

afterstage busca convertirse en un medio reconocido para acceder a pases de prensa en eventos y recitales. El gestor debe ayudar a demostrar trabajo periodístico real: archivo de coberturas, notas consistentes, fotos correctamente acreditadas, métricas y seguimiento de contactos. La automatización de redes es el último tramo de ese proceso, no un sustituto de la edición ni de la relación con productoras y salas.

El dominio de prensa ya incorpora:

- eventos y artistas vinculados a cada nota y cobertura;
- dossier de prensa público con audiencia, equipo, servicios y ejemplos;
- agenda de productoras, sellos, salas y contactos de prensa;
- solicitudes de acreditación con estados `borrador`, `enviada`, `aceptada`, `rechazada`, `cubierta` y `seguimiento`;
- historial de enlaces y métricas para adjuntar a cada nuevo pedido.

## Arquitectura

- **Frontend:** React 19 + Vite, servido como SPA por Nginx y conectado a esta API.
- **API:** Node.js 22, Express y TypeScript estricto.
- **Persistencia:** MongoDB obligatorio; los stores JSON sólo existen para tests unitarios aislados.
- **IA:** endpoint compatible con OpenAI para nota completa, copys o edición.
- **Meta:** Instagram Content Publishing API y Facebook Pages API.
- **MCP:** servidor remoto Streamable HTTP con OAuth 2.1, PKCE, scopes y perfiles por cuenta; nunca guarda tokens de usuarios en variables de entorno.
- **Operación:** logs JSON, health/readiness, estado del scheduler, rate limit, auditoría `data/audit.jsonl` y script de backup.
- **Operación:** imagen Docker multi-stage, usuario sin privilegios y healthcheck.

La estructura de `src` sigue una arquitectura por capas:

```text
src/
├── domain/                    # tipos, schemas y reglas puras
│   ├── content/
│   └── press/
├── application/               # casos de uso y scheduler
├── infrastructure/
│   ├── persistence/            # JSON/MongoDB
│   └── integrations/           # Meta, IA, SMTP, RSS y medios
├── interfaces/
│   ├── http/                   # Express, seguridad y endpoints
│   └── mcp/                    # transporte MCP
└── bootstrap/                  # arranque del proceso
```

Las colecciones `contents`, `press_events`, `press_contacts`, `press_accreditations`, `press_coverages`, `press_settings`, `directory` y `users` se inicializan con índices para estados, fechas, agenda, directorio y búsquedas de contactos. Sin `MONGODB_URI` el servicio no inicia.

No se automatiza Chrome. La API oficial de Meta evita selectores rotos, sesiones vencidas, captchas y almacenamiento de contraseñas. También ofrece IDs, estados y errores auditables. Si una función no está disponible para la cuenta, se puede añadir otro adaptador detrás de `MetaPublisher` sin cambiar el panel ni MCP.

## Inicio rápido

```bash
cp .env.example .env
# Generar un token seguro, por ejemplo: openssl rand -hex 32
docker compose up --build
```

La interfaz queda disponible en `http://localhost:8080` y la redacción en `http://localhost:8080/admin`. El backend directo queda en `http://localhost:8787`.

Para desarrollo sin Docker:

```bash
cd backend
npm install
npm run dev
```

## Variables

| Variable | Uso |
| --- | --- |
| `MONGODB_URI` | URI obligatoria de MongoDB Atlas. |
| `MONGODB_DB` | Base de datos, por defecto `afterstage`. |
| `PUBLIC_BASE_URL` | Origen HTTPS público desde el que Meta descargará imágenes y Mercado Pago volverá al checkout. |
| `MERCADOPAGO_ACCESS_TOKEN` | Token privado para crear preferencias y validar pagos desde el webhook. |
| `MONETIZATION_PRODUCTS_JSON` | Catálogo opcional configurable en JSON; si se omite se usa el catálogo inicial de monetización. |
| `MEDIA_ROOT` | Raíz local autorizada para archivos que se sirven bajo `/media`. |
| `PUBLIC_MEDIA_BASE_URL` | Base pública alternativa para medios locales. |
| `CLOUDFLARE_TUNNEL_URL` | URL HTTPS vigente del túnel Cloudflare que apunta al puerto del gestor. |
| `AI_API_KEY` | Opcional para las herramientas internas de regeneración editorial (`/api/content/:id/generate`); no es necesaria para el MCP, porque el agente genera la nota. Nunca debe configurarse en el cliente, Git o la conexión MCP. |
| `AI_BASE_URL` | Base OpenAI-compatible; por defecto `https://api.openai.com/v1`. |
| `AI_MODEL` | Modelo de redacción. |
| `META_ACCESS_TOKEN` | Token de Page de larga duración. |
| `META_INSTAGRAM_ACCOUNT_ID` | ID de la cuenta profesional vinculada. |
| `META_PAGE_ID` | ID de la página de Facebook. |
| `META_API_VERSION` | Versión de Graph API, configurable para facilitar upgrades. |
| `CORS_ORIGINS` | Lista opcional de orígenes permitidos, separada por comas. |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | Opcionales. Habilitan el envío de solicitudes de acreditación. |
| `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM` | Ajustes del transporte de correo. |
| `JWT_SECRET` | Clave obligatoria para firmar y validar los JWT del login. |
| `JWT_ACCESS_TTL_SECONDS` | Duración del access token emitido por `/api/auth/login` (mínimo 5 minutos; por defecto 15). |
| `MCP_PUBLIC_URL` | URL pública HTTPS del recurso MCP y su Authorization Server; por defecto usa `PUBLIC_BASE_URL`. |
| `RATE_LIMIT` | Máximo de requests por IP y ventana de un minuto (default 120). |
| `EVENTS_RSS_URLS` | URLs RSS/Atom públicas separadas por coma. Sus eventos se combinan con la agenda editorial, con caché de 5 minutos. |

El token de Meta necesita los permisos vigentes equivalentes a publicación de contenido de Instagram y gestión/publicación de páginas. La cuenta de Instagram debe ser profesional y estar vinculada a la página. Revisá los nombres y requisitos actuales en Meta antes del despliegue, porque cambian entre versiones.

Para publicar imágenes locales, `PUBLIC_BASE_URL` debe resolver por HTTPS hacia este servicio o hacia un storage/CDN. `localhost` no es accesible para los servidores de Meta.

Para Atlas, agregá la IP del servidor en Network Access, creá un usuario de base de datos y copiá la URI SRV completa en `MONGODB_URI`. El driver mantiene un único pool por proceso con `maxPoolSize=20`, `maxIdleTimeMS=5 min`, `serverSelectionTimeoutMS=5 s` y `waitQueueTimeoutMS=5 s`, valores conservadores para un servidor editorial de baja concurrencia.

El login se administra en MongoDB. Para crear o rotar un usuario ejecutá `USER_PASSWORD='una-clave-de-12-o-más-caracteres' MONGODB_URI='...' npm run users:upsert -- redaccion editor redaccion@medio.example true`. El backend nunca guarda la contraseña en claro: usa hashes `scrypt`, emite JWT HS256 de corta duración y vuelve a consultar en Mongo el usuario activo y su rol en cada request.
El flujo de archivos locales y Cloudflare está detallado en [`documentacion/06-publicacion-local-cloudflare.md`](../documentacion/06-publicacion-local-cloudflare.md). La URL estable se configura con `CLOUDFLARE_TUNNEL_URL`; no se crea un container de Meta hasta que llega la fecha programada.

## Sitio público conectado

El `docker-compose.yml` incluye un proxy Nginx en el puerto `8080`. Sirve el sitio editorial estático y enruta `/api`, `/media`, `/notas/:slug`, `/press-kit`, `/rss.xml`, `/sitemap.xml` y `/robots.txt` al gestor. Así el feed público y las notas publicadas funcionan en el mismo dominio; directorio, comunidad y publicación exigen autenticación. El túnel Cloudflare debe apuntar al servicio web (`http://localhost:8080`) y `PUBLIC_BASE_URL` debe usar ese dominio HTTPS.

Las propuestas autenticadas de `/publicar` entran como contenidos `idea` y quedan pendientes de moderación. El equipo puede completar autor, fotógrafo, fuente, SEO, créditos y destacar una nota desde `/admin`.

Cada entrada del directorio nace como `unverified` con fiabilidad 0. Un usuario autorizado debe revisarla desde `/admin/directorio` y marcarla como `verified`, `stale` o `incorrect`, con una fiabilidad de 0 a 100, fecha de revisión, responsable y notas. La operación se realiza mediante `POST /api/directory/:id/verification` y queda auditada.

## Flujo editorial

```text
idea → borrador → revisión → aprobado → programado → publicando → publicado
                                      └────────────→ publicando → error
error → borrador | aprobado | publicando
```

Una generación de IA nunca aprueba ni publica. La publicación manual pide confirmación y el endpoint solo acepta contenido aprobado, programado o fallido. **Simular publicación** ejecuta el flujo y genera IDs ficticios sin llamar a Meta.

Las solicitudes de acreditación también tienen **Simular** y **Enviar**. El envío real solo se habilita cuando SMTP está configurado; el modo simulación siempre permite revisar destinatario y asunto sin salir del sistema.
Los correos se envían con el nombre configurado en el dossier (`mediaKit.name`), `reply-to` del medio y una plantilla HTML/texto. Así no salen como mensajes personales del operador.

## Seguridad y operación

Las rutas privadas aceptan `Authorization: Bearer <JWT>` o la sesión de navegador `HttpOnly` emitida por el login. Cada usuario tiene un array obligatorio de roles y otro de permisos; no existe un rol singular. `admin` controla todo; `editor` gestiona contenido; `press` gestiona acreditaciones, eventos y dossier; `directory` gestiona el catálogo; `community` puede enviar propuestas autenticadas; `auditor` sólo puede consultar contenido, prensa, directorio y postulaciones; `social` habilita la operación de Instagram. Los permisos granulares son `instagram:read`, `instagram:metrics` e `instagram:publish`; las métricas y la publicación de Instagram no se habilitan para un editor común. Sincronizar roles y permisos en el JWT no alcanza: cada request se revalida contra MongoDB. Al inicio las propuestas de comunidad se aprueban automáticamente (`AUTO_APPROVE_COMMUNITY_SUBMISSIONS=true` implícito); para exigir revisión manual configurar esa variable en `false`. Cada request queda registrado en `DATA_DIR/audit.jsonl` y el endpoint `/api/ops/status` muestra scheduler, persistencia y túnel para monitoreo.

Para un backup local/Docker: `DATA_DIR=./data UPLOAD_DIR=./uploads ./scripts/backup.sh`. En Atlas, complementar con `mongodump` programado y retención en almacenamiento externo.

## MCP

El MCP se publica como `https://afterstage.ar/mcp`. El cliente descubre los metadatos OAuth en:

- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server`

La primera vez que una cuenta usa una herramienta, el cliente abre la pantalla de conexión de Afterstage. El usuario inicia sesión en Afterstage y autoriza scopes. El login deja una cookie `HttpOnly`, `Secure` y `SameSite=Lax`; la pantalla de consentimiento sólo envía el `request_id`, nunca usuario ni contraseña. El servidor emite un access token MCP de corta duración y un refresh token; ambos quedan asociados al usuario, cliente y recurso. No se copia ningún JWT de usuario a `.env`, Git ni configuración del agente.

Scopes disponibles:

- `notes:read`: perfil y lectura de notas.
- `notes:write`: creación de borradores con IA; requiere usuario `editor` o `admin`.

Configuración remota de ejemplo:

```json
{
  "mcpServers": {
    "afterstage": {
      "url": "https://afterstage.ar/mcp"
    }
  }
}
```

Herramientas remotas:

- `crear_nota_con_ia` — conserva el nombre por compatibilidad, pero recibe una nota ya redactada por el agente y la guarda como borrador. El MCP no llama a una IA, no publica, no programa ni envía comunicaciones. Acepta `idempotencyKey` para repetir una solicitud sin crear otro borrador.
- `listar_notas` — busca notas del workspace conectado y devuelve `{ notes, total, limit }` para mantener un contrato MCP de objeto, incluso sin resultados.
- `listar_agenda` — consulta eventos, acreditaciones y coberturas con filtros de texto, estado y fecha.
- `buscar_directorio` — busca entradas del directorio; los emails, teléfonos y contactos sólo se incluyen cuando se solicita y el rol está autorizado.
- `listar_reemplazos` — consulta búsquedas y, opcionalmente, sus postulaciones.
- `get_profile` — devuelve la identidad estable, roles y permisos de la cuenta conectada.

La disponibilidad de la IA interna opcional se expone en `GET /ready` como `ai` y en `GET /api/ops/status` como `ai.configured`, sin devolver nunca la clave. Esa señal sólo corresponde a las herramientas internas de regeneración; el MCP puede guardar notas redactadas por el agente aunque sea `false`.

El backend necesita sus secretos de servidor (`MONGODB_URI`, `JWT_SECRET` y, sólo si se usa la regeneración interna, `AI_API_KEY`), pero ninguno representa a un usuario del MCP. La conexión de cada usuario se autoriza por OAuth y se vuelve a validar contra MongoDB en cada llamada.

Ejemplo de instrucción para un agente:

```text
Generá una nota con los datos verificables, marcá con [VERIFICAR] lo que falte y usá `crear_nota_con_ia` para guardar el título, la bajada y el cuerpo como borrador. No la publiques ni la programes.
```

## API principal

- `GET/POST /api/content`
- `GET/PATCH/DELETE /api/content/:id`
- `POST /api/content/duplicates` — analiza similitud de título, resumen, cuerpo, slug y fuente antes de guardar; devuelve coincidencias explicadas.
- `POST /api/content/:id/generate`
- `POST /api/content/:id/publish`
- `POST /api/content/:id/metrics/instagram` — consulta y persiste insights de la publicación de Instagram.
- `GET /api/metrics/instagram` — resumen agregado de alcance, impresiones, interacciones, likes, comentarios, guardados, compartidos y reproducciones.
- `POST /api/assets`
- `GET /media/<archivo>` — sirve únicamente archivos dentro de `MEDIA_ROOT`
- `GET /api/public/content` y `/api/public/content/:slug`
- `GET /notas/:slug` — vista pública segura de cada nota publicada en el canal web
- `GET /press-kit` — dossier público compartible con productoras y salas
- `GET /api/public/press-kit` — versión JSON del dossier y archivo de coberturas
- `GET /api/press/snapshot`
- `POST /api/press/events`, `PATCH/DELETE /api/press/events/:id`
- `POST /api/press/contacts`, `PATCH/DELETE /api/press/contacts/:id`
- `POST /api/press/accreditations`, `PATCH/DELETE /api/press/accreditations/:id`
- `POST /api/press/coverages`, `PATCH/DELETE /api/press/coverages/:id`
- `GET/POST/PATCH/DELETE /api/press/replacements` — búsquedas de fotógrafo/a, notero/a, cronista o videógrafo/a, asociadas a eventos y ubicación.
- `GET /api/press/replacements/:id/applications` — postulaciones recibidas (admin/press).
- `POST /api/public/replacements/:id/applications` — postulación autenticada de comunidad.
- `POST /api/press/replacement-applications/:id/assign` — asigna un reemplazo, rechaza los demás y notifica por email con la identidad del medio.
- `GET/PATCH /api/press/media-kit`
- `POST /api/press/accreditations/:id/send` — SMTP; recibe `dryRun: true` por defecto
- `GET /health`
- `POST /api/auth/login` — recibe `identifier` (usuario o email) y `password`, devuelve un JWT de acceso y establece la sesión de navegador segura.
- `GET /api/auth/me` — devuelve la identidad, roles y permisos del JWT actual.

El detector de duplicados bloquea al guardar coincidencias fuertes (HTTP 409), pero permite consultar coincidencias preliminares con un umbral más amplio para que edición o IA decidan si continuar.

Los listados públicos de contenido, eventos, directorio y reemplazos aplican un límite seguro por request (default 50, máximo 100). El backend devuelve sólo ese máximo efectivo; la paginación/cursor queda como siguiente evolución si el volumen editorial lo requiere.

Las rutas `/api/*` requieren el JWT emitido por el login o la sesión de navegador segura; los roles y permisos se validan contra MongoDB en cada request.

## Verificación

```bash
cd backend
npm test
npm run build
```

Antes de una publicación real: probá **Simular publicación**, verificá que las imágenes sean públicas, usá una cuenta de prueba de Meta y confirmá el contenido en el panel de Meta Business.
