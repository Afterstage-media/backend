import { randomUUID } from "node:crypto";
import type { Collection } from "mongodb";
import {
  SocialSeriesConflictError,
  socialSeriesSchema,
  type SocialSeries,
  type SocialSeriesInput,
  type SocialSeriesRepository,
} from "../../domain/content/social-series.js";

type SeriesRecord = Record<string, unknown> & { _id: string };
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
const firstOfNextMonth = () => {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 12));
  return next.toISOString().slice(0, 10);
};
const timestamp = () => new Date().toISOString();
const obsoleteStorySeriesCutoff = "2026-11-13T00:00:00.000Z";
const storyPublishDate = () => {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const today = `${value("year")}-${value("month")}-${value("day")}`;
  if (`${value("hour")}:${value("minute")}` < "12:00") return today;
  const [year, month, day] = today.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + 1, 12)).toISOString().slice(0, 10);
};

export const starterSocialSeries: SocialSeriesInput[] = [
  {
    slug: "shows-del-mes",
    name: "Los shows del mes",
    description: "Una selección mensual de fechas confirmadas para guardar y compartir.",
    templateSlug: "agenda-mensual",
    editorialBrief:
      "Reuní los shows confirmados del período, ordenalos por fecha y ciudad, y aclará cuando sea una selección. Verificá cada fecha, venue y enlace oficial; no completes datos ausentes.",
    cadence: { every: 1, unit: "month" },
    nextRunAt: firstOfNextMonth(),
    active: true,
  },
  {
    slug: "historias-de-la-escena",
    name: "Historias de la escena",
    description: "Historias breves sobre comunidad, convocatorias y oportunidades.",
    templateSlug: "historia-convocatoria",
    editorialBrief:
      "Variá el foco entre bandas, fotografía, producción, difusión y oportunidades de trabajo. Hacé cada historia independiente y sin numeración fija.",
    cadence: { every: 1, unit: "week" },
    nextRunAt: null,
    active: false,
  },
  {
    slug: "secuencia-afterstage-diaria",
    name: "Afterstage · historias diarias",
    description:
      "Tres historias editables generadas desde las plantillas de Afterstage y publicadas en orden todos los días.",
    templateSlug: "afterstage-historia-red",
    editorialBrief:
      "Generar cada historia con su plantilla editable de Afterstage y publicar la secuencia en el orden definido.",
    cadence: { every: 1, unit: "day" },
    nextRunAt: storyPublishDate(),
    active: true,
    autoPublish: true,
    publishTime: "12:00",
    fixedStoryTemplates: [
      {
        templateSlug: "afterstage-historia-red",
        data: {
          eyebrow: "UN PUNTO DE ENCUENTRO",
          headline1: "UN LUGAR PARA",
          headline2: "QUIENES HACEN",
          headline3: "LA ESCENA.",
          body1: "Bandas, fotógrafos, fans, creadores",
          body2: "y productoras. La música nos cruza:",
          body3: "acá podemos encontrarnos y hacer match.",
          service1: "INFORMACIÓN, DIFUSIÓN",
          service2: "Y OPORTUNIDADES DE TRABAJO.",
          badge: "EN RED",
        },
      },
      {
        templateSlug: "afterstage-historia-lugar",
        data: {
          eyebrow: "PARA QUIENES HACEN LA ESCENA",
          headline1: "¿TENÉS UNA",
          headline2: "BANDA?",
          body1: "¿Querés difundir tu proyecto?",
          body2: "¿Hacés fotos o te gustaría",
          body3: "cubrir algún show?",
          banner: "ESTE ES TU LUGAR.",
          footer1: "Un espacio para compartir lo que hacés",
          footer2: "y conectar con otros proyectos.",
        },
      },
      {
        templateSlug: "afterstage-historia-coberturas",
        data: {
          eyebrow: "COBERTURAS PARA LA ESCENA",
          headline1: "¿QUERÉS QUE",
          headline2: "CUBRAMOS",
          headline3: "TU SHOW?",
          services: "FOTO · VIDEO · CRÓNICA · ENTREVISTAS",
          body1: "Cada cobertura lleva tiempo, oficio",
          body2: "y trabajo profesional. Por eso, nuestros",
          body3: "servicios son remunerados.",
          question: "¿ESTÁS EMPEZANDO?",
          footer1: "Escribinos. Podemos conversar una propuesta",
          footer2: "que acompañe a tu proyecto.",
          badge: "TRABAJO CON VALOR",
        },
      },
    ],
  },
  {
    slug: "descubrimiento-de-bandas",
    name: "Una banda para descubrir",
    description: "Presentaciones breves de proyectos de la escena.",
    templateSlug: "descubrimiento-banda",
    editorialBrief:
      "Elegí un proyecto y contá qué lo distingue con datos verificables, referencias concretas y enlaces oficiales. No inventes integrantes, trayectoria ni fechas.",
    cadence: { every: 2, unit: "week" },
    nextRunAt: null,
    active: false,
  },
  {
    slug: "cronica-post-show",
    name: "Después del show",
    description: "Una crónica visual a partir de coberturas realizadas.",
    templateSlug: "cronica-show",
    editorialBrief:
      "Contá un momento concreto de una cobertura ya realizada. Verificá fecha, lugar, créditos y cualquier cita; no agregues detalles que no estén en el material fuente.",
    cadence: { every: 1, unit: "week" },
    nextRunAt: null,
    active: false,
  },
];

