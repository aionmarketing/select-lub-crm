/**
 * In-process events, for the cases where a producer should not know its
 * consumers.
 *
 * The rule this serves is in design.md D6: a cross-module effect is either a
 * call to a function on the owning module's `contracts/`, or an event whose
 * schema lives in the producer's `contracts/` — and for any pair of modules, at
 * most one of the two. Events are the minority case; a request to a transport
 * (`channel.enqueueOutbound`, `erp.enqueueWrite`) is a contract call, because
 * the caller does mean that particular module.
 *
 * Delivery is synchronous and in-process: `publish` awaits every subscriber, so
 * a handler that throws fails the publisher's transaction. That is deliberate
 * while everything runs in one process — an event that silently dropped would
 * be worse than one that fails loudly — and is the thing to revisit if a module
 * ever moves out.
 */
import type { z } from "zod";

/** A declared event: its name and the schema its payload is parsed with. */
export interface EventDefinition<T> {
  readonly name: string;
  readonly schema: z.ZodType<T>;
}

/** Receives a published payload. May be async; `publish` awaits it. */
export type Subscriber<T> = (payload: T) => Promise<void> | void;

const subscribers = new Map<string, Set<Subscriber<never>>>();

/**
 * Declares an event.
 *
 * @param name - `<module>/<event>`, e.g. `conversations/message-received`. The
 *   module prefix is what makes the owner greppable.
 * @param schema - Parsed on every publish, so a bad payload fails at the
 *   producer rather than inside some subscriber.
 * @returns The definition to publish and subscribe with.
 */
export function defineEvent<T>(name: string, schema: z.ZodType<T>): EventDefinition<T> {
  return { name, schema };
}

/**
 * Registers a subscriber.
 *
 * @param event - The definition, imported from the producer's `contracts/`.
 * @param subscriber - Called with the parsed payload on every publish.
 * @returns A function that removes this subscriber.
 */
export function subscribe<T>(event: EventDefinition<T>, subscriber: Subscriber<T>): () => void {
  const set = subscribers.get(event.name) ?? new Set();
  set.add(subscriber as Subscriber<never>);
  subscribers.set(event.name, set);
  return () => {
    set.delete(subscriber as Subscriber<never>);
  };
}

/**
 * Parses `payload` and delivers it to every subscriber, in registration order.
 *
 * @param event - The definition.
 * @param payload - Parsed by `event.schema` before anything is called.
 * @throws The schema's parse error, or whatever a subscriber threw.
 */
export async function publish<T>(event: EventDefinition<T>, payload: T): Promise<void> {
  const parsed = event.schema.parse(payload);
  for (const subscriber of subscribers.get(event.name) ?? []) {
    await (subscriber as Subscriber<T>)(parsed);
  }
}

/**
 * Collects everything published on `event` while `fn` runs, for a test that
 * asserts a slice emitted something rather than asserting on its consumer.
 *
 * @param event - The definition to watch.
 * @param fn - Run with the collector subscribed; unsubscribed afterwards
 *   whatever the outcome.
 * @returns The payloads, in publish order.
 */
export async function capture<T>(event: EventDefinition<T>, fn: () => Promise<void>): Promise<T[]> {
  const seen: T[] = [];
  const off = subscribe(event, (payload) => {
    seen.push(payload);
  });
  try {
    await fn();
  } finally {
    off();
  }
  return seen;
}

/** Drops every subscriber. For a test that must not leak a handler into the next file. */
export function resetSubscribers(): void {
  subscribers.clear();
}
