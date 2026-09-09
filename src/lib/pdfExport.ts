import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type PdfExportProgress = {
  runId: string;
  done: number;
  total: number;
};

// Resolves to true if the PDF was written, false if the run was cancelled
// before it finished.
export async function exportImagesToPdf(
  runId: string,
  imagePaths: string[],
  outputPath: string,
  borderPx: number,
  onProgress?: (progress: PdfExportProgress) => void,
): Promise<boolean> {
  const unlisten = onProgress
    ? await listen<PdfExportProgress>("pdf-export-progress", (e) => {
        if (e.payload.runId === runId) onProgress(e.payload);
      })
    : undefined;
  try {
    return await invoke("export_images_to_pdf", {
      runId,
      imagePaths,
      outputPath,
      borderPx,
    });
  } finally {
    unlisten?.();
  }
}

export async function cancelPdfExport(runId: string): Promise<void> {
  await invoke("cancel_pdf_export", { runId });
}
