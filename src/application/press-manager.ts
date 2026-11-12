import { createHash, createHmac } from "node:crypto";
import { PressStore, type PressRepository } from "../infrastructure/persistence/press-store.js";
import { PressMailer } from "../infrastructure/integrations/mailer.js";
import {
  accreditationSchema,
  contactSchema,
  coverageSchema,
  createEventSchema,
  eventSchema,
  mediaKitSchema,
  type AccreditationInput,
  type ContactInput,
  type CoverageInput,
  type EventInput,
  type MediaKit,
  replacementApplicationSchema,
  replacementSearchSchema,
} from "../domain/press/types.js";
import { parsePatch } from "../domain/parse-patch.js";

const publicStatuses = new Set(["draft", "sent", "followup", "accepted", "rejected", "attended", "coverage_sent"]);

export class IdempotentOperationError extends Error {
  constructor(readonly reason: "pending" | "conflict") {
    super(
      reason === "pending"
        ? "El envío con esta clave sigue pendiente de confirmación. Revisá la solicitud antes de volver a enviarla."
        : "La clave de idempotencia ya se usó con otros datos.",
    );
    this.name = "IdempotentOperationError";
  }
}

const normalizeEventDates = <T extends { startsAt?: string | null; dates?: string[] }>(event: T): T => {
  const dates = [...(event.dates ?? []), event.startsAt]
    .filter((date): date is string => Boolean(date))
    .filter((date, index, values) => values.indexOf(date) === index)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return {
    ...event,
    dates,
    startsAt: dates[0] ?? null,
  };
};

const validateEventDates = (startsAt: string | null, endsAt: string | null, dates: string[] = []) => {
  const occurrenceDates = [...dates, startsAt]
    .filter((date): date is string => Boolean(date))
    .map((date) => Date.parse(date))
    .filter(Number.isFinite);
  const lastOccurrence = occurrenceDates.length ? Math.max(...occurrenceDates) : null;
  if (endsAt && lastOccurrence === null) throw new Error("La fecha de fin necesita al menos una fecha del evento");
  if (endsAt && lastOccurrence !== null && Date.parse(endsAt) < lastOccurrence)
    throw new Error("La fecha de fin no puede ser anterior al inicio");
};

export class PressManager {
  constructor(
    readonly store: PressRepository = new PressStore(),
    private readonly mailer = new PressMailer(),
  ) {}

  beginIdempotentOperation(key: string, requestHash: string) {
    return this.store.beginIdempotentOperation(key, requestHash);
  }

  completeIdempotentOperation(key: string, result: unknown) {
    return this.store.completeIdempotentOperation(key, result);
  }

  async snapshot() {
    return this.store.snapshot();
  }
  async createEvent(input: unknown) {
    const event = normalizeEventDates(createEventSchema.parse(input));
    validateEventDates(event.startsAt, event.endsAt, event.dates);
    return this.store.createEvent(event);
  }
  async updateEvent(id: string, input: unknown) {
    const current = (await this.store.snapshot()).events.find((item) => item.id === id);
    if (!current) throw new Error("Evento no encontrado");
    const patch = parsePatch(eventSchema, input);
    const merged = normalizeEventDates({ ...current, ...patch });
    validateEventDates(merged.startsAt ?? null, merged.endsAt ?? null, merged.dates);
    const scheduleChanged = patch.dates !== undefined || patch.startsAt !== undefined;
    return this.store.updateEvent(
      id,
      scheduleChanged ? { ...patch, dates: merged.dates, startsAt: merged.startsAt } : patch,
    );
  }
  async createContact(input: unknown) {
    return this.store.createContact(contactSchema.parse(input));
  }
  async updateContact(id: string, input: unknown) {
    const current = (await this.store.snapshot()).contacts.find((item) => item.id === id);
    if (!current) throw new Error("Contacto no encontrado");
    return this.store.updateContact(id, parsePatch(contactSchema, input));
  }

  async createAccreditation(input: unknown) {
    const parsed = accreditationSchema.parse(input);
    await this.assertReferences(parsed.eventId, parsed.contactId);
    return this.store.createAccreditation(parsed);
  }

