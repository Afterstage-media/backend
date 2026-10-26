import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PlatformManager } from "./platform-manager.js";
import { PlatformStore } from "../infrastructure/persistence/platform-store.js";

test("gestiona perfiles, coberturas, seguros, foro y traslados de la plataforma", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-platform-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new PlatformManager(new PlatformStore(directory));

  const pending = await manager.createPhotographer({
    name: "Fotógrafa Nueva",
    city: "Moreno",
    specialties: ["Recitales"],
    portfolioUrls: ["https://cdn.example.com/foto-1.jpg", "https://cdn.example.com/foto-2.jpg"],
    contactEmail: "foto@example.com",
  });
  assert.equal(pending.status, "pending");
  await manager.updatePhotographer(pending.id, { status: "published" });
  assert.equal((await manager.publicPhotographers()).length, 1);
  assert.equal((await manager.publicPhotographers())[0]?.portfolioUrls.length, 2);
  const request = await manager.createCoverageRequest({
    eventId: "6cc5f2d1-5f22-4a2a-971e-c7783fb8c1a1",
    title: "Cobertura de recital",
    description: "Buscamos fotos y material para una nota.",
    requesterName: "Afterstage",
    requesterEmail: "prensa@example.com",
  });
  const application = await manager.createCoverageApplication({
    requestId: request.id,
    photographerId: pending.id,
    applicantName: "Fotógrafa Nueva",
    applicantEmail: "foto@example.com",
    message: "Tengo disponibilidad.",
  });
  assert.equal(application.status, "pending");
  const publicRequests = await manager.publicCoverageRequests();
  assert.equal("requesterEmail" in (publicRequests[0] || {}), false);
  const accepted = await manager.updateCoverageApplication(application.id, {
    status: "accepted",
    deliveryUrl: "https://cdn.example.com/entrega.zip",
    deliveryNotes: "Material listo para edición.",
  });
  assert.equal(accepted?.status, "accepted");
  assert.equal((await manager.snapshot()).coverageRequests[0]?.status, "assigned");
  const offer = await manager.createTransportOffer({
    eventId: "6cc5f2d1-5f22-4a2a-971e-c7783fb8c1a1",
    title: "Micro desde Moreno",
    kind: "bus",
    providerName: "Traslados Under",
    origin: "Moreno",
    destination: "CABA",
    seats: 20,
  });
  const transportRequest = await manager.createTransportRequest({
    eventId: offer.eventId,
    offerId: offer.id,
    name: "Fan del show",
    email: "fan@example.com",
    origin: "Moreno",
  });
  assert.equal(transportRequest.status, "new");
  const smallOffer = await manager.createTransportOffer({
    eventId: offer.eventId,
    title: "Cupo chico",
    kind: "carpool",
    providerName: "Comunidad",
    origin: "Moreno",
    destination: "CABA",
    seats: 2,
  });
  const reserved = await manager.createTransportRequest({
    eventId: smallOffer.eventId,
    offerId: smallOffer.id,
    name: "Pasajero 1",
    email: "pasajero1@example.com",
    origin: "Moreno",
    partySize: 2,
  });
  await manager.updateTransportRequest(reserved.id, { status: "confirmed" });
  await assert.rejects(
    () =>
      manager.createTransportRequest({
        eventId: smallOffer.eventId,
        offerId: smallOffer.id,
        name: "Pasajero 2",
        email: "pasajero2@example.com",
        origin: "Moreno",
        partySize: 1,
      }),
    /No quedan cupos/,
  );
  const insurance = await manager.createInsuranceRequest({
    eventId: offer.eventId,
    name: "Productora",
    email: "produccion@example.com",
    coverageType: "Accidentes personales",
  });
  assert.equal(insurance.status, "new");
  const thread = await manager.createForumThread({
    eventId: offer.eventId,
    title: "¿Desde dónde salen?",
    body: "¿Alguien más viaja desde Moreno?",
    authorName: "Fan del show",
    authorEmail: "fan@example.com",
  });
  await manager.createForumPost({
    threadId: thread.id,
    body: "Yo también voy desde ahí.",
    authorName: "Otra persona",
    authorEmail: "otra@example.com",
  });
  const hub = await manager.eventHub({ id: offer.eventId });
  assert.equal(hub.coverageRequests.length, 0);
  assert.equal(hub.transportOffers.length, 2);
  assert.equal(hub.threads[0]?.posts.length, 1);
});
