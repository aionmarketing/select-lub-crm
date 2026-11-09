/**
 * The shared kernel: the few vocabulary items more than one module needs, and
 * that belong to none of them.
 *
 * The bar for adding something here is high. A type two modules happen to use
 * is not shared kernel — it belongs to whichever module owns the data, exported
 * from its `contracts/`. What lives here is vocabulary the domain itself
 * shares: how a phone number is written down, what a message's origin can be,
 * how an id is made. `utils`, `helpers`, `common`, `types`, `misc` and `lib`
 * are banned names precisely so this folder does not become one of them.
 */
export {
  MESSAGE_ORIGIN_LIVE,
  MESSAGE_ORIGIN_SEED,
  MESSAGE_ORIGINS,
  type MessageOrigin,
} from "./message-origin.js";
export { canonicalPhone, isCanonicalPhone } from "./phone.js";
export { newId } from "./ids.js";
export {
  SAO_PAULO_TIME_ZONE,
  calendarDayKey,
  saoPauloCalendarDay,
  saoPauloDateKey,
  type CalendarDay,
} from "./sao-paulo-calendar.js";