  async updateAccreditation(id: string, input: unknown) {
    const snapshot = await this.store.snapshot();
    const current = snapshot.accreditations.find((item) => item.id === id);
    if (!current) throw new Error("Solicitud de acreditación no encontrada");
    let patch: Partial<AccreditationInput>;
    try {
      patch = parsePatch(accreditationSchema, input);
    } catch (error) {
      const issues = (error as { issues?: Array<{ code?: string }> }).issues;
      if (issues?.some((issue) => issue.code === "invalid_value")) throw new Error("Invalid enum");
      throw error;
    }
    await this.assertReferences(
      patch.eventId ?? current.eventId,
      patch.contactId === undefined ? current.contactId : patch.contactId,
    );
    if (patch.status && !publicStatuses.has(patch.status)) throw new Error("Estado de acreditación inválido");
    return this.store.updateAccreditation(id, patch);
  }

  async createCoverage(input: unknown) {
    const parsed = coverageSchema.parse(input);
    const snapshot = await this.store.snapshot();
    if (parsed.eventId && !snapshot.events.some((event) => event.id === parsed.eventId))
      throw new Error("Evento no encontrado");
    return this.store.createCoverage(parsed);
  }

  async updateCoverage(id: string, input: unknown) {
    const snapshot = await this.store.snapshot();
    if (!snapshot.coverages.some((coverage) => coverage.id === id)) throw new Error("Cobertura no encontrada");
    const patch = parsePatch(coverageSchema, input);
    if (patch.eventId && !snapshot.events.some((event) => event.id === patch.eventId))
      throw new Error("Evento no encontrado");
    return this.store.updateCoverage(id, patch);
  }

  async updateMediaKit(input: unknown): Promise<MediaKit> {
    return this.store.updateMediaKit(parsePatch(mediaKitSchema, input));
  }

