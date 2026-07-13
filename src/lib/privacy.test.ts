import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { profile } from "./profile";

test("public profile omits exact birth date", () => {
  expect("dob" in profile).toBe(false);
});

test("published LinkedIn snapshot excludes private sections and identifiers", async () => {
  const snapshot = JSON.parse(await readFile("src/data/linkedin-about.json", "utf8")) as {
    sections?: Array<{ title?: string }>;
  };
  const titles = (snapshot.sections ?? []).map((section) => section.title);
  const serialized = JSON.stringify(snapshot);

  expect(titles).not.toContain("Projects");
  expect(titles).not.toContain("Certifications");
  expect(serialized).not.toMatch(/credential\s+id/i);
  expect(serialized).not.toMatch(/home.?lab/i);
  expect(serialized).not.toMatch(/[?&]rcm=/i);
});

test("published photos contain no EXIF payload", async () => {
  const exifMagic = Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
  const photos = [
    "public/photos/IMG_1673.jpeg",
    "public/photos/IMG_3040.jpeg",
    "public/photos/IMG_6264.JPG",
    "public/photos/IMG_8388.jpeg",
  ];

  for (const photo of photos) {
    const bytes = await readFile(photo);
    expect(bytes.indexOf(exifMagic), photo).toBe(-1);
  }
});
