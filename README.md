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

3. Add your Gemini API key to `.env.local`:

   ```bash
   GEMINI_API_KEY=your_key_here
   ```

4. Start the development server:

   ```bash
   npm run dev
   ```

## Validation

- `npm run lint`
- `npm run build`
