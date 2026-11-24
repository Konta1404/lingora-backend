/**
 * The public API: every callable the app uses, by name. Names and payloads are a contract with the
 * shipped iOS app — add new callables freely, but never rename or remove one.
 */
import * as ai from "../modules/ai/handlers";
import * as chatgpt from "../modules/chatgpt/handlers";
import { courseUnit } from "../modules/course/course-unit";
import * as social from "../modules/social.handlers";
import * as vocab from "../modules/vocab/handlers";
import { CallableDef } from "./define";

export const callables = {
  // AI on the user's own ChatGPT plan
  weeklyPlan: ai.weeklyPlan,
  adaptToday: ai.adaptToday,
  lesson: ai.lesson,
  checkWriting: ai.checkWriting,
  tutorTurn: ai.tutorTurn,
  correctMessage: ai.correctMessage,
  explainAnswer: ai.explainAnswer,
  callFeedback: ai.callFeedback,
  courseUnit,
  translateWords: vocab.translateWords,
  checkTranslation: vocab.checkTranslation,

  // Sign in with ChatGPT
  chatgptAuthStart: chatgpt.chatgptAuthStart,
  chatgptAuthFinish: chatgpt.chatgptAuthFinish,
  chatgptStatus: chatgpt.chatgptStatus,
  chatgptDisconnect: chatgpt.chatgptDisconnect,

  // Profile
  profileSync: social.profileSync,
  setHandle: social.setHandle,
  setPrivacy: social.setPrivacy,
  setAvatar: social.setAvatar,
  publicProfile: social.publicProfile,
  reportActivity: social.reportActivity,
  leagueStatus: social.leagueStatus,
  sendFeedback: social.sendFeedback,

  // Friends
  searchUsers: social.searchUsers,
  matchContacts: social.matchContacts,
  sendFriendRequest: social.sendFriendRequest,
  respondFriendRequest: social.respondFriendRequest,
  removeFriend: social.removeFriend,
  friendsOverview: social.friendsOverview,
  cheer: social.cheer,
  nudge: social.nudge,
  markNudgesSeen: social.markNudgesSeen,

  // Challenges & shared plans
  createChallenge: social.createChallenge,
  respondChallenge: social.respondChallenge,
  leaveChallenge: social.leaveChallenge,
  sharePlan: social.sharePlan,
  getSharedPlan: social.getSharedPlan,

  // Chat
  chatMessages: social.chatMessages,
  sendChatMessage: social.sendChatMessage,

  // Devices
  registerDevice: social.registerDevice,
  listDevices: social.listDevices,
  removeDevice: social.removeDevice,
} satisfies Record<string, CallableDef>;

export type CallableName = keyof typeof callables;
export const callableNames = Object.keys(callables) as CallableName[];
