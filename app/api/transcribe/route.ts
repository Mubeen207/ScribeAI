import { NextResponse } from "next/server";
import { transcribeUpload, ValidationError } from "@/lib/transcription";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Upload a single audio or video file." },
        { status: 400 },
      );
    }

    const result = await transcribeUpload(file);

    return NextResponse.json({
      duration: result.duration,
      transcript: result.transcript,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Transcription failed unexpectedly.";

    return NextResponse.json(
      { error: message },
      { status: error instanceof ValidationError ? 400 : 500 },
    );
  }
}