  async listReplacementSearches(status?: string) {
    const items = (await this.store.snapshot()).replacementSearches;
    return status ? items.filter((item) => item.status === status) : items;
  }
  async createReplacementSearch(input: unknown) {
    const parsed = replacementSearchSchema.parse(input);
    if (parsed.eventId && !(await this.store.snapshot()).events.some((event) => event.id === parsed.eventId))
      throw new Error("Evento no encontrado");
    return this.store.createReplacementSearch(parsed);
  }
  async updateReplacementSearch(id: string, input: unknown) {
    const snapshot = await this.store.snapshot();
    const current = snapshot.replacementSearches.find((item) => item.id === id);
    if (!current) throw new Error("Búsqueda de reemplazo no encontrada");
    const patch = parsePatch(replacementSearchSchema, input);
    if (patch.eventId && !snapshot.events.some((event) => event.id === patch.eventId))
      throw new Error("Evento no encontrado");
    return this.store.updateReplacementSearch(id, patch);
  }
  async createReplacementApplication(input: unknown) {
    const parsed = replacementApplicationSchema.parse(input);
    const snapshot = await this.store.snapshot();
    const search = snapshot.replacementSearches.find((item) => item.id === parsed.searchId);
    if (!search) throw new Error("Búsqueda de reemplazo no encontrada");
    if (!["open", "screening"].includes(search.status)) throw new Error("La búsqueda ya no acepta postulaciones");
    if (search.profile !== parsed.profile) throw new Error("El perfil no coincide con la búsqueda");
    if (
      snapshot.replacementApplications.some(
        (item) =>
          item.searchId === parsed.searchId &&
          item.applicantEmail.toLowerCase() === parsed.applicantEmail.toLowerCase() &&
          item.status !== "withdrawn",
      )
    )
      throw new Error("Ya existe una postulación con ese email");
    return this.store.createReplacementApplication(parsed);
  }
  async listReplacementApplications(searchId: string) {
    const snapshot = await this.store.snapshot();
    if (!snapshot.replacementSearches.some((item) => item.id === searchId))
      throw new Error("Búsqueda de reemplazo no encontrada");
    return snapshot.replacementApplications.filter((item) => item.searchId === searchId);
  }
  async assignReplacementApplication(id: string, dryRun = true, idempotency?: { key: string; actorId: string }) {
    const snapshot = await this.store.snapshot();
    const application = snapshot.replacementApplications.find((item) => item.id === id);
    if (!application) throw new Error("Postulación no encontrada");
    const search = snapshot.replacementSearches.find((item) => item.id === application.searchId);
    if (!search) throw new Error("Búsqueda de reemplazo no encontrada");
    const message = `Hola ${application.applicantName},\n\n${snapshot.mediaKit.name} seleccionó tu postulación para “${search.title}”. Nos pondremos en contacto para coordinar la cobertura.\n\nSaludos,\n${snapshot.mediaKit.name}`;
    const mailInput = {
      to: application.applicantEmail,
      subject: `Reemplazo confirmado: ${search.title}`,
      text: message,
      html: `<p>${message.replace(/\n/g, "<br>")}</p>`,
      fromName: snapshot.mediaKit.name,
      replyTo: snapshot.mediaKit.email || undefined,
    };
    let operationKey: string | undefined;
    if (!dryRun) {
      if (!idempotency) throw new Error("Para enviar la asignación se necesita una clave de idempotencia");
      if (this.mailer.configured === false) throw new Error("El envío de correo no está configurado");
      operationKey = createHash("sha256")
        .update(`${idempotency.actorId}:replacement-application-assign:${id}:${idempotency.key}`)
        .digest("hex");
      const requestHash = createHmac("sha256", process.env.JWT_SECRET ?? "afterstage-local-idempotency")
        .update(JSON.stringify(mailInput))
        .digest("hex");
      const existing = await this.store.beginIdempotentOperation(operationKey, requestHash);
      if (existing.status === "conflict") throw new IdempotentOperationError("conflict");
      if (existing.status === "pending") throw new IdempotentOperationError("pending");
      if (existing.status === "completed")
        return existing.result as { applicationId: string; searchId: string; notification: unknown };
    }
    await this.store.updateReplacementApplication(id, { status: "accepted" });
    for (const other of snapshot.replacementApplications.filter(
      (item) =>
        item.searchId === search.id && item.id !== id && ["pending", "shortlisted", "accepted"].includes(item.status),
    ))
      await this.store.updateReplacementApplication(other.id, { status: "rejected" });
    await this.store.updateReplacementSearch(search.id, { status: "assigned", assignedApplicationId: id });
    const notification = await this.mailer.send(mailInput, dryRun);
    const result = { applicationId: id, searchId: search.id, notification };
    if (operationKey) await this.store.completeIdempotentOperation(operationKey, result);
    return result;
  }

