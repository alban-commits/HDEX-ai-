import type { Psd } from "ag-psd";

export type HorizonRestoreView = "composite" | "original" | "generated";
export type HorizonRestoreBrushMode = "restore" | "erase";

export type HorizonRestoreWorkspace = {
  width: number;
  height: number;
  original: HTMLCanvasElement;
  generated: HTMLCanvasElement;
  mask: HTMLCanvasElement;
  composite: HTMLCanvasElement;
};

export type HorizonRestorePoint = {
  x: number;
  y: number;
};

export function horizonRestoreFaceBounds(width: number, height: number) {
  return {
    x: Math.round(width * 0.35),
    y: Math.round(height * 0.015),
    width: Math.round(width * 0.3),
    height: Math.round(height * 0.23),
  };
}

export function horizonRestoreCanvasPoint(
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  canvasWidth: number,
  canvasHeight: number,
): HorizonRestorePoint {
  return {
    x: Math.max(0, Math.min(canvasWidth, ((clientX - bounds.left) / bounds.width) * canvasWidth)),
    y: Math.max(0, Math.min(canvasHeight, ((clientY - bounds.top) / bounds.height) * canvasHeight)),
  };
}

export function horizonRestoreFilename(value: string, extension: "png" | "psd"): string {
  const base = value
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[<>:"/\\|?*]/g, "-")
    .split("")
    .map((character) => character.charCodeAt(0) < 32 ? "-" : character)
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || "horizon-result"}-원본복원.${extension}`;
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function decodeImage(url: string): Promise<ImageBitmap> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`restore_image_fetch_failed_${response.status}`);
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

export async function createHorizonRestoreWorkspace(
  originalUrl: string,
  generatedUrl: string,
): Promise<HorizonRestoreWorkspace> {
  const [originalBitmap, generatedBitmap] = await Promise.all([
    decodeImage(originalUrl),
    decodeImage(generatedUrl),
  ]);
  try {
    const width = generatedBitmap.width;
    const height = generatedBitmap.height;
    if (!width || !height) throw new Error("restore_image_dimensions_invalid");

    const original = createCanvas(width, height);
    const generated = createCanvas(width, height);
    const mask = createCanvas(width, height);
    const composite = createCanvas(width, height);
    const originalContext = original.getContext("2d");
    const generatedContext = generated.getContext("2d");
    if (!originalContext || !generatedContext) throw new Error("restore_canvas_unavailable");

    drawCover(
      originalContext,
      originalBitmap,
      originalBitmap.width,
      originalBitmap.height,
      width,
      height,
    );
    generatedContext.drawImage(generatedBitmap, 0, 0, width, height);
    const workspace = { width, height, original, generated, mask, composite };
    applyHorizonRestoreFacePreset(workspace);
    return workspace;
  } finally {
    originalBitmap.close();
    generatedBitmap.close();
  }
}

export function clearHorizonRestoreMask(workspace: HorizonRestoreWorkspace): void {
  workspace.mask.getContext("2d")?.clearRect(0, 0, workspace.width, workspace.height);
  renderHorizonRestoreComposite(workspace);
}

export function applyHorizonRestoreFacePreset(workspace: HorizonRestoreWorkspace): void {
  const context = workspace.mask.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, workspace.width, workspace.height);
  const bounds = horizonRestoreFaceBounds(workspace.width, workspace.height);
  context.fillStyle = "#fff";
  context.beginPath();
  context.ellipse(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
    bounds.width / 2,
    bounds.height / 2,
    0,
    0,
    Math.PI * 2,
  );
  context.fill();
  renderHorizonRestoreComposite(workspace);
}

export function paintHorizonRestoreMask(
  workspace: HorizonRestoreWorkspace,
  point: HorizonRestorePoint,
  radius: number,
  mode: HorizonRestoreBrushMode,
  previousPoint?: HorizonRestorePoint,
): void {
  const context = workspace.mask.getContext("2d");
  if (!context) return;
  context.save();
  context.globalCompositeOperation = mode === "restore" ? "source-over" : "destination-out";
  context.fillStyle = "#fff";
  context.strokeStyle = "#fff";
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = Math.max(2, radius * 2);
  if (previousPoint) {
    context.beginPath();
    context.moveTo(previousPoint.x, previousPoint.y);
    context.lineTo(point.x, point.y);
    context.stroke();
  }
  context.beginPath();
  context.arc(point.x, point.y, Math.max(1, radius), 0, Math.PI * 2);
  context.fill();
  context.restore();
  renderHorizonRestoreComposite(workspace);
}

export function renderHorizonRestoreComposite(workspace: HorizonRestoreWorkspace): HTMLCanvasElement {
  const output = workspace.composite.getContext("2d");
  if (!output) return workspace.composite;
  const restored = createCanvas(workspace.width, workspace.height);
  const restoredContext = restored.getContext("2d");
  if (!restoredContext) return workspace.composite;

  restoredContext.drawImage(workspace.original, 0, 0);
  restoredContext.globalCompositeOperation = "destination-in";
  restoredContext.drawImage(workspace.mask, 0, 0);

  output.clearRect(0, 0, workspace.width, workspace.height);
  output.drawImage(workspace.generated, 0, 0);
  output.drawImage(restored, 0, 0);
  return workspace.composite;
}

export function drawHorizonRestorePreview(
  workspace: HorizonRestoreWorkspace,
  target: HTMLCanvasElement,
  view: HorizonRestoreView,
): void {
  target.width = workspace.width;
  target.height = workspace.height;
  const context = target.getContext("2d");
  if (!context) return;
  const source =
    view === "original"
      ? workspace.original
      : view === "generated"
        ? workspace.generated
        : renderHorizonRestoreComposite(workspace);
  context.clearRect(0, 0, workspace.width, workspace.height);
  context.drawImage(source, 0, 0);
}

function opaqueMaskCanvas(workspace: HorizonRestoreWorkspace): HTMLCanvasElement {
  const result = createCanvas(workspace.width, workspace.height);
  const resultContext = result.getContext("2d", { willReadFrequently: true });
  const sourceContext = workspace.mask.getContext("2d", { willReadFrequently: true });
  if (!resultContext || !sourceContext) return result;
  const source = sourceContext.getImageData(0, 0, workspace.width, workspace.height);
  const output = resultContext.createImageData(workspace.width, workspace.height);
  for (let index = 0; index < source.data.length; index += 4) {
    const value = source.data[index + 3] ?? 0;
    output.data[index] = value;
    output.data[index + 1] = value;
    output.data[index + 2] = value;
    output.data[index + 3] = 255;
  }
  resultContext.putImageData(output, 0, 0);
  return result;
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

function canvasBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("restore_export_failed"));
    }, type);
  });
}

export async function downloadHorizonRestorePng(
  workspace: HorizonRestoreWorkspace,
  sourceName: string,
): Promise<void> {
  const blob = await canvasBlob(renderHorizonRestoreComposite(workspace), "image/png");
  downloadBlob(blob, horizonRestoreFilename(sourceName, "png"));
}

export async function createHorizonRestorePsdBytes(
  workspace: HorizonRestoreWorkspace,
): Promise<ArrayBuffer> {
  const { writePsd } = await import("ag-psd");
  const psd: Psd = {
    width: workspace.width,
    height: workspace.height,
    canvas: renderHorizonRestoreComposite(workspace),
    children: [
      {
        name: "02_원본 얼굴·몸 복원",
        canvas: workspace.original,
        mask: {
          canvas: opaqueMaskCanvas(workspace),
          defaultColor: 0,
          fromVectorData: false,
          userMaskFeather: 2,
        },
      },
      {
        name: "01_AI 의상 결과",
        canvas: workspace.generated,
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
  const bytes = writePsd(psd, {
    compress: true,
    generateThumbnail: true,
    noBackground: true,
  });
  return bytes;
}

export async function downloadHorizonRestorePsd(
  workspace: HorizonRestoreWorkspace,
  sourceName: string,
): Promise<void> {
  const bytes = await createHorizonRestorePsdBytes(workspace);
  downloadBlob(
    new Blob([bytes], { type: "image/vnd.adobe.photoshop" }),
    horizonRestoreFilename(sourceName, "psd"),
  );
}
