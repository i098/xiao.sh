import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

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
