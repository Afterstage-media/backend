# Carruseles de Instagram por MCP

Afterstage no llama a un proveedor de IA para este flujo. La misma operación está disponible desde el front de redes y desde una IA externa que invoca el MCP. En ambos casos se elige una plantilla, se envían las imágenes y el texto de cada lámina, se obtiene un borrador con URLs y se pueden reemplazar láminas.

## Flujo

1. El front consulta `GET /api/social-templates?type=carousel&channel=instagram`; MCP usa `listar_plantillas_sociales`. Ambos reciben las plantillas publicadas de MongoDB.
2. El front `POST /api/social-carousel`; MCP usa `crear_carrusel_instagram`. Ambas entradas aceptan `templateId`, título, texto del post y entre 2 y 9 objetos `slides`; cada objeto incluye una imagen y el texto que debe verse en esa lámina.
3. El servidor renderiza las imágenes con el tamaño y estilo de la plantilla, guarda una publicación `draft` y devuelve su ID y las URLs de todas las imágenes. El front las previsualiza; MCP devuelve las URLs al agente para que las abra/revise.
4. Para corregir, el front envía `PUT /api/social-carousel/:id/slides/:slide`; MCP usa `corregir_lamina_instagram`. Ambas operaciones reciben la imagen corregida, reemplazan esa imagen en la misma publicación y devuelven las URLs vigentes.

No se publica ni programa automáticamente. Las correcciones no crean publicaciones duplicadas.

## Entrada y render

- Imágenes de entrada: JPEG, PNG o WebP en base64 o data URL; hasta 2,5 MiB por imagen.
- Cada carrusel contiene de 2 a 9 láminas. Cada lámina recibe su propia imagen y texto (hasta 180 caracteres).
- Texto del post: hasta 2.200 caracteres.
- La definición de plantilla es información estructurada en MongoDB, no código ejecutable. El servidor hace el recorte y la composición final.
- Las imágenes renderizadas se guardan en el almacenamiento configurado y el borrador conserva el ID y versión de la plantilla.

## Origen editorial

El resumen de reunión propone anuncios/calendarios de shows, crónicas post-evento, descubrimiento de bandas under, curiosidades/efemérides y noticias musicales; sugiere ganchos iniciales, fotos propias, overlays legibles y generalmente 5–9 láminas. Son lineamientos editoriales para elegir o diseñar plantillas, no instrucciones técnicas automáticas ni datos que el servidor invente. La cantidad permitida por el MCP es 2–9 para aceptar también publicaciones breves.

La referencia visual indicada por el usuario es un carrusel fotográfico con portada de titular destacado y texto corto por foto en una banda oscura. Los detalles deben configurarse en una plantilla publicada.
