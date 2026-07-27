export const BASE_PROFILE = {
  schema_version: "4.1",
  target_model: "higgsfield_2.0",
  generation_mode: "text_to_image",
  prompt_language: "English",
  runtime_reference_images: false,
  profile_id: "dynamic_influencer_profile",
  subject_profile: {
    presentation: "Korean adult in their twenties",
    strength: 1.65,
    variable_identity: true,
    variable_face: true,
    variable_hairstyle: true,
    variable_outfit: true,
    nationality_and_style_direction: "Korean fitness and lifestyle influencer",
    physique: "well-trained athletic body with balanced natural proportions",
    appearance: "polished contemporary Korean social-media influencer appearance",
  },
  weight_system: {
    concept_strength_range: "0.0-2.0",
    instructions:
      "Use the master_prompt as the text prompt. Higher component strength means stronger influence.",
  },
  visual_weights: { environment: 40, pose_action: 25, composition: 25, naturalism: 10 },
  weighted_prompt_components: [
    { role: "subject", text: "", strength: 1.65 },
    { role: "environment", text: "", strength: 1.7 },
    { role: "pose_action", text: "", strength: 2 },
    { role: "composition", text: "", strength: 1.6 },
    { role: "naturalism", text: "", strength: 2 },
    {
      role: "text_suppression",
      text:
        "No visible writing, letters, words, numbers, captions, subtitles, logos, brand names, watermarks, signatures, interface overlays or typographic graphics anywhere.",
      strength: 2,
    },
  ],
  master_prompt: "",
  negative_prompt: [
    "split screen",
    "collage",
    "diptych",
    "triptych",
    "multiple panels",
    "duplicated person",
    "multiple people",
    "visible text",
    "letters",
    "words",
    "numbers",
    "captions",
    "logos",
    "watermark",
    "interface overlay",
    "social media UI",
    "impossible anatomy",
    "extra limbs or fingers",
    "distorted hands",
    "professional studio campaign",
    "rigid catalog posing",
  ],
  intentionally_unspecified: [
    "specific identity",
    "specific hairstyle",
    "specific outfit",
    "lighting design",
    "color grading",
  ],
  artifact_controls: {
    visible_text_suppression: {
      enabled: true,
      strength: 2,
      requirement: "No readable or decorative text may appear anywhere in the generated image.",
    },
  },
} as const;

export type InfluencerProfile = {
  [K in keyof typeof BASE_PROFILE]: (typeof BASE_PROFILE)[K] extends readonly unknown[]
    ? unknown[]
    : (typeof BASE_PROFILE)[K];
};
