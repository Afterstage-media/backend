# Carruseles de Instagram por MCP

Afterstage no llama a un proveedor de IA para este flujo. La IA externa invoca el MCP de Afterstage con la plantilla que eligió, las imágenes y el texto de cada lámina. Afterstage valida, compone y guarda los archivos.

## Flujo

1. `listar_plantillas_sociales` devuelve las plantillas publicadas para carrusel de Instagram almacenadas en MongoDB.
2. `crear_carrusel_instagram` recibe `templateId`, título, texto del post y entre 2 y 9 objetos `slides`; cada objeto incluye una imagen y el texto que debe verse en esa lámina.
3. El servidor renderiza las imágenes con el tamaño y estilo de la plantilla, guarda una publicación `draft` y devuelve su ID y las URLs de todas las imágenes.
4. La IA puede abrir/revisar esas URLs. Si una lámina necesita cambios, invoca `corregir_lamina_instagram` con el ID del borrador, número de lámina e imagen corregida. La herramienta reemplaza esa imagen en la misma publicación y devuelve las URLs vigentes.

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
