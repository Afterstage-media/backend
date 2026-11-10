import { randomUUID } from "node:crypto";
import type { Collection } from "mongodb";
import {
  socialTemplateSchema,
  type SocialTemplate,
  type SocialTemplateInput,
  type SocialTemplateRepository,
} from "../../domain/content/social-template.js";

type RecordDoc = Record<string, unknown> & { _id: string };
const now = () => new Date().toISOString();

export const starterSocialTemplates: SocialTemplateInput[] = [
  {
    slug: "agenda-mensual",
    name: "Agenda mensual de shows",
    description: "Fechas confirmadas para guardar y compartir.",
    guidanceVersion: 1,
    editorialGuidance: {
      purpose: "Ayudar a la audiencia a planificar recitales del mes con información útil y confirmada.",
      angle:
        "Ordená las fechas por cercanía y relevancia para la escena; agrupá por semana o zona solo si facilita decidir.",
      verify: [
        "Día de la semana y fecha completa con año",
        "Artista, venue y ciudad",
        "Horario, entradas, precio y enlace oficial si están disponibles",
        "Que la fecha siga vigente y no haya sido reprogramada",
      ],
      slidePlan: [
        "Portada: mes/año y una promesa concreta de la agenda",
        "Bloques de fechas en orden cronológico, con artista, venue y ciudad",
        "Si hace falta, separar por semana o zona sin duplicar fechas",
        "Cierre con fuente y fecha de última actualización",
      ],
      caption:
        "Abrí con el mes y el criterio de selección. Incluí cómo consultar entradas y aclarar que precios, disponibilidad o horarios pueden cambiar cuando corresponda. Enlazá la fuente oficial.",
      voice: "Práctica, clara y útil; priorizá fechas y datos por encima de adjetivos promocionales.",
      avoid: [
        "No completar horarios, precios o disponibilidad ausentes",
        "No presentar la agenda como exhaustiva si es una selección",
        "No mezclar fechas pasadas y futuras",
      ],
    },
    editorialSection: "show-calendar",
    outputType: "carousel",
    channels: ["instagram", "facebook"],
    status: "published",
    canvas: { width: 1080, height: 1350 },
    fields: [
      { key: "period", label: "Mes y año", required: true, maxLength: 50 },
      { key: "headline", label: "Hook de portada", required: true, maxLength: 90 },
      { key: "dates", label: "Fechas y lugares", required: true, maxLength: 450 },
      { key: "source", label: "Fuente", maxLength: 160 },
    ],
    slides: [
      { eyebrow: "AGENDA UNDER", titleField: "period" },
      { eyebrow: "ESTE MES", titleField: "headline", bodyField: "dates" },
      { eyebrow: "FUENTES", titleField: "source" },
    ],
  },
  {
    slug: "anuncio-show",
    name: "Anuncio de show",
    description: "Una fecha con la información esencial y su fuente.",
    guidanceVersion: 2,
    editorialGuidance: {
      purpose: "Informar una fecha de show con lo necesario para entender qué se anunció y dónde confirmarlo.",
      angle: "El dato principal es el anuncio; el gancho debe contar qué vuelve, debuta o sucede, sin exagerar.",
      verify: [
        "Artista y nombre oficial del evento",
        "Fecha, horario, venue y ciudad",
        "Estado de venta, precio y enlace de tickets",
        "Fuente oficial del anuncio y vigencia de la información",
      ],
      slidePlan: [
        "Titular específico del anuncio",
        "Fecha, venue y ciudad con jerarquía legible",
        "Entradas/precio solo si la fuente lo confirma",
        "Crédito visual cuando corresponda",
      ],
      caption:
        "Resumí el anuncio en la primera línea; después agregá datos de acceso, venta y fuente oficial. No prometas información que no figure en el anuncio.",
      voice: "Informativa y directa; separá datos confirmados de información pendiente.",
      avoid: [
        "No usar lenguaje de venta como si fuera comunicación del organizador",
        "No inventar line-up, horarios ni precios",
        "No usar urgencia artificial",
      ],
    },
    editorialSection: "show-announcement",
    outputType: "post",
    visualStyle: {
      id: "afterstage-stage-photo",
      name: "En vivo",
      description: "Foto a sangre, contraste carbón y acentos violeta para anuncios con energía.",
      layout: "photo-overlay",
      coverEyebrow: "AFTERSTAGE · EN VIVO",
      palette: { background: "#111114", foreground: "#f4f0e8", accent: "#7b35ff", overlay: "#080808" },
    },
    channels: ["instagram", "facebook"],
    status: "published",
    canvas: { width: 1080, height: 1350 },
    fields: [
      { key: "artist", label: "Artista o banda", required: true, maxLength: 90 },
      { key: "hook", label: "Hook", required: true, maxLength: 100 },
      { key: "dateVenue", label: "Fecha y lugar", required: true, maxLength: 140 },
      { key: "ticketInfo", label: "Entradas / precio confirmado", maxLength: 160 },
      { key: "source", label: "Fuente", required: true, maxLength: 160 },
    ],
    slides: [{ eyebrow: "FECHA ANUNCIADA", titleField: "artist", bodyField: "dateVenue" }],
  },
  {
    slug: "cronica-show",
    name: "Crónica post-show",
    description: "Secuencia visual para contar lo que pasó en vivo.",
    guidanceVersion: 1,
    editorialGuidance: {
      purpose: "Contar qué ocurrió en el show mediante una observación concreta y una secuencia visual con contexto.",
      angle:
        "Elegí un hilo narrativo real —un regreso, una decisión musical, un momento del repertorio— sustentado por notas y fotos.",
      verify: [
        "Artista, fecha, venue y ciudad",
        "Canciones, invitados, duración y hechos puntuales contra notas o fuentes",
        "Identidad y contexto de las fotos y crédito autorizado",
        "Distinguir observación del cronista de citas o declaraciones",
      ],
      slidePlan: [
        "Portada: hecho o escena que sintetiza la crónica",
        "Contexto breve del show y del momento",
        "Uno o dos momentos concretos en secuencia",
        "Detalle musical o visual que explique por qué importó",
        "Cierre que devuelva la historia al presente, sin conclusión genérica",
      ],
      caption:
        "Usá una bajada que aporte contexto y no repita la portada. Atribuí declaraciones con exactitud, agregá crédito fotográfico y enlazá la crónica completa si existe.",
      voice:
        "Observacional, precisa y con ritmo narrativo. Solo usa primera persona si la cobertura y las notas acreditan presencia directa.",
      avoid: [
        "No inventar reacciones del público, citas, setlist ni detalles de producción",
        "No afirmar que una noche fue histórica o única sin evidencia",
        "No convertir impresiones personales en hechos",
      ],
    },
    editorialSection: "show-recap",
    outputType: "carousel",
    channels: ["instagram", "facebook"],
    status: "published",
    canvas: { width: 1080, height: 1350 },
    fields: [
      { key: "band", label: "Artista o banda", required: true, maxLength: 90 },
      { key: "hook", label: "Hook", required: true, maxLength: 100 },
      { key: "context", label: "Fecha, lugar y contexto", required: true, maxLength: 180 },
      { key: "moment1", label: "Momento destacado 1", required: true, maxLength: 180 },
      { key: "moment2", label: "Momento destacado 2", maxLength: 180 },
      { key: "closing", label: "Cierre", maxLength: 160 },
      { key: "credit", label: "Crédito fotográfico", maxLength: 100 },
    ],
    slides: [
      { eyebrow: "CRÓNICA EN VIVO", titleField: "hook", bodyField: "context" },
      { eyebrow: "EL SHOW", titleField: "band", bodyField: "moment1" },
      { eyebrow: "UN MOMENTO", titleField: "moment2", bodyField: "closing" },
      { eyebrow: "AFTERSTAGE", titleField: "closing", bodyField: "credit" },
    ],
  },
  {
    slug: "descubrimiento-banda",
    name: "Descubrimiento de banda",
    description: "Perfil breve para descubrir un proyecto de la escena.",
    guidanceVersion: 1,
    editorialGuidance: {
      purpose: "Presentar un proyecto musical y darle a la audiencia razones concretas para escucharlo.",
      angle: "Definí qué distingue su sonido o recorrido con ejemplos verificables, no con etiquetas vacías.",
      verify: [
        "Nombre, integrantes y ciudad de origen con fuente vigente",
        "Años de actividad, lanzamientos y descripción del sonido",
        "Próxima fecha, venue y venta desde canal oficial",
        "Pronombres, citas y créditos según fuentes originales",
      ],
      slidePlan: [
        "Portada: rasgo distintivo y nombre de la banda",
        "Origen o contexto de la escena",
        "Cómo suena, con referencias musicales concretas",
        "Lanzamiento o canción para empezar a escuchar",
        "Próximo show confirmado o pregunta genuina para la audiencia",
      ],
      caption:
        "Presentá el proyecto sin biografía promocional copiada; incluí enlaces a música y fuente de la información, y una pregunta que invite a descubrir, no a validar el gusto.",
      voice: "Curiosa, respetuosa y específica; evita jerarquías de popularidad como sustituto del análisis.",
      avoid: [
        "No llamar emergente a una banda sin contexto",
        "No asignar género como verdad absoluta si la banda lo describe distinto",
        "No inventar trayectoria, integrantes ni fechas",
      ],
    },
    editorialSection: "discovery",
    outputType: "carousel",
    channels: ["instagram"],
    status: "published",
    canvas: { width: 1080, height: 1350 },
    fields: [
      { key: "band", label: "Nombre", required: true, maxLength: 90 },
      { key: "hook", label: "Hook", required: true, maxLength: 100 },
      { key: "genre", label: "Sonido / género", required: true, maxLength: 140 },
      { key: "story", label: "Historia", required: true, maxLength: 240 },
      { key: "nextDate", label: "Próxima fecha verificada", maxLength: 140 },
      { key: "question", label: "Pregunta de cierre", maxLength: 120 },
    ],
    slides: [
      { eyebrow: "DESCUBRIMIENTO", titleField: "hook", bodyField: "band" },
      { eyebrow: "SU SONIDO", titleField: "genre", bodyField: "story" },
      { eyebrow: "EN VIVO", titleField: "nextDate", bodyField: "question" },
    ],
  },
  {
    slug: "noticia-musical",
    name: "Noticia musical",
    description: "Novedad breve con contexto y fuente verificable.",
    guidanceVersion: 1,
    editorialGuidance: {
      purpose: "Explicar una novedad musical con contexto suficiente para que se entienda su relevancia.",
      angle:
        "Respondé qué pasó, quién está involucrado, cuándo y qué cambia; priorizá el hecho sobre el juego de palabras.",
      verify: [
        "Hecho, fecha y protagonistas desde fuente primaria",
        "Declaraciones textuales contra publicación original",
        "Contexto anterior y consecuencias sin especular",
        "Enlace y fecha de consulta de la fuente",
      ],
      slidePlan: [
        "Portada: el hecho central en una frase concreta",
        "Qué ocurrió y cuándo",
        "Contexto que ayude a entenderlo",
        "Qué se sabe y qué falta confirmar",
        "Fuente original o siguiente paso confirmado",
      ],
      caption:
        "Diferenciá hechos, declaraciones atribuidas y contexto. Incluí fuente directa. Si la noticia evoluciona, señalá cuándo se actualizó.",
      voice: "Sobria, clara y proporcional a la evidencia disponible.",
      avoid: [
        "No amplificar rumores ni trascendidos como noticia",
        "No convertir coincidencia temporal en causalidad",
        "En muertes, separaciones o acusaciones, usar confirmación directa y lenguaje preciso",
      ],
    },
    editorialSection: "news",
    outputType: "post",
    channels: ["instagram", "facebook"],
    status: "published",
    canvas: { width: 1080, height: 1350 },
    fields: [
      { key: "headline", label: "Titular / hook", required: true, maxLength: 120 },
      { key: "summary", label: "Qué pasó", required: true, maxLength: 260 },
      { key: "context", label: "Contexto", maxLength: 240 },
      { key: "source", label: "Fuente", required: true, maxLength: 160 },
    ],
    slides: [{ eyebrow: "NOVEDAD DE LA ESCENA", titleField: "headline", bodyField: "summary" }],
  },
  {
    slug: "efemeride-curiosidad",
    name: "Efeméride o curiosidad",
    description: "Un dato cultural con contexto y fuente.",
    guidanceVersion: 1,
    editorialGuidance: {
      purpose: "Recuperar un dato musical interesante y explicar por qué importa hoy.",
      angle: "Elegí un dato preciso que cambie o enriquezca la lectura de una canción, disco o trayectoria.",
      verify: [
        "Fecha exacta y evento al que refiere",
        "Créditos, autoría, grabación y citas en fuente primaria o archivo confiable",
        "Contexto histórico y alcance de la afirmación",
        "Fuente que permita comprobar el dato",
      ],
      slidePlan: [
        "Portada: pregunta o dato específico sin exageración",
        "El dato central, con fecha y protagonistas",
        "Contexto que lo vuelve significativo",
        "Consecuencia, legado o matiz documentado",
        "Fuente y pregunta final si aporta conversación",
      ],
      caption:
        "Añadí el contexto que no entra en la lámina y una fuente identificable. Aclará discrepancias entre fuentes en lugar de ocultarlas.",
      voice: "Didáctica y curiosa, sin tono escolar ni mito repetido como hecho.",
      avoid: [
        "No usar ‘primero’, ‘único’ o ‘nunca’ sin evidencia amplia",
        "No repetir anécdotas sin fuente",
        "No forzar efemérides solo porque coinciden con la fecha",
      ],
    },
    editorialSection: "curiosity",
    outputType: "carousel",
    channels: ["instagram"],
    status: "published",
    canvas: { width: 1080, height: 1350 },
    fields: [
      { key: "artist", label: "Banda o artista", required: true, maxLength: 90 },
      { key: "hook", label: "Hook", required: true, maxLength: 110 },
      { key: "fact", label: "Dato verificado", required: true, maxLength: 250 },
      { key: "context", label: "Contexto", maxLength: 220 },
      { key: "source", label: "Fuente", required: true, maxLength: 160 },
    ],
    slides: [
      { eyebrow: "¿SABÍAS ESTO?", titleField: "hook", bodyField: "artist" },
      { eyebrow: "EL DATO", titleField: "fact", bodyField: "context" },
      { eyebrow: "FUENTE", titleField: "source" },
    ],
  },
  {
    slug: "historia-convocatoria",
    name: "Historia de convocatoria",
    description: "Secuencia vertical breve para invitar a participar o descubrir un servicio.",
    guidanceVersion: 2,
    editorialGuidance: {
      purpose: "Comunicar una propuesta concreta de Afterstage en una secuencia breve y fácil de recorrer.",
      angle: "Presentá primero la situación de la audiencia, después qué ofrece Afterstage y cómo avanzar.",
      verify: [
        "Disponibilidad y condiciones vigentes del servicio",
        "Alcance exacto de la cobertura o producción ofrecida",
        "Canal de contacto y respuesta esperada",
      ],
      slidePlan: ["Una historia vertical: pregunta o gancho, propuesta concreta y una invitación simple a conversar"],
      caption: "Acompañá la secuencia con un contacto vigente y aclaraciones necesarias sobre disponibilidad.",
      voice: "Directa, cercana y segura; hablale a la escena sin convertir la historia en un aviso genérico.",
      avoid: [
        "No prometer alcance, resultados ni tiempos que no estén confirmados",
        "No insinuar que una cobertura es gratuita si no lo es",
        "No llenar la historia de hashtags ni llamadas a la acción repetidas",
      ],
    },
    editorialSection: "show-announcement",
    outputType: "story",
    visualStyle: {
      id: "afterstage-urban-poster",
      name: "Afiche de escena",
      description: "Papel de imprenta, tipografía condensada y tinta violeta de Afterstage.",
      layout: "type-poster",
      coverEyebrow: "AFTERSTAGE · EN ESCENA",
      palette: { background: "#e8e6e0", foreground: "#242329", accent: "#6d38ba", overlay: "#242329" },
    },
    channels: ["instagram"],
    status: "published",
    canvas: { width: 1080, height: 1920 },
    fields: [
      { key: "headline", label: "Pregunta o gancho", required: true, maxLength: 180 },
      { key: "body", label: "Propuesta y contacto", required: true, maxLength: 180 },
    ],
    slides: [{ eyebrow: "AFTERSTAGE · EN ESCENA", titleField: "headline", bodyField: "body" }],
  },
  {
    slug: "historia-en-vivo",
    name: "Historia desde el show",
    description: "Una placa vertical con fotografía protagonista para compartir una escena en vivo.",
    guidanceVersion: 1,
    editorialGuidance: {
      purpose: "Compartir una escena real del vivo con un dato o una observación que le aporte contexto.",
      angle: "Dejá que la foto abra la historia y usá una sola frase concreta para contar por qué importa.",
      verify: [
        "Artista, show y fecha",
        "Identidad y crédito de la fotografía",
        "Toda cita o dato incluido en la placa",
      ],
      slidePlan: ["Una sola historia vertical: foto del show, frase breve y marca Afterstage"],
      caption: "Si la historia lleva copy, sumá el contexto y el crédito que no entran en la placa.",
      voice: "Observacional, breve y precisa; no describas como hecho una interpretación personal.",
      avoid: [
        "No inventar reacciones o citas",
        "No tapar la escena principal con texto",
        "No quitar el crédito de la foto",
      ],
    },
    editorialSection: "show-recap",
    outputType: "story",
    channels: ["instagram"],
    status: "published",
    visualStyle: {
      id: "afterstage-stage-photo",
      name: "En vivo",
      description: "Foto a sangre, contraste carbón y acentos violeta para anuncios con energía.",
      layout: "photo-overlay",
      coverEyebrow: "AFTERSTAGE · EN VIVO",
      palette: { background: "#111114", foreground: "#f4f0e8", accent: "#7b35ff", overlay: "#080808" },
    },
    canvas: { width: 1080, height: 1920 },
    fields: [
      { key: "headline", label: "Frase sobre la escena", required: true, maxLength: 160 },
      { key: "photoCredit", label: "Crédito de fotografía", maxLength: 120 },
    ],
    slides: [{ eyebrow: "AFTERSTAGE · EN VIVO", titleField: "headline" }],
  },
];

