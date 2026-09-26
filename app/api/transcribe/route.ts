import { transcribeUpload, ValidationError } from "@/lib/transcription";

export const runtime = "nodejs";
// Extends serverless function execution time (e.g. on Vercel) so long
// media files don't get cut off mid-transcription.
export const maxDuration = 60;

function encodeLine(data: unknown) {
  return new TextEncoder().encode(`${JSON.stringify(data)}\n`);
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return new Response(
      encodeLine({ type: "error", error: "Upload a single audio or video file." }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-cache",
        },
      },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const result = await transcribeUpload(file, (status) => {
          controller.enqueue(
            encodeLine({
              type: "progress",
              step: status.step,
              percent: status.percent,
            }),
          );
        });

        controller.enqueue(
          encodeLine({ type: "complete", transcript: result.transcript }),
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Transcription failed unexpectedly.";

        console.error(
          `Transcription request failed (${
            error instanceof ValidationError ? "validation" : "server"
          }):`,
          error,
        );

        controller.enqueue(encodeLine({ type: "error", error: message }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
    },
  });
}
