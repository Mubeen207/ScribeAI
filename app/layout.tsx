import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ScribeAI",
  description:
    "Upload audio or video files, transcribe them with Gemini AI, and export transcripts in multiple formats.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
