import test from "node:test";
import assert from "node:assert/strict";
import { MemoryMonetizationRepository, MonetizationManager } from "./monetization-manager.js";

test("crea una solicitud paga sin exponer datos privados en el catálogo", async () => {
  const repository = new MemoryMonetizationRepository();
  const manager = new MonetizationManager(repository);
  const input = {
    productId: "evento-destacado",
    customerName: "Ana Under",
    customerEmail: "ana@example.com",
    title: "Fecha en Niceto",
    description: "Una fecha importante para la banda",
    city: "CABA",
  };
  const item = await manager.create(input, "promotion-1");
  assert.equal(item.status, "pending_payment");
  assert.equal(item.amountArs, 12000);
  assert.equal(manager.listProducts().length, 13);
  const [replay, concurrent] = await Promise.all([
    manager.create(input, "promotion-1"),
    manager.create(input, "promotion-1"),
  ]);
  assert.equal(replay.id, item.id);
  assert.equal(concurrent.id, item.id);
  assert.equal((await repository.list()).length, 1);
  assert.deepEqual(
    manager
      .listProducts()
      .slice(-5)
      .map((product) => product.id),
    [
      "pasarela-entradas",
      "promocion-festivales",
      "organizacion-festivales",
      "publicidad-viajes-conciertos",
      "tienda-merch",
    ],
  );
});

test("crea servicios a consultar directamente en revisión", async () => {
  const manager = new MonetizationManager(new MemoryMonetizationRepository());
  const item = await manager.create(
    {
      productId: "cobertura-foto-video",
      customerName: "Club",
      customerEmail: "club@example.com",
      title: "Cobertura",
      description: "Necesitamos fotos y video para un evento",
    },
    "promotion-2",
  );
  assert.equal(item.status, "in_review");
  assert.equal(item.amountArs, null);
});