  async sendAccreditation(id: string, dryRun = true, idempotency?: { key: string; actorId: string }) {
    const snapshot = await this.store.snapshot();
    const request = snapshot.accreditations.find((item) => item.id === id);
    if (!request) throw new Error("Solicitud de acreditación no encontrada");
    const contact = request.contactId ? snapshot.contacts.find((item) => item.id === request.contactId) : undefined;
    if (!contact?.email) throw new Error("La solicitud necesita un contacto con email");
    const event = snapshot.events.find((item) => item.id === request.eventId);
    const message =
      request.message ||
      [
        `Hola ${contact.name || "equipo"},`,
        "",
        `Somos ${snapshot.mediaKit.name}, ${snapshot.mediaKit.tagline}.`,
        `Nos gustaría solicitar acreditación de prensa para cubrir ${event?.name ?? "el evento"}${event?.artist ? ` (${event.artist})` : ""}${event?.venue ? ` en ${event.venue}` : ""}.`,
        "",
        `La cobertura incluiría: ${request.deliverables}.`,
        snapshot.mediaKit.website ? `Podés conocer nuestro trabajo en ${snapshot.mediaKit.website}.` : "",
        "Quedamos atentos para enviar los datos del equipo y coordinar la cobertura.",
        "",
        `Saludos,`,
        snapshot.mediaKit.name,
        snapshot.mediaKit.email,
      ]
        .filter(Boolean)
        .join("\n");
    const html = message
      .split("\n\n")
      .map(
        (paragraph) =>
          `<p>${paragraph.replace(/[&<>\"]|'/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character).replace(/\n/g, "<br>")}</p>`,
      )
      .join("");
    const mail = {
      to: contact.email,
      subject: request.subject,
      text: message,
      html,
      fromName: snapshot.mediaKit.name,
      replyTo: snapshot.mediaKit.email || undefined,
    };
    let operationKey: string | undefined;
    if (!dryRun && idempotency) {
      if (this.mailer.configured === false) throw new Error("El envío de correo no está configurado");
      operationKey = createHash("sha256")
        .update(`${idempotency.actorId}:press-accreditation-send:${id}:${idempotency.key}`)
        .digest("hex");
      const requestHash = createHmac("sha256", process.env.JWT_SECRET ?? "afterstage-local-idempotency")
        .update(JSON.stringify({ to: mail.to, subject: mail.subject, text: mail.text, html: mail.html }))
        .digest("hex");
      const existing = await this.store.beginIdempotentOperation(operationKey, requestHash);
      if (existing.status === "conflict") throw new IdempotentOperationError("conflict");
      if (existing.status === "pending") throw new IdempotentOperationError("pending");
      if (existing.status === "completed") {
        const previous = existing.result as { messageId: string; dryRun: boolean };
        return { ...previous, accreditationId: id, to: contact.email };
      }
    }
    const result = await this.mailer.send(mail, dryRun);
    if (!dryRun) {
      const updated = await this.store.updateAccreditation(id, {
        status: "sent",
        sentAt: new Date().toISOString(),
      });
      if (!updated) throw new Error("No se pudo confirmar el envío de la acreditación");
      if (operationKey) await this.store.completeIdempotentOperation(operationKey, result);
    }
    return { ...result, accreditationId: id, to: contact.email };
  }

  async sendDueFollowups(dryRun = true) {
    const snapshot = await this.store.snapshot();
    const nowMs = Date.now();
    const due = snapshot.accreditations.filter(
      (item) => ["sent", "followup"].includes(item.status) && item.followUpAt && Date.parse(item.followUpAt) <= nowMs,
    );
    const results = [];
    for (const item of due) {
      const result = await this.sendAccreditation(
        item.id,
        dryRun,
        dryRun || !item.followUpAt
          ? undefined
          : { actorId: "afterstage-scheduler", key: `followup:${item.followUpAt}` },
      );
      results.push(result);
      if (!dryRun)
        await this.store.updateAccreditation(item.id, {
          status: "followup",
          followUpAt: null,
        });
    }
    return results;
  }

  async remove(
    collection:
      "events" | "contacts" | "accreditations" | "coverages" | "replacementSearches" | "replacementApplications",
    id: string,
  ) {
    const snapshot = await this.store.snapshot();
    if (
      collection === "events" &&
      (snapshot.accreditations.some((item) => item.eventId === id) ||
        snapshot.coverages.some((item) => item.eventId === id))
    )
      throw new Error("No se puede eliminar un evento con solicitudes o coberturas vinculadas");
    if (collection === "contacts" && snapshot.accreditations.some((item) => item.contactId === id))
      throw new Error("No se puede eliminar un contacto con solicitudes vinculadas");
    if (collection === "replacementSearches" && snapshot.replacementApplications.some((item) => item.searchId === id))
      throw new Error("No se puede eliminar una búsqueda con postulaciones vinculadas");
    return this.store.remove(collection, id);
  }

  private async assertReferences(eventId: string, contactId: string | null) {
    const snapshot = await this.store.snapshot();
    if (!snapshot.events.some((event) => event.id === eventId)) throw new Error("Evento no encontrado");
    if (contactId && !snapshot.contacts.some((contact) => contact.id === contactId))
      throw new Error("Contacto no encontrado");
  }
}

export type { AccreditationInput, ContactInput, CoverageInput, EventInput };
