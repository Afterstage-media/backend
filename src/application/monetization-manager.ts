import { randomUUID } from "node:crypto";
import {
  defaultMonetizationProducts,
  promotionInputSchema,
  promotionPatchSchema,
  type MonetizationProduct,
  type MonetizationPromotion,
  type MonetizationStatus,
  type PromotionPatch,
} from "../domain/monetization/types.js";

export interface MonetizationRepository {
  init?(): Promise<void>;
  list(status?: MonetizationStatus): Promise<MonetizationPromotion[]>;
  get(id: string): Promise<MonetizationPromotion | undefined>;
  create(item: MonetizationPromotion): Promise<MonetizationPromotion>;
  update(id: string, patch: Partial<MonetizationPromotion>): Promise<MonetizationPromotion | undefined>;
}

export class MemoryMonetizationRepository implements MonetizationRepository {
  private items: MonetizationPromotion[] = [];
  async list(status?: MonetizationStatus) {
    return this.items
      .filter((item) => !status || item.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async get(id: string) {
    return this.items.find((item) => item.id === id);
  }
  async create(item: MonetizationPromotion) {
    this.items.push(item);
    return item;
  }
  async update(id: string, patch: Partial<MonetizationPromotion>) {
    const item = await this.get(id);
    if (!item) return undefined;
    Object.assign(item, patch, { updatedAt: new Date().toISOString() });
    return item;
  }
}

export class MercadoPagoCheckout {
  async createPreference(
    item: MonetizationPromotion,
    product: MonetizationProduct,
  ): Promise<{ id: string; url: string }> {
    const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
    if (!token) throw new Error("Mercado Pago no está configurado");
    const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
    const response = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            id: product.id,
            title: product.name,
            description: product.description,
            quantity: 1,
            currency_id: "ARS",
            unit_price: product.priceArs,
          },
        ],
        external_reference: item.id,
        payer: { name: item.customerName, email: item.customerEmail },
        back_urls: {
          success: `${base}/monetizar?payment=success&promotion=${item.id}`,
          failure: `${base}/monetizar?payment=failure&promotion=${item.id}`,
          pending: `${base}/monetizar?payment=pending&promotion=${item.id}`,
        },
        notification_url: `${base}/api/payments/mercadopago/webhook`,
        auto_return: "approved",
      }),
    });
    if (!response.ok) throw new Error(`Mercado Pago rechazó la preferencia (${response.status})`);
    const data = (await response.json()) as { id?: string; init_point?: string; sandbox_init_point?: string };
    if (!data.id || !(data.init_point || data.sandbox_init_point))
      throw new Error("Mercado Pago devolvió una preferencia incompleta");
    return { id: data.id, url: data.init_point ?? data.sandbox_init_point! };
  }
  async getPayment(paymentId: string): Promise<{ status?: string; external_reference?: string }> {
    const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
    if (!token) throw new Error("Mercado Pago no está configurado");
    const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`No se pudo consultar el pago (${response.status})`);
    return (await response.json()) as { status?: string; external_reference?: string };
  }
}

export class MonetizationManager {
  constructor(
    readonly repository: MonetizationRepository = new MemoryMonetizationRepository(),
    private readonly checkout = new MercadoPagoCheckout(),
    private readonly products = loadProducts(),
  ) {}
  listProducts() {
    return this.products.filter((product) => product.active);
  }
  product(id: string) {
    return this.products.find((product) => product.id === id && product.active);
  }
  async create(input: unknown) {
    const parsed = promotionInputSchema.parse(input);
    const product = this.product(parsed.productId);
    if (!product) throw new Error("Producto no disponible");
    const now = new Date().toISOString();
    const item: MonetizationPromotion = {
      ...parsed,
      id: randomUUID(),
      amountArs: product.priceArs,
      status: product.priceArs == null ? "in_review" : "pending_payment",
      paymentId: null,
      paymentUrl: null,
      createdAt: now,
      updatedAt: now,
      approvedAt: null,
      fulfilledAt: null,
      rejectionReason: null,
      featuredUntil: null,
    };
    await this.repository.create(item);
    if (product.priceArs != null && process.env.MERCADOPAGO_ACCESS_TOKEN) {
      const payment = await this.checkout.createPreference(item, product);
      return (await this.repository.update(item.id, { paymentId: payment.id, paymentUrl: payment.url }))!;
    }
    return item;
  }
  async update(id: string, input: unknown) {
    const patch = promotionPatchSchema.parse(input) as PromotionPatch;
    const now = new Date().toISOString();
    const values: Partial<MonetizationPromotion> = { ...patch };
    if (patch.status === "approved") values.approvedAt = now;
    if (patch.status === "fulfilled") values.fulfilledAt = now;
    if (patch.status === "rejected" && patch.rejectionReason === undefined)
      values.rejectionReason = "Rechazada por el equipo";
    const updated = await this.repository.update(id, values);
    if (!updated) throw new Error("Solicitud no encontrada");
    return updated;
  }
  async processPayment(paymentId: string) {
    const payment = await this.checkout.getPayment(paymentId);
    if (!payment.external_reference) throw new Error("El pago no tiene referencia externa");
    const status =
      payment.status === "approved"
        ? "paid"
        : ["rejected", "cancelled"].includes(payment.status ?? "")
          ? "rejected"
          : undefined;
    if (!status) return this.repository.get(payment.external_reference);
    return this.repository.update(payment.external_reference, { paymentId, status: status as MonetizationStatus });
  }
}

function loadProducts(): MonetizationProduct[] {
  const configured = process.env.MONETIZATION_PRODUCTS_JSON;
  if (!configured) return defaultMonetizationProducts;
  try {
    const parsed = JSON.parse(configured) as MonetizationProduct[];
    if (!Array.isArray(parsed) || !parsed.length) throw new Error("empty catalog");
    return parsed;
  } catch {
    throw new Error("MONETIZATION_PRODUCTS_JSON debe ser un JSON válido de productos");
  }
}
