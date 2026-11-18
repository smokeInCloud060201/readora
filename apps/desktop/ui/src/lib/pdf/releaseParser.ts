/// <reference types="vite/client" />
import { type ReleaseManifestDto } from "../../types/ipc";

export const DEFAULT_APP_VERSION: string =
  (import.meta.env.VITE_APP_VERSION as string | undefined)?.trim() || "1.1.3";

export function isValidSha256Hex(value: string | null | undefined): boolean {
  return /^[0-9a-f]{64}$/i.test((value ?? "").trim());
}

const ALLOWED_GITHUB_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

const GITHUB_REPO_SEGMENT_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidGithubRepoSlug(slug: string): boolean {
  const trimmed = slug.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || trimmed.indexOf("/", slashIndex + 1) !== -1) {
    return false;
  }
  const owner = trimmed.slice(0, slashIndex);
  const repo = trimmed.slice(slashIndex + 1);
  return (
    GITHUB_REPO_SEGMENT_RE.test(owner) &&
    GITHUB_REPO_SEGMENT_RE.test(repo) &&
    owner !== "." &&
    owner !== ".." &&
    repo !== "." &&
    repo !== ".."
  );
}

export function isAllowedGithubHttpsUrl(
  rawUrl: string | null | undefined,
): boolean {
  const trimmed = (rawUrl ?? "").trim();
  if (!trimmed.startsWith("https://") || trimmed.includes("\\")) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      (parsed.port === "" || parsed.port === "443") &&
      ALLOWED_GITHUB_HOSTS.has(parsed.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

export function isAllowedGithubHttpsUrlForRepo(
  rawUrl: string | null | undefined,
  repoSlug: string,
): boolean {
  if (!isAllowedGithubHttpsUrl(rawUrl) || !isValidGithubRepoSlug(repoSlug)) {
    return false;
  }
  try {
    const parsed = new URL((rawUrl ?? "").trim());
    const host = parsed.hostname.toLowerCase();
    const pathLower = parsed.pathname.toLowerCase();
    const slugLower = repoSlug.trim().toLowerCase();
    if (host === "github.com") {
      return pathLower.startsWith(`/${slugLower}/releases/`);
    }
    if (host === "api.github.com") {
      return pathLower.startsWith(`/repos/${slugLower}/`);
    }
    return true;
  } catch {
    return false;
  }
}

export function compareSemver(left: string, right: string): number {
  const parse = (raw: string): [number, number, number] => {
    const cleaned = raw.trim().replace(/^[vV]/, "");
    const core = cleaned.split(/[-+]/)[0] ?? "";
    const parts = core.split(".");
    return [
      Number.parseInt(parts[0] ?? "0", 10) || 0,
      Number.parseInt(parts[1] ?? "0", 10) || 0,
      Number.parseInt(parts[2] ?? "0", 10) || 0,
    ];
  };
  const l = parse(left);
  const r = parse(right);
  for (let i = 0; i < 3; i += 1) {
    const li = l[i] ?? 0;
    const ri = r[i] ?? 0;
    if (li > ri) return 1;
    if (li < ri) return -1;
  }
  return 0;
}

interface GithubReleaseAssetPayload {
  name?: string;
  size?: number;
  browser_download_url?: string;
  digest?: string;
}

interface GithubReleasePayload {
  tag_name?: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string;
  html_url?: string;
  assets?: GithubReleaseAssetPayload[];
}

const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[.-][0-9A-Za-z.-]+)?$/;
const SIDECAR_EXTENSIONS = [
  ".sha256",
  ".sig",
  ".asc",
  ".json",
  ".jsonl",
  ".sbom",
  ".txt",
  ".blockmap",
];

export function parseGithubReleasePayload(
  rawJson: string,
  targetOs = "macos",
  targetArch = "aarch64",
): ReleaseManifestDto {
  const rawParsed: unknown = JSON.parse(rawJson);
  if (!rawParsed || typeof rawParsed !== "object" || Array.isArray(rawParsed)) {
    throw new Error("Invalid GitHub release payload: expected a JSON object.");
  }
  const parsed = rawParsed as GithubReleasePayload;
  if (parsed.draft === true || parsed.prerelease === true) {
    throw new Error(
      "Draft and prerelease GitHub releases are not eligible for updates",
    );
  }

  const rawTag = (parsed.tag_name ?? "").trim();
  const version = rawTag.replace(/^[vV]/, "").trim();
  if (!version || !SEMVER_RE.test(version)) {
    throw new Error("GitHub release payload has missing or invalid tag_name");
  }

  const title = parsed.name?.trim() || `Focus Reader ${version} is ready`;
  const notes =
    parsed.body?.trim() || `Release ${version} published on GitHub Releases.`;
  const publishedAt = parsed.published_at ?? "";

  const rawHtmlUrl = parsed.html_url?.trim() ?? "";
  if (rawHtmlUrl.length > 0 && !isAllowedGithubHttpsUrl(rawHtmlUrl)) {
    throw new Error("GitHub release html_url must be a valid https:// GitHub URL");
  }
  const htmlUrl = rawHtmlUrl.length > 0 ? rawHtmlUrl : null;

  const osTokens =
    targetOs === "windows"
      ? [".msi", ".exe", "windows", "win64"]
      : targetOs === "linux"
        ? [".appimage", ".deb", ".rpm", "linux"]
        : [".app.tar.gz", ".dmg", "macos", "darwin"];

  const foreignArchTokens =
    targetArch === "aarch64"
      ? ["x86_64", "amd64", "x64", "win64"]
      : targetArch === "x86_64"
        ? ["aarch64", "arm64"]
        : [];

  let selectedSize = 0;
  let selectedUrl: string | null = null;
  let selectedSha256 = "";

  if (Array.isArray(parsed.assets)) {
    for (const asset of parsed.assets) {
      const nameLower = (asset.name ?? "").toLowerCase().trim();
      if (!nameLower) {
        continue;
      }
      if (SIDECAR_EXTENSIONS.some((ext) => nameLower.endsWith(ext))) {
        continue;
      }
      if (foreignArchTokens.some((tok) => nameLower.includes(tok))) {
        continue;
      }
      const matchesOs = osTokens.some((tok) => nameLower.includes(tok));
      if (!matchesOs) {
        continue;
      }

      const rawAssetUrl = asset.browser_download_url?.trim() ?? "";
      if (rawAssetUrl.length > 0 && !isAllowedGithubHttpsUrl(rawAssetUrl)) {
        throw new Error(
          "GitHub release asset browser_download_url must be a valid https:// GitHub URL",
        );
      }

      const size = typeof asset.size === "number" && asset.size > 0 ? asset.size : 0;
      const digest = asset.digest
        ? asset.digest.replace(/^sha256:/i, "").trim()
        : "";

      selectedSize = size;
      selectedUrl = rawAssetUrl.length > 0 ? rawAssetUrl : null;
      selectedSha256 =
        selectedUrl && isValidSha256Hex(digest) ? digest.toLowerCase() : "";
      break;
    }
  }

  const packageSizeBytes = selectedSize > 0 ? selectedSize : 42 * 1024 * 1024;
  const downloadUrl = selectedUrl ?? htmlUrl;

  return {
    version,
    title,
    notes,
    package_size_bytes: packageSizeBytes,
    sha256: selectedSha256,
    published_at: publishedAt,
    download_url: downloadUrl,
  };
}
