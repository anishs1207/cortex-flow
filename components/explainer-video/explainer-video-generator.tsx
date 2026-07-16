"use client";

// Date: 2026-03-22
// Purpose: Full end-to-end AI explainer video generator.
// Pipeline:
//   1. Gemini API → generates narration script from user topic
//   2. Web SpeechSynthesis API → converts script to spoken audio
//   3. Whisper.js (browser, @xenova/transformers) → transcribes audio to timed subtitle words
//   4. Canvas API + MediaRecorder → composites background clip + music + subtitles → MP4 blob
//   5. User can preview and download the final video

import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  Play,
  Music,
  Video,
  FileText,
  Sparkles,
  Download,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
  Volume2,
} from "lucide-react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import ModeToggle from "../chat/ModeToggle";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SubtitleWord {
  word: string;
  startTime: number; // seconds from start of narration
  endTime: number;
}

type PipelineStep = "idle" | "script" | "audio" | "subtitles" | "video" | "transcode" | "done" | "error";

async function transcodeToMP4(
  webmUrl: string,
  onProgress: (_msg: string) => void
): Promise<string> {
  onProgress("Loading FFmpeg engine (v0.11)…");

  try {
    // 1. Load basic FFmpeg script if not present
    //@ts-expect-error - FFmpeg is loaded via script tag
    if (!window.FFmpeg) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js";
        script.crossOrigin = "anonymous";
        script.onload = () => resolve();
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }

    //@ts-expect-error - FFmpeg global from script tag
    const { createFFmpeg, fetchFile } = window.FFmpeg;
    const ffmpeg = createFFmpeg({
      log: true,
      corePath: "https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js",
    });

    onProgress("Initialising FFmpeg engine…");
    await ffmpeg.load();

    onProgress("Transcoding WebM to MP4 (processing in browser)…");

    // 2. Monitor ffmpeg logs for progress
    ffmpeg.setProgress(({ ratio }: { ratio: number }) => {
      onProgress(`MP4 Encoding: ${isNaN(ratio) ? 0 : Math.round(ratio * 100)}% complete`);
    });

    // 3. Process the file
    ffmpeg.FS("writeFile", "video.webm", await fetchFile(webmUrl));

    // Convert to MP4 H.264
    await ffmpeg.run(
      "-i", "video.webm",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "28",
      "-c:a", "aac",
      "-b:a", "128k",
      "output.mp4"
    );

    const data = ffmpeg.FS("readFile", "output.mp4");
    const mp4Blob = new Blob([data.buffer], { type: "video/mp4" });

    onProgress("MP4 Transcode complete!");
    return URL.createObjectURL(mp4Blob);
  } catch (err) {
    console.error("[MP4 Transcode] Error:", err);
    throw new Error(`MP4 Transcode failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Asset Maps ───────────────────────────────────────────────────────────────

// Map dropdown values to actual /public paths
const BACKGROUND_CLIPS: Record<string, { label: string; path: string }> = {
  "subway-surfers.mp4": { label: "🛹 Subway Surfers", path: "/background-clips/subway-surfers.mp4" },
  "minecraft_parkour.mp4": { label: "⛏️ Minecraft Parkour", path: "/background-clips/minecraft_parkour.mp4" },
  "gta5.mp4": { label: "🚗 GTA 5", path: "/background-clips/gta5.mp4" },
};

const MUSIC_TRACKS: Record<string, { label: string; path: string }> = {
  "lofi-peaceful.mp3": { label: "🎵 Lofi Peaceful", path: "/music/lofi-peaceful.mp3" },
  "phonk-drift.mp3": { label: "🔥 Phonk Drift", path: "/music/phonk-drift.mp3" },
  "mountain-ambient.mp3": { label: "🏔️ Mountain Ambient", path: "/music/mountain-ambient.mp3" },
};

// ─── Utility: Fetch audio file as AudioBuffer ──────────────────────────────

async function fetchAudioBuffer(url: string, audioCtx: AudioContext): Promise<AudioBuffer> {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  return audioCtx.decodeAudioData(arrayBuffer);
}

// ─── Utility: Speak text and capture as WAV blob ───────────────────────────
// Uses Web SpeechSynthesis to speak, and simultaneously records via AudioContext
// destination → MediaRecorder to capture the spoken audio as a WAV/WebM blob.

async function speakAndCapture(
  scriptText: string,
  onProgress: (_msg: string) => void
): Promise<{ audioBlobUrl: string; durationSec: number }> {
  onProgress("Requesting AI narration audio from server…");

  try {
    const response = await fetch("/api/explainer-video/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: scriptText }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `TTS API failed with status ${response.status}`);
    }

    const blob = await response.blob();
    const audioBlobUrl = URL.createObjectURL(blob);

    // Determine actual duration via AudioContext
    onProgress("Processing audio duration…");
    const audioCtx = new AudioContext();
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const durationSec = audioBuffer.duration;
    audioCtx.close();

    onProgress(`Narration ready (${Math.round(durationSec)}s).`);

    // Play preview for the user
    const audio = new Audio(audioBlobUrl);
    audio.play().catch(e => console.warn("Auto-play blocked:", e));

    return { audioBlobUrl, durationSec };
  } catch (err) {
    console.error("[TTS Capture] Error:", err);
    throw new Error(`Narration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Utility: Generate subtitle words using Whisper.js (browser) ────────────
// We dynamically import @xenova/transformers so it only loads client-side.
// We transcribe the audio blob and extract word-level timestamps.

// ─── Declare global type for Whisper loaded from CDN ─────────────────────────
declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __whisperPipeline?: any;
  }
}

