import { randomUUID } from "crypto";
import { existsSync, unlinkSync, promises as fs } from "fs";
import os from "os";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { GoogleGenerativeAI } from "@google/generative-ai";

if (!ffmpegPath) {
  throw new Error("ffmpeg-static did not provide a binary path.");
}

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobe.path);

const MAX_SEGMENT_SECONDS = 15 * 60;
const TRANSCRIPTION_MIME_TYPE = "audio/mpeg";
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

// Models to fall back to (in order) if the primary model keeps returning 503s.
const FALLBACK_GEMINI_MODELS = ["gemini-2.0-flash", "gemini-1.5-flash"];

// Exponential backoff delays between retries of the same model.
const RETRY_DELAYS_MS = [2000, 4000, 8000];

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".flac",
  ".ogg",
  ".opus",
  ".amr",
  ".aiff",
  ".wma",
  ".webm",
]);

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".mpeg",
  ".mpg",
  ".m4v",
  ".3gp",
  ".ogv",
  ".webm",
]);

const AUDIO_MIME_PREFIXES = ["audio/"];
const VIDEO_MIME_PREFIXES = ["video/"];

type MediaKind = "audio" | "video";
type MediaHint = MediaKind | "ambiguous";

export class ValidationError extends Error {}

export type ProgressCallback = (status: {
  step: string;
  percent?: number;
}) => void;

type FfprobeResult = {
  format?: {
    duration?: number;
  };
  streams?: Array<{
    codec_type?: string;
  }>;
};

function isMimeMatch(type: string, prefixes: string[]) {
  return prefixes.some((prefix) => type.startsWith(prefix));
}

function getExtensionHint(fileName: string): MediaHint | null {
  const extension = path.extname(fileName).toLowerCase();

  if (AUDIO_EXTENSIONS.has(extension) && VIDEO_EXTENSIONS.has(extension)) {
    return "ambiguous";
  }

  if (AUDIO_EXTENSIONS.has(extension)) {
    return "audio";
  }

  if (VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }

  return null;
}

function getMimeHint(mimeType: string): MediaHint | null {
  if (!mimeType) {
    return null;
  }

  if (isMimeMatch(mimeType, AUDIO_MIME_PREFIXES)) {
    return "audio";
  }

  if (isMimeMatch(mimeType, VIDEO_MIME_PREFIXES)) {
    return "video";
  }

  return null;
}

function isAllowedUpload(fileName: string, mimeType: string) {
  const extensionHint = getExtensionHint(fileName);
  const mimeHint = getMimeHint(mimeType);

  if (!extensionHint && !mimeHint) {
    return false;
  }

  if (
    extensionHint &&
    mimeHint &&
    extensionHint !== "ambiguous" &&
    mimeHint !== "ambiguous" &&
    extensionHint !== mimeHint
  ) {
    throw new ValidationError(
      "The uploaded file extension does not match its media type.",
    );
  }

  return true;
}

function probe(filePath: string) {
  return new Promise<FfprobeResult>((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (error, metadata) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(metadata as FfprobeResult);
    });
  });
}

function runFfmpeg(command: ffmpeg.FfmpegCommand) {
  return new Promise<void>((resolve, reject) => {
    command.on("end", () => resolve()).on("error", reject).run();
  });
}

async function detectMediaKind(filePath: string) {
  const metadata = await probe(filePath);
  const streams = metadata.streams ?? [];
  const hasAudio = streams.some((stream) => stream.codec_type === "audio");
  const hasVideo = streams.some((stream) => stream.codec_type === "video");

  if (hasVideo) {
    if (!hasAudio) {
      throw new ValidationError("The uploaded video does not contain an audio track.");
    }

    return "video" as const;
  }

  if (hasAudio) {
    return "audio" as const;
  }

  throw new ValidationError(
    "The uploaded file does not contain a valid audio or video stream.",
  );
}

async function createTranscriptionAudio(
  sourcePath: string,
  destinationPath: string,
) {
  await runFfmpeg(
    ffmpeg(sourcePath)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioChannels(1)
      .audioFrequency(16000)
      .format("mp3")
      .output(destinationPath),
  );
}

async function getAudioDurationSeconds(filePath: string) {
  const metadata = await probe(filePath);
  const duration = Number(metadata.format?.duration);

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Unable to determine the uploaded audio duration.");
  }

  return duration;
}

