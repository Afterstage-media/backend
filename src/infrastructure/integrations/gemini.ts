import { z } from "zod";

/** Small reusable Gemini REST client; output is validated by the caller's schema. */
export class GeminiClient {
  async generate<T>(input: { task: string; data: unknown; schema: z.ZodType<T>; instructions?: string }): Promise<T> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY no está configurada");
    const model = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: [
                "Sos parte de la redacción de Afterstage, medio argentino de música y cultura independiente.",
                "Escribí en español rioplatense claro. No inventes ni infieras hechos, nombres, fechas, citas, cifras, contexto, promesas o conclusiones. No agregues llamados a la acción ni preguntas retóricas si los datos no los piden. Separá los datos confirmados de lo que falta verificar y devolvé todos los campos requeridos por el esquema.",
                input.instructions ?? "",
              ].join(" "),
            },
          ],
        },
        contents: [{ role: "user", parts: [{ text: JSON.stringify({ task: input.task, data: input.data }) }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: z.toJSONSchema(input.schema),
          temperature: 0.3,
        },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Gemini respondió ${response.status}: ${(await response.text()).slice(0, 400)}`);
    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const resultText = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!resultText) throw new Error("Gemini no devolvió contenido");
    return input.schema.parse(JSON.parse(resultText));
  }
}
