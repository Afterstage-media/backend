import test from "node:test";
import assert from "node:assert/strict";
import { MemoryMonetizationRepository, MonetizationManager } from "./monetization-manager.js";

test("crea una solicitud paga sin exponer datos privados en el catálogo", async () => {
  const repository = new MemoryMonetizationRepository();
  const manager = new MonetizationManager(repository);
  const item = await manager.create({
    productId: "evento-destacado",
    customerName: "Ana Under",
    customerEmail: "ana@example.com",
    title: "Fecha en Niceto",
    description: "Una fecha importante para la banda",
    city: "CABA",
  });
  assert.equal(item.status, "pending_payment");
  assert.equal(item.amountArs, 12000);
  assert.equal(manager.listProducts().length, 8);
});

test("crea servicios a consultar directamente en revisión", async () => {
  const manager = new MonetizationManager(new MemoryMonetizationRepository());
  const item = await manager.create({
    productId: "cobertura-foto-video",
    customerName: "Club",
    customerEmail: "club@example.com",
    title: "Cobertura",
    description: "Necesitamos fotos y video para un evento",
  });
  assert.equal(item.status, "in_review");
  assert.equal(item.amountArs, null);
});
