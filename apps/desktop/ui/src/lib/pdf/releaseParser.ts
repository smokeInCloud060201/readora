/// <reference types="vite/client" />
import { type ReleaseManifestDto } from "../../types/ipc";

export const DEFAULT_APP_VERSION: string =
  (import.meta.env.VITE_APP_VERSION as string | undefined)?.trim() || "1.1.1";

export function isValidSha256Hex(value: string | null | undefined): boolean {
  return /^[0-9a-f]{64}$/i.test((value ?? "").trim());
}

const ALLOWED_GITHUB_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

export function isAllowedGithubHttpsUrl(
  rawUrl: string | null | undefined,
): boolean {
  const trimmed = (rawUrl ?? "").trim();
  if (!trimmed.startsWith("https://")) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      ALLOWED_GITHUB_HOSTS.has(parsed.hostname.toLowerCase())
    );
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

export function parseGithubReleasePayload(
  rawJson: string,
  targetOs = "macos",
): ReleaseManifestDto {
  const parsed = JSON.parse(rawJson) as GithubReleasePayload;
  if (parsed.draft === true || parsed.prerelease === true) {
    throw new Error(
      "Draft and prerelease GitHub releases are not eligible for updates",
    );
  }

  const rawTag = (parsed.tag_name ?? "").trim();
  const version = rawTag.replace(/^[vV]/, "").trim();
  if (!version) {
    throw new Error("GitHub release payload is missing tag_name");
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

  let selectedSize = 0;
  let selectedUrl: string | null = null;
  let selectedSha256 = "";

  if (Array.isArray(parsed.assets)) {
    for (const asset of parsed.assets) {
      const nameLower = (asset.name ?? "").toLowerCase();
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
