"use client";

import { useMemo, useState } from "react";
import { Document, Packer, Paragraph } from "docx";
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
  URL.revokeObjectURL(url);
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

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);

      const response = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
      });

      const result = (await response.json()) as {
        error?: string;
        transcript?: string;
      };

      if (!response.ok || !result.transcript) {
        throw new Error(result.error ?? "Transcription failed.");
      }

      setTranscript(result.transcript);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Transcription failed.",
      );
    } finally {
      setIsSubmitting(false);
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
          children: transcript
            .split(/\n{2,}/)
            .filter(Boolean)
            .map((paragraph) => new Paragraph(paragraph)),
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
      if (cursorY > pageHeight - bottomMargin) {
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

    printWindow.document.write(`
      <html>
        <head>
          <title>${escapeHtml(downloadBaseName)}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 2rem; line-height: 1.6; white-space: pre-wrap; }
          </style>
        </head>
        <body>${escapeHtml(transcript)}</body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
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

          {error ? <p className={styles.error}>{error}</p> : null}
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
