import { z } from "zod";

export const latitude = z.number().finite().min(-90).max(90).nullable().default(null);
export const longitude = z.number().finite().min(-180).max(180).nullable().default(null);
export const locationFields = {
  country: z.string().max(120).default("Argentina"),
  latitude,
  longitude,
};

export const distanceKm = (fromLat: number, fromLng: number, toLat: number, toLng: number): number => {
  const radians = (value: number) => (value * Math.PI) / 180;
  const dLat = radians(toLat - fromLat);
  const dLng = radians(toLng - fromLng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(fromLat)) * Math.cos(radians(toLat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

export const distanceQuery = z.object({
  lat: z.coerce.number().finite().min(-90).max(90),
  lng: z.coerce.number().finite().min(-180).max(180),
  radiusKm: z.coerce.number().finite().positive().max(20000).default(50),
});
