/**
 * What this package lets the rest of the system do, and why it is a package at
 * all.
 *
 * A token is minted in two places and verified in one. The gateway verifies
 * every bearer it is handed and mints a run's task-bound credential at
 * dispatch; the bot mints the manager agent's credential once per chat turn.
 * Those are two processes, and an application may not import another
 * application's source — so the signer lives here, beside neither of them, and
 * both hold the same one definition of what a token is.
 *
 * Nothing else is in this package on purpose. It knows the claim shape, the
 * signature and the ceiling each kind of actor may hold; it knows nothing about
 * HTTP, about a request, or about how a credential is presented. That is what
 * keeps "which actor may hold which scope" a single rule enforced at mint and
 * at verify, rather than a rule each caller re-applies.
 */

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
