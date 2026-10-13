import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PressManager } from "./press-manager.js";
import { PressStore } from "../infrastructure/persistence/press-store.js";

test("gestiona evento, contacto, acreditación y cobertura vinculados", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-press-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new PressManager(new PressStore(directory));
  const contact = await manager.createContact({
    name: "Prensa Sala",
    organization: "Sala Under",
    email: "prensa@example.com",
  });
  const event = await manager.createEvent({
    name: "Noche Under",
    artist: "Banda Test",
    venue: "Sala Under",
    organizerContactId: contact.id,
  });
  const request = await manager.createAccreditation({
    eventId: event.id,
    contactId: contact.id,
    subject: "Acreditación Medio Under",
  });
  await manager.updateAccreditation(request.id, { status: "sent" });
  const simulatedMail = await manager.sendAccreditation(request.id, true);
  assert.equal(simulatedMail.to, "prensa@example.com");
  assert.equal(simulatedMail.dryRun, true);
  const coverage = await manager.createCoverage({
    eventId: event.id,
    title: "Crónica de Noche Under",
    url: "https://medio.example/nota",
  });
  await manager.updateEvent(event.id, { status: "covered" });
  await manager.updateMediaKit({ mission: "Periodismo musical independiente" });

  const snapshot = await manager.snapshot();
  assert.equal(snapshot.events[0]?.status, "covered");
  assert.equal(snapshot.accreditations[0]?.status, "sent");
  assert.equal(snapshot.coverages[0]?.id, coverage.id);
  assert.equal(snapshot.mediaKit.mission, "Periodismo musical independiente");
  await assert.rejects(() => manager.remove("events", event.id), /vinculadas/);
});

test("genera el correo con identidad, reply-to y plantilla del medio", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-mail-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let sent: Record<string, unknown> | undefined;
  const mailer = {
    send: async (mail: Record<string, unknown>) => {
      sent = mail;
      return { messageId: "mail-1", dryRun: false };
    },
  };
  const manager = new PressManager(new PressStore(directory), mailer as never);
  await manager.updateMediaKit({
    name: "Medio Under",
    email: "redaccion@medio.test",
    tagline: "Periodismo musical",
  });
  const contact = await manager.createContact({
    name: "Producción",
    email: "prensa@evento.test",
  });
  const event = await manager.createEvent({
    name: "Recital",
    artist: "Las Perlas",
    venue: "Sala X",
  });
  const request = await manager.createAccreditation({
    eventId: event.id,
    contactId: contact.id,
    subject: "Pase de prensa",
  });
  const result = await manager.sendAccreditation(request.id, false);
  assert.equal(result.messageId, "mail-1");
  assert.equal(sent?.to, "prensa@evento.test");
  assert.equal(sent?.fromName, "Medio Under");
  assert.equal(sent?.replyTo, "redaccion@medio.test");
  assert.match(String(sent?.text), /Las Perlas/);
  assert.match(String(sent?.html), /<p>/);
  assert.equal((await manager.snapshot()).accreditations[0]?.status, "sent");
});

test("envía follow-ups vencidos y limpia su fecha para no duplicarlos", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-followup-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let count = 0;
  const mailer = {
    send: async () => {
      count += 1;
      return { messageId: `mail-${count}`, dryRun: false };
    },
  };
  const manager = new PressManager(new PressStore(directory), mailer as never);
  const contact = await manager.createContact({
    name: "Prensa",
    email: "prensa@evento.test",
  });
  const event = await manager.createEvent({ name: "Fecha" });
  const request = await manager.createAccreditation({
    eventId: event.id,
    contactId: contact.id,
    subject: "Acreditación",
    followUpAt: new Date(Date.now() - 1000).toISOString(),
  });
  await manager.updateAccreditation(request.id, { status: "sent" });
  const sent = await manager.sendDueFollowups(false);
  assert.equal(sent.length, 1);
  assert.equal(count, 1);
  const after = await manager.snapshot();
  assert.equal(after.accreditations[0]?.status, "followup");
  assert.equal(after.accreditations[0]?.followUpAt, null);
  assert.equal((await manager.sendDueFollowups(false)).length, 0);
});