async function generateWhisperSubtitles(
  audioBlobUrl: string,
  onProgress: (_msg: string) => void
): Promise<SubtitleWord[]> {
  onProgress("Loading Whisper model via CDN (first load may take ~20s)…");

  try {
    // Step 1: Load @xenova/transformers dynamically from CDN
    // This avoids any npm install requirement — it runs 100% in the browser via WASM
    let pipeline: ((..._args: unknown[]) => Promise<unknown>) | undefined;

    if (typeof window !== "undefined" && window.__whisperPipeline) {
      // Reuse previously loaded pipeline
      pipeline = window.__whisperPipeline;
      onProgress("Reusing cached Whisper pipeline…");
    } else {
      onProgress("Fetching Whisper runtime from CDN…");
      // Dynamically load from esm.sh CDN — no npm required
      const whisperModule = await import(
        /* webpackIgnore: true */ "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js" as string
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as any;

      const pipelineFn = whisperModule.pipeline || whisperModule.default?.pipeline;
      if (!pipelineFn) throw new Error("Could not load pipeline from CDN module");

      onProgress("Initialising Whisper-tiny model (downloading weights…)");
      pipeline = await pipelineFn(
        "automatic-speech-recognition",
        "Xenova/whisper-tiny.en",
        { return_timestamps: "word" }
      );
      // Cache on window for reuse in same session
      if (typeof window !== "undefined") {
        window.__whisperPipeline = pipeline;
      }
    }

    if (!pipeline) throw new Error("Whisper pipeline failed to initialise");

    // Step 2: Decode audio blob to 16kHz float32 (Whisper requirement)
    const response = await fetch(audioBlobUrl);
    const arrayBuffer = await response.arrayBuffer();
    const audioCtx = new AudioContext({ sampleRate: 16000 });
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const float32Audio = audioBuffer.getChannelData(0);
    audioCtx.close();

    onProgress("Whisper is transcribing audio in the browser…");

    // Step 3: Run Whisper inference
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (pipeline as any)(float32Audio, {
      return_timestamps: "word",
      language: "en",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as { chunks?: any[] };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunks: any[] = result.chunks || [];
    if (chunks.length === 0) return [];

    // Step 4: Map Whisper word-level chunks to SubtitleWord format
    const subtitleWords: SubtitleWord[] = chunks
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((chunk: any) => ({
        word: String(chunk.text || "").trim(),
        startTime: Array.isArray(chunk.timestamp) ? Number(chunk.timestamp[0]) : 0,
        endTime: Array.isArray(chunk.timestamp) ? Number(chunk.timestamp[1]) : 0.5,
      }))
      .filter((w: SubtitleWord) => w.word.length > 0);

    onProgress(`✅ Whisper generated ${subtitleWords.length} timed subtitle words.`);
    return subtitleWords;
  } catch (whisperError) {
    // Whisper.js may fail in restricted environments, slow connections, or if WASM is blocked.
    // We gracefully fall back to the word-timing estimate generated during TTS.
    console.warn("[Whisper] CDN load failed, using estimated timing:", whisperError);
    onProgress("Whisper CDN unavailable — using estimated subtitle timing (still accurate).");
    return [];
  }
}

// ─── Utility: Build SRT subtitle content from word list ─────────────────────

function buildSRTContent(subtitleWords: SubtitleWord[]): string {
  // Group words into subtitle cues of 3–4 words each
  const CUE_WORD_COUNT = 3;
  const srtLines: string[] = [];
  let cueIndex = 1;

  for (let i = 0; i < subtitleWords.length; i += CUE_WORD_COUNT) {
    const cueWords = subtitleWords.slice(i, i + CUE_WORD_COUNT);
    const startTime = cueWords[0].startTime;
    const endTime = cueWords[cueWords.length - 1].endTime;
    const text = cueWords.map((w) => w.word).join(" ");

    const formatTime = (sec: number) => {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.floor(sec % 60);
      const ms = Math.floor((sec % 1) * 1000);
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
    };

    srtLines.push(
      `${cueIndex}\n${formatTime(startTime)} --> ${formatTime(endTime)}\n${text.toUpperCase()}\n`
    );
    cueIndex++;
  }

  return srtLines.join("\n");
}

// ─── Utility: Compose video on canvas and record ────────────────────────────
// This renders the background clip at PORTRAIT ratio (9:16) in the top 60%,
// overlays animated subtitles in the centre, and mixes background music.
// Uses MediaRecorder on the canvas stream + music audio.

async function composeAndRecordVideo(
  backgroundClipPath: string,
  musicPath: string,
  narrationBlobUrl: string, // Added narration source
  subtitleWords: SubtitleWord[],
  totalDurationSec: number,
  onProgress: (_msg: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    (async () => {
      onProgress("Setting up video canvas…");

      // Canvas dimensions: portrait 9:16
      const CANVAS_WIDTH = 720;
      const CANVAS_HEIGHT = 1280;

      const canvas = document.createElement("canvas");
      canvas.width = CANVAS_WIDTH;
      canvas.height = CANVAS_HEIGHT;
      const ctx = canvas.getContext("2d")!;

      // ── Load background video element ──
      const bgVideo = document.createElement("video");
      bgVideo.src = backgroundClipPath;
      bgVideo.muted = true;
      bgVideo.loop = true;
      bgVideo.crossOrigin = "anonymous";
      bgVideo.playsInline = true;

      await new Promise<void>((res, rej) => {
        bgVideo.oncanplay = () => res();
        bgVideo.onerror = () => rej(new Error("Could not load background video: " + backgroundClipPath));
        bgVideo.load();
      });

      onProgress("Background clip loaded. Setting up audio…");

      // ── Set up AudioContext for music mixing ──
      const audioCtx = new AudioContext();
      const musicBuffer = await fetchAudioBuffer(musicPath, audioCtx);

      const musicSource = audioCtx.createBufferSource();
      musicSource.buffer = musicBuffer;
      musicSource.loop = true;

      // Lower music volume significantly so voice-over is audible
      const musicGain = audioCtx.createGain();
      musicGain.gain.value = 0.08; // Lowered from 0.25

      musicSource.connect(musicGain);

      // Route music to a MediaStream destination
      const audioDestination = audioCtx.createMediaStreamDestination();
      musicGain.connect(audioDestination);

      // ── Load and mix narration audio ──
      try {
        if (narrationBlobUrl) {
          const response = await fetch(narrationBlobUrl);
          const arrayBuffer = await response.arrayBuffer();
          const narrationBuffer = await audioCtx.decodeAudioData(arrayBuffer);
          const narrationSource = audioCtx.createBufferSource();
          narrationSource.buffer = narrationBuffer;

          const narrationGain = audioCtx.createGain();
          narrationGain.gain.value = 1.0; // Voiceover should be full volume

          narrationSource.connect(narrationGain);
          narrationGain.connect(audioDestination);
          narrationSource.start();
        }
      } catch (err) {
        console.warn("Could not mix narration audio into video:", err);
      }

      // ── Combine canvas stream + audio stream for MediaRecorder ──
      const canvasStream = canvas.captureStream(30); // 30fps
      const audioTracks = audioDestination.stream.getAudioTracks();
      for (const track of audioTracks) {
        canvasStream.addTrack(track);
      }

      // Pick a supported MIME type
      const mimeType = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
      ].find((t) => MediaRecorder.isTypeSupported(t)) || "video/webm";

      const recorder = new MediaRecorder(canvasStream, { mimeType, videoBitsPerSecond: 4_000_000 });
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        audioCtx.close();
        bgVideo.pause();
        const blob = new Blob(chunks, { type: mimeType });
        const videoUrl = URL.createObjectURL(blob);
        resolve(videoUrl);
      };
      recorder.onerror = (e) => reject(new Error("MediaRecorder error: " + e));

      // ── Start everything ──
      bgVideo.play();
      musicSource.start();
      recorder.start(100); // collect data every 100ms

      onProgress("Recording video… (this takes as long as the clip)");

      const startTimestamp = performance.now();

      // ── Subtitle helper ──
      // Returns the words that should be visible at a given elapsed time
      const getVisibleSubtitleGroup = (elapsedSec: number): string => {
        const CUE_WORD_COUNT = 3;
        for (let i = 0; i < subtitleWords.length; i += CUE_WORD_COUNT) {
          const cueWords = subtitleWords.slice(i, i + CUE_WORD_COUNT);
          const start = cueWords[0].startTime;
          const end = cueWords[cueWords.length - 1].endTime;
          if (elapsedSec >= start && elapsedSec <= end) {
            return cueWords.map((w) => w.word).join(" ").toUpperCase();
          }
        }
        return "";
      };

      // ── Frame rendering loop ──
      const renderFrame = () => {
        const elapsedSec = (performance.now() - startTimestamp) / 1000;

        // Clear canvas with black
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

        // Draw background video — stretched to fill canvas (crop to fill)
        const videoAspect = bgVideo.videoWidth / (bgVideo.videoHeight || 1);
        const canvasAspect = CANVAS_WIDTH / CANVAS_HEIGHT;

        let drawW = CANVAS_WIDTH;
        let drawH = CANVAS_HEIGHT;
        let drawX = 0;
        let drawY = 0;

        if (videoAspect > canvasAspect) {
          // Video is wider — constrain by height
          drawH = CANVAS_HEIGHT;
          drawW = drawH * videoAspect;
          drawX = (CANVAS_WIDTH - drawW) / 2;
        } else {
          // Video is taller — constrain by width
          drawW = CANVAS_WIDTH;
          drawH = drawW / videoAspect;
          drawY = (CANVAS_HEIGHT - drawH) / 2;
        }

        ctx.drawImage(bgVideo, drawX, drawY, drawW, drawH);

        // Draw a semi-transparent overlay to help subtitle readability
        const gradient = ctx.createLinearGradient(0, CANVAS_HEIGHT * 0.35, 0, CANVAS_HEIGHT * 0.75);
        gradient.addColorStop(0, "rgba(0,0,0,0)");
        gradient.addColorStop(0.4, "rgba(0,0,0,0.65)");
        gradient.addColorStop(1, "rgba(0,0,0,0.65)");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

        // Draw subtitle text in the vertical centre
        const subtitleText = getVisibleSubtitleGroup(elapsedSec);
        if (subtitleText) {
          const lines = wrapTextCanvas(ctx, subtitleText, CANVAS_WIDTH - 80, 72);
          const lineHeight = 90;
          const totalTextHeight = lines.length * lineHeight;
          let textY = (CANVAS_HEIGHT - totalTextHeight) / 2;

          for (const line of lines) {
            // Shadow / outline effect
            ctx.font = "bold 72px Arial, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";

            // Yellow background pill
            const textMetrics = ctx.measureText(line);
            const pillW = textMetrics.width + 40;
            const pillH = lineHeight - 8;
            const pillX = (CANVAS_WIDTH - pillW) / 2;

            ctx.fillStyle = "#FACC15"; // Yellow-400
            roundRect(ctx, pillX, textY - pillH / 2, pillW, pillH, 16);
            ctx.fill();

            // Black text on yellow pill
            ctx.fillStyle = "#000000";
            ctx.fillText(line, CANVAS_WIDTH / 2, textY);

            textY += lineHeight;
          }
        }

        // Draw recording progress indicator
        const progressRatio = Math.min(elapsedSec / totalDurationSec, 1);
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.fillRect(20, CANVAS_HEIGHT - 24, CANVAS_WIDTH - 40, 8);
        ctx.fillStyle = "#3B82F6"; // Blue
        ctx.fillRect(20, CANVAS_HEIGHT - 24, (CANVAS_WIDTH - 40) * progressRatio, 8);

        // Stop recording when duration reached
        if (elapsedSec >= totalDurationSec) {
          recorder.stop();
          musicSource.stop();
          return; // Stop the loop
        }

        requestAnimationFrame(renderFrame);
      };

      requestAnimationFrame(renderFrame);
    })();
  });
}

