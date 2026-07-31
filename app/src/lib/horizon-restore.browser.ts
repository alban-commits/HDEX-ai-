import type { Psd } from "ag-psd";

export type HorizonLayeredPsdSource = {
  originalUrl: string;
  generatedUrl: string;
  filename: string;
};

export function horizonLayeredPsdFilename(value: string): string {
  const base = value
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[<>:"/\\|?*]/g, "-")
    .split("")
    .map((character) => character.charCodeAt(0) < 32 ? "-" : character)
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || "horizon-result"}-원본+생성본.psd`;
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function decodeImage(url: string): Promise<ImageBitmap> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`layered_psd_image_fetch_failed_${response.status}`);
  const blob = await response.blob();
  return createImageBitmap(blob, { imageOrientation: "from-image" });
}

function drawCover(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
) {
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const scaledWidth = sourceWidth * scale;
  const scaledHeight = sourceHeight * scale;
  context.drawImage(
    source,
    (width - scaledWidth) / 2,
    (height - scaledHeight) / 2,
    scaledWidth,
    scaledHeight,
  );
}

export async function createHorizonLayeredPsdBytes(
  originalUrl: string,
  generatedUrl: string,
): Promise<ArrayBuffer> {
  const [originalBitmap, generatedBitmap] = await Promise.all([
    decodeImage(originalUrl),
    decodeImage(generatedUrl),
  ]);
  try {
    const width = generatedBitmap.width;
    const height = generatedBitmap.height;
    if (!width || !height) throw new Error("layered_psd_image_dimensions_invalid");

    const original = createCanvas(width, height);
    const generated = createCanvas(width, height);
    const originalContext = original.getContext("2d");
    const generatedContext = generated.getContext("2d");
    if (!originalContext || !generatedContext) throw new Error("layered_psd_canvas_unavailable");

    drawCover(
      originalContext,
      originalBitmap,
      originalBitmap.width,
      originalBitmap.height,
      width,
      height,
    );
    generatedContext.drawImage(generatedBitmap, 0, 0, width, height);

    const psd: Psd = {
      width,
      height,
      canvas: generated,
      children: [
        {
          name: "02_AI 의상 생성본",
          canvas: generated,
        },
        {
          name: "01_원본 모델",
          canvas: original,
        },
      ],
      imageResources: {
        resolutionInfo: {
          horizontalResolution: 72,
          horizontalResolutionUnit: "PPI",
          widthUnit: "Inches",
          verticalResolution: 72,
          verticalResolutionUnit: "PPI",
          heightUnit: "Inches",
        },
      },
    };
    const { writePsd } = await import("ag-psd");
    return writePsd(psd, {
      compress: true,
      generateThumbnail: true,
      noBackground: true,
    });
  } finally {
    originalBitmap.close();
    generatedBitmap.close();
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadHorizonLayeredPsd({
  originalUrl,
  generatedUrl,
  filename,
}: HorizonLayeredPsdSource): Promise<void> {
  const bytes = await createHorizonLayeredPsdBytes(originalUrl, generatedUrl);
  downloadBlob(
    new Blob([bytes], { type: "image/vnd.adobe.photoshop" }),
    horizonLayeredPsdFilename(filename),
  );
}