test("impide referencias inexistentes y borrado de contactos vinculados", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-refs-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new PressManager(new PressStore(directory));
  await assert.rejects(
    () =>
      manager.createAccreditation({
        eventId: "00000000-0000-4000-8000-000000000000",
        subject: "x",
      }),
    /Evento no encontrado/,
  );
  const contact = await manager.createContact({ name: "Contacto" });
  const event = await manager.createEvent({ name: "Evento" });
  await manager.createAccreditation({
    eventId: event.id,
    contactId: contact.id,
    subject: "x",
  });
  await assert.rejects(() => manager.remove("contacts", contact.id), /solicitudes vinculadas/);
});

test("gestiona búsqueda de reemplazo, postulación, asignación y aviso al medio", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-replacement-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let sent: Record<string, unknown> | undefined;
  const manager = new PressManager(new PressStore(directory), {
    send: async (mail: Record<string, unknown>) => {
      sent = mail;
      return { dryRun: true };
    },
  } as never);
  await manager.updateMediaKit({ name: "Medio Under", email: "redaccion@medio.test" });
  const event = await manager.createEvent({
    name: "Festival Under",
    city: "Córdoba",
    latitude: -31.4,
    longitude: -64.2,
  });
  const search = await manager.createReplacementSearch({
    eventId: event.id,
    title: "Fotógrafo para Festival Under",
    profile: "photographer",
    city: "Córdoba",
    latitude: -31.4,
    longitude: -64.2,
    contactEmail: "redaccion@medio.test",
  });
  assert.equal(search.eventId, event.id);
  const application = await manager.createReplacementApplication({
    searchId: search.id,
    applicantName: "Ana Foto",
    applicantEmail: "ana@example.com",
    profile: "photographer",
    portfolioUrl: "https://ana.example",
  });
  await assert.rejects(
    () =>
      manager.createReplacementApplication({
        searchId: search.id,
        applicantName: "Ana Foto",
        applicantEmail: "ana@example.com",
        profile: "photographer",
      }),
    /Ya existe/,
  );
  await assert.rejects(
    () =>
      manager.createReplacementApplication({
        searchId: search.id,
        applicantName: "Nico",
        applicantEmail: "nico@example.com",
        profile: "notero",
      }),
    /no coincide/,
  );
  const assigned = await manager.assignReplacementApplication(application.id, true);
  assert.equal(assigned.searchId, search.id);
  assert.equal((await manager.snapshot()).replacementSearches[0]?.status, "assigned");
  assert.equal(sent?.fromName, "Medio Under");
});

test("el modo simulación no cambia el estado ni requiere SMTP", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-dry-mail-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new PressManager(new PressStore(directory));
  const contact = await manager.createContact({
    name: "Prensa",
    email: "prensa@evento.test",
  });
  const event = await manager.createEvent({ name: "Evento" });
  const request = await manager.createAccreditation({
    eventId: event.id,
    contactId: contact.id,
    subject: "Solicitud",
  });
  const result = await manager.sendAccreditation(request.id, true);
  assert.equal(result.dryRun, true);
  assert.equal((await manager.snapshot()).accreditations[0]?.status, "draft");
});

test("valida estados de acreditación y enlaces de coberturas", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-press-validation-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new PressManager(new PressStore(directory));
  const event = await manager.createEvent({ name: "Evento" });
  const request = await manager.createAccreditation({
    eventId: event.id,
    subject: "Solicitud",
  });
  await assert.rejects(() => manager.updateAccreditation(request.id, { status: "nope" }), /Invalid enum/);
  await assert.rejects(
    () =>
      manager.createCoverage({
        eventId: "00000000-0000-4000-8000-000000000000",
        title: "Cobertura",
      }),
    /Evento no encontrado/,
  );
});
