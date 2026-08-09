/**
 * Who is allowed to work on a subject, and what becomes of the runs a dead
 * process left behind.
 *
 * A subject is a task or a conversation, and the claim is the same either way:
 * one worker on a card, one live turn in a thread. Keying by
 * {@link subjectFileNameOf} rather than by a task id is what lets a chat turn
 * have a durable claim at all — without it, two loops on one data root would
 * both answer the same message.
 *
 * A claim is two things at once, and it has to be, because they answer
 * different questions. The in-memory set answers "is this process already
 * working on that subject", which a notify and a poll arriving together ask
 * many times a minute and which must never touch a disk. The file under the
 * data root answers "was anybody working on it when the power went out", which
 * is asked exactly once, at boot, and can only be answered by something that
 * outlived the process.
 *
 * The file is heartbeated rather than merely written, and that is the whole
 * mechanism behind "kill the loop mid-run and it recovers on restart". Nothing
 * about a crash is distinguishable from a very slow loop except the passage of
 * time, so a lease whose last beat is older than the staleness threshold is
 * treated as belonging to a process that is gone. The threshold is three
 * heartbeats rather than one for the same reason: reclaiming a live run's lease
 * would put two containers on one artifacts directory, which is the exact
 * failure the lease exists to prevent.
 *
 * Every write is a temp file and a rename. A half-written lease is worse than
 * no lease at all — it decodes to nothing, so the task reads as free while a
 * container is working on it.
 *
 * {@link reconcileLostRuns} is the same argument on the database side. A run
 * row still marked live at boot has no container behind it, because this
 * process has only just started, unless a lease that is still being heartbeated
 * says another loop has it. Everything else closes as `lost`: a start with no
 * terminus is a countable run or it is nothing at all, and nothing at all is a
 * task waiting forever on a spinner.
 */

