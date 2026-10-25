import { z } from "zod";

const routeAddress = z.string().trim().toLowerCase().email().max(180);

export const mailRouteKindSchema = z.enum(["personal", "distribution"]);
export const mailRouteInputSchema = z.object({
  address: routeAddress,
  label: z.string().trim().min(1).max(80),
  kind: mailRouteKindSchema,
  destinations: z.array(routeAddress).min(1).max(50),
});
export const mailRoutePatchSchema = mailRouteInputSchema.omit({ address: true }).partial();

export type MailRouteKind = z.infer<typeof mailRouteKindSchema>;
export type MailRouteInput = z.infer<typeof mailRouteInputSchema>;
export type MailRoutePatch = z.infer<typeof mailRoutePatchSchema>;
export type MailRoute = MailRouteInput & { id: string };

export const defaultMailRoutes: MailRouteInput[] = [
  {
    address: "comunicaciones@afterstage.ar",
    label: "Comunicaciones",
    kind: "distribution",
    destinations: ["fede.markoo@gmail.com", "carlajmagnol@gmail.com", "nfalconaro5@gmail.com"],
  },
  {
    address: "prensa@afterstage.ar",
    label: "Prensa",
    kind: "distribution",
    destinations: ["fede.markoo@gmail.com", "carlajmagnol@gmail.com"],
  },
  {
    address: "federico.markowicz@afterstage.ar",
    label: "Federico Markowicz",
    kind: "personal",
    destinations: ["fede.markoo@gmail.com"],
  },
  {
    address: "carla.magnol@afterstage.ar",
    label: "Carla Magnol",
    kind: "personal",
    destinations: ["carlajmagnol@gmail.com"],
  },
  {
    address: "nahuel.falconaro@afterstage.ar",
    label: "Nahuel Falconaro",
    kind: "personal",
    destinations: ["nfalconaro5@gmail.com"],
  },
];

export const normalizeRouteAddress = (address: string) => address.trim().toLowerCase();
