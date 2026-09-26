# ScribeAI

ScribeAI is a Next.js transcription app for standard audio and video files. It extracts audio from video uploads, splits long audio into 15-minute chunks, sends each chunk to Gemini for transcription, and lets you export the final transcript as PDF, TXT, DOCX, or print it.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a local environment file:

   ```bash
   cp .env.example .env.local
   ```

   On Windows or any shell where `cp` is unavailable, create `.env.local`
   manually and paste the same variables shown below.

3. Add your Gemini API settings to `.env.local`:

   ```bash
   GEMINI_API_KEY=your_key_here
   # Optional
   GEMINI_MODEL=gemini-2.5-flash
   ```

4. Start the development server:

   ```bash
   npm run dev
   ```

## Validation

- `npm run lint`
- `npm run build`