async function splitAudio(audioPath: string, tempDirectory: string, duration: number) {
  const segments: string[] = [];

  for (
    let startSeconds = 0, segmentIndex = 0;
    startSeconds < duration;
    startSeconds += MAX_SEGMENT_SECONDS, segmentIndex += 1
  ) {
    const segmentPath = path.join(
      tempDirectory,
      `segment-${segmentIndex}-${randomUUID()}.mp3`,
    );

    await runFfmpeg(
      ffmpeg(audioPath)
        .setStartTime(startSeconds)
        .duration(Math.min(MAX_SEGMENT_SECONDS, duration - startSeconds))
        .audioCodec("libmp3lame")
        .audioChannels(1)
        .audioFrequency(16000)
        .format("mp3")
        .output(segmentPath),
    );

    segments.push(segmentPath);
  }

  return segments;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Detects the "model overloaded" family of errors the Gemini API returns
// (HTTP 503, or messages mentioning overload/high demand/unavailability).
function isRetryableGeminiError(error: unknown): boolean {
  const status =
    (error as { status?: number } | undefined)?.status ??
    (error as { httpStatus?: number } | undefined)?.httpStatus;

  if (status === 503) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /\b503\b|service unavailable|overloaded|high demand|unavailable/i.test(
    message,
  );
}

// Sends a generateContent request, retrying the same model with exponential
// backoff on 503/overloaded errors, then falling back to alternate models
// (in order) once retries on a model are exhausted. Non-retryable errors are
// thrown immediately without retrying or falling back.
async function generateContentWithFallback(
  client: GoogleGenerativeAI,
  primaryModel: string,
  parts: Parameters<
    ReturnType<GoogleGenerativeAI["getGenerativeModel"]>["generateContent"]
  >[0],
) {
  const modelsToTry = Array.from(
    new Set([primaryModel, ...FALLBACK_GEMINI_MODELS]),
  );

  let lastError: unknown;

  for (const modelName of modelsToTry) {
    const model = client.getGenerativeModel({ model: modelName });

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await model.generateContent(parts);
      } catch (error) {
        lastError = error;
        console.error(
          `Gemini request failed (model=${modelName}, attempt=${attempt + 1}/${
            RETRY_DELAYS_MS.length + 1
          }):`,
          error,
        );

        if (!isRetryableGeminiError(error)) {
          throw error;
        }

        const isLastAttemptForModel = attempt === RETRY_DELAYS_MS.length;
        if (!isLastAttemptForModel) {
          await sleep(RETRY_DELAYS_MS[attempt]);
        }
      }
    }

    console.warn(
      `Gemini model "${modelName}" is unavailable after ${
        RETRY_DELAYS_MS.length + 1
      } attempts. Falling back to the next model, if any.`,
    );
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Gemini API request failed after retries and fallbacks.");
}

async function transcribeAudioSegment(
  client: GoogleGenerativeAI,
  primaryModel: string,
  audioPath: string,
  segmentNumber: number,
  totalSegments: number,
) {
  const audioBuffer = await fs.readFile(audioPath);
  const result = await generateContentWithFallback(client, primaryModel, [
    {
      text:
        totalSegments > 1
          ? `Transcribe segment ${segmentNumber} of ${totalSegments}. Return only the transcript text for this audio segment.`
          : "Transcribe this audio file. Return only the transcript text.",
    },
    {
      inlineData: {
        data: audioBuffer.toString("base64"),
        mimeType: TRANSCRIPTION_MIME_TYPE,
      },
    },
  ]);

  return result.response.text().trim();
}

// Deletes each tracked temp file individually (existsSync + unlinkSync guard
// against "file not found" errors). This guarantees no leftover audio/chunk
// files remain in /tmp even if FFmpeg or Gemini fails mid-way through
// processing. The temp directory itself is removed separately afterwards.
function cleanupTempFiles(filePaths: string[]) {
  for (const filePath of filePaths) {
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch (cleanupError) {
      console.error(`Failed to delete temp file "${filePath}":`, cleanupError);
    }
  }
}

export async function transcribeUpload(
  file: File,
  onProgress?: ProgressCallback,
) {
  if (!isAllowedUpload(file.name, file.type)) {
    throw new ValidationError(
      "Unsupported file type. Upload a standard audio or video file.",
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured on the server.");
  }

  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "scribeai-"));
  // Tracks every temp file created during processing so cleanup can happen
  // reliably in the finally block, regardless of success or failure.
  const createdFilePaths: string[] = [];

  try {
    const safeName = path.basename(file.name);
    const uploadedPath = path.join(tempDirectory, `${randomUUID()}-${safeName}`);
    const audioPath = path.join(tempDirectory, `${randomUUID()}.mp3`);
    createdFilePaths.push(uploadedPath, audioPath);
    await fs.writeFile(uploadedPath, Buffer.from(await file.arrayBuffer()));

    await detectMediaKind(uploadedPath);

    onProgress?.({ step: "Extracting and optimizing media audio..." });
    await createTranscriptionAudio(uploadedPath, audioPath);

    onProgress?.({ step: "Analyzing audio duration and creating segments..." });
    const duration = await getAudioDurationSeconds(audioPath);
    const segments =
      duration <= MAX_SEGMENT_SECONDS
        ? [audioPath]
        : await splitAudio(audioPath, tempDirectory, duration);
    createdFilePaths.push(...segments);

    const client = new GoogleGenerativeAI(apiKey);
    const transcriptParts: string[] = [];
    const totalChunks = segments.length;

    for (let index = 0; index < totalChunks; index += 1) {
      onProgress?.({
        step: `Transcribing chunk ${index + 1} of ${totalChunks} with Gemini AI...`,
        percent: Math.round(((index + 1) / totalChunks) * 100),
      });

      const transcript = await transcribeAudioSegment(
        client,
        DEFAULT_GEMINI_MODEL,
        segments[index],
        index + 1,
        totalChunks,
      );

      if (transcript) {
        transcriptParts.push(transcript);
      }
    }

    onProgress?.({ step: "Combining segment transcripts...", percent: 100 });

    if (transcriptParts.length === 0) {
      throw new Error("Gemini did not return a transcript for the uploaded file.");
    }

    return {
      duration,
      transcript: transcriptParts.join("\n\n"),
    };
  } finally {
    // Explicit per-file cleanup first (guaranteed, even on mid-way FFmpeg or
    // Gemini failure), then a recursive removal as a final safety net for
    // anything unexpected left behind in the temp directory.
    cleanupTempFiles(Array.from(new Set(createdFilePaths)));
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}
