import { z } from "zod";

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export const blockedSenderSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine((value) => {
    if (value.startsWith("@")) return domainPattern.test(value.slice(1));
    if (value.includes("@")) return z.email().safeParse(value).success;
    return false;
  }, "Usá un email exacto o un dominio con @, por ejemplo @ejemplo.com");

export const blockedSendersSchema = z.array(blockedSenderSchema).max(200).transform((entries) => [...new Set(entries)]);
export type BlockedSender = z.infer<typeof blockedSenderSchema>;

export const senderMatchesBlacklist = (sender: string, entries: readonly string[]): boolean => {
  const match = sender.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}/i);
  const email = match?.[0]?.toLowerCase();
  if (!email) return false;
  const domain = email.slice(email.lastIndexOf("@") + 1);
  return entries.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    if (normalized.startsWith("@")) {
      const blockedDomain = normalized.slice(1);
      return domain === blockedDomain || domain.endsWith(`.${blockedDomain}`);
    }
    return email === normalized;
  });
};
