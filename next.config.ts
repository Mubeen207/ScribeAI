import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static", "fluent-ffmpeg"],
};

export default nextConfig;
