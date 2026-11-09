/**
 * The two-armed return a slice's rules use instead of throwing for outcomes the
 * caller is expected to handle.
 *
 * A thrown error is for something that should not have happened; a `Result` is
 * for something that legitimately can (the plate is not in the ledger, the
 * quote has no lines). Keeping the two apart is what lets a handler map a
 * failure to a status code without catching exceptions it did not mean to.
 */

/** The work succeeded and produced `value`. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/** The work did not succeed, for the stated reason. */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/** Either arm. */
export type Result<T, E> = Ok<T> | Err<E>;

/** Wraps a value as the success arm. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** Wraps a reason as the failure arm. */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Narrows to the success arm. */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

/** Narrows to the failure arm. */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}