import { join } from "node:path";
import { RunRepo, withActor } from "@workspace/db";
import {
  Actor,
  type Run,
  RunId,
  RunSubject,
  type WorkspaceId,
} from "@workspace/domain";
import { hostRunLayout } from "@workspace/harness";
import {
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import { FileSystem } from "effect/FileSystem";
import { orchestratorConfig } from "./config";
import {
  errorFieldsOf,
  lostTerminus,
  outcomeOfTerminus,
  type RunLost,
} from "./dispatch-context";
import { AlreadyLive, DispatchFailed, LeaseReclaimFailed } from "./errors";
import { subjectFileNameOf, subjectKeyOf, subjectOfRow } from "./subject";

/** Directory under the data root holding one lease file per claimed subject. */
export const LEASES_SEGMENT = "leases";

/** What a lease file is called, and what a directory listing filters on. */
const LEASE_SUFFIX = ".json";

/** Where every lease this loop holds lives. */
export const leasesDirOf = (dataRoot: string) => join(dataRoot, LEASES_SEGMENT);

/** Names one subject's lease. */
export interface LeasePathInput {
  readonly dataRoot: string;
  readonly subject: RunSubject;
}

/**
 * A subject's lease file. Keyed by the subject rather than by the run because
 * the claim is made before the run row exists, and because "one run per task
 * and one turn per thread" is the invariant being defended. The name carries
 * the kind as well as the id, so a task and a conversation can never collide
 * even if a uuid somehow did.
 */
export const leasePathOf = ({ dataRoot, subject }: LeasePathInput) =>
  join(leasesDirOf(dataRoot), `${subjectFileNameOf(subject)}${LEASE_SUFFIX}`);

/**
 * What one loop wrote to say it is working on a task.
 *
 * The two timestamps are epoch millis rather than ISO strings because the only
 * thing ever done with them is arithmetic against a staleness threshold, and a
 * parse step between the file and that comparison is where a timezone bug
 * lives. What a human reading the file wants is on it anyway: the process that
 * holds it, and the run it turned into.
 */
export const LeaseRecord = Schema.Struct({
  claimedAtMs: Schema.Number,
  /** Stamped on an interval. Freshness against the staleness threshold is what liveness means. */
  heartbeatAtMs: Schema.Number,
  /** Which loop process holds it — minted per process, so a restart never inherits its own lease. */
  instanceId: Schema.String,
  /** The holder's OS process id, so a crash on this host is reclaimable before the threshold. */
  pid: Schema.Int,
  /** Null between the claim and the run row, which is a real window and not a missing value. */
  runId: Schema.NullOr(RunId),
  /** The task or the conversation this claim is on. */
  subject: RunSubject,
});

/** A lease as it is held in memory and on disk. */
export interface LeaseRecord extends Schema.Schema.Type<typeof LeaseRecord> {}

/** Reads a lease file. Absent, unreadable and malformed all mean "no lease". */
const decodeLease = Schema.decodeUnknownOption(
  Schema.fromJsonString(LeaseRecord)
);

/** Writes a lease. Trusted construction: every record encoded here was built above. */
const encodeLease = Schema.encodeSync(Schema.fromJsonString(LeaseRecord));

/**
 * Whether a process is still running. Signal 0 asks the kernel without touching
 * the process; `EPERM` means it exists and belongs to somebody else, which is
 * still alive.
 */
const defaultPidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * The liveness probe, as a reference with a working default so nothing has to
 * wire it. A test overrides it to make a crash happen on demand, which is the
 * one thing a real probe cannot be asked to do.
 */
export const PidAlive = Context.Reference<(pid: number) => boolean>(
  "@workspace/orchestrator/PidAlive",
  { defaultValue: () => defaultPidAlive }
);

/** Whether this loop still holds a lease it claimed. */
export const LEASE_STATES = ["held", "lost"] as const;

/**
 * `lost` means the file now names another holder, or this process never had the
 * lease to begin with. A write that failed is not loss — the run keeps going
 * and the lease goes stale on its own, which is the case reclaim already
 * handles.
 */
export type LeaseState = (typeof LEASE_STATES)[number];

/** What identifies a lease to every operation below. */
export interface LeaseRef {
  readonly subject: RunSubject;
}

/** Stamps the run a claim turned into onto the lease that is holding it. */
export interface LeaseAttachInput extends LeaseRef {
  readonly runId: RunId;
}

/** The durable claim on a task, plus the in-flight set for this process. */
export interface LeaseStoreInterface {
  /**
   * Records the run this lease is now working on. Null when this process does
   * not hold the lease, which is the honest answer to a stamp arriving late.
   */
  readonly attach: (
    input: LeaseAttachInput
  ) => Effect.Effect<LeaseRecord | null, DispatchFailed>;
  /**
   * Takes the subject, unless this process is already on it or a live lease
   * says another loop is. The refusal is {@link AlreadyLive} because that is
   * what the dispatcher does with it: skip and move to the next one.
   */
  readonly claim: (
    input: LeaseRef
  ) => Effect.Effect<LeaseRecord, AlreadyLive | DispatchFailed>;
  /** Stamps the lease so another loop can see it is alive. Never fails. */
  readonly heartbeat: (input: LeaseRef) => Effect.Effect<LeaseState>;
  /** The subject keys this process is working on right now. */
  readonly held: Effect.Effect<ReadonlySet<string>>;
  /** This loop's identity, and the `loopInstance` its audit rows carry. */
  readonly instanceId: string;
  /** Whether a lease found on disk still has a process behind it. */
  readonly isLive: (lease: LeaseRecord) => Effect.Effect<boolean>;
  /** Every lease still being heartbeated, this process's own included. */
  readonly liveLeases: Effect.Effect<
    readonly LeaseRecord[],
    LeaseReclaimFailed
  >;
  /**
   * Deletes every lease whose holder is gone and returns what was reclaimed.
   * Fatal when it cannot: a loop that cannot see the old leases cannot tell a
   * crashed run from a live one.
   */
  readonly reclaimStale: Effect.Effect<
    readonly LeaseRecord[],
    LeaseReclaimFailed
  >;
  /** Gives the task back. Idempotent, and never fails. */
  readonly release: (input: LeaseRef) => Effect.Effect<void>;
  /**
   * Claims the subject, heartbeats it for as long as the work runs, and gives
   * it back on every exit path — a failure, a defect, and the interrupt a SIGINT
   * turns into. The one form that cannot leak a claim.
   */
  readonly withLease: <A, E, R>(
    input: LeaseRef,
    work: (lease: LeaseRecord) => Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | AlreadyLive | DispatchFailed, R>;
}

/**
 * Logs a failure this path is committed to surviving, then continues. Named
 * rather than inlined so every deliberate loss in this file is greppable and
 * none of them are silent.
 */
const bestEffort =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapCause((cause) => Effect.logWarning(operation, cause)),
      Effect.ignoreCause
    );

const make = Effect.gen(function* () {
  const fs = yield* FileSystem;
  const { dataRoot, leaseHeartbeatMs, leaseStaleMs } =
    yield* orchestratorConfig;

  // Minted per process, so a restart can never mistake a lease it wrote before
  // the crash for one it is holding now.
  const instanceId = yield* Effect.sync(() => crypto.randomUUID());

  const claims = yield* Ref.make<ReadonlyMap<string, LeaseRecord>>(new Map());

  // Claiming is read-then-write against the filesystem, so two fibers reaching
  // it for one task would both find it free. One permit makes the whole
  // decision serial, which costs nothing next to a container start.
  const gate = yield* Semaphore.make(1);

  const pathOf = (subject: RunSubject) => leasePathOf({ dataRoot, subject });

  const reclaimFailed = (detail: string) => (cause: unknown) =>
    new LeaseReclaimFailed({ cause, detail });

  /**
   * Temp file, then rename. The temp name is unique per write, so a heartbeat
   * and an attach racing on one task cannot land in each other's partial file.
   */
  const writeLease = (lease: LeaseRecord) =>
    Effect.gen(function* () {
      const path = pathOf(lease.subject);
      yield* fs.makeDirectory(leasesDirOf(dataRoot), { recursive: true });
      const temp = `${path}.${crypto.randomUUID()}.tmp`;
      yield* fs.writeFileString(temp, encodeLease(lease));
      yield* fs.rename(temp, path);
    });

  const remember = (lease: LeaseRecord) =>
    Ref.update(claims, (current) =>
      new Map(current).set(subjectKeyOf(lease.subject), lease)
    ).pipe(Effect.as(lease));

  const readLease = (input: LeaseRef) =>
    fs.readFileString(pathOf(input.subject)).pipe(
      Effect.map((text) => Option.getOrNull(decodeLease(text))),
      Effect.orElseSucceed(() => null)
    );

  const isLive = Effect.fnUntraced(function* (lease: LeaseRecord) {
    const now = yield* Clock.currentTimeMillis;
    if (now - lease.heartbeatAtMs >= leaseStaleMs) {
      return false;
    }
    // Our own lease is live by definition — this process is the thing asking.
    if (lease.instanceId === instanceId) {
      return true;
    }
    // Leases and run directories share one local data root, so the pid on the
    // file belongs to this host and a crash is reclaimable at once rather than
    // three heartbeats later. A recycled pid can only make the answer more
    // conservative, and only inside the freshness window.
    const alive = yield* PidAlive;
    return alive(lease.pid);
  });

  const claimExclusive = Effect.fnUntraced(function* (input: LeaseRef) {
    const key = subjectKeyOf(input.subject);
    const mine = (yield* Ref.get(claims)).get(key);
    if (mine !== undefined) {
      return yield* Effect.fail(
        new AlreadyLive({ runId: mine.runId, subject: input.subject })
      );
    }
    const found = yield* readLease(input);
    if (found !== null && (yield* isLive(found))) {
      return yield* Effect.fail(
        new AlreadyLive({ runId: found.runId, subject: input.subject })
      );
    }
    const nowMs = yield* Clock.currentTimeMillis;
    const lease: LeaseRecord = {
      claimedAtMs: nowMs,
      heartbeatAtMs: nowMs,
      instanceId,
      pid: process.pid,
      runId: null,
      subject: input.subject,
    };
    yield* writeLease(lease).pipe(
      Effect.mapError(
        (cause) =>
          new DispatchFailed({
            cause,
            detail: "the lease file could not be written",
            subject: input.subject,
          })
      )
    );
    return yield* remember(lease);
  });

  const claim = Effect.fn("LeaseStore.claim")(function* (input: LeaseRef) {
    return yield* gate.withPermit(claimExclusive(input));
  });

  const attach = Effect.fn("LeaseStore.attach")(function* (
    input: LeaseAttachInput
  ) {
    const mine = (yield* Ref.get(claims)).get(subjectKeyOf(input.subject));
    if (mine === undefined) {
      return null;
    }
    const stamped: LeaseRecord = { ...mine, runId: input.runId };
    yield* writeLease(stamped).pipe(
      Effect.mapError(
        (cause) =>
          new DispatchFailed({
            cause,
            detail: "the run could not be stamped onto the lease",
            subject: input.subject,
          })
      )
    );
    return yield* remember(stamped);
  });

  const heartbeat = Effect.fn("LeaseStore.heartbeat")(function* (
    input: LeaseRef
  ) {
    const mine = (yield* Ref.get(claims)).get(subjectKeyOf(input.subject));
    if (mine === undefined) {
      return "lost" as const;
    }
    const found = yield* readLease(input);
    if (found !== null && found.instanceId !== instanceId) {
      return "lost" as const;
    }
    // A lease that has gone missing is rewritten rather than mourned: this
    // process still holds it in memory and a container is still working.
    const beaten: LeaseRecord = {
      ...mine,
      heartbeatAtMs: yield* Clock.currentTimeMillis,
    };
    yield* writeLease(beaten).pipe(bestEffort("lease heartbeat not written"));
    yield* remember(beaten);
    return "held" as const;
  });

  const release = Effect.fn("LeaseStore.release")(function* (input: LeaseRef) {
    // Memory first: a delete that fails leaves a file that goes stale and is
    // reclaimed at the next boot, whereas a task left in the in-flight set is
    // a slot this process never offers again.
    yield* Ref.update(claims, (current) => {
      const next = new Map(current);
      next.delete(subjectKeyOf(input.subject));
      return next;
    });
    yield* fs
      .remove(pathOf(input.subject), { force: true })
      .pipe(bestEffort("lease file not removed"));
  });

  const listLeases = Effect.fnUntraced(function* () {
    const directory = leasesDirOf(dataRoot);
    const present = yield* fs
      .exists(directory)
      .pipe(
        Effect.mapError(reclaimFailed("the lease directory is unreadable"))
      );
    if (!present) {
      return [] as LeaseRecord[];
    }
    const entries = yield* fs
      .readDirectory(directory)
      .pipe(
        Effect.mapError(reclaimFailed("the lease directory is unreadable"))
      );
    const found: LeaseRecord[] = [];
    for (const name of entries) {
      // Anything else under here is a temp file from a write that died between
      // the two syscalls, and reading it is how a partial record gets believed.
      if (!name.endsWith(LEASE_SUFFIX)) {
        continue;
      }
      const text = yield* fs
        .readFileString(join(directory, name))
        .pipe(Effect.orElseSucceed(() => ""));
      const decoded = decodeLease(text);
      if (Option.isSome(decoded)) {
        found.push(decoded.value);
      }
    }
    return found;
  });

  const reclaimStale = Effect.fn("LeaseStore.reclaimStale")(function* () {
    const reclaimed: LeaseRecord[] = [];
    for (const lease of yield* listLeases()) {
      if (yield* isLive(lease)) {
        continue;
      }
      yield* fs
        .remove(pathOf(lease.subject), { force: true })
        .pipe(
          Effect.mapError(
            reclaimFailed(
              `the stale lease for ${subjectKeyOf(lease.subject)} is stuck`
            )
          )
        );
      reclaimed.push(lease);
    }
    return reclaimed;
  });

  const liveLeases = Effect.fn("LeaseStore.liveLeases")(function* () {
    const live: LeaseRecord[] = [];
    for (const lease of yield* listLeases()) {
      if (yield* isLive(lease)) {
        live.push(lease);
      }
    }
    return live;
  });

  const beat = (input: LeaseRef) =>
    heartbeat(input).pipe(Effect.repeat(Schedule.spaced(leaseHeartbeatMs)));

  const withLease = <A, E, R>(
    input: LeaseRef,
    work: (lease: LeaseRecord) => Effect.Effect<A, E, R>
  ) =>
    Effect.gen(function* () {
      const lease = yield* Effect.acquireRelease(claim(input), () =>
        release(input)
      );
      // Forked into the same scope, so it stops with the work it is vouching
      // for and never outlives the claim it keeps alive.
      yield* Effect.forkScoped(beat(input));
      return yield* work(lease);
    }).pipe(Effect.scoped);

  return LeaseStore.of({
    attach,
    claim,
    heartbeat,
    held: Ref.get(claims).pipe(
      Effect.map((current) => new Set(current.keys()))
    ),
    instanceId,
    isLive,
    liveLeases: liveLeases(),
    reclaimStale: reclaimStale(),
    release,
    withLease,
  });
});

/**
 * The claim on a task: the in-flight set this process reasons with, and the
 * file that outlives it.
 */
export class LeaseStore extends Context.Service<
  LeaseStore,
  LeaseStoreInterface
>()("@workspace/orchestrator/LeaseStore") {
  static readonly layer = Layer.effect(LeaseStore, make);
}

/** A run the database still believed was live, and the ending it was given. */
export interface LostRun {
  readonly run: Run;
  readonly terminus: RunLost;
}

/** What the startup reconcile needs: a workspace to sweep and a data root to read. */
export interface ReconcileInput {
  readonly dataRoot: string;
  readonly workspaceId: WorkspaceId;
}

/**
 * How far the run's stream got before it stopped. Read off the file the
 * container appended to, because it is the one thing that tells a container
 * that never started from one that died halfway. Unreadable counts as none: an
 * absent file is a run that produced nothing, which is the same fact.
 */
const eventsSeenOf = (input: { dataRoot: string; runId: RunId }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const text = yield* fs.readFileString(hostRunLayout(input).eventLogPath);
    return text.split("\n").filter((line) => line.trim().length > 0).length;
  }).pipe(Effect.orElseSucceed(() => 0));

