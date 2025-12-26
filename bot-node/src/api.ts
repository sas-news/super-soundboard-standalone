import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";

// --- Types ---

export type SoundMapping = {
  keywords: string[];
  file: string;
  volume?: number; // percent (0-200)
};

export type AppConfig = {
  mappings: SoundMapping[];
  cooldownMs: number;
  lang?: string;
  wsPort?: number; // legacy
};

type LogFunction = (
  level: "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>
) => void;

// --- API Server Setup ---

export const createApiServer = (
  appConfig: AppConfig,
  soundsDir: string,
  log: LogFunction
) => {
  const app = express();
  const API_PORT = process.env.API_PORT
    ? parseInt(process.env.API_PORT, 10)
    : 3211;

  // Enable CORS for all routes
  app.use(cors());

  // GET /api/config - Returns the current configuration
  app.get("/api/config", (req, res) => {
    try {
      res.json({
        success: true,
        data: {
          mappings: appConfig.mappings,
          cooldownMs: appConfig.cooldownMs,
          lang: appConfig.lang,
          wsPort: appConfig.wsPort,
        },
      });
    } catch (error: any) {
      log("error", "Failed to get config via API", { error: error.message });
      res.status(500).json({
        success: false,
        error: "Failed to retrieve configuration",
      });
    }
  });

  // GET /api/sounds/:filename - Returns a sound file
  app.get("/api/sounds/:filename", (req, res) => {
    try {
      const { filename } = req.params;

      // Validate filename to prevent directory traversal
      if (
        !filename ||
        filename.includes("..") ||
        filename.includes("/") ||
        filename.includes("\\")
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid filename",
        });
      }

      const filePath = path.join(soundsDir, filename);

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({
          success: false,
          error: "Sound file not found",
        });
      }

      // Set appropriate content type based on extension
      const ext = path.extname(filename).toLowerCase();
      const contentTypeMap: Record<string, string> = {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".m4a": "audio/mp4",
      };
      const contentType = contentTypeMap[ext] || "application/octet-stream";

      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `inline; filename="${filename}"`);

      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);
    } catch (error: any) {
      log("error", "Failed to serve sound file via API", {
        error: error.message,
      });
      res.status(500).json({
        success: false,
        error: "Failed to serve sound file",
      });
    }
  });

  // GET /api/sounds - Returns list of available sound files
  app.get("/api/sounds", (req, res) => {
    try {
      const files = fs.readdirSync(soundsDir).filter((file) => {
        const ext = path.extname(file).toLowerCase();
        return [".mp3", ".wav", ".ogg", ".m4a"].includes(ext);
      });

      res.json({
        success: true,
        data: files,
      });
    } catch (error: any) {
      log("error", "Failed to list sound files via API", {
        error: error.message,
      });
      res.status(500).json({
        success: false,
        error: "Failed to list sound files",
      });
    }
  });

  // Health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({ success: true, status: "ok" });
  });

  // Start API server
  let httpServer: import("http").Server | null = null;
  let started = false;

  const startServer = () => {
    if (started && httpServer) {
      log("info", `API server already running on port ${API_PORT}`);
      return;
    }
    httpServer = app.listen(API_PORT, () => {
      started = true;
      log("info", `API server started on port ${API_PORT}`);
    });

    httpServer.on("error", (err) => {
      log("error", "API server error", { error: String(err) });
    });
  };

  const stopServer = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (!httpServer) {
        resolve();
        return;
      }
      httpServer.close((err?: Error) => {
        if (err) {
          log("error", "Failed to stop API server", { error: String(err) });
          reject(err);
          return;
        }
        log("info", "API server stopped");
        httpServer = null;
        started = false;
        resolve();
      });
    });
  };

  const restartServer = async (): Promise<void> => {
    await stopServer();
    startServer();
  };

  return { startServer, stopServer, restartServer };
};
