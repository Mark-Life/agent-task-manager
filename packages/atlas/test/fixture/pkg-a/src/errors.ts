import { Schema } from "effect";

/** Tagged, so the node id is the tag rather than the file it lives in. */
export class NotFound extends Schema.TaggedErrorClass<NotFound>()(
  "Fixture.NotFound",
  { id: Schema.String }
) {}

export class Denied extends Schema.TaggedErrorClass<Denied>()(
  "Fixture.Denied",
  { reason: Schema.String }
) {}
