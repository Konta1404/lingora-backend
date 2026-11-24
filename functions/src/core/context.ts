/** Who is calling. Built by the transport adapter from the verified Firebase ID token. */
export interface CallContext {
  uid: string | null;
  email?: string;
}

/** A caller that is signed in. */
export interface UserContext {
  uid: string;
  email?: string;
}
