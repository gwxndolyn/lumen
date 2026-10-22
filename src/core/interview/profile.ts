/**
 * Interview profile sections. Each is stored as a global knowledge document tagged
 * `profile:<section>`, so it is retrieved by the normal (BM25, budgeted, cited) pipeline and is
 * removable like any other document.
 */
export const PROFILE_SECTIONS = {
  resume: "Résumé",
  experience: "Work experience",
  projects: "Projects",
  skills: "Technical skills",
  accomplishments: "Accomplishments",
  challenges: "Past challenges (for behavioral answers)",
  target: "Target role & company",
  style: "Preferred answer style",
} as const;

export type ProfileSection = keyof typeof PROFILE_SECTIONS;
