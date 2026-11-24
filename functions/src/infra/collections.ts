import { db } from "./firebase";

/**
 * Every Firestore collection the backend uses, in one place. All data is server-only:
 * firestore.rules deny direct client access, so these functions are the only way in.
 */
export const col = {
  profiles: () => db().collection("profiles"),
  handles: () => db().collection("handles"),
  friendships: () => db().collection("friendships"),
  challenges: () => db().collection("challenges"),
  sharedPlans: () => db().collection("sharedPlans"),
  chats: () => db().collection("chats"),
  leagues: () => db().collection("leagues"),
  leagueOpen: () => db().collection("leagueOpen"),
  avatars: () => db().collection("avatars"),
  feedback: () => db().collection("feedback"),
  usage: () => db().collection("usage"),
  courseUnits: () => db().collection("courseUnits"),
  chatgptPending: () => db().collection("chatgptPending"),
  users: () => db().collection("users"),
  vocabTranslations: (lang: string) => db().collection("vocabTranslations").doc(lang).collection("words"),
};

/** profiles/{uid}/feed, profiles/{uid}/nudges */
export const feedOf = (uid: string) => col.profiles().doc(uid).collection("feed");
export const nudgesOf = (uid: string) => col.profiles().doc(uid).collection("nudges");
/** users/{uid}/devices, users/{uid}/private/chatgpt */
export const devicesOf = (uid: string) => col.users().doc(uid).collection("devices");
export const chatgptTokenDoc = (uid: string) => col.users().doc(uid).collection("private").doc("chatgpt");