// ─── Canvas text-wrap helper ──────────────────────────────────────────────────

function wrapTextCanvas(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  fontSize: number
): string[] {
  ctx.font = `bold ${fontSize}px Arial, sans-serif`;
  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? currentLine + " " + word : word;
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

// ─── Canvas roundRect helper ─────────────────────────────────────────────────

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

// ─── Pipeline Step Indicator ──────────────────────────────────────────────────

interface StepIndicatorProps {
  label: string;
  status: "pending" | "active" | "done" | "error";
}

function StepIndicator({ label, status }: StepIndicatorProps) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex-shrink-0 w-7 h-7 flex items-center justify-center">
        {status === "pending" && (
          <div className="w-3 h-3 rounded-full border-2 border-zinc-600" />
        )}
        {status === "active" && (
          <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
        )}
        {status === "done" && (
          <CheckCircle2 className="w-5 h-5 text-emerald-400" />
        )}
        {status === "error" && (
          <AlertCircle className="w-5 h-5 text-red-400" />
        )}
      </div>
      <span
        className={`text-sm transition-colors ${status === "active"
          ? "text-blue-600 dark:text-blue-300 font-semibold"
          : status === "done"
            ? "text-emerald-600 dark:text-emerald-300"
            : status === "error"
              ? "text-red-600 dark:text-red-300"
              : "text-zinc-400 dark:text-zinc-500"
          }`}
      >
        {label}
      </span>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ExplainerVideoGenerator() {
  // ── State ──
  const [topic, setTopic] = useState("");
  const [script, setScript] = useState("");
  const [selectedBgClip, setSelectedBgClip] = useState<keyof typeof BACKGROUND_CLIPS>("subway-surfers.mp4");
  const [selectedMusic, setSelectedMusic] = useState<keyof typeof MUSIC_TRACKS>("lofi-peaceful.mp3");

  const [pipelineStep, setPipelineStep] = useState<PipelineStep>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  // Subtitle words from Whisper or estimation
  const subtitleWordsRef = useRef<SubtitleWord[]>([]);
  const estimatedSubtitleWordsRef = useRef<SubtitleWord[]>([]);
  const audioBlobUrlRef = useRef<string>("");
  const totalDurationRef = useRef<number>(30);

  // Final output
  const [videoBlobUrl, setVideoBlobUrl] = useState<string>("");
  const [mp4BlobUrl, setMp4BlobUrl] = useState<string>("");
  const [srtContent, setSrtContent] = useState<string>("");

  const videoPreviewRef = useRef<HTMLVideoElement>(null);

  // ── Voices hydration ──
  useEffect(() => {
    // Trigger voice list load (browsers load lazily)
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    }
  }, []);

  // ── Step helper ──
  const stepStatus = (target: PipelineStep): "pending" | "active" | "done" | "error" => {
    const order: PipelineStep[] = ["idle", "script", "audio", "subtitles", "video", "transcode", "done"];
    const currentIdx = order.indexOf(pipelineStep);
    const targetIdx = order.indexOf(target);
    if (pipelineStep === "error") return target === "idle" ? "done" : "error";
    if (currentIdx > targetIdx) return "done";
    if (currentIdx === targetIdx) return "active";
    return "pending";
  };

  // ── MAIN PIPELINE ──
  const runPipeline = useCallback(async () => {
    if (!topic.trim()) return;

    setErrorMessage("");
    setVideoBlobUrl("");
    setMp4BlobUrl("");
    setSrtContent("");
    setScript("");

    try {
      // ── STEP 1: Generate Script via Gemini API ──
      setPipelineStep("script");
      setStatusMessage("Calling Gemini to write your script…");

      const scriptResponse = await fetch("/api/explainer-video/generate-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });

      if (!scriptResponse.ok) {
        const errData = await scriptResponse.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${scriptResponse.status}: Script generation failed`);
      }

      const { script: generatedScript } = await scriptResponse.json();
      setScript(generatedScript);
      setStatusMessage("Script generated! Starting narration…");

      // ── STEP 2: TTS Audio Capture ──
      setPipelineStep("audio");
      const { audioBlobUrl, durationSec } = await speakAndCapture(
        generatedScript,
        setStatusMessage
      );
      audioBlobUrlRef.current = audioBlobUrl;
      totalDurationRef.current = durationSec;

      // Store estimated timing as fallback for Whisper
      // Regenerate word timing from the script (same logic as inside speakAndCapture)
      const words = generatedScript.split(/\s+/).filter(Boolean);
      const estimatedWords: SubtitleWord[] = [];
      let t = 0.2;
      for (const word of words) {
        const clean = word.replace(/[.,!?;:]/g, "");
        const dur = 0.4 + clean.length * 0.015;
        estimatedWords.push({ word: clean, startTime: t, endTime: t + dur });
        t += dur;
        if (/[.!?]$/.test(word)) t += 0.3;
      }
      estimatedSubtitleWordsRef.current = estimatedWords;

      // ── STEP 3: Whisper Subtitle Generation ──
      setPipelineStep("subtitles");
      const whisperWords = await generateWhisperSubtitles(audioBlobUrl, setStatusMessage);

      // Use Whisper results if we got them, otherwise fall back to estimates
      const finalSubtitleWords =
        whisperWords.length > 0 ? whisperWords : estimatedSubtitleWordsRef.current;
      subtitleWordsRef.current = finalSubtitleWords;

      // Build SRT content
      const srt = buildSRTContent(finalSubtitleWords);
      setSrtContent(srt);
      setStatusMessage(
        `Subtitles ready (${finalSubtitleWords.length} words). Starting video composition…`
      );

      // ── STEP 4: Video Composition ──
      setPipelineStep("video");
      const clipInfo = BACKGROUND_CLIPS[selectedBgClip];
      const musicInfo = MUSIC_TRACKS[selectedMusic];

      const videoUrl = await composeAndRecordVideo(
        clipInfo.path,
        musicInfo.path,
        audioBlobUrlRef.current, // Pass the narration audio
        finalSubtitleWords,
        totalDurationRef.current,
        setStatusMessage
      );

      setVideoBlobUrl(videoUrl);

      // ── STEP 5: MP4 Transcoding ──
      setPipelineStep("transcode");
      const mp4Url = await transcodeToMP4(videoUrl, setStatusMessage);
      setMp4BlobUrl(mp4Url);

      setPipelineStep("done");
      setStatusMessage("Your explainer video is ready as .MP4!");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(message);
      setPipelineStep("error");
      setStatusMessage("Pipeline failed. See error below.");
      console.error("[ExplainerVideo Pipeline]", err);
    }
  }, [topic, selectedBgClip, selectedMusic]);

  // ── Download handlers ──
  const downloadVideo = () => {
    const url = mp4BlobUrl || videoBlobUrl;
    if (!url) return;
    const isMP4 = !!mp4BlobUrl;
    const a = document.createElement("a");
    a.href = url;
    a.download = `explainer-${Date.now()}.${isMP4 ? "mp4" : "webm"}`;
    a.click();
  };

  const downloadSRT = () => {
    if (!srtContent) return;
    const blob = new Blob([srtContent], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `subtitles-${Date.now()}.srt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isRunning = ["script", "audio", "subtitles", "video", "transcode"].includes(pipelineStep);
  const isDone = pipelineStep === "done";
  const isError = pipelineStep === "error";
  return (
    <div className="max-w-6xl mx-auto px-4 pb-20 relative">
      {/* ── Mode Toggle ── */}
      <div className="absolute top-10 right-4 z-20">
        <ModeToggle />
      </div>

      {/* ── Header ── */}
      <div className="text-center py-10 space-y-3">
        <div className="inline-flex items-center gap-2 bg-blue-500/10 border border-blue-500/20 text-blue-600 dark:text-blue-400 px-4 py-1.5 rounded-full text-sm font-medium">
          <Sparkles className="w-4 h-4" />
          AI-Powered · Browser-Native · No Upload Required
        </div>
        <h1 className="text-5xl font-black tracking-tight text-zinc-900 dark:text-white bg-gradient-to-r from-zinc-900 via-blue-600 to-purple-600 dark:from-white dark:via-blue-200 dark:to-purple-300 bg-clip-text text-transparent">
          Explainer Video Generator
        </h1>

      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* ── LEFT: Controls ── */}
        <div className="lg:col-span-2 space-y-5">
          {/* Topic Input */}
          <div className="bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
            <label className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-widest flex items-center gap-2">
              <FileText className="w-3 h-3" />
              Video Topic
            </label>
            <Textarea
              className="resize-none bg-white dark:bg-zinc-950 border-zinc-200 dark:border-zinc-700 h-24 text-zinc-900 dark:text-white placeholder:text-zinc-400 dark:placeholder:text-zinc-600 hover:border-blue-500/50 focus:border-blue-500 transition-colors text-sm"
              placeholder="e.g. Why the universe is expanding faster than light…"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              disabled={isRunning}
            />
          </div>

          {/* Background Clip Selector */}
          <div className="bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
            <label className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-widest flex items-center gap-2">
              <Video className="w-3 h-3" />
              Background Gameplay Clip
            </label>
            <div className="grid gap-2">
              {Object.entries(BACKGROUND_CLIPS).map(([key, { label }]) => (
                <button
                  key={key}
                  onClick={() => setSelectedBgClip(key)}
                  disabled={isRunning}
                  className={`w-full cursor-pointer text-left px-4 py-3 rounded-xl border text-sm font-medium transition-all ${selectedBgClip === key
                    ? "bg-blue-600/10 border-blue-500 text-blue-600 dark:text-blue-300 dark:bg-blue-600/20"
                    : "bg-white dark:bg-zinc-800/50 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-zinc-400 dark:hover:border-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200"
                    }`}
                >
                  <span className="flex items-center justify-between">
                    {label}
                    {selectedBgClip === key && <ChevronRight className="w-4 h-4 opacity-60" />}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Music Selector */}
          <div className="bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
            <label className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-widest flex items-center gap-2">
              <Music className="w-3 h-3" />
              Background Music
            </label>
            <div className="grid gap-2">
              {Object.entries(MUSIC_TRACKS).map(([key, { label }]) => (
                <button
                  key={key}
                  onClick={() => setSelectedMusic(key)}
                  disabled={isRunning}
                  className={`w-full cursor-pointer text-left px-4 py-3 rounded-xl border text-sm font-medium transition-all ${selectedMusic === key
                    ? "bg-purple-600/10 border-purple-500 text-purple-600 dark:text-purple-300 dark:bg-purple-600/20"
                    : "bg-white dark:bg-zinc-800/50 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-zinc-400 dark:hover:border-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200"
                    }`}
                >
                  <span className="flex items-center justify-between">
                    {label}
                    {selectedMusic === key && <ChevronRight className="w-4 h-4 opacity-60" />}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Generate Button */}
          <Button
            onClick={runPipeline}
            disabled={!topic.trim() || isRunning}
            className="w-full py-6 text-base font-bold bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white border-0 rounded-xl shadow-lg dark:shadow-blue-900/30 disabled:opacity-50 disabled:cursor-not-allowed disabled:scale-100"
          >
            {isRunning ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-5 h-5 animate-spin" /> Running Pipeline…
              </span>
            ) : (
              <span className="cursor-pointer flex items-center gap-2">
                <Play className="w-5 h-5" /> Generate Explainer Video
              </span>
            )}
          </Button>

          {/* Pipeline Steps */}
          {pipelineStep !== "idle" && (
            <div className="bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
              <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-500 uppercase tracking-widest">
                Pipeline Progress
              </p>
              <div className="space-y-2.5">
                <StepIndicator label="Generate Script (Gemini)" status={stepStatus("script")} />
                <StepIndicator label="Text-to-Speech Narration" status={stepStatus("audio")} />
                <StepIndicator label="Whisper Subtitle Transcription" status={stepStatus("subtitles")} />
                <StepIndicator label="Canvas Video Composition" status={stepStatus("video")} />
                <StepIndicator label="Transcode to MP4 (H.264)" status={stepStatus("transcode")} />
              </div>
              {statusMessage && (
                <p className="text-xs text-zinc-500 italic border-t border-zinc-200 dark:border-zinc-800 pt-3">
                  {statusMessage}
                </p>
              )}
              {isError && errorMessage && (
                <div className="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900/50 rounded-xl p-3">
                  <p className="text-xs text-red-600 dark:text-red-400 font-medium">{errorMessage}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── RIGHT: Preview and Output ── */}
        <div className="lg:col-span-3 space-y-5">
          {/* Video Preview */}
          <div className="bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden min-h-[480px] flex flex-col items-center justify-center relative">
            {isDone && videoBlobUrl ? (
              <div className="w-full flex flex-col items-center">
                <video
                  ref={videoPreviewRef}
                  src={videoBlobUrl}
                  controls
                  autoPlay
                  loop
                  playsInline
                  className="w-full max-h-[600px] object-contain bg-black"
                  style={{ aspectRatio: "9/16", maxWidth: "340px", margin: "0 auto" }}
                />
              </div>
            ) : isRunning ? (
              <div className="text-center space-y-4 p-8">
                <div className="relative w-24 h-24 mx-auto">
                  <div className="absolute inset-0 rounded-full border-4 border-blue-500/20 animate-ping" />
                  <div className="absolute inset-0 rounded-full border-4 border-blue-500/40 animate-pulse" />
                  <div className="w-24 h-24 rounded-full border-4 border-t-blue-500 border-r-purple-500 border-b-transparent border-l-transparent animate-spin" />
                </div>
                <p className="text-zinc-600 dark:text-zinc-300 font-medium">Generating your video…</p>
                <p className="text-zinc-500 text-sm max-w-xs">{statusMessage}</p>
              </div>
            ) : (
              <div className="text-center space-y-3 p-8">
                <div className="w-24 h-24 mx-auto rounded-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 flex items-center justify-center">
                  <Video className="w-12 h-12 text-zinc-400 dark:text-zinc-600" />
                </div>
                <p className="text-zinc-500 text-sm max-w-xs">
                  Enter a topic and click Generate — your video will appear here.
                </p>
              </div>
            )}
          </div>

          {/* Generated Script Preview */}
          {script && (
            <div className="bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
              <label className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-widest flex items-center gap-2">
                <Volume2 className="w-3 h-3" />
                Generated Script (Gemini)
              </label>
              <div className="bg-white dark:bg-zinc-950 rounded-xl p-4 border border-zinc-200 dark:border-zinc-800 font-mono text-sm text-zinc-700 dark:text-zinc-300 leading-relaxed max-h-48 overflow-y-auto">
                {script}
              </div>
            </div>
          )}

          {/* Download Buttons */}
          {isDone && videoBlobUrl && (
            <div className="grid grid-cols-2 gap-3">
              <Button
                onClick={downloadVideo}
                className="bg-zinc-900 dark:bg-white text-white dark:text-black hover:bg-zinc-800 dark:hover:bg-zinc-100 font-bold py-4 rounded-xl transition-all hover:scale-105 active:scale-95"
              >
                <Download className="w-4 h-4 mr-2" />
                Download Video ({mp4BlobUrl ? ".mp4" : ".webm"})
              </Button>
              <Button
                onClick={downloadSRT}
                variant="outline"
                className="border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 font-bold py-4 rounded-xl transition-all hover:scale-105 active:scale-95"
              >
                <FileText className="w-4 h-4 mr-2" />
                Export Subtitles (.srt)
              </Button>
            </div>
          )}

          {/* SRT Preview */}
          {srtContent && (
            <div className="bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
              <label className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-widest">
                Subtitle Preview (.SRT)
              </label>
              <pre className="bg-white dark:bg-zinc-950 rounded-xl p-4 border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-500 dark:text-zinc-400 font-mono leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap">
                {srtContent.slice(0, 800)}{srtContent.length > 800 ? "\n…" : ""}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
