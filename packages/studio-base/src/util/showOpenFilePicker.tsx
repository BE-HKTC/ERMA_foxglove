// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import Logger from "@foxglove/log";

const log = Logger.getLogger(__filename);

/**
 * A wrapper around window.showOpenFilePicker that returns an empty array instead of throwing when
 * the user cancels the file picker.
 */
export default async function showOpenFilePicker(
  options?: OpenFilePickerOptions,
): Promise<FileSystemFileHandle[] /* foxglove-depcheck-used: @types/wicg-file-system-access */> {
  if (typeof window.showOpenFilePicker === "function") {
    try {
      log.debug("showOpenFilePicker: using native picker");
      return await window.showOpenFilePicker(options);
    } catch (err) {
      if ((err as DOMException).name === "AbortError") {
        log.debug("showOpenFilePicker: user cancelled");
        return [];
      }
      log.error("showOpenFilePicker: native picker failed", err);
      throw err;
    }
  }

  log.debug("showOpenFilePicker: using input fallback");
  return new Promise<FileSystemFileHandle[]>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = options?.multiple ?? false;

    if (options?.types) {
      const accept: string[] = [];
      for (const type of options.types) {
        for (const exts of Object.values(type.accept)) {
          accept.push(...exts);
        }
      }
      if (accept.length > 0) {
        input.accept = accept.join(",");
      }
    }

    const cleanup = () => {
      window.removeEventListener("focus", onFocus);
      input.remove();
    };

    const onFocus = () => {
      // When the file dialog closes without selecting a file, no change event is fired.
      // We detect this by waiting for focus to return to the window and checking if any
      // files were selected.
      setTimeout(() => {
        if (!input.files || input.files.length === 0) {
          log.debug("showOpenFilePicker: fallback cancelled");
          cleanup();
          resolve([]);
        }
      }, 0);
    };

    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      log.debug("showOpenFilePicker: selected", files.map((f) => f.name));
      cleanup();
      resolve(
        files.map((file) => ({
          kind: "file",
          name: file.name,
          // Only the getFile method is used by callers.
          getFile: async () => file,
        })) as unknown as FileSystemFileHandle[],
      );
    });

    window.addEventListener("focus", onFocus, { once: true });
    input.click();
  });
}