const normalize = (doc: SeriesRecord): SocialSeries => {
  const { _id, ...data } = doc;
  return socialSeriesSchema.parse({ ...data, id: _id }) as SocialSeries;
};

const nextDate = (from: string, every: number, unit: "day" | "week" | "month") => {
  const [year, month, day] = from.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!, 12));
  if (unit === "day") date.setUTCDate(date.getUTCDate() + every);
  else if (unit === "week") date.setUTCDate(date.getUTCDate() + every * 7);
  else date.setUTCMonth(date.getUTCMonth() + every);
  return date.toISOString().slice(0, 10);
};

export class MongoSocialSeriesStore implements SocialSeriesRepository {
  constructor(private readonly collection: Collection<SeriesRecord>) {}

  async init() {
    await this.collection.createIndex({ slug: 1 }, { unique: true });
    for (const series of starterSocialSeries) {
      if (!(await this.findBySlug(series.slug))) await this.create(series);
    }
    const obsoleteStorySeries = await this.findBySlug("historias-de-la-escena");
    if (
      obsoleteStorySeries?.active &&
      (obsoleteStorySeries.updatedAt ?? obsoleteStorySeries.createdAt ?? "") < obsoleteStorySeriesCutoff
    ) {
      await this.save({ ...obsoleteStorySeries, active: false }, obsoleteStorySeries.id);
    }
  }

  async list() {
    const docs = await this.collection.find({}).sort({ active: -1, nextRunAt: 1, name: 1 }).toArray();
    return docs.map(normalize);
  }

  async get(id: string) {
    const doc = await this.collection.findOne({ _id: id });
    return doc ? normalize(doc) : undefined;
  }

  async findBySlug(slug: string) {
    const doc = await this.collection.findOne({ slug });
    return doc ? normalize(doc) : undefined;
  }

  async create(input: SocialSeriesInput) {
    const parsed = socialSeriesSchema.parse(input);
    const timestampNow = timestamp();
    const next = socialSeriesSchema.parse({
      ...parsed,
      id: parsed.id ?? randomUUID(),
      createdAt: timestampNow,
      updatedAt: timestampNow,
      lastDraftAt: parsed.lastDraftAt ?? null,
      lastDraftId: parsed.lastDraftId ?? null,
      lastAutoScheduledAt: parsed.lastAutoScheduledAt ?? null,
    }) as SocialSeries;
    const { id: _id, ...data } = next;
    const record = { ...data, _id: next.id } as SeriesRecord;
    try {
      await this.collection.insertOne(record);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new SocialSeriesConflictError();
      throw error;
    }
    return normalize(record);
  }

  async save(input: SocialSeriesInput, id: string) {
    const parsed = socialSeriesSchema.parse(input);
    const existing = await this.get(id);
    if (!existing) throw new Error("Serie social no encontrada");
    if (existing.slug !== parsed.slug) throw new Error("No se puede cambiar el identificador de una serie");
    const timestampNow = timestamp();
    const next = socialSeriesSchema.parse({
      ...parsed,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: timestampNow,
      lastDraftAt: existing.lastDraftAt ?? parsed.lastDraftAt ?? null,
      lastDraftId: existing.lastDraftId ?? parsed.lastDraftId ?? null,
      lastAutoScheduledAt: existing.lastAutoScheduledAt ?? parsed.lastAutoScheduledAt ?? null,
    }) as SocialSeries;
    const { id: _id, ...data } = next;
    const record = { ...data, _id: next.id } as SeriesRecord;
    const result = await this.collection.replaceOne({ _id: id }, record);
    if (result.matchedCount === 0) throw new Error("Serie social no encontrada");
    return normalize(record);
  }

