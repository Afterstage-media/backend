# Publicaciones sociales editoriales: front y MCP

Afterstage no invoca una IA. La IA externa prepara el contenido con las reglas editoriales y la plantilla consultadas a Afterstage; una persona puede completar el mismo flujo desde el front. Ambos canales comparten plantillas de MongoDB, validación, render, almacenamiento y transiciones de borrador.

## Contrato para la IA

`listar_plantillas_sociales` es la consulta inicial. Devuelve estándares editoriales del medio y, para cada plantilla publicada de carrusel de Instagram: propósito, enfoque, hechos a verificar, estructura narrativa sugerida, guía del caption, voz, errores que evitar, campos, estilos, tamaño y versión. La IA debe aplicar esa guía antes de redactar.

Los estándares definen una barra de redacción de medio digital:

- No inventar ni inferir nombres, fechas, lugares, horarios, precios, canciones, citas, cifras, reacciones o derechos fotográficos.
- Distinguir hechos comprobados, citas atribuidas y observación propia; pedir fuentes o excluir datos inciertos. Nunca publicar `[VERIFICAR]`.
- Usar fuentes primarias para anuncios, noticias sensibles y hechos de última hora; no convertir rumores en hechos.
- Redactar en español rioplatense claro, con un dato concreto como gancho, una idea por lámina y progresión narrativa. Evitar clickbait, clichés y grandilocuencia.
- Hacer que el caption aporte contexto, atribución, fuente/enlace y créditos, sin repetir las láminas.
- Usar 5–9 láminas cuando el material sostiene la historia; menos si la pieza es breve, sin rellenar. Máximo técnico: 9; 180 caracteres por lámina.
- Incluir texto alternativo descriptivo y crédito fotográfico cuando se conozcan; no inventar autoría.
- Antes de crear el borrador, comprobar exactitud, enfoque, repetición, fuentes, nombres, fechas, citas, enlaces, créditos y accesibilidad. Si un hecho central queda sin verificar, pedir aclaración.

Cada tipo de plantilla añade sus propios criterios y secuencia narrativa. Por ejemplo: una crónica se basa en notas de cobertura y hechos observados; una agenda exige verificar vigencia, orden cronológico, venue, ciudad y venta; una noticia separa qué se sabe de lo que falta confirmar; un perfil de banda necesita referencias concretas sobre sonido y trayectoria.

## Flujo equivalente

1. Front: `GET /api/social-templates?type=carousel&channel=instagram`. MCP: `listar_plantillas_sociales`. Ambos devuelven estándares y guía completa para las plantillas disponibles.
2. Front: formulario de título, caption, fuentes, autoría, fotos, texto/alt text/crédito por lámina y selector de plantilla. MCP: `crear_carrusel_instagram` recibe `templateId`, esos datos y entre 2 y 9 láminas.
3. El servidor renderiza, guarda una publicación `draft` y devuelve sus URLs. El front muestra una vista previa; MCP entrega las URLs para inspección de la IA.
4. Para corregir una imagen, el front usa `PUT /api/social-carousel/:id/slides/:slide`; MCP usa `corregir_lamina_instagram`. Ambas reemplazan el archivo de la lámina en el mismo borrador y devuelven las URLs actualizadas.

No se publica ni programa automáticamente. Las correcciones solo aceptan publicaciones en borrador.

## Límites técnicos

- JPEG, PNG o WebP en base64/data URL; hasta 2,5 MiB por archivo.
- Una fuente/referencia y un texto alternativo descriptivo son obligatorios al crear. El crédito fotográfico se incluye cuando corresponda; una corrección conserva los metadatos de la lámina si no se vuelven a enviar.
- Texto por lámina: máximo 180 caracteres. Caption de Instagram: máximo 2.200 caracteres.
- Plantillas estructuradas, no código ejecutable. Incluyen `guidanceVersion` y los metadatos editoriales se versionan con la plantilla.
- La migración de inicio crea nuevas versiones de plantillas existentes para incorporar guía editorial, conservando sus datos visuales y estado.

## Origen editorial

El resumen de reunión propone anuncios/calendarios de shows, crónicas post-evento, descubrimiento de bandas under, curiosidades/efemérides y noticias musicales; sugiere ganchos, fotos propias, overlays legibles y normalmente 5–9 láminas. Estos son criterios editoriales y no hechos que la IA o el servidor puedan completar por su cuenta.