/**
 * Closes out every run this loop knows nobody is working on, and says which
 * ones it closed.
 *
 * Called at boot, and safe to call at any other time. The reclaim comes first
 * and is part of the same operation on purpose: the two steps are only correct
 * in that order — leases are cleared, and what survives is the set of tasks
 * some live loop is still heartbeating — and splitting them across two calls
 * would make the ordering a convention somebody eventually gets wrong.
 *
 * Closing the run row is the whole of the job. Moving the task to *review*,
 * posting the crash message and emitting the `atm.run` row for the ending are
 * the terminal path's, which is why the closed runs come back rather than being
 * quietly filed: the caller runs each of them through the same terminus
 * handling a run that died in front of it would get.
 */
export const reconcileLostRuns = Effect.fn("Lease.reconcileLostRuns")(
  function* (input: ReconcileInput) {
    const leases = yield* LeaseStore;
    const runs = yield* RunRepo;

    yield* leases.reclaimStale;
    const guarded = new Set(
      (yield* leases.liveLeases).map((lease) => subjectKeyOf(lease.subject))
    );

    // The reconcile is not about one run, so the actor names the loop and no
    // attempt — which is exactly the case the orchestrator actor's optional
    // `runId` exists for.
    const actor = Actor.cases.orchestrator.make({
      loopInstance: leases.instanceId,
    });

    const lost: LostRun[] = [];
    for (const run of yield* runs.listLive({
      workspaceId: input.workspaceId,
    })) {
      const subject = subjectOfRow(run);
      // A run whose columns name nothing at all cannot be attributed, so it
      // cannot be guarded either; closing it is still the right answer.
      if (subject !== null && guarded.has(subjectKeyOf(subject))) {
        continue;
      }
      const terminus = lostTerminus({
        eventsSeen: yield* eventsSeenOf({
          dataRoot: input.dataRoot,
          runId: run.id,
        }),
        exitCode: run.exitCode,
        finalText: "",
        providerSessionId: null,
      });
      const fields = errorFieldsOf(terminus);
      const closed = yield* runs
        .close({
          errorClass: fields.errorClass ?? undefined,
          errorMessage: fields.errorMessage ?? undefined,
          id: run.id,
          outcome: outcomeOfTerminus(terminus),
          workspaceId: input.workspaceId,
        })
        .pipe(
          withActor(actor),
          // Somebody closed it between the read and the write, which is the one
          // failure here that means the work is already done.
          Effect.catchTag("RunRepo.NotLive", () => Effect.succeed(null))
        );
      if (closed !== null) {
        lost.push({ run: closed, terminus });
      }
    }
    return lost;
  }
);