  async completeDraftRun(id: string, draftId: string) {
    const existing = await this.get(id);
    if (!existing) throw new Error("Serie social no encontrada");
    if (existing.lastDraftId === draftId) return existing;
    const nowDate = today();
    let nextRunAt = existing.nextRunAt ?? nowDate;
    do {
      nextRunAt = nextDate(nextRunAt, existing.cadence.every, existing.cadence.unit);
    } while (nextRunAt <= nowDate);
    return this.save({ ...existing, nextRunAt, lastDraftAt: timestamp(), lastDraftId: draftId }, id);
  }

  async completeAutoScheduleRun(id: string, runDate: string, nextRunAt: string) {
    await this.collection.updateOne(
      { _id: id, active: true, autoPublish: true, nextRunAt: runDate },
      { $set: { nextRunAt, lastAutoScheduledAt: timestamp(), updatedAt: timestamp() } },
    );
    return this.get(id);
  }
}

export class MemorySocialSeriesStore implements SocialSeriesRepository {
  private series: SocialSeries[] = [];
  async init() {
    for (const item of starterSocialSeries) if (!(await this.findBySlug(item.slug))) await this.create(item);
  }
  async list() {
    return [...this.series].sort(
      (left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name),
    );
  }
  async get(id: string) {
    return this.series.find((item) => item.id === id);
  }
  async findBySlug(slug: string) {
    return this.series.find((item) => item.slug === slug);
  }
  async create(input: SocialSeriesInput) {
    const parsed = socialSeriesSchema.parse(input);
    if (this.series.some((item) => item.slug === parsed.slug || (parsed.id && item.id === parsed.id))) {
      throw new SocialSeriesConflictError();
    }
    const timestampNow = timestamp();
    const next = socialSeriesSchema.parse({
      ...parsed,
      id: parsed.id ?? randomUUID(),
      createdAt: timestampNow,
      updatedAt: timestampNow,
      lastDraftAt: parsed.lastDraftAt ?? null,
      lastDraftId: parsed.lastDraftId ?? null,
      lastAutoScheduledAt: parsed.lastAutoScheduledAt ?? null,
    }) as SocialSeries;
    this.series = [...this.series, next];
    return next;
  }
  async save(input: SocialSeriesInput, id: string) {
    const parsed = socialSeriesSchema.parse(input);
    const existing = await this.get(id);
    if (!existing) throw new Error("Serie social no encontrada");
    if (existing.slug !== parsed.slug) throw new Error("No se puede cambiar el identificador de una serie");
    const timestampNow = timestamp();
    const next = socialSeriesSchema.parse({
      ...parsed,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: timestampNow,
      lastDraftAt: existing.lastDraftAt ?? parsed.lastDraftAt ?? null,
      lastDraftId: existing.lastDraftId ?? parsed.lastDraftId ?? null,
      lastAutoScheduledAt: existing.lastAutoScheduledAt ?? parsed.lastAutoScheduledAt ?? null,
    }) as SocialSeries;
    this.series = [...this.series.filter((item) => item.id !== next.id), next];
    return next;
  }
  async completeDraftRun(id: string, draftId: string) {
    const existing = await this.get(id);
    if (!existing) throw new Error("Serie social no encontrada");
    if (existing.lastDraftId === draftId) return existing;
    const nowDate = today();
    let nextRunAt = existing.nextRunAt ?? nowDate;
    do {
      nextRunAt = nextDate(nextRunAt, existing.cadence.every, existing.cadence.unit);
    } while (nextRunAt <= nowDate);
    return this.save({ ...existing, nextRunAt, lastDraftAt: timestamp(), lastDraftId: draftId }, id);
  }
  async completeAutoScheduleRun(id: string, runDate: string, nextRunAt: string) {
    const current = await this.get(id);
    if (!current || !current.active || !current.autoPublish || current.nextRunAt !== runDate) return current;
    return this.save({ ...current, nextRunAt, lastAutoScheduledAt: timestamp() }, id);
  }
}
