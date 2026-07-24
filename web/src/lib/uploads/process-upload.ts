import { elapsed, nowMs } from "@/lib/utils";
import { getConfig } from "@/lib/config";
import { extractPdfText } from "@/lib/extract/pdf";
import { extractPlainText } from "@/lib/extract/text";
import { addSource, getSourceDetail } from "@/lib/db/notebooks-repo";
import {
  findNotebookUpload,
  updateNotebookUpload,
} from "@/lib/db/notebook-uploads-repo";
import { downloadStorageObject } from "@/lib/storage/supabase-storage";
import { indexNotebookEmbeddings } from "@/lib/ir/index-embeddings";
import type { UploadStreamEvent } from "@/lib/ir/types";
import type { StatelessUpload } from "@/lib/uploads/upload-types";

export async function processNotebookUpload(
  notebookId: string,
  uploadId: string,
  emit: (event: UploadStreamEvent) => void,
) {
  const upload = await findNotebookUpload(notebookId, uploadId);
  if (!upload) throw new Error("Upload not found");
  if (upload.status === "completed") {
    throw new Error("Upload has already been processed");
  }
  if (upload.status !== "uploaded" && upload.status !== "failed") {
    throw new Error(`Upload is not ready for processing (${upload.status})`);
  }

  const totalStart = nowMs();
  emit({
    type: "upload_started",
    filename: upload.originalFilename,
    bytes: upload.byteSize,
  });
  let progressWrite = Promise.resolve();

  try {
    await updateNotebookUpload(notebookId, uploadId, {
      status: "extracting",
      stage: "extract",
      progress: 10,
      errorMessage: null,
    });

    const blob = await downloadStorageObject(upload.storageBucket, upload.storagePath);
    const buffer = Buffer.from(await blob.arrayBuffer());
    if (buffer.byteLength !== upload.byteSize) {
      throw new Error(
        `Uploaded object size mismatch (expected ${upload.byteSize}, received ${buffer.byteLength}).`,
      );
    }

    const extractStart = nowMs();
    const lower = upload.originalFilename.toLowerCase();
    let text =
      lower.endsWith(".pdf") || upload.mime === "application/pdf"
        ? await extractPdfText(buffer)
        : extractPlainText(upload.originalFilename, buffer, upload.mime);
    text = text.replace(/\u0000/g, "").trim();
    if (!text) throw new Error("No extractable text");
    const extractMs = elapsed(extractStart);
    emit({ type: "extract_completed", chars: text.length, ms: extractMs });

    await updateNotebookUpload(notebookId, uploadId, {
      status: "stored",
      stage: "store",
      progress: 25,
    });
    const existingSource = upload.sourceId
      ? await getSourceDetail(notebookId, upload.sourceId)
      : null;
    const source = existingSource
      ? {
          id: existingSource.id,
          title: existingSource.title,
          charCount: existingSource.charCount,
          timing: { storeMs: 0 },
        }
      : await addSource({
          notebookId,
          title: upload.originalFilename,
          mime: upload.mime,
          text,
        });
    if (!source) throw new Error("Stored source could not be loaded for retry");
    emit({
      type: "store_completed",
      sourceId: source.id,
      ms: source.timing.storeMs,
    });
    await updateNotebookUpload(notebookId, uploadId, {
      status: "chunking",
      stage: "chunk",
      progress: 30,
      sourceId: source.id,
    });

    // Progress events can arrive once per embedding batch. Persisting every
    // event creates a Supabase write burst and competes with index inserts.
    // Keep stage changes immediate, but throttle same-stage progress updates.
    let lastProgress = -1;
    let lastProgressKey = "";
    const updateProgress = (patch: Parameters<typeof updateNotebookUpload>[2]) => {
      const progress = patch.progress ?? lastProgress;
      const key = `${patch.status || ""}:${patch.stage || ""}`;
      const stageChanged = key !== lastProgressKey;
      const meaningful =
        stageChanged || progress >= 98 || progress - lastProgress >= 5;
      if (!meaningful) return;
      lastProgress = progress;
      lastProgressKey = key;
      progressWrite = progressWrite
        .then(() => updateNotebookUpload(notebookId, uploadId, patch))
        .then(() => undefined)
        .catch((err) => {
          console.warn(
            "[upload] progress update failed:",
            err instanceof Error ? err.message : err,
          );
        });
    };

    const indexResult = await indexNotebookEmbeddings(notebookId, {
      sourceIds: [source.id],
      onProgress: (event) => {
        if (event.type === "chunk_started") {
          updateProgress({
            status: "chunking",
            stage: "chunk",
            progress: 35,
          });
        } else if (event.type === "chunk_completed") {
          updateProgress({
            status: "embedding",
            stage: "embed",
            progress: 45,
          });
        } else if (event.type === "index_progress") {
          const progress = event.total > 0
            ? Math.min(95, 45 + Math.round((event.done / event.total) * 45))
            : 45;
          updateProgress({
            status: event.message.toLowerCase().includes("writing") ? "persisting" : "embedding",
            stage: event.message.toLowerCase().includes("writing") ? "persist" : "embed",
            progress,
          });
        } else if (event.type === "persist_completed") {
          updateProgress({
            status: "persisting",
            stage: "persist",
            progress: 98,
          });
        }
        emit(event);
      },
    });

    if (indexResult.status === "failed") {
      throw new Error(indexResult.message);
    }

    // Keep progress writes ordered so a late 98% update cannot overwrite the
    // terminal completed state.
    await progressWrite;

    const timing = {
      extractMs,
      storeMs: source.timing.storeMs,
      chunkMs: indexResult.chunkMs,
      embedMs: indexResult.embedMs,
      persistMs: indexResult.persistMs,
      totalMs: elapsed(totalStart),
    };
    await updateNotebookUpload(notebookId, uploadId, {
      status: "completed",
      stage: "complete",
      progress: 100,
      sourceId: source.id,
      completedAt: new Date().toISOString(),
    });
    emit({
      type: "upload_completed",
      source: {
        id: source.id,
        title: source.title,
        chunkCount: indexResult.unitCount,
        charCount: source.charCount,
        mode: indexResult.status === "ready" ? "indexed" : "raw-sources-only",
      },
      timing,
      metrics: {
        chunkCount: indexResult.unitCount,
        charCount: source.charCount,
        embeddedCount: indexResult.embeddedCount,
        mode: indexResult.status === "ready" ? "indexed" : "raw-sources-only",
        indexStatus: indexResult.status,
        storage: "supabase-postgres",
      },
    });
    return { status: "completed" as const, sourceId: source.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload processing failed";
    await progressWrite;
    await updateNotebookUpload(notebookId, uploadId, {
      status: "failed",
      stage: "complete",
      progress: 0,
      errorMessage: message,
    });
    emit({ type: "error", message });
    throw err;
  }
}

/**
 * Process a Storage upload without requiring notebook_uploads.
 * This is a compatibility path for deployments where migration 0006 has not
 * been applied yet; source persistence and retrieval indexing remain identical.
 */
export async function processStatelessNotebookUpload(
  notebookId: string,
  upload: StatelessUpload,
  emit: (event: UploadStreamEvent) => void,
) {
  const expectedPrefix = `notebooks/${notebookId}/uploads/${upload.uploadId}/`;
  const relativePath = upload.path.startsWith(expectedPrefix)
    ? upload.path.slice(expectedPrefix.length)
    : "";
  if (
    upload.bucket !== getConfig().storageBucket ||
    !relativePath ||
    relativePath.includes("/") ||
    relativePath.includes("..")
  ) {
    throw new Error("Invalid upload storage path");
  }

  const totalStart = nowMs();
  emit({ type: "upload_started", filename: upload.filename, bytes: upload.size });

  try {
    const blob = await downloadStorageObject(upload.bucket, upload.path);
    const buffer = Buffer.from(await blob.arrayBuffer());
    if (buffer.byteLength !== upload.size) {
      throw new Error(
        `Uploaded object size mismatch (expected ${upload.size}, received ${buffer.byteLength}).`,
      );
    }

    const extractStart = nowMs();
    const lower = upload.filename.toLowerCase();
    let text =
      lower.endsWith(".pdf") || upload.mime === "application/pdf"
        ? await extractPdfText(buffer)
        : extractPlainText(upload.filename, buffer, upload.mime || null);
    text = text.replace(/\u0000/g, "").trim();
    if (!text) throw new Error("No extractable text");
    const extractMs = elapsed(extractStart);
    emit({ type: "extract_completed", chars: text.length, ms: extractMs });

    const source = await addSource({
      notebookId,
      title: upload.filename,
      mime: upload.mime || null,
      text,
    });
    emit({
      type: "store_completed",
      sourceId: source.id,
      ms: source.timing.storeMs,
    });

    const indexResult = await indexNotebookEmbeddings(notebookId, {
      sourceIds: [source.id],
      onProgress: emit,
    });
    if (indexResult.status === "failed") {
      throw new Error(indexResult.message);
    }

    const timing = {
      extractMs,
      storeMs: source.timing.storeMs,
      chunkMs: indexResult.chunkMs,
      embedMs: indexResult.embedMs,
      persistMs: indexResult.persistMs,
      totalMs: elapsed(totalStart),
    };
    emit({
      type: "upload_completed",
      source: {
        id: source.id,
        title: source.title,
        chunkCount: indexResult.unitCount,
        charCount: source.charCount,
        mode: indexResult.status === "ready" ? "indexed" : "raw-sources-only",
      },
      timing,
      metrics: {
        chunkCount: indexResult.unitCount,
        charCount: source.charCount,
        embeddedCount: indexResult.embeddedCount,
        mode: indexResult.status === "ready" ? "indexed" : "raw-sources-only",
        indexStatus: indexResult.status,
        storage: "supabase-postgres",
      },
    });
    return { status: "completed" as const, sourceId: source.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload processing failed";
    emit({ type: "error", message });
    throw err;
  }
}
