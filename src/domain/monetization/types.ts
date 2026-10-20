import { z } from "zod";

export const monetizationStatuses = [
  "pending_payment",
  "paid",
  "in_review",
  "approved",
  "rejected",
  "fulfilled",
  "cancelled",
] as const;
export type MonetizationStatus = (typeof monetizationStatuses)[number];

export type MonetizationProduct = {
  id: string;
  name: string;
  description: string;
  delivery: string;
  priceArs: number | null;
  active: boolean;
  featuredDays?: number;
};

export const defaultMonetizationProducts: MonetizationProduct[] = [
  {
    id: "evento-destacado",
    name: "Evento destacado",
    description: "Publicación en la agenda con posición destacada.",
    delivery: "Hasta 48 h",
    priceArs: 12000,
    active: true,
    featuredDays: 7,
  },
  {
    id: "publicacion-promocionada",
    name: "Publicación promocionada",
    description: "Nota breve con descripción, fotos, links y difusión. No es una reseña editorial.",
    delivery: "Hasta 5 días hábiles",
    priceArs: 18000,
    active: true,
  },
  {
    id: "lanzamiento-musical",
    name: "Lanzamiento musical",
    description: "Difusión de single, videoclip, EP, álbum o nueva fecha.",
    delivery: "Hasta 72 h",
    priceArs: 15000,
    active: true,
  },
  {
    id: "pack-difusion",
    name: "Pack difusión",
    description: "Publicación web, agenda y piezas para redes.",
    delivery: "Hasta 7 días hábiles",
    priceArs: 30000,
    active: true,
  },
  {
    id: "press-kit-express",
    name: "Press kit express",
    description: "Biografía, presentación, links, contacto y material visual.",
    delivery: "Hasta 7 días hábiles",
    priceArs: 22000,
    active: true,
  },
  {
    id: "aviso-clasificado",
    name: "Aviso clasificado",
    description: "Buscá músicos, fotógrafos, videógrafos, diseñadores, salas o colaboradores.",
    delivery: "A coordinar",
    priceArs: 8000,
    active: true,
  },
  {
    id: "cobertura-foto-video",
    name: "Cobertura foto/video",
    description: "Solicitud de presupuesto y disponibilidad para tu evento.",
    delivery: "Respuesta en 48 h",
    priceArs: null,
    active: true,
  },
  {
    id: "contenido-para-redes",
    name: "Contenido para redes",
    description: "Reels, fotos, placas o piezas para promocionar un evento.",
    delivery: "A coordinar",
    priceArs: null,
    active: true,
  },
  {
    id: "pasarela-entradas",
    name: "Pasarela de venta de entradas",
    description: "Consultá por una solución para centralizar la venta y el acceso a tu fecha.",
    delivery: "A coordinar",
    priceArs: null,
    active: true,
  },
  {
    id: "promocion-festivales",
    name: "Promoción para festivales",
    description: "Campaña de difusión para que tu festival llegue a más gente y se mueva por la escena.",
    delivery: "A coordinar",
    priceArs: null,
    active: true,
  },
  {
    id: "organizacion-festivales",
    name: "Creación y organización de festivales",
    description: "Pensamos y coordinamos tu festival: propuesta, agenda, comunicación y operación.",
    delivery: "A coordinar",
    priceArs: null,
    active: true,
  },
  {
    id: "publicidad-viajes-conciertos",
    name: "Publicidad para viajes a conciertos",
    description: "Espacio publicitario para promocionar viajes organizados a conciertos y festivales.",
    delivery: "A coordinar",
    priceArs: null,
    active: true,
  },
  {
    id: "tienda-merch",
    name: "Tienda de merch",
    description: "Propuesta de tienda online para vender merch de bandas, fechas y festivales.",
    delivery: "A coordinar",
    priceArs: null,
    active: true,
  },
];

export const promotionInputSchema = z.object({
  productId: z.string().min(1).max(80),
  customerName: z.string().trim().min(2).max(160),
  customerEmail: z.string().trim().email().max(180),
  organization: z.string().trim().max(180).default(""),
  title: z.string().trim().min(2).max(180),
  description: z.string().trim().min(10).max(5000),
  eventDate: z.string().max(40).default(""),
  city: z.string().trim().max(120).default(""),
  instagram: z.string().trim().max(180).default(""),
  website: z.string().trim().max(500).default(""),
  mediaUrls: z.array(z.string().url().max(1000)).max(20).default([]),
  contactPreference: z.enum(["email", "whatsapp", "instagram"]).default("email"),
  notes: z.string().max(3000).default(""),
});
export type PromotionInput = z.infer<typeof promotionInputSchema>;

export type MonetizationPromotion = PromotionInput & {
  id: string;
  amountArs: number | null;
  status: MonetizationStatus;
  paymentId: string | null;
  paymentUrl: string | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  fulfilledAt: string | null;
  rejectionReason: string | null;
  featuredUntil: string | null;
};

export const promotionPatchSchema = z.object({
  status: z.enum(monetizationStatuses).optional(),
  rejectionReason: z.string().max(2000).nullable().optional(),
  featuredUntil: z.string().datetime().nullable().optional(),
});
export type PromotionPatch = z.infer<typeof promotionPatchSchema>;
