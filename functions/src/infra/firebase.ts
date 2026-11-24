import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Firestore } from "firebase-admin/firestore";

/**
 * Initialises the Admin SDK once. On Firebase it needs no config; elsewhere (Render, Docker) the
 * service-account JSON comes from FIREBASE_SERVICE_ACCOUNT.
 */
export function initFirebase(): void {
  if (getApps().length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    initializeApp();
    return;
  }
  const account = JSON.parse(raw) as { project_id?: string };
  if (!process.env.GCLOUD_PROJECT && account.project_id) process.env.GCLOUD_PROJECT = account.project_id;
  initializeApp({ credential: cert(account as Parameters<typeof cert>[0]) });
}

let firestoreOverride: Firestore | null = null;

/** Swaps in another Firestore (tests use an in-memory one). Pass null to restore the real one. */
export function useFirestore(f: Firestore | null): void {
  firestoreOverride = f;
}

export const db = (): Firestore => firestoreOverride ?? getFirestore();
export const auth = () => getAuth();
