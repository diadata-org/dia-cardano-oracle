// Structured file logger for intent/transaction lifecycle.
// Writes JSON Lines format: one JSON object per line, append-only.
// Also writes all terminal output to a chronological log.

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type IntentLogEntry = {
  ts: string;           // ISO timestamp
  level: LogLevel;
  intentHash: string;
  symbol: string;
  step: string;         // pipeline step name
  message: string;
  meta?: Record<string, unknown>;
};

export type FileLogger = {
  /** Write terminal line to chronological log */
  logTerminal(line: string): Promise<void>;
  /** Write step to intent's individual log file */
  logIntentStep(entry: IntentLogEntry): Promise<void>;
  /** Get the terminal reporter that also writes to file */
  getReportingFn(reportToConsole: (line: string) => void): (line: string) => void;
};

export async function createFileLogger(logDir: string): Promise<FileLogger> {
  await mkdir(logDir, { recursive: true });
  await mkdir(path.join(logDir, "intents"), { recursive: true });
  
  const terminalLogPath = path.join(logDir, "feeder.log");
  
  // Map to store first timestamp seen per intent (for consistent filename)
  const intentFirstTs = new Map<string, string>();
  
  async function appendLine(filePath: string, line: string): Promise<void> {
    await appendFile(filePath, line + "\n", "utf8");
  }
  
  async function appendJson(filePath: string, data: unknown): Promise<void> {
    await appendLine(filePath, JSON.stringify(data));
  }
  
  const logger = {
    async logTerminal(line: string): Promise<void> {
      const ts = new Date().toISOString();
      await appendLine(terminalLogPath, `[${ts}] ${line}`);
    },
    
    async logIntentStep(entry: IntentLogEntry): Promise<void> {
      const shortHash = entry.intentHash.slice(0, 16);
      
      // Use first timestamp seen for this intent, or store current one
      let firstTs = intentFirstTs.get(shortHash);
      if (!firstTs) {
        firstTs = entry.ts;
        intentFirstTs.set(shortHash, firstTs);
      }
      
      // Filename uses first timestamp for consistent ordering: YYYYMMDD-HHMMSS
      const ts = firstTs;
      const sortableTs = ts.slice(0, 4) + ts.slice(5, 7) + ts.slice(8, 10) + "-" + ts.slice(11, 13) + ts.slice(14, 16) + ts.slice(17, 19);
      const intentLogPath = path.join(logDir, "intents", `${sortableTs}_${shortHash}.log`);
      
      // Append to this intent's log (actual timestamp of each step is in content)
      const line = `[${entry.ts}] [${entry.step}] ${entry.message}`;
      await appendLine(intentLogPath, line);
      
      // If meta exists, write it as indented JSON
      if (entry.meta && Object.keys(entry.meta).length > 0) {
        await appendLine(intentLogPath, `  meta: ${JSON.stringify(entry.meta)}`);
      }
    },
    
    getReportingFn(reportToConsole: (line: string) => void): (line: string) => void {
      return (line: string) => {
        // Always print to console
        reportToConsole(line);
        // Also append to terminal log
        void logger.logTerminal(line);
      };
    },
  };
  
  return logger;
}
