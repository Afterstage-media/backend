import { randomUUID } from "node:crypto";
import type { Collection } from "mongodb";
import {
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
      if (!(await this.findBySlug(series.slug))) await this.save(series);
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

  async save(input: SocialSeriesInput, id?: string) {
    const parsed = socialSeriesSchema.parse(input);
    const existing = id ? await this.get(id) : await this.findBySlug(parsed.slug);
    if (id && !existing) throw new Error("Serie social no encontrada");
    if (existing && existing.slug !== parsed.slug) throw new Error("No se puede cambiar el identificador de una serie");
    const timestampNow = timestamp();
    const next = socialSeriesSchema.parse({
      ...parsed,
      id: existing?.id ?? parsed.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? timestampNow,
      updatedAt: timestampNow,
      lastDraftAt: existing?.lastDraftAt ?? parsed.lastDraftAt ?? null,
      lastDraftId: existing?.lastDraftId ?? parsed.lastDraftId ?? null,
    }) as SocialSeries;
    const { id: _id, ...data } = next;
    const record = { ...data, _id: next.id } as SeriesRecord;
    await this.collection.replaceOne({ _id: next.id }, record, { upsert: true });
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
}

export class MemorySocialSeriesStore implements SocialSeriesRepository {
  private series: SocialSeries[] = [];
  async init() {
    for (const item of starterSocialSeries) if (!(await this.findBySlug(item.slug))) await this.save(item);
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
  async save(input: SocialSeriesInput, id?: string) {
    const parsed = socialSeriesSchema.parse(input);
    const existing = id ? await this.get(id) : await this.findBySlug(parsed.slug);
    if (id && !existing) throw new Error("Serie social no encontrada");
    if (existing && existing.slug !== parsed.slug) throw new Error("No se puede cambiar el identificador de una serie");
    const timestampNow = timestamp();
    const next = socialSeriesSchema.parse({
      ...parsed,
      id: existing?.id ?? parsed.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? timestampNow,
      updatedAt: timestampNow,
      lastDraftAt: existing?.lastDraftAt ?? parsed.lastDraftAt ?? null,
      lastDraftId: existing?.lastDraftId ?? parsed.lastDraftId ?? null,
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
}
