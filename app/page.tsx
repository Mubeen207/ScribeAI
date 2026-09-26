"use client";

import { useMemo, useState } from "react";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { jsPDF } from "jspdf";
import styles from "./page.module.css";

const ACCEPTED_FORMATS = [
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
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".mpeg",
  ".mpg",
  ".m4v",
  ".3gp",
  ".ogv",
].join(",");

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export default function Home() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [progress, setProgress] = useState(0);

  const downloadBaseName = useMemo(() => {
    if (!selectedFile) {
      return "transcript";
    }

    const extensionIndex = selectedFile.name.lastIndexOf(".");
    return extensionIndex > 0
      ? selectedFile.name.slice(0, extensionIndex)
      : selectedFile.name;
  }, [selectedFile]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedFile) {
      setError("Choose an audio or video file to transcribe.");
      return;
    }

    setIsSubmitting(true);
    setError("");
    setTranscript("");
    setStatusText("Uploading file...");
    setProgress(0);

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);

      const response = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
      });

      if (!response.body) {
        throw new Error("Streaming responses are not supported by this browser.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalTranscript = "";
      let streamError = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }

          const update = JSON.parse(line) as {
            type: "progress" | "complete" | "error";
            step?: string;
            percent?: number;
            transcript?: string;
            error?: string;
          };

          if (update.type === "progress") {
            setStatusText(update.step ?? "");
            if (typeof update.percent === "number") {
              setProgress(update.percent);
            }
          } else if (update.type === "complete") {
            finalTranscript = update.transcript ?? "";
          } else if (update.type === "error") {
            streamError = update.error ?? "Transcription failed.";
          }
        }
      }

      if (streamError || !finalTranscript) {
        throw new Error(streamError || "Transcription failed.");
      }

      setTranscript(finalTranscript);
      setProgress(100);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Transcription failed.",
      );
    } finally {
      setIsSubmitting(false);
      setStatusText("");
      setProgress(0);
    }
  }

  function handleDownloadTxt() {
    downloadBlob(
      new Blob([transcript], { type: "text/plain;charset=utf-8" }),
      `${downloadBaseName}.txt`,
    );
  }

  async function handleDownloadDocx() {
    const document = new Document({
      sections: [
        {
          properties: {},
          children: transcript.split("\n").map((line) =>
            line
              ? new Paragraph({
                  children: [new TextRun(line)],
                })
              : new Paragraph(""),
          ),
        },
      ],
    });

    const blob = await Packer.toBlob(document);
    downloadBlob(
      blob,
      `${downloadBaseName || "transcript"}.docx`,
    );
  }

  function handleDownloadPdf() {
    const pdf = new jsPDF();
    const lines = pdf.splitTextToSize(transcript, 180) as string[];
    const pageHeight = pdf.internal.pageSize.getHeight();
    const lineHeight = 8;
    const topMargin = 20;
    const bottomMargin = 20;
    let cursorY = topMargin;

    lines.forEach((line: string, index: number) => {
      if (cursorY + lineHeight > pageHeight - bottomMargin) {
        pdf.addPage();
        cursorY = topMargin;
      }

      pdf.text(line, 15, cursorY);
      cursorY += lineHeight;

      if (index === lines.length - 1) {
        cursorY += lineHeight;
      }
    });

    pdf.save(`${downloadBaseName || "transcript"}.pdf`);
  }

  function handlePrint() {
    const printWindow = window.open("", "_blank", "noopener,noreferrer");

    if (!printWindow) {
      setError("Unable to open the print dialog.");
      return;
    }

    const markup = `
      <html>
        <head>
          <title>${escapeHtml(downloadBaseName)}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 2rem; line-height: 1.6; white-space: pre-wrap; }
          </style>
          <script>
            window.addEventListener("load", () => {
              window.focus();
              window.print();
            });
          </script>
        </head>
        <body>${escapeHtml(transcript)}</body>
      </html>
    `;

    printWindow.document.write(markup);
    printWindow.document.close();
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <span className={styles.eyebrow}>ScribeAI</span>
            <h1>Transcribe audio and video with Gemini AI.</h1>
            <p>
              Upload standard audio or video files, let the backend extract or
              chunk the media when needed, and then export the final transcript
              as PDF, TXT, or Word.
            </p>
          </div>
        </section>

        <section className={styles.card}>
          <form className={styles.form} onSubmit={handleSubmit}>
            <label className={styles.label} htmlFor="media-file">
              Upload file
            </label>
            <input
              id="media-file"
              className={styles.input}
              type="file"
              accept={ACCEPTED_FORMATS}
              onChange={(event) =>
                setSelectedFile(event.target.files?.[0] ?? null)
              }
            />
            <p className={styles.helpText}>
              Supported formats include MP3, WAV, M4A, FLAC, OGG, WebM, MP4,
              MOV, AVI, MKV, MPEG, MPG, and more.
            </p>
            <button className={styles.primaryButton} disabled={isSubmitting}>
              {isSubmitting ? "Transcribing..." : "Start transcription"}
            </button>
          </form>

          {isSubmitting ? (
            <div className={styles.progressWrapper}>
              <span className={styles.statusBadge}>
                {statusText || "Starting transcription..."}
              </span>
              <div className={styles.progressTrack}>
                <div
                  className={styles.progressFill}
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          ) : null}

          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
        </section>

        <section className={styles.card}>
          <div className={styles.transcriptHeader}>
            <div>
              <h2>Transcript</h2>
              <p>
                Your full transcript appears here after processing finishes.
              </p>
            </div>
            <div className={styles.actions}>
              <button
                className={styles.secondaryButton}
                disabled={!transcript}
                onClick={handleDownloadTxt}
                type="button"
              >
                Download TXT
              </button>
              <button
                className={styles.secondaryButton}
                disabled={!transcript}
                onClick={handleDownloadPdf}
                type="button"
              >
                Download PDF
              </button>
              <button
                className={styles.secondaryButton}
                disabled={!transcript}
                onClick={handleDownloadDocx}
                type="button"
              >
                Download Word
              </button>
              <button
                className={styles.secondaryButton}
                disabled={!transcript}
                onClick={handlePrint}
                type="button"
              >
                Print
              </button>
            </div>
          </div>

          <textarea
            className={styles.transcript}
            readOnly
            value={transcript}
            placeholder="Your transcript will appear here."
          />
        </section>
      </main>
    </div>
  );
}