export class MongoSocialTemplateStore implements SocialTemplateRepository {
  constructor(private readonly collection: Collection<RecordDoc>) {}
  async init() {
    await Promise.all([
      this.collection.createIndex({ slug: 1, templateVersion: 1 }, { unique: true }),
      this.collection.createIndex({ status: 1, editorialSection: 1, outputType: 1 }),
    ]);
    for (const template of starterSocialTemplates) {
      const current = await this.findBySlug(template.slug);
      if (!current) {
        await this.save(template);
      } else if (current.guidanceVersion < (template.guidanceVersion ?? 0)) {
        const { id: _id, ...existing } = current;
        await this.save({
          ...existing,
          guidanceVersion: template.guidanceVersion ?? 0,
          editorialGuidance: template.editorialGuidance,
          ...(template.visualStyle ? { visualStyle: template.visualStyle } : {}),
        });
      }
    }
  }
  private normalize(doc: RecordDoc): SocialTemplate {
    const { _id, ...data } = doc;
    return { ...socialTemplateSchema.parse({ ...data, id: _id }), id: _id } as SocialTemplate;
  }
  async list(filters: { section?: string; type?: string; status?: string; channel?: string } = {}) {
    const query: Record<string, unknown> = {};
    if (filters.section) query.editorialSection = filters.section;
    if (filters.type) query.outputType = filters.type;
    if (filters.channel) query.channels = filters.channel;
    const docs = await this.collection.find(query).sort({ slug: 1, templateVersion: -1 }).toArray();
    const versionsBySlug = new Map<string, SocialTemplate[]>();
    for (const doc of docs) {
      const template = this.normalize(doc);
      versionsBySlug.set(template.slug, [...(versionsBySlug.get(template.slug) ?? []), template]);
    }
    return [...versionsBySlug.values()].flatMap((versions) => {
      const latest = versions[0]!;
      if (filters.status === "published") {
        if (latest.status === "archived") return [];
        const published =
          latest.status === "published" ? latest : versions.find((entry) => entry.status === "published");
        return published ? [published] : [];
      }
      return !filters.status || latest.status === filters.status ? [latest] : [];
    });
  }
  async get(id: string) {
    const doc = await this.collection.findOne({ _id: id });
    return doc ? this.normalize(doc) : undefined;
  }
  async findBySlug(slug: string) {
    const doc = await this.collection.find({ slug }).sort({ templateVersion: -1 }).limit(1).next();
    return doc ? this.normalize(doc) : undefined;
  }
  async save(input: SocialTemplateInput, id?: string) {
    const parsed = socialTemplateSchema.parse(input);
    if (id && !(await this.get(id))) throw new Error("Plantilla no encontrada");
    const current = await this.findBySlug(parsed.slug);
    const version = current ? current.templateVersion + 1 : 1;
    const timestamp = now();
    const next = socialTemplateSchema.parse({
      ...parsed,
      id: undefined,
      templateVersion: version,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
      publishedAt: parsed.status === "published" ? timestamp : null,
    });
    const { id: _ignored, ...templateData } = next;
    const doc = { ...templateData, _id: `${next.slug}:v${version}`, templateVersion: version };
    await this.collection.insertOne(doc as RecordDoc);
    return this.normalize(doc as RecordDoc);
  }
}

