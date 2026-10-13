import type { ContentItem } from "../../domain/content/types.js";

type GenerationKind = "full_article" | "social_copy" | "improve";

export type GeneratedContent = {
  title?: string;
  summary?: string;
  body?: string;
  instagramCopy?: string;
  facebookCopy?: string;
  tags?: string[];
};

const instructions: Record<GenerationKind, string> = {
  full_article:
    "Escribí una nota periodística musical completa, con título, bajada y cuerpo. No inventes datos: señalá entre corchetes aquello que requiera verificación.",
  social_copy:
    "Creá copys distintos para Instagram y Facebook. Instagram debe tener gancho, información concreta, CTA y hasta 8 hashtags relevantes; Facebook puede ser más explicativo.",
  improve: "Editá el material para mejorar claridad, ritmo y precisión sin cambiar su voz ni inventar información.",
};

const extractJson = (value: string): GeneratedContent => {
  const clean = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(clean) as GeneratedContent;
};

export class AiWriter {
  async generate(
    item: ContentItem,
    kind: GenerationKind,
    extraInstructions = "",
    context: ContentItem[] = [],
  ): Promise<GeneratedContent> {
    const apiKey = process.env.AI_API_KEY;
    if (!apiKey) throw new Error("AI_API_KEY no está configurada");

    const baseUrl = (process.env.AI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL ?? "gpt-5-mini",
        temperature: 0.6,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "Sos parte de la redacción de Medio Under, un medio argentino de música y cultura independiente.",
              "Escribís en español rioplatense, con una voz cercana, informada y sin grandilocuencia.",
              "Nunca inventes nombres, fechas, lugares, citas ni hechos. Conservá créditos y fuentes.",
              "Respondé únicamente JSON con las claves: title, summary, body, instagramCopy, facebookCopy, tags.",
            ].join(" "),
          },
          {
            role: "user",
            content: JSON.stringify({
              task: instructions[kind],
              extraInstructions,
              content: item,
              verifiedContext: context.map((source) => ({
                title: source.title,
                summary: source.summary,
                body: source.body,
                source: source.source,
                publishedAt: source.publishedAt,
              })),
            }),
          },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`El proveedor de IA respondió ${response.status}: ${detail}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("El proveedor de IA no devolvió contenido");
    return extractJson(content);
  }
}

export type { GenerationKind };
