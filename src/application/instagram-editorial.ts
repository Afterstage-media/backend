import { detectDuplicates } from "../domain/content/duplicate-detector.js";
import { slugify, type ContentItem } from "../domain/content/types.js";
import type { SocialTemplateRepository } from "../domain/content/social-template.js";
import type { ContentManager } from "./content-manager.js";
import type { PressManager } from "./press-manager.js";
import { argentinaParts } from "./recurring-story-publisher.js";
import type { PhotoCandidate } from "../infrastructure/integrations/openverse.js";

const timeZone = "America/Argentina/Buenos_Aires";
const dateLabel = new Intl.DateTimeFormat("es-AR", { timeZone, day: "numeric", month: "short" });
const clean = (value: string) =>
  value
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
const usable = (value: string) => value.trim() && !/\[[^\]]*verificar[^\]]*\]/i.test(value);
const articleUrl = (item: ContentItem) => `https://afterstage.ar/notas/${encodeURIComponent(item.slug)}`;
const sections = {
  news: { template: "noticia-musical", label: "Novedades", cta: "Leé la nota completa en Afterstage." },
  discovery: { template: "descubrimiento-banda", label: "Descubrimientos", cta: "¿A quién se lo harías escuchar?" },
  "show-recap": { template: "cronica-show", label: "Crónica en vivo", cta: "Leé la crónica completa en Afterstage." },
};

type Section = keyof typeof sections;
const sectionFor = (item: ContentItem): Section => {
  const tags = item.tags.map(slugify);
  if (tags.some((tag) => ["cronica", "cobertura", "show-recap"].includes(tag))) return "show-recap";
  if (tags.some((tag) => ["descubrimiento", "discovery"].includes(tag))) return "discovery";
  return "news";
};

