import { z } from "zod";

export const AgentSpecialtySchema = z.enum([
  "general",
  "ui",
  "business_logic",
  "api_crud"
]);

export type AgentSpecialty = z.infer<typeof AgentSpecialtySchema>;
