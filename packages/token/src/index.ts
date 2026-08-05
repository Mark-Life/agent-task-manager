/**
 * What this package lets the rest of the system do, and why it is a package at
 * all.
 *
 * A token is minted in three places and verified in one. The gateway verifies
 * every bearer it is handed and mints one for a dashboard request; the loop
 * mints an agent's credential once per turn, for a worker and a manager alike;
 * the bot mints one for the board buttons a person taps. Those are three
 * processes, and an application may not import another application's source —
 * so the signer lives here, beside none of them, and all three hold the same
 * one definition of what a token is.
 *
 * {@link mintAgentToken} is here for the same reason: "how a token for an agent
 * is made" is one answer, and the difference between the two roles is a
 * narrower binding of it rather than a second recipe.
 *
 * The sealer is here for the third time the same reason applies. A project's
 * environment files are encrypted with a key derived from the same root secret
 * under a different label, and the gateway seals what an operator types while
 * the loop opens it on the way into a container. Two processes, one derivation
 * — and a second module reading `BETTER_AUTH_SECRET` would be a second thing to
 * rotate.
 *
 * Nothing else is in this package on purpose. It knows the claim shape, the
 * signature, the ceiling each kind of actor may hold, and how a stored secret
 * is sealed; it knows nothing about HTTP, about a request, or about how a
 * credential is presented. That is what keeps "which actor may hold which
 * scope" a single rule enforced at mint and at verify, rather than a rule each
 * caller re-applies.
 */

export type {
  AgentBinding,
  AgentTokenInput,
  ManagerBinding,
  WorkerRunBinding,
} from "./actors";
export { DEFAULT_AGENT_TOKEN_TTL_MS, mintAgentToken } from "./actors";
export {
  makeSecretSealer,
  SEALED_KEY_VERSION,
  SECRET_FAILURES,
  type SealedSecret,
  SecretFailure,
  type SecretSealer,
  SecretUnreadable,
  secretSealerConfig,
  secretSealerFrom,
} from "./secrets";
export {
  type MintOptions,
  makeTokenSigner,
  TOKEN_REJECTIONS,
  TokenClaims,
  TokenRejected,
  TokenRejection,
  type TokenSigner,
  tokenSecretConfig,
  tokenSignerFrom,
} from "./tokens";