const relevantPhotoCandidate = (article: ContentItem, candidates: PhotoCandidate[]) => {
  const tokens = (value: string) =>
    clean(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .match(/[a-z0-9]{4,}/g) ?? [];
  const generic = new Set([
    "musica",
    "musical",
    "rock",
    "banda",
    "concierto",
    "conciertos",
    "show",
    "shows",
    "escena",
    "argentina",
    "nuevo",
    "nueva",
    "album",
    "disco",
    "cancion",
    "live",
    "photo",
    "image",
  ]);
  const articleTerms = new Set(
    tokens(`${article.title} ${article.tags.join(" ")}`).filter((token) => !generic.has(token)),
  );
  const matching = candidates
    .filter(
      (candidate) =>
        candidate.rightsVerified === false &&
        candidate.creator.trim() &&
        candidate.license.trim() &&
        candidate.licenseVersion.trim() &&
        candidate.licenseUrl &&
        candidate.sourceUrl.startsWith("https://"),
    )
    .map((candidate) => {
      const candidateTerms = tokens(`${candidate.title} ${candidate.tags.join(" ")}`);
      const overlap = new Set(candidateTerms.filter((token) => articleTerms.has(token)));
      return { candidate, overlap: overlap.size };
    })
    .filter(({ overlap }) => overlap >= 2)
    .sort((left, right) => right.overlap - left.overlap);
  if (!matching.length || (matching.length > 1 && matching[0]!.overlap === matching[1]!.overlap)) return undefined;
  return matching[0]!.candidate;
};

const performance = (items: ContentItem[], section: Section) => {
  const measured = items.filter((item) => {
    const metrics = item.instagramMetrics;
    return (
      item.tags.includes(sections[section].label) &&
      metrics?.observed?.includes("saves") &&
      metrics.observed.includes("shares") &&
      metrics.observed.includes("reach") &&
      metrics.reach > 0
    );
  });
  if (measured.length < 3) return 0;
  return (
    measured.reduce((sum, item) => {
      const metrics = item.instagramMetrics!;
      return sum + Math.min(1, (metrics.saves + metrics.shares) / metrics.reach);
    }, 0) / measured.length
  );
};

export async function prepareInstagramEditorial(
  manager: ContentManager,
  press: PressManager,
  templates: SocialTemplateRepository,
  now: Date,
) {
  const { day } = argentinaParts(now);
  const weekday = new Date(day).getUTCDay();
  if (![2, 4, 6].includes(weekday)) return { result: "no_slot" };
  const slot = `instagram-editorial:${day}`;
  const existing = await manager.store.findByIdempotencyKey(slot);
  if (existing?.assets.length) return { result: "existing", id: existing.id };

  if (weekday === 2) {
    const { events } = await press.snapshot();
    const upcoming = events
      .flatMap((event) => {
        if (
          event.status === "cancelled" ||
          !event.venue.trim() ||
          !event.city.trim() ||
          !/^https:\/\//i.test(event.url)
        )
          return [];
        return [...new Set([event.startsAt, ...(event.dates ?? [])])].flatMap((date) => {
          const timestamp = Date.parse(date ?? "");
          return timestamp > +now && timestamp <= +now + 7 * 86_400_000
            ? [{ event, timestamp, day: dateLabel.format(timestamp) }]
            : [];
        });
      })
      .sort((left, right) => left.timestamp - right.timestamp);
    const key = (entry: (typeof upcoming)[number]) =>
      [slugify(entry.event.name), slugify(entry.event.venue), entry.timestamp].join(":");
    const chosen = upcoming
      .filter((entry, index) => upcoming.findIndex((other) => key(other) === key(entry)) === index)
      .filter(
        ({ event, day }) =>
          usable(`${event.name} ${event.venue} ${event.city}`) &&
          event.name.length <= 72 &&
          `${day} · ${event.venue} · ${event.city}`.length <= 125,
      )
      .slice(0, 5);
    if (chosen.length < 2) return { result: "insufficient_agenda" };
    const template = await templates.findBySlug("agenda-mensual");
    if (!template) return { result: "missing_template" };
    const lines = chosen.map(({ event, day }) => `${day} · ${event.name} · ${event.venue}, ${event.city}`);
    const draft = await manager.prepareEditorialGraphic(
      template,
      {
        title: `Shows para los próximos siete días · ${dateLabel.format(now)}`,
        summary: "Una selección de fechas de la agenda de Afterstage.",
        instagramCopy: [
          "¿Qué show vas a ver esta semana? Guardá esta selección y consultá la organización antes de salir.",
          lines.join("\n"),
          "Encontrá los enlaces de cada show en la agenda de Afterstage.",
        ].join("\n\n"),
        source: "Agenda de Afterstage",
        notes: `Revisar fecha, lugar y vigencia con la organización.\n${chosen.map(({ event }) => event.url).join("\n")}`,
        tags: ["Agenda"],
        idempotencyKey: slot,
      },
      [
        { eyebrow: "AGENDA AFTERSTAGE", title: "Shows para los próximos siete días", body: dateLabel.format(now) },
        ...chosen.map(({ event, day }) => ({
          eyebrow: "EN VIVO",
          title: event.name,
          body: `${day} · ${event.venue} · ${event.city}`,
        })),
      ],
    );
    return { result: "draft", id: draft.id };
  }

  const items = await manager.store.list();
  const editorial = items.filter(
    (item) => item.idempotencyKey?.startsWith("instagram-editorial:") && item.id !== existing?.id,
  );
  const recent = editorial.filter((item) => +now - Date.parse(item.createdAt) <= 28 * 86_400_000);
  const previousSection = recent.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.tags[0];
  const candidates = items.filter(
    (item) =>
      item.status === "published" &&
      item.type === "article" &&
      item.channels.includes("website") &&
      item.publishedAt &&
      +now - Date.parse(item.publishedAt) <= 28 * 86_400_000 &&
      item.slug &&
      item.title.length <= 80 &&
      usable(item.title) &&
      usable(item.summary) &&
      clean(item.summary).length >= 40 &&
      usable(item.body) &&
      !item.remoteIds.instagram &&
      !editorial.some((previous) => previous.source === articleUrl(item)) &&
      !detectDuplicates(item, recent, undefined, 0.65).length,
  );
  const scores = new Map(
    (Object.keys(sections) as Section[]).map((section) => [section, performance(recent, section)]),
  );
  candidates.sort((left, right) => {
    const rank = (item: ContentItem) => {
      const section = sectionFor(item);
      return (sections[section].label === previousSection ? -2 : 0) + (scores.get(section) ?? 0);
    };
    return rank(right) - rank(left) || right.publishedAt!.localeCompare(left.publishedAt!);
  });
  const article = candidates[0];
  if (!article) return { result: "no_eligible_article" };
  const section = sections[sectionFor(article)];
  const template = await templates.findBySlug(section.template);
  if (!template) return { result: "missing_template" };
  const source = articleUrl(article);
  if (
    section.template === "noticia-musical" &&
    template.outputType === "post" &&
    template.visualStyle.layout === "photo-overlay"
  ) {
    try {
      const query = `${article.title} ${article.tags.join(" ")} ${clean(article.summary).slice(0, 100)}`.slice(0, 200);
      const photoCandidates = await manager.searchPhotoCandidates(query, 10);
      const candidate = relevantPhotoCandidate(article, photoCandidates);
      if (candidate) {
        const downloaded = await manager.downloadOpenversePhoto(candidate);
        const checkedAt = new Date().toISOString();
        const licenseLabel = `${candidate.license.toUpperCase()} ${candidate.licenseVersion}`;
        const draft = await manager.createInstagramSocialPublication(
          {
            templateId: template.id,
            type: "post",
            title: article.title,
            instagramCopy: [clean(article.summary), section.cta, `Fuente editorial: ${source}`].join("\n\n"),
            slides: [
              {
                text: clean(article.summary).slice(0, 180),
                image: {
                  base64: downloaded.bytes.toString("base64"),
                  mimeType: downloaded.mimeType,
                  altText:
                    "Foto candidata de Openverse. Revisar autenticidad, contexto y texto alternativo antes de publicar.",
                  credit: `${candidate.creator} · ${candidate.providerName} · ${licenseLabel} (pendiente de verificación)`,
                  photoRights: {
                    sourceUrl: candidate.sourceUrl,
                    creator: candidate.creator,
                    license: candidate.license,
                    licenseVersion: candidate.licenseVersion,
                    licenseUrl: candidate.licenseUrl!,
                    permissionType: "license_terms",
                    termsUrl: candidate.licenseUrl!,
                    evidenceUrl: candidate.sourceUrl,
                    evidenceCheckedAt: checkedAt,
                    allowedUses: ["instagram", "commercial", "adaptation", "platform_sublicense"],
                    subjectContext: article.title.slice(0, 300),
                    contextType: "illustrative_context",
                    documentaryPhotograph: false,
                  },
                },
              },
            ],
            tags: [section.label, "Foto pendiente de revisión"],
            source: `${source} · Foto candidata: ${candidate.sourceUrl}`,
            author: "Afterstage",
            photographer: candidate.creator,
          },
          "afterstage-editorial",
          template,
          slot,
        );
        return { result: "draft", id: draft.id, visual: "photo_pending_review" };
      }
    } catch {
      // Editorial image search is optional; keep the existing typographic fallback on any uncertainty.
    }
  }
  const draft = await manager.prepareEditorialGraphic(
    template,
    {
      title: article.title,
      slug: `instagram-editorial-${day}`,
      summary: clean(article.summary),
      instagramCopy: [clean(article.summary), section.cta, `Fuente: ${source}`].join("\n\n"),
      source,
      notes:
        "Revisar vigencia, atribución y contexto antes de publicar. Si se cambia la gráfica por una foto, verificar permiso y crédito.",
      tags: [section.label],
      idempotencyKey: slot,
    },
    [{ eyebrow: section.label.toUpperCase(), title: article.title, body: "" }],
  );
  return { result: "draft", id: draft.id };
}
