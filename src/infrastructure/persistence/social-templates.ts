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
    editorialSection: "show-announcement",
    outputType: "post",
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
];

export class MongoSocialTemplateStore implements SocialTemplateRepository {
  constructor(private readonly collection: Collection<RecordDoc>) {}
  async init() {
    await Promise.all([
      this.collection.createIndex({ slug: 1, templateVersion: 1 }, { unique: true }),
      this.collection.createIndex({ status: 1, editorialSection: 1, outputType: 1 }),
    ]);
    const count = await this.collection.countDocuments({});
    if (!count) for (const template of starterSocialTemplates) await this.save(template);
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
    if (!this.templates.length)
      this.templates = await Promise.all(starterSocialTemplates.map((template) => this.save(template)));
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
