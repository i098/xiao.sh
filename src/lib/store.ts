import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Persistent key/value store for runtime data (visit counter, question tally, Spotify
// history). Keys are .data-relative file names, so local disk and the Cloudflare KV
// namespace hold the same keys and a .data copy maps 1:1 onto KV.
// Default: files under ./.data (Bun server, local dev). The Worker swaps in its KV binding.
export type Store = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

const DIR = path.join(process.cwd(), ".data");

let store: Store = {
  get: (key) => readFile(path.join(DIR, key), "utf8").catch(() => null),
  async put(key, value) {
    const file = path.join(DIR, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, value);
  },
};

export function useStore(next: Store): void {
  store = next;
}

export const get = (key: string) => store.get(key);
export const put = (key: string, value: string) => store.put(key, value);
