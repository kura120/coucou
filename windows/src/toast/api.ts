// Showing a toast from any page — the island, Settings, the desktop Mochi.
// The toasts' own window draws it (./main.ts); Rust carries it there and brings
// a decision's answer back (src-tauri/src/toast.rs).
//
//   showToast({ kind: "info", title: t("Copied") });
//   const answer = await askToast({ kind: "warning", title, text, actions: {} });
//   if (answer === "yes") …
//
// A toast never approves a Claude Code or Codex permission and never sends an
// email: those need a click on their own card.

import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI } from "../core/bridge";
import type { ToastAnswer, ToastSpec } from "./stack";

/** What a caller gives: everything but the id is up to the toast. */
export type ToastRequest = Omit<ToastSpec, "id"> & { id?: string };

/** Shows a toast; resolves with its id (null outside the app). */
export async function showToast(toast: ToastRequest): Promise<string | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<string>("toast_show", { toast: { ...toast, id: toast.id ?? "" } });
  } catch (err) {
    console.error("[coucou] toast_show failed", err);
    return null;
  }
}

/**
 * Shows a toast and resolves with how it ended: "yes" or "no" for a decision
 * (`actions` given), "dismissed" for anything else — closed, timed out, taken
 * back, or no app to show it in.
 */
export async function askToast(toast: ToastRequest): Promise<ToastAnswer> {
  if (!IS_TAURI) return "dismissed";
  try {
    return await invoke<ToastAnswer>("toast_ask", { toast: { ...toast, id: toast.id ?? "" } });
  } catch (err) {
    console.error("[coucou] toast_ask failed", err);
    return "dismissed";
  }
}

/** Takes a toast back before it ends by itself; whoever waits hears "dismissed". */
export async function dismissToast(id: string): Promise<void> {
  if (!IS_TAURI) return;
  await invoke("toast_dismiss", { id }).catch(() => {});
}
