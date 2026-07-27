import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { bindings } from "@/lib/bindings.server";
import { requireCurrentUser } from "@/lib/auth.server";

export const savePreferences = createServerFn({ method: "POST" })
  .validator(
    z.object({
      mode: z.enum(["influencer", "horizon"]),
      gender: z.enum(["male", "female"]),
      environment: z.string().max(160),
      scene: z.string().max(200),
      aspectRatio: z.string().max(12),
      imageType: z.string().max(80),
    }),
  )
  .handler(async ({ data }) => {
    const auth = await requireCurrentUser();
    if (!auth.ok || !auth.user.id) return { ok: false as const };
    const db = bindings().DB;
    if (!db) return { ok: true as const };
    await db
      .prepare(
        `INSERT INTO user_preferences
          (user_id, mode, gender, environment, scene, aspect_ratio, image_type, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
          mode = excluded.mode,
          gender = excluded.gender,
          environment = excluded.environment,
          scene = excluded.scene,
          aspect_ratio = excluded.aspect_ratio,
          image_type = excluded.image_type,
          updated_at = CURRENT_TIMESTAMP`,
      )
      .bind(
        auth.user.id,
        data.mode,
        data.gender,
        data.environment,
        data.scene,
        data.aspectRatio,
        data.imageType,
      )
      .run();
    return { ok: true as const };
  });
