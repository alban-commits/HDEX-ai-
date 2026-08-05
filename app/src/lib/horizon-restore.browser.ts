import type { Psd } from "ag-psd";

export type HorizonImageSource = string | Blob;

export type HorizonPngPsdArtifacts = {
  png: Blob;
  psd: Blob;
  pngFilename: string;
  psdFilename: string;
};

export type HorizonPngPsdSource = {
  original: HorizonImageSource;
  generated: HorizonImageSource;
  filename: string;
};

function safeOutputBase(value: string): string {
  return value
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[<>:"/\\|?*]/g, "-")
    .split("")
    .map((character) => character.charCodeAt(0) < 32 ? "-" : character)
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "horizon-result";
}

export function horizonPngPsdFilenames(value: string): { png: string; psd: string } {
  const base = safeOutputBase(value);
  return { png: `${base}.png`, psd: `${base}.psd` };
}

export function horizonLayeredPsdFilename(value: string): string {
  return horizonPngPsdFilenames(value).psd;
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function sourceBlob(source: HorizonImageSource): Promise<Blob> {
  if (source instanceof Blob) return source;
  const response = await fetch(source, { credentials: "include" });
  if (!response.ok) throw new Error(`horizon_output_fetch_failed_${response.status}`);
  const blob = await response.blob();
  if (!blob.type.toLowerCase().startsWith("image/")) throw new Error("horizon_output_type_invalid");
  return blob;
}

async function decodeImage(source: HorizonImageSource): Promise<ImageBitmap> {
  return createImageBitmap(await sourceBlob(source), { imageOrientation: "from-image" });
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

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("horizon_png_encode_failed"));
    }, "image/png");
  });
}

export async function createHorizonPngPsdArtifacts({
  original,
  generated,
  filename,
}: HorizonPngPsdSource): Promise<HorizonPngPsdArtifacts> {
  const [originalBitmap, generatedBitmap] = await Promise.all([
    decodeImage(original),
    decodeImage(generated),
  ]);
  try {
    const width = generatedBitmap.width;
    const height = generatedBitmap.height;
    if (!width || !height) throw new Error("horizon_output_dimensions_invalid");

    const originalCanvas = createCanvas(width, height);
    const generatedCanvas = createCanvas(width, height);
    const originalContext = originalCanvas.getContext("2d");
    const generatedContext = generatedCanvas.getContext("2d");
    if (!originalContext || !generatedContext) throw new Error("horizon_output_canvas_unavailable");

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
      canvas: generatedCanvas,
      children: [
        { name: "02_AI 의상 생성본", canvas: generatedCanvas },
        { name: "01_원본 모델", canvas: originalCanvas },
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
    const [{ writePsd }, png] = await Promise.all([
      import("ag-psd"),
      canvasPng(generatedCanvas),
    ]);
    const psdBytes = writePsd(psd, {
      compress: true,
      generateThumbnail: true,
      noBackground: true,
    });
    const names = horizonPngPsdFilenames(filename);
    return {
      png,
      psd: new Blob([psdBytes], { type: "image/vnd.adobe.photoshop" }),
      pngFilename: names.png,
      psdFilename: names.psd,
    };
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
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function downloadHorizonPngPsdArtifacts(artifacts: HorizonPngPsdArtifacts): void {
  downloadBlob(artifacts.png, artifacts.pngFilename);
  downloadBlob(artifacts.psd, artifacts.psdFilename);
}

export async function downloadHorizonPngAndLayeredPsd(input: HorizonPngPsdSource): Promise<void> {
  downloadHorizonPngPsdArtifacts(await createHorizonPngPsdArtifacts(input));
}
