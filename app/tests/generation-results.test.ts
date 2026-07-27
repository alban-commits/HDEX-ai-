import { describe, expect, test } from "bun:test";
import type { Generation } from "@higgsfield/fnf/client";
import {
  generationToAssetItem,
  generationToGalleryItem,
  mediaRefToAssetItem,
} from "../src/lib/higgsfield-generation-results";

describe("generation gallery mapping", () => {
  test("uses a video element instead of treating a thumbnail-less video as an image", () => {
    const item = generationToGalleryItem({
      id: "video-1",
      model: "seedance_2_0",
      type: "video",
      status: "completed",
      input: { model: "seedance_2_0", settings: { aspectRatio: "16:9" } },
      results: { rawUrl: "https://cdn.example/video.mp4" },
    } satisfies Generation);

    expect(item).toMatchObject({ src: "", videoSrc: "https://cdn.example/video.mp4" });
  });

  test("keeps terminal failures visible in history", () => {
    const item = generationToGalleryItem({
      id: "failed-1",
      model: "seedance_2_0",
      type: "video",
      status: "failed",
      failReason: "Safety check failed",
      input: { model: "seedance_2_0", settings: { aspectRatio: "9:16" } },
      results: {},
    } satisfies Generation);

    expect(item).toMatchObject({
      id: "failed-1",
      status: "failed",
      failureLabel: "Safety check failed",
      width: 9,
      height: 16,
    });
  });

  test("uses the generated image dimensions instead of cropping previews to the setting ratio", () => {
    const item = generationToGalleryItem({
      id: "image-1",
      model: "seedream_v4_5",
      type: "image",
      status: "completed",
      input: {
        model: "seedream_v4_5",
        settings: { aspectRatio: "3:4" },
        extra: { width: 1920, height: 1080 },
      },
      results: { rawUrl: "https://cdn.example/image.png" },
    } satisfies Generation);

    expect(item).toMatchObject({ width: 1920, height: 1080 });
  });

  test("maps persisted media refs into the Uploads tab", () => {
    expect(
      mediaRefToAssetItem({ id: "media-123456789", type: "image", url: "https://cdn/x.png" }),
    ).toMatchObject({
      name: "Upload media-12",
      kind: "upload",
      src: "https://cdn/x.png",
      ref: { id: "media-123456789", type: "media_input" },
    });
  });

  test("maps generated media to reusable job references", () => {
    const image = generationToAssetItem({
      id: "97cf1fec-77a9-4627-a3d4-23a09ea8aaa4",
      model: "nano_banana_2",
      type: "image",
      status: "completed",
      input: { model: "nano_banana_2", settings: {} },
      results: {
        rawUrl: "https://cdn.example/image.png",
        minUrl: "https://cdn.example/image-preview.webp",
      },
    } satisfies Generation);
    const video = generationToAssetItem({
      id: "51aef560-9cf8-4edb-89e3-500c789f987d",
      model: "seedance_2_0",
      type: "video",
      status: "completed",
      input: { model: "seedance_2_0", settings: {} },
      results: {
        rawUrl: "https://cdn.example/video.mp4",
        thumbnailUrl: "https://cdn.example/video-poster.webp",
      },
    } satisfies Generation);

    expect(image).toMatchObject({
      src: "https://cdn.example/image-preview.webp",
      ref: {
        id: "97cf1fec-77a9-4627-a3d4-23a09ea8aaa4",
        type: "image_job",
        url: "https://cdn.example/image.png",
      },
    });
    expect(video).toMatchObject({
      src: "https://cdn.example/video-poster.webp",
      ref: {
        id: "51aef560-9cf8-4edb-89e3-500c789f987d",
        type: "video_job",
        url: "https://cdn.example/video.mp4",
      },
    });
  });
});
