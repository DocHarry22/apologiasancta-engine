import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type ReleaseRepository = "apologia-graph" | "apologiasancta-engine" | "apologiasancta-ui";
export type DeploymentStatus = "pending" | "deployed" | "failed";

export interface ReleaseNotification {
  id: string;
  commitSha: string;
  repository: ReleaseRepository;
  category: string;
  title: string;
  summary: string;
  changes: string[];
  fixes: string[];
  features: string[];
  tests: string[];
  deploymentStatus: DeploymentStatus;
  links: Record<string, string>;
  createdAt: string;
  read: boolean;
  email: {
    status: "sent" | "skipped" | "failed";
    recipient?: string;
    providerId?: string;
    error?: string;
  };
}

export interface CreateReleaseInput {
  commitSha: string;
  repository: ReleaseRepository;
  category: string;
  title: string;
  summary: string;
  changes?: string[];
  fixes?: string[];
  features?: string[];
  tests?: string[];
  deploymentStatus?: DeploymentStatus;
  links?: Record<string, string>;
}

const filePath = resolve(process.env.RELEASES_FILE_PATH || "./data/release-notifications.json");
let writeChain = Promise.resolve();

async function readAll(): Promise<ReleaseNotification[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as ReleaseNotification[] : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeAll(records: ReleaseNotification[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(records, null, 2), "utf8");
  await rename(temporaryPath, filePath);
}

function serialise<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeChain.then(operation, operation);
  writeChain = result.then(() => undefined, () => undefined);
  return result;
}

function cleanList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 100)
    : [];
}

function cleanLinks(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && /^https:\/\//.test(entry[1]))
      .slice(0, 20)
  );
}

export function validateReleaseInput(value: unknown): { ok: true; value: CreateReleaseInput } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "JSON object required" };
  const input = value as Record<string, unknown>;
  const repository = input.repository;
  if (!["apologia-graph", "apologiasancta-engine", "apologiasancta-ui"].includes(String(repository))) {
    return { ok: false, error: "Invalid repository" };
  }
  const required = ["commitSha", "category", "title", "summary"] as const;
  for (const field of required) {
    if (typeof input[field] !== "string" || !(input[field] as string).trim()) {
      return { ok: false, error: `Missing or invalid field: ${field}` };
    }
  }
  const commitSha = (input.commitSha as string).trim();
  if (!/^[a-f0-9]{7,40}$/i.test(commitSha)) return { ok: false, error: "Invalid commit SHA" };
  const deploymentStatus = input.deploymentStatus;
  if (deploymentStatus !== undefined && !["pending", "deployed", "failed"].includes(String(deploymentStatus))) {
    return { ok: false, error: "Invalid deployment status" };
  }
  return {
    ok: true,
    value: {
      commitSha,
      repository: repository as ReleaseRepository,
      category: (input.category as string).trim().slice(0, 80),
      title: (input.title as string).trim().slice(0, 140),
      summary: (input.summary as string).trim().slice(0, 2000),
      changes: cleanList(input.changes),
      fixes: cleanList(input.fixes),
      features: cleanList(input.features),
      tests: cleanList(input.tests),
      deploymentStatus: (deploymentStatus as DeploymentStatus | undefined) ?? "pending",
      links: cleanLinks(input.links),
    },
  };
}

async function sendReleaseEmail(record: ReleaseNotification): Promise<ReleaseNotification["email"]> {
  const apiKey = process.env.RESEND_API_KEY;
  const recipient = process.env.RELEASE_EMAIL_TO || "thletsholo2@gmail.com";
  const sender = process.env.RELEASE_EMAIL_FROM;
  if (!apiKey || !sender) return { status: "skipped", recipient, error: "Email provider is not configured" };

  const sections = [
    record.summary,
    record.features.length ? `New features:\n- ${record.features.join("\n- ")}` : "",
    record.fixes.length ? `Fixes:\n- ${record.fixes.join("\n- ")}` : "",
    record.changes.length ? `Changes:\n- ${record.changes.join("\n- ")}` : "",
    record.tests.length ? `Validation:\n- ${record.tests.join("\n- ")}` : "",
    `Repository: ${record.repository}`,
    `Commit: ${record.commitSha}`,
    `Deployment: ${record.deploymentStatus}`,
  ].filter(Boolean).join("\n\n");

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: sender, to: [recipient], subject: `Apologia Sancta update: ${record.title}`, text: sections }),
    });
    const payload = await response.json().catch(() => ({})) as { id?: string; message?: string };
    if (!response.ok) return { status: "failed", recipient, error: payload.message || `HTTP ${response.status}` };
    return { status: "sent", recipient, providerId: payload.id };
  } catch (error) {
    return { status: "failed", recipient, error: error instanceof Error ? error.message : "Email request failed" };
  }
}

export async function createRelease(input: CreateReleaseInput): Promise<{ record: ReleaseNotification; created: boolean }> {
  return serialise(async () => {
    const records = await readAll();
    const existing = records.find((item) => item.commitSha === input.commitSha && item.repository === input.repository);
    if (existing) return { record: existing, created: false };

    const record: ReleaseNotification = {
      id: randomUUID(),
      ...input,
      changes: input.changes ?? [],
      fixes: input.fixes ?? [],
      features: input.features ?? [],
      tests: input.tests ?? [],
      deploymentStatus: input.deploymentStatus ?? "pending",
      links: input.links ?? {},
      createdAt: new Date().toISOString(),
      read: false,
      email: { status: "skipped" },
    };
    record.email = await sendReleaseEmail(record);
    records.unshift(record);
    await writeAll(records.slice(0, 1000));
    return { record, created: true };
  });
}

export async function listReleases(options: { page: number; pageSize: number; search?: string }) {
  const records = await readAll();
  const needle = options.search?.trim().toLowerCase();
  const filtered = needle
    ? records.filter((item) => [item.title, item.summary, item.category, item.repository, item.commitSha].some((field) => field.toLowerCase().includes(needle)))
    : records;
  const start = (options.page - 1) * options.pageSize;
  return { items: filtered.slice(start, start + options.pageSize), page: options.page, pageSize: options.pageSize, total: filtered.length, pages: Math.ceil(filtered.length / options.pageSize) };
}

export async function markReleaseRead(id: string, read: boolean): Promise<ReleaseNotification | null> {
  return serialise(async () => {
    const records = await readAll();
    const record = records.find((item) => item.id === id);
    if (!record) return null;
    record.read = read;
    await writeAll(records);
    return record;
  });
}

export function setReleaseFilePathForTests(path: string): void {
  (process.env as Record<string, string>).RELEASES_FILE_PATH = path;
}