export class MemorySocialTemplateStore implements SocialTemplateRepository {
  private templates: SocialTemplate[] = [];
  async init() {
    for (const template of starterSocialTemplates) {
      const current = await this.findBySlug(template.slug);
      if (!current) {
        await this.save(template);
      } else if (current.guidanceVersion < (template.guidanceVersion ?? 0)) {
        const { id: _id, ...existing } = current;
        await this.save({
          ...existing,
          guidanceVersion: template.guidanceVersion ?? 0,
          editorialGuidance: template.editorialGuidance,
          ...(template.visualStyle ? { visualStyle: template.visualStyle } : {}),
        });
      }
    }
  }
  async list(filters: { section?: string; type?: string; status?: string; channel?: string } = {}) {
    const candidates = this.templates.filter(
      (item) =>
        (!filters.section || item.editorialSection === filters.section) &&
        (!filters.type || item.outputType === filters.type) &&
        (!filters.channel || item.channels.includes(filters.channel as "instagram" | "facebook")),
    );
    const versionsBySlug = new Map<string, SocialTemplate[]>();
    for (const item of candidates.sort((left, right) => right.templateVersion - left.templateVersion)) {
      versionsBySlug.set(item.slug, [...(versionsBySlug.get(item.slug) ?? []), item]);
    }
    return [...versionsBySlug.values()].flatMap((versions) => {
      const latest = versions[0]!;
      if (filters.status === "published") {
        if (latest.status === "archived") return [];
        const published =
          latest.status === "published" ? latest : versions.find((entry) => entry.status === "published");
        return published ? [published] : [];
      }
      return !filters.status || latest.status === filters.status ? [latest] : [];
    });
  }
  async get(id: string) {
    return this.templates.find((item) => item.id === id);
  }
  async findBySlug(slug: string) {
    return this.templates
      .filter((item) => item.slug === slug)
      .sort((left, right) => right.templateVersion - left.templateVersion)[0];
  }
  async save(input: SocialTemplateInput, id?: string) {
    const parsed = socialTemplateSchema.parse(input);
    if (id && !this.templates.some((item) => item.id === id)) throw new Error("Plantilla no encontrada");
    const current = this.templates.find((item) => item.slug === parsed.slug);
    const timestamp = now();
    const item = socialTemplateSchema.parse({
      ...parsed,
      id: current ? `${parsed.slug}:v${current.templateVersion + 1}` : randomUUID(),
      templateVersion: (current?.templateVersion ?? 0) + 1,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
      publishedAt: parsed.status === "published" ? timestamp : null,
    }) as SocialTemplate;
    this.templates.push(item);
    return item;
  }
}
