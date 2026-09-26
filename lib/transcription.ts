import { randomUUID } from "crypto";
import { promises as fs } from "fs";
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

export class ValidationError extends Error {}

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

function isAllowedUpload(fileName: string, mimeType: string) {
  const extension = path.extname(fileName).toLowerCase();

  if (
    AUDIO_EXTENSIONS.has(extension) ||
    (mimeType && isMimeMatch(mimeType, AUDIO_MIME_PREFIXES))
  ) {
    return true;
  }

  if (
    VIDEO_EXTENSIONS.has(extension) ||
    (mimeType && isMimeMatch(mimeType, VIDEO_MIME_PREFIXES))
  ) {
    return true;
  }

  return false;
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

async function validateUploadedMedia(filePath: string, kind: MediaKind) {
  const metadata = await probe(filePath);
  const streams = metadata.streams ?? [];
  const hasAudio = streams.some((stream) => stream.codec_type === "audio");
  const hasVideo = streams.some((stream) => stream.codec_type === "video");

  if (kind === "audio" && !hasAudio) {
    throw new ValidationError(
      "The uploaded file does not contain a valid audio stream.",
    );
  }

  if (kind === "video") {
    if (!hasVideo) {
      throw new ValidationError(
        "The uploaded file does not contain a valid video stream.",
      );
    }

    if (!hasAudio) {
      throw new ValidationError("The uploaded video does not contain an audio track.");
    }
  }
}

async function detectMediaKind(filePath: string) {
  const metadata = await probe(filePath);
  const streams = metadata.streams ?? [];
  const hasAudio = streams.some((stream) => stream.codec_type === "audio");
  const hasVideo = streams.some((stream) => stream.codec_type === "video");

  if (hasVideo) {
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

async function transcribeAudioSegment(model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]>, audioPath: string, segmentNumber: number, totalSegments: number) {
  const audioBuffer = await fs.readFile(audioPath);
  const result = await model.generateContent([
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

export async function transcribeUpload(file: File) {
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

  try {
    const safeName = path.basename(file.name);
    const uploadedPath = path.join(tempDirectory, `${randomUUID()}-${safeName}`);
    const audioPath = path.join(tempDirectory, `${randomUUID()}.mp3`);
    await fs.writeFile(uploadedPath, Buffer.from(await file.arrayBuffer()));

    const mediaKind = await detectMediaKind(uploadedPath);
    await validateUploadedMedia(uploadedPath, mediaKind);
    await createTranscriptionAudio(uploadedPath, audioPath);

    const duration = await getAudioDurationSeconds(audioPath);
    const segments =
      duration <= MAX_SEGMENT_SECONDS
        ? [audioPath]
        : await splitAudio(audioPath, tempDirectory, duration);

    const client = new GoogleGenerativeAI(apiKey);
    const model = client.getGenerativeModel({ model: DEFAULT_GEMINI_MODEL });
    const transcriptParts: string[] = [];

    for (let index = 0; index < segments.length; index += 1) {
      const transcript = await transcribeAudioSegment(
        model,
        segments[index],
        index + 1,
        segments.length,
      );

      if (transcript) {
        transcriptParts.push(transcript);
      }
    }

    if (transcriptParts.length === 0) {
      throw new Error("Gemini did not return a transcript for the uploaded file.");
    }

    return {
      duration,
      transcript: transcriptParts.join("\n\n"),
    };
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}
