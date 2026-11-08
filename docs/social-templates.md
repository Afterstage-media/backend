# Plantillas de redes

Afterstage mantiene las definiciones versionadas en MongoDB (`social_templates`). En el primer arranque se insertan seis plantillas iniciales si la colección está vacía. Cada cambio se guarda como nueva versión; las piezas conservan el ID y la versión usados.

## Flujo

1. El frontend consulta `GET /api/social-templates?type=carousel` y ofrece las plantillas publicadas compatibles.
2. Se crea un borrador en el flujo editorial existente.
3. En el editor se completan los campos de la plantilla y se pueden adjuntar fotografías desde el bloque de medios.
4. `POST /api/content/:id/render-social` valida los campos, genera un PNG por slide en el servidor y adjunta los archivos al borrador.
5. El contenido continúa por los estados de revisión, aprobación y publicación ya existentes. El renderer no publica.

## Administración

- `GET /api/social-templates`: catálogo compatible; admin ve el último estado de cada plantilla y editor sólo las publicadas.
- `POST /api/social-templates` (admin): crea una plantilla/version.
- `PUT /api/social-templates/:id` (admin): guarda una nueva versión. Enviar `status: "archived"` para retirar una plantilla del catálogo de selección.

Las definiciones se validan con un esquema tipado. Los campos permitidos son textos; las diapositivas sólo admiten fondo, acento, eyebrow y referencias a campos existentes. No se interpreta HTML o código de la base de datos.

## Medios

En producción, los renders se cargan mediante grants al almacenamiento R2 del servicio de medios. En instalaciones sin R2 configurado se guardan en `MEDIA_ROOT` (por defecto `UPLOAD_DIR`) y se sirven desde `/media`. Para usar fotografías fuentes, sus URLs deben pertenecer al origen configurado en `MEDIA_PUBLIC_BASE_URL` o `PUBLIC_BASE_URL`; se limitan a 8 MiB y tipos de imagen admitidos. Las imágenes generadas se distinguen con `altText` prefijado `[Plantilla:slug]` y son los únicos medios que se envían a Meta en publicaciones que tienen `socialTemplateId`.

Variables ya existentes que afectan este flujo: `MONGODB_URI`, `MEDIA_GATEWAY_URL`, `MEDIA_GATEWAY_SERVICE_TOKEN`, `MEDIA_PUBLIC_BASE_URL`, `PUBLIC_BASE_URL`, `MEDIA_ROOT` y `UPLOAD_DIR`.

## Plantillas iniciales

Agenda mensual, anuncio de show, crónica post-show, descubrimiento de banda, noticia musical y efeméride/curiosidad. Los formatos disponibles son post, carrusel y story; Reels siguen usando el flujo de video existente.
