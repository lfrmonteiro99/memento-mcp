export type SourceKind = "sqlite" | "vault" | "claude-file";

export interface SourceIndexEntry {
  id: string;
  source: SourceKind;
  title: string;
  kind?: string;
  summary?: string;
  path?: string;
  aliases?: string[];
  breadcrumb?: string[];
  weight?: number;
  score?: number;
}

export interface SourceDocument extends SourceIndexEntry {
  body?: string;
  bodyMode?: "none" | "summary" | "full";
  metadata?: Record<string, unknown>;
}
