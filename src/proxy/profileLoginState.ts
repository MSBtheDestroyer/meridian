import { authLifecycleLoggedOut, observeCredentialInBackground } from "./authLifecycle"
import type { ClaudeAuthStatus } from "./models"
import type { ResolvedProfile } from "./profiles"
import { createPlatformCredentialStore, readStoredCredentialSnapshot, type CredentialStore, type StoredCredentialPresence } from "./tokenRefresh"

export type ProfileLoginState = "authenticated" | "needs_login" | "unverified"

/**
 * One login state for every surface that reports it. `loggedOut` is the
 * login history's verdict (authLifecycle.ts `authLifecycleLoggedOut`): a
 * refused renewal counts only once the access token it left has run out.
 */
export function profileLoginState(input: {
  readonly loggedIn?: boolean
  readonly presence?: StoredCredentialPresence
  readonly loggedOut?: boolean
}): ProfileLoginState {
  if (input.loggedOut || input.presence === "absent" || input.loggedIn === false) return "needs_login"
  return input.loggedIn === true ? "authenticated" : "unverified"
}

/** `claude auth status` corrected by what the stored credential and its login history say. */
export async function reconcileClaudeProfileAuth(
  auth: ClaudeAuthStatus | null,
  profile: ResolvedProfile,
  store?: CredentialStore,
): Promise<ClaudeAuthStatus | null> {
  if (profile.type !== "claude-max") return auth
  const profileStore = store ?? createPlatformCredentialStore({ claudeConfigDir: profile.env.CLAUDE_CONFIG_DIR })
  const stored = await readStoredCredentialSnapshot(profileStore)
  const lifecycle = observeCredentialInBackground(profileStore.refreshKey, stored)
  const loggedOut = authLifecycleLoggedOut(lifecycle, stored.accessTokenExpiresAt, Date.now())
  const state = profileLoginState({ loggedIn: auth?.loggedIn, presence: stored.presence, loggedOut })
  return state === "needs_login" ? { ...auth, loggedIn: false } : auth
}
