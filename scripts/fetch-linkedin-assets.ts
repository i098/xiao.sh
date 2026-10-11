import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { projects } from "../src/lib/projects";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const OUTPUT_ROOT = path.join(process.cwd(), "public", "projects", "choices");

type DownloadedAsset = {
  file: string;
  sourceUrl: string;
  bytes: number;
};

type ProjectAssetManifest = {
  title: string;
  githubUrl: string;
  linkedinUrl: string;
  slug: string;
  assets: DownloadedAsset[];
};

function decodeHtml(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function toGithubSlug(githubUrl: string) {
  const match = githubUrl.match(/github\.com\/([^/]+)\/([^/?#]+)/i);
  if (!match) return githubUrl.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

  const owner = match[1].toLowerCase();
  const repo = match[2].toLowerCase();
  return `${owner}-${repo}`;
}

function uniqueInOrder(values: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }

  return out;
}

function normalizeForDedup(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url;
  }
}

function extractPostMediaUrls(html: string) {
  const matches = html.match(/https:\/\/media\.licdn\.com\/[^"'\s<)]+/g) ?? [];
  const decoded = matches.map((value) => decodeHtml(value));

  const keep = decoded
    .filter((url) => url.includes("/dms/image/"))
    .filter(
      (url) =>
        url.includes("feedshare-") ||
        url.includes("articleshare-") ||
        url.includes("video-shrink_"),
    )
    .filter(
      (url) =>
        !url.includes("profile-displayphoto") &&
        !url.includes("profile-displaybackgroundimage") &&
        !url.includes("company-logo"),
    );

  const dedupeMap = new Map<string, string>();
  for (const url of keep) {
    const key = normalizeForDedup(url);
    if (!dedupeMap.has(key)) dedupeMap.set(key, url);
  }

  return uniqueInOrder([...dedupeMap.values()]);
}

function getExtension(contentType: string, sourceUrl: string) {
  const lowerType = contentType.toLowerCase();
  if (lowerType.includes("image/png")) return ".png";
  if (lowerType.includes("image/webp")) return ".webp";
  if (lowerType.includes("image/jpeg") || lowerType.includes("image/jpg")) return ".jpg";

  const clean = sourceUrl.split("?")[0].toLowerCase();
  if (clean.endsWith(".png")) return ".png";
  if (clean.endsWith(".webp")) return ".webp";
  if (clean.endsWith(".jpeg") || clean.endsWith(".jpg")) return ".jpg";

  return ".jpg";
}

async function fetchText(url: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.text();
}

async function downloadImage(url: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: "https://www.linkedin.com/",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = getExtension(response.headers.get("content-type") ?? "", url);
  return { buffer, extension };
}

async function main() {
  await mkdir(OUTPUT_ROOT, { recursive: true });

  const linkedinProjects = projects.filter(
    (project): project is (typeof project) & { linkedinUrl: string; githubUrl: string } => Boolean(project.linkedinUrl && project.githubUrl),
  );

  const manifest: ProjectAssetManifest[] = [];

  for (const project of linkedinProjects) {
    const slug = toGithubSlug(project.githubUrl);
    const projectDir = path.join(OUTPUT_ROOT, slug);
    await mkdir(projectDir, { recursive: true });

    try {
      const html = await fetchText(project.linkedinUrl);
      const mediaUrls = extractPostMediaUrls(html);
      const assets: DownloadedAsset[] = [];

      let index = 1;
      for (const mediaUrl of mediaUrls) {
        try {
          const { buffer, extension } = await downloadImage(mediaUrl);
          const file = `${String(index).padStart(2, "0")}${extension}`;
          await writeFile(path.join(projectDir, file), buffer);
          assets.push({
            file: `/projects/choices/${slug}/${file}`,
            sourceUrl: mediaUrl,
            bytes: buffer.byteLength,
          });
          index += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`skip ${project.title} ${mediaUrl} (${message})`);
        }
      }

      manifest.push({
        title: project.title,
        githubUrl: project.githubUrl,
        linkedinUrl: project.linkedinUrl,
        slug,
        assets,
      });

      console.log(`${project.title}: downloaded ${assets.length} images`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`${project.title}: failed (${message})`);
      manifest.push({
        title: project.title,
        githubUrl: project.githubUrl,
        linkedinUrl: project.linkedinUrl,
        slug,
        assets: [],
      });
    }
  }

  const manifestPath = path.join(OUTPUT_ROOT, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`wrote ${manifestPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
