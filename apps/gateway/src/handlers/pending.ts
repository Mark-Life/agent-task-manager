/**
 * The stand-in every unimplemented endpoint answers with.
 *
 * A group whose handlers do not exist yet is a group the server cannot mount,
 * and a server that will not start is a server nobody can develop the next
 * group against. So each endpoint is wired from the first commit and answers
 * 501 until its handler lands: the route table, the middleware, the spec and
 * the process are all real, and what is missing is missing out loud.
 *
 * It typechecks against every endpoint in the contract regardless of that
 * endpoint's success schema, because a handler may return an
 * `HttpServerResponse` in place of the declared body — including where the body
 * is a stream.
 */

import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

/** Status for an operation this build knows about and cannot yet perform. */
const NOT_IMPLEMENTED = 501;

/**
 * Answers one endpoint with 501 and the name of the operation, so a caller
 * reading a log or a response body learns which handler is missing rather than
 * that something is.
 */
export const pending = (operation: string) => () =>
  Effect.succeed(
    HttpServerResponse.text(`${operation} is not implemented yet`, {
      status: NOT_IMPLEMENTED,
    })
  );
